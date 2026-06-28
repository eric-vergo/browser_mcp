import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ZodRawShape } from "zod";

import type { ToolDef, McpServerHandle, CreateMcpServer } from "./types";

/** Read the full request body as a UTF-8 string (resolves with "" for an empty body). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Reply with a JSON-RPC-shaped error before the MCP transport gets involved. */
function sendJsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Host a STATELESS MCP server over plain HTTP. Claude Code connects via .mcp.json with
 * { type: "http", url: "http://127.0.0.1:<port>/mcp" }.
 *
 * Stateless wiring (per the SDK's documented stateless pattern, required by SDK v1.29.0):
 * `StreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`) throws
 * if a single transport is reused across requests, so we build a FRESH McpServer + transport
 * for EACH /mcp request, connect them, route the request through `transport.handleRequest`,
 * and tear both down when the response closes. Endpoint conventions: POST/GET/DELETE on /mcp.
 */
export const createMcpServer: CreateMcpServer = (tools: ToolDef[], info): McpServerHandle => {
  // Build a fresh, fully-registered McpServer for a single request (stateless).
  function makeServer(): McpServer {
    const server = new McpServer({ name: info.name, version: info.version });
    for (const t of tools) {
      server.registerTool(
        t.name,
        {
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema as ZodRawShape | undefined,
        },
        // ToolDef.handler is (args) => Promise<ToolResult>; the SDK callback also passes an
        // `extra` arg (ignored) and its return is structurally a CallToolResult. Cast to
        // bridge the differing arg/variance typing — runtime behaviour is identical.
        t.handler as unknown as ToolCallback<ZodRawShape>,
      );
    }
    return server;
  }

  let httpServer: http.Server | undefined;
  const live = new Set<{ server: McpServer; transport: StreamableHTTPServerTransport }>();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname !== "/mcp") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const method = req.method || "GET";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, POST, DELETE");
      res.end("Method not allowed");
      return;
    }

    // POST carries a JSON-RPC body; read+parse it so we can hand it to the transport.
    let parsedBody: unknown;
    if (method === "POST") {
      const raw = await readBody(req);
      try {
        parsedBody = raw.length ? JSON.parse(raw) : undefined;
      } catch {
        sendJsonRpcError(res, 400, -32700, "Parse error: invalid JSON body");
        return;
      }
    }

    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const entry = { server, transport };
    live.add(entry);

    // Stateless cleanup: drop the per-request server+transport once the response is done.
    const cleanup = () => {
      if (!live.has(entry)) return;
      live.delete(entry);
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    };
    res.on("close", cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      cleanup();
      sendJsonRpcError(res, 500, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    listen(port: number): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const srv = http.createServer((req, res) => {
          handle(req, res).catch((err) => {
            sendJsonRpcError(res, 500, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
          });
        });

        let settled = false;
        srv.on("error", (err: NodeJS.ErrnoException) => {
          if (settled) return; // post-listen errors have nothing to reject
          settled = true;
          if (err.code === "EADDRINUSE") {
            reject(new Error(`MCP server port ${port} is already in use (strictPort: refusing to pick another port)`));
          } else {
            reject(err);
          }
        });

        // strictPort: bind this exact port on loopback; never fall back to another port.
        srv.listen(port, "127.0.0.1", () => {
          settled = true;
          httpServer = srv;
          resolve();
        });
      });
    },

    async close(): Promise<void> {
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        httpServer = undefined;
      }
      for (const entry of [...live]) {
        live.delete(entry);
        await entry.transport.close().catch(() => undefined);
        await entry.server.close().catch(() => undefined);
      }
    },
  };
};
