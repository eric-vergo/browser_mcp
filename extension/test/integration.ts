// Stage-2 integration test: full pipeline (docs server + Playwright sidecar + tools + MCP HTTP),
// with only the VSCode pane stubbed. Bundled to CJS by run-integration.mjs and executed.
import * as cp from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { startDocsServer } from "../src/docsServer";
import { createBrowserEngine } from "../src/browserClient";
import { createMcpServer } from "../src/mcpServer";
import { crawlLinks } from "../src/checkLinks";
import { buildTools } from "../src/tools";
import type { McpToolCtx, PaneController, PaneState } from "../src/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO = process.cwd(); // runner sets cwd to repo root
const SIDECAR = path.join(REPO, "extension", "dist", "sidecar", "main.js");
const PORT = 8791;

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}
function firstText(r: any): string {
  return (r.content?.find((c: any) => c.type === "text")?.text ?? "").trim();
}

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcb-integ-"));
  // good.html is linked TWICE (nav + list) so a selector like a[href="good.html"] matches >1
  // element — the B1 strict-mode regression case.
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>Home</title><nav><a href="good.html">good</a> <a href="broken.html">broken</a></nav><h1>Home</h1><ul><li><a href="good.html">good</a></li></ul>`);
  fs.writeFileSync(path.join(dir, "good.html"), `<!doctype html><title>Good</title><h1>Good page</h1><a href="index.html">home</a>`);
  fs.writeFileSync(path.join(dir, "broken.html"), `<!doctype html><title>Broken</title><h1>Broken</h1><a href="missing.html">dead</a><img src="missing.png"><script>console.error('XYZ-console')</script>`);
  fs.writeFileSync(path.join(dir, "orphan.html"), `<!doctype html><title>Orphan</title><h1>Orphan</h1>`);
  return dir;
}

const stubPane: PaneController = {
  _s: { panelExists: false, events: [] } as PaneState & { panelExists: boolean },
  async show(url: string) { (this as any)._s.panelExists = true; (this as any)._s.requestedUrl = url; },
  async reload() {},
  state() { return { ...(this as any)._s, events: [...(this as any)._s.events] }; },
  dispose() {},
} as any;

async function main() {
  const docsDir = makeFixture();
  const docsServer = await startDocsServer(docsDir, 0);
  const sidecar = cp.spawn(process.execPath, [SIDECAR], { cwd: path.join(REPO, "extension"), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  sidecar.stderr?.on("data", (d) => process.stderr.write("[sidecar] " + d));
  const engine = createBrowserEngine(sidecar);

  const ctx: McpToolCtx = {
    engine, pane: stubPane, docsServer, crawlLinks, workspaceRoot: docsDir,
    resolve: (t) => { const base = docsServer.baseUrl + "/"; const u = new URL(t, base); return { url: u.toString(), path: u.pathname + u.search + u.hash }; },
  };
  const mcp = createMcpServer(buildTools(ctx), { name: "docs-browser", version: "test" });
  await mcp.listen(PORT);

  const client = new Client({ name: "integ", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));

  const call = (name: string, args: any = {}) => client.callTool({ name, arguments: args });
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check("tools registered", ["navigate", "screenshot", "get_page_title", "read_console", "read_network", "check_links", "click", "pane_state", "get_links", "list_pages"].every((n) => names.includes(n)), names.join(","));

  const nav = firstText(await call("navigate", { path: "broken.html" }));
  check("navigate -> broken.html", /broken\.html/.test(nav) && /Title: Broken/.test(nav), nav.replace(/\n/g, " | "));

  const title = firstText(await call("get_page_title"));
  check("get_page_title", /Title: Broken/.test(title) && /broken\.html/.test(title));

  const console_ = firstText(await call("read_console"));
  check("read_console catches console.error", /XYZ-console/.test(console_), console_);

  const net = firstText(await call("read_network"));
  check("read_network catches missing.png 404", /missing\.png/.test(net), net);

  const shot = await call("screenshot", {});
  const img = (shot as any).content?.find((c: any) => c.type === "image");
  check("screenshot returns PNG image", !!img && Buffer.from(img.data, "base64").subarray(0, 4).toString("hex") === "89504e47");

  const links = firstText(await call("check_links"));
  check("check_links flags broken target", /missing\.html/.test(links), links.replace(/\n/g, " | "));
  check("check_links flags orphan", /orphan\.html/.test(links));

  await call("navigate", { path: "/" });
  const click = firstText(await call("click", { text: "good" }));
  check("click 'good' navigates", /good\.html/.test(click) && /Navigated/.test(click), click.replace(/\n/g, " | "));

  const pstate = JSON.parse(firstText(await call("pane_state")));
  check("pane_state reflects sync", pstate.panelExists === true && /good\.html/.test(pstate.requestedUrl || ""), JSON.stringify(pstate));

  const pages = firstText(await call("list_pages"));
  check("list_pages lists fixture html", /index\.html/.test(pages) && /orphan\.html/.test(pages));

  // B1 regression: a selector matching >1 element must click the first match, not throw a
  // Playwright strict-mode violation.
  await call("navigate", { path: "/" });
  const clickSel = firstText(await call("click", { selector: 'a[href="good.html"]' }));
  check("B1: click selector w/ multi-match navigates (no strict-mode error)", /good\.html/.test(clickSel) && /Navigated/.test(clickSel), clickSel.replace(/\n/g, " | "));

  // B2 regression: navigating to a 404 surfaces the HTTP status instead of a plain success.
  const nav404 = firstText(await call("navigate", { path: "definitely-missing.html" }));
  check("B2: navigate to 404 surfaces (HTTP 404)", /\(HTTP 404\)/.test(nav404), nav404.replace(/\n/g, " | "));
  const reload404 = firstText(await call("reload"));
  check("B2: reload on 404 page surfaces (HTTP 404)", /\(HTTP 404\)/.test(reload404), reload404.replace(/\n/g, " | "));

  await client.close();
  await engine.dispose();
  await mcp.close();
  await docsServer.close();
  try { fs.rmSync(docsDir, { recursive: true, force: true }); } catch {}

  console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("integration error:", e); process.exit(1); });
