// Standalone integration test for the Playwright sidecar + browserClient.
//
// Bundles both TS modules with esbuild (playwright-core kept external), serves a
// tiny HTML page that logs to the console and references a missing image, drives
// it through createBrowserEngine, and asserts the round-trip works end to end.
//
// Run:  node extension/test/sidecar.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extensionDir, "..");
const repoNodeModules = path.join(repoRoot, "node_modules");

const SIDECAR_OUT = "/tmp/dcb-sidecar.cjs";
const CLIENT_OUT = "/tmp/dcb-client.cjs";

const failures = [];
function check(cond, label) {
  if (cond) {
    console.log(`  ok   - ${label}`);
  } else {
    console.log(`  FAIL - ${label}`);
    failures.push(label);
  }
}

const PAGE_HTML = `<!doctype html>
<html>
  <head><title>Sidecar Test Page</title></head>
  <body>
    <h1>Sidecar Test</h1>
    <a href="/other">Other page</a>
    <a href="https://example.com/">External</a>
    <img src="/nope.png" alt="missing">
    <script>console.error('BOOM');</script>
  </body>
</html>`;

async function main() {
  // 1. Bundle sidecar (playwright-core external) and client to CJS.
  await esbuild.build({
    entryPoints: [path.join(extensionDir, "sidecar/main.ts")],
    outfile: SIDECAR_OUT,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["playwright-core"],
    logLevel: "warning",
  });
  await esbuild.build({
    entryPoints: [path.join(extensionDir, "src/browserClient.ts")],
    outfile: CLIENT_OUT,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "warning",
  });
  console.log("bundled sidecar + client");

  const { createBrowserEngine } = require(CLIENT_OUT);

  // 2. Tiny HTTP server: '/' -> HTML, '/nope.png' -> 404, '/other' -> ok.
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE_HTML);
    } else if (url === "/other") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>Other</title><h1>Other page</h1>");
    } else {
      res.statusCode = 404;
      res.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;
  console.log(`serving at ${baseUrl}`);

  // 3. Spawn the sidecar. NODE_PATH lets the bundled CJS resolve the external
  //    playwright-core from the repo's node_modules.
  const child = spawn(process.execPath, [SIDECAR_OUT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_PATH: [repoNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    },
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));

  const engine = createBrowserEngine(child);

  try {
    // 4. Drive the engine and assert.
    const nav = await engine.goto(baseUrl);
    check(nav.title === "Sidecar Test Page", `goto title is correct (got "${nav.title}")`);
    check(nav.url === baseUrl, `goto url is correct (got "${nav.url}")`);

    const title = await engine.getTitle();
    check(title.title === "Sidecar Test Page", "getTitle matches");

    const url = await engine.currentUrl();
    check(url === baseUrl, "currentUrl matches");

    // Give late console/network events a beat to flush.
    await new Promise((r) => setTimeout(r, 100));

    const consoleEntries = await engine.getConsole();
    check(
      consoleEntries.some((e) => e.text.includes("BOOM")),
      `getConsole includes 'BOOM' (${consoleEntries.length} entries)`,
    );

    const network = await engine.getNetwork();
    check(
      network.some((n) => n.url.includes("/nope.png") && n.status === 404),
      `getNetwork includes 404 for nope.png (${network.length} entries)`,
    );

    const shot = await engine.screenshot();
    check(Buffer.isBuffer(shot), "screenshot returns a Buffer");
    check(
      shot.length >= 8 &&
        shot[0] === 0x89 &&
        shot[1] === 0x50 &&
        shot[2] === 0x4e &&
        shot[3] === 0x47,
      `screenshot has PNG magic bytes (${shot.length} bytes)`,
    );

    const links = await engine.getLinks();
    check(Array.isArray(links) && links.length >= 1, `getLinks returns links (${links.length})`);
    check(
      links.some((l) => l.href.includes("/other") && l.text === "Other page"),
      "getLinks resolves href + trimmed text",
    );

    const text = await engine.getText();
    check(text.includes("Sidecar Test"), "getText includes body text");
  } catch (e) {
    console.log(`  FAIL - threw: ${e && e.stack ? e.stack : e}`);
    failures.push("exception");
  } finally {
    await engine.dispose().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

main()
  .then(() => {
    const pass = failures.length === 0;
    console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
    process.exit(pass ? 0 : 1);
  })
  .catch((e) => {
    console.log(`\nfatal: ${e && e.stack ? e.stack : e}`);
    console.log("\nRESULT: FAIL");
    process.exit(1);
  });
