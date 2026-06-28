import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DocsServerHooks {
  version: string;
  /** Show a site-relative path in the Simple Browser pane. */
  onShow: (urlPath: string) => void;
  /** Reload the currently shown page. */
  onReload: () => void;
}

export interface DocsServer {
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
}

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
 * One loopback HTTP server that serves the docs directory AND exposes the
 * /__control__/* endpoint the MCP server uses to drive the pane. Pass
 * docsDir=null for "external docs server" mode (control routes only).
 */
export async function startDocsServer(
  docsDir: string | null,
  port: number,
  hooks: DocsServerHooks,
): Promise<DocsServer> {
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/__control__/")) {
      handleControl(req, res, url.split("?")[0], hooks);
      return;
    }
    if (docsDir) {
      serveStatic(docsDir, req, res);
    } else {
      res.statusCode = 404;
      res.end("No docs served (external baseUrl mode)");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    baseUrl: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function handleControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  hooks: DocsServerHooks,
): void {
  if (req.method === "GET" && url === "/__control__/info") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version: hooks.version }));
    return;
  }
  if (req.method === "POST" && (url === "/__control__/show" || url === "/__control__/reload")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = body ? (JSON.parse(body) as { path?: string }) : {};
        if (url === "/__control__/show") hooks.onShow(typeof data.path === "string" ? data.path : "/");
        else hooks.onReload();
      } catch {
        // ignore malformed body
      }
      res.statusCode = 204;
      res.end();
    });
    return;
  }
  res.statusCode = 404;
  res.end("Not found");
}
