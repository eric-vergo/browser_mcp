import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StartDocsServer } from "./types";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Minimal zero-dependency static file serving, scoped to docsDir (no traversal). */
function serveStatic(docsDir: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  } catch {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }
  const root = path.resolve(docsDir);
  let filePath = path.resolve(root, pathname.replace(/^\/+/, ""));
  // Path-traversal guard: reject anything resolving outside docsDir.
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, "index.html");
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.setHeader("content-type", MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream");
      res.setHeader("cache-control", "no-cache");
      res.end(data);
    });
  });
}

/**
 * One loopback HTTP server that serves the docs directory as static files.
 * strictPort: binds the requested port on 127.0.0.1 and rejects on EADDRINUSE
 * rather than auto-picking another port. The MCP server is now in-process, so
 * there are no control routes here.
 */
export const startDocsServer: StartDocsServer = (docsDir, port) =>
  new Promise((resolve, reject) => {
    const root = path.resolve(docsDir);
    const server = http.createServer((req, res) => serveStatic(root, req, res));

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`docsServer: port ${port} is already in use (strictPort, not auto-picking)`));
      } else {
        reject(new Error(`docsServer: failed to bind port ${port}: ${err.message}`));
      }
    };
    server.once("error", onError);

    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      // Swallow late runtime errors to stderr instead of crashing the host.
      server.on("error", (err) => process.stderr.write(`docsServer: runtime error: ${String(err)}\n`));
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      process.stderr.write(`docsServer: serving ${root} at http://127.0.0.1:${boundPort}\n`);
      resolve({
        baseUrl: `http://127.0.0.1:${boundPort}`,
        port: boundPort,
        docsDir: root,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            // Drop keep-alive sockets so close() does not hang.
            server.closeAllConnections?.();
          }),
      });
    });
  });
