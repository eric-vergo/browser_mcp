// Standalone test for docsServer.ts + checkLinks.ts.
// Bundles both TS modules to CJS via esbuild, then exercises them over real loopback HTTP.
// Run: node extension/test/docs.mjs   (from the repo root or the extension dir)
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "docs-bundle-"));

const failures = [];
const ok = (cond, msg) => {
  if (cond) console.log(`  ok: ${msg}`);
  else { console.log(`  FAIL: ${msg}`); failures.push(msg); }
};

async function bundle(name) {
  const outfile = path.join(OUT, `${name}.cjs`);
  await build({
    entryPoints: [path.join(SRC, `${name}.ts`)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "warning",
  });
  return require(outfile);
}

/** strictPort means a busy port rejects; walk a list of likely-free literals. */
async function startOnSomePort(startDocsServer, docsDir, ports) {
  let lastErr;
  for (const p of ports) {
    try {
      return await startDocsServer(docsDir, p);
    } catch (e) {
      lastErr = e;
      if (!String(e.message || e).includes("in use")) throw e;
    }
  }
  throw lastErr;
}

async function main() {
  const { startDocsServer } = await bundle("docsServer");
  const { crawlLinks } = await bundle("checkLinks");

  // ── Test 1: docsServer over the repo's real docs/ ──────────────────────
  console.log("docsServer:");
  const realDocs = path.join(__dirname, "..", "..", "docs");
  const srv = await startOnSomePort(startDocsServer, realDocs, [4321, 4322, 4399, 4555, 4777]);
  try {
    ok(srv.baseUrl.startsWith("http://127.0.0.1:"), `baseUrl looks loopback (${srv.baseUrl})`);
    ok(typeof srv.port === "number" && srv.port > 0, `port set (${srv.port})`);
    ok(path.resolve(srv.docsDir) === path.resolve(realDocs), "docsDir echoed");

    const root = await fetch(srv.baseUrl + "/");
    const rootBody = await root.text();
    ok(root.status === 200, "GET / -> 200");
    ok((root.headers.get("content-type") || "").includes("text/html"), "GET / is text/html");
    ok(rootBody.includes("Sample Docs"), "GET / body has 'Sample Docs'");

    const strings = await fetch(srv.baseUrl + "/api/strings.html");
    await strings.text();
    ok(strings.status === 200, "GET /api/strings.html -> 200");

    const trav = await fetch(srv.baseUrl + "/%2e%2e%2f%2e%2e%2fpackage.json");
    await trav.text();
    ok(trav.status === 403, "encoded traversal -> 403");

    const missing = await fetch(srv.baseUrl + "/nope.html");
    await missing.text();
    ok(missing.status === 404, "GET /nope.html -> 404");
  } finally {
    await srv.close();
  }

  // ── Test 2: checkLinks over a temp fixture ─────────────────────────────
  console.log("checkLinks:");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "docs-fixture-"));
  fs.writeFileSync(path.join(fixture, "index.html"),
    `<!doctype html><html><body><h1>Home</h1>
     <a href="good.html">good</a>
     <a href="missing.html">missing</a>
     <a href="good.html#section">good-frag</a>
     </body></html>`);
  fs.writeFileSync(path.join(fixture, "good.html"),
    `<!doctype html><html><body><h1>Good</h1><a href="/index.html">home</a></body></html>`);
  fs.writeFileSync(path.join(fixture, "orphan.html"),
    `<!doctype html><html><body><h1>Orphan, nobody links me</h1></body></html>`);

  const srv2 = await startOnSomePort(startDocsServer, fixture, [4811, 4812, 4899, 4944, 4988]);
  try {
    const report = await crawlLinks(srv2.baseUrl, fixture, "/");
    console.log("  report:", JSON.stringify(report));
    ok(report.broken.some((b) => b.url.includes("missing.html") && b.status === 404),
      "missing.html reported broken (404)");
    ok(!report.broken.some((b) => b.url.includes("good.html")),
      "good.html NOT broken");
    ok(report.orphans.some((o) => o.includes("orphan.html")),
      "orphan.html reported as orphan");
    ok(!report.orphans.some((o) => o.includes("index.html")),
      "index.html NOT orphan (reached via /)");
    ok(report.pagesVisited >= 3, `visited >= 3 pages (${report.pagesVisited})`);
  } finally {
    await srv2.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  fs.rmSync(OUT, { recursive: true, force: true });
}

main()
  .then(() => {
    console.log(failures.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
    process.exit(failures.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    console.log("RESULT: FAIL");
    process.exit(1);
  });
