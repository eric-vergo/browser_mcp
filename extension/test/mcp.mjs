// Standalone test for src/mcpServer.ts.
// Bundles the module with esbuild (CJS), starts it on a fixed port, then drives it
// with the real MCP SDK client over StreamableHTTP. Prints RESULT: PASS|FAIL.
//
// Run: node extension/test/mcp.mjs   (from anywhere; paths are absolute)
import { build } from "esbuild";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..", "src", "mcpServer.ts");
const OUT = "/tmp/dcb-mcp.cjs";
const PORT = 8799;
const ENDPOINT = `http://127.0.0.1:${PORT}/mcp`;

const failures = [];
function check(cond, msg) {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    failures.push(msg);
    console.log(`  FAIL: ${msg}`);
  }
}

let handle;
let client;
try {
  // 1. Bundle src/mcpServer.ts -> CJS (SDK + zod inlined, no externals).
  await build({
    entryPoints: [SRC],
    outfile: OUT,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "warning",
  });
  console.log(`bundled -> ${OUT}`);

  const mod = await import(pathToFileURL(OUT).href);
  const createMcpServer = mod.createMcpServer ?? mod.default?.createMcpServer;
  check(typeof createMcpServer === "function", "createMcpServer is exported as a function");

  // 2. One echo tool.
  const echo = {
    name: "echo",
    title: "Echo",
    description: "Echoes the provided message back.",
    inputSchema: { msg: z.string() },
    handler: async (args) => ({ content: [{ type: "text", text: args.msg }] }),
  };

  // 3 + 4. Create and start on the fixed port.
  handle = createMcpServer([echo], { name: "test", version: "0" });
  await handle.listen(PORT);
  console.log(`listening on ${ENDPOINT}`);

  // 5. Connect the real SDK client.
  client = new Client({ name: "test-client", version: "0" });
  const clientTransport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
  await client.connect(clientTransport);
  console.log("client connected");

  // listTools -> echo present.
  const listed = await client.listTools();
  const names = (listed.tools ?? []).map((t) => t.name);
  console.log(`  tools: ${JSON.stringify(names)}`);
  check(names.includes("echo"), "listTools includes 'echo'");

  // callTool echo -> text 'hi'.
  const res = await client.callTool({ name: "echo", arguments: { msg: "hi" } });
  const text = res?.content?.[0]?.text;
  console.log(`  callTool result text: ${JSON.stringify(text)}`);
  check(text === "hi", "callTool('echo', {msg:'hi'}) returns text 'hi'");

  // Bonus: a bad port should reject loudly (strictPort), not silently rebind.
  const dup = createMcpServer([echo], { name: "test2", version: "0" });
  let rejected = false;
  try {
    await dup.listen(PORT); // PORT already bound by `handle`
  } catch (e) {
    rejected = /in use/i.test(String(e?.message));
  }
  check(rejected, "second listen on the same port rejects (strictPort)");
  await dup.close().catch(() => {});
} catch (err) {
  failures.push(`threw: ${err?.stack || err}`);
  console.log(`  FAIL (exception): ${err?.stack || err}`);
} finally {
  try {
    if (client) await client.close();
  } catch {}
  try {
    if (handle) await handle.close();
  } catch {}
}

if (failures.length === 0) {
  console.log("RESULT: PASS");
  process.exit(0);
} else {
  console.log(`RESULT: FAIL (${failures.length} check(s))`);
  process.exit(1);
}
