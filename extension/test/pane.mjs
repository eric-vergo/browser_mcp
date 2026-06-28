// Standalone test for src/paneController.ts.
//
// We cannot run a real VSCode webview outside the editor, so this verifies the two
// pieces that ARE pure / testable in plain node:
//   1. The module BUILDS: esbuild-bundles src/paneController.ts with `vscode` external,
//      proving imports resolve and the TypeScript is syntactically/structurally sound.
//      (`tsc --noEmit` is intentionally avoided: sibling modules are still incomplete and
//      would fail the whole-project type-check.)
//   2. The exported PURE functions buildHtml()/getNonce() produce correct output. To run
//      them we re-bundle to ESM with a tiny `vscode` stub (the pure fns never touch it).
//
// Run:  node extension/test/pane.mjs   ->  prints "RESULT: PASS" / "RESULT: FAIL".

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../src/paneController.ts");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pane-test-"));

const failures = [];
function check(name, cond) {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL- ${name}`);
  }
}

async function main() {
  // ── (1) Buildability: bundle with vscode external (matches the real esbuild build). ──
  const externalOut = path.join(tmpDir, "paneController.external.js");
  try {
    await build({
      entryPoints: [SRC],
      outfile: externalOut,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["vscode"],
      logLevel: "silent",
    });
    check("esbuild bundles src/paneController.ts (vscode external)", fs.existsSync(externalOut));
  } catch (err) {
    check(`esbuild bundles src/paneController.ts (vscode external) [${err.message}]`, false);
  }

  // ── (2) Bundle to ESM with a vscode stub so we can import the pure exports. ──
  const vscodeStub = {
    name: "vscode-stub",
    setup(b) {
      b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "vscode-stub" }));
      b.onLoad({ filter: /.*/, namespace: "vscode-stub" }, () => ({
        contents: "export const window = {}; export const ViewColumn = { Beside: -2 };",
        loader: "js",
      }));
    },
  };
  const esmOut = path.join(tmpDir, "paneController.esm.mjs");
  await build({
    entryPoints: [SRC],
    outfile: esmOut,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    plugins: [vscodeStub],
    logLevel: "silent",
  });

  const mod = await import(pathToFileURL(esmOut).href);
  const { buildHtml, getNonce } = mod;

  check("exports buildHtml function", typeof buildHtml === "function");
  check("exports getNonce function", typeof getNonce === "function");
  check("exports createPaneController function", typeof mod.createPaneController === "function");

  // ── Assertions on buildHtml output. ──
  const url = "http://127.0.0.1:3999/a.html";
  const frameOrigin = new URL(url).origin; // http://127.0.0.1:3999
  const nonce = getNonce();
  const html = buildHtml("vscode-resource://csp-source", frameOrigin, nonce, url);

  check("getNonce() returns a 32-char string", typeof nonce === "string" && nonce.length === 32);
  check("frame-src is the exact origin (http://127.0.0.1:3999)", html.includes("frame-src http://127.0.0.1:3999;"));
  check("frame-src is origin-only (no /a.html path)", !html.includes("frame-src http://127.0.0.1:3999/a.html"));
  check("origin is 127.0.0.1, not coerced to localhost", !html.includes("localhost"));
  check("CSP has default-src 'none'", html.includes("default-src 'none'"));
  check("contains an <iframe", html.includes("<iframe"));

  // nonce in the CSP must match the actual <script> tag nonce.
  const scriptNonceMatch = html.match(/<script nonce="([^"]+)">/);
  check("has a <script nonce=\"...\"> tag", !!scriptNonceMatch);
  if (scriptNonceMatch) {
    const scriptNonce = scriptNonceMatch[1];
    check("script tag nonce equals the nonce we passed", scriptNonce === nonce);
    check("CSP script-src references the same nonce", html.includes(`script-src 'nonce-${scriptNonce}'`));
  }

  // The iframe initially loads the requested URL (first-paint, race-proof).
  check("iframe src is the initial url", html.includes(`src="${url}"`));
  // connect-src is also pinned to the frame origin per spec.
  check("connect-src is the frame origin", html.includes("connect-src http://127.0.0.1:3999;"));
}

main()
  .then(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (failures.length === 0) {
      console.log("RESULT: PASS");
      process.exit(0);
    } else {
      console.log(`RESULT: FAIL (${failures.length} failed: ${failures.join("; ")})`);
      process.exit(1);
    }
  })
  .catch((err) => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.error(err);
    console.log("RESULT: FAIL");
    process.exit(1);
  });
