import http from "node:http";
import sirv from "sirv";

export interface StaticServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Fallback static file server over the docs directory, used only when no VSCode
 * extension is serving the docs (i.e. Claude-side inspection without the pane).
 * Binds an ephemeral port on loopback. Logs go to stderr — stdout is the MCP
 * JSON-RPC channel.
 */
export async function startStaticServer(docsDir: string): Promise<StaticServer> {
  const assets = sirv(docsDir, { dev: true });
  const server = http.createServer((req, res) => {
    assets(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.error(`[docs-browser] fallback static server: ${baseUrl} (root: ${docsDir})`);
  return {
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
