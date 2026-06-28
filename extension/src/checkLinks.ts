import * as fs from "node:fs";
import * as path from "node:path";
import type { CrawlLinks, LinkReport } from "./types";

const DEFAULT_MAX_PAGES = 500;
const HREF_RE = /<a\s[^>]*href=["']([^"'#]+)/gi;

/** Site path key used for dedupe / orphan matching: decoded pathname + search. */
function keyOf(u: URL): string {
  let pathname: string;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    pathname = u.pathname;
  }
  return pathname + u.search;
}

/** Recursively collect `.html`/`.htm` files under root, skipping dotfiles/dirs. */
function walkHtml(root: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkHtml(root, full, out);
    } else if (ent.isFile() && /\.html?$/i.test(ent.name)) {
      const rel = path.relative(root, full).split(path.sep).join("/");
      out.push("/" + rel);
    }
  }
}

export const crawlLinks: CrawlLinks = async (baseUrl, docsDir, startPath = "/", maxPages = DEFAULT_MAX_PAGES): Promise<LinkReport> => {
  const cap = maxPages > 0 ? maxPages : DEFAULT_MAX_PAGES;
  const origin = new URL(baseUrl).origin;
  const start = new URL(startPath, baseUrl);

  const broken: LinkReport["broken"] = [];
  const queue: { url: URL; linkedFrom: string }[] = [{ url: start, linkedFrom: "(start)" }];
  const queued = new Set<string>([keyOf(start)]);
  const visitedPaths = new Set<string>(); // decoded pathnames actually fetched
  let pagesVisited = 0;
  let capped = false;

  while (queue.length > 0) {
    if (pagesVisited >= cap) {
      capped = true;
      break;
    }
    const { url, linkedFrom } = queue.shift()!;
    pagesVisited++;

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = url.pathname;
    }
    visitedPaths.add(pathname);

    let status = 0;
    let contentType = "";
    let body: string | null = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      status = res.status;
      contentType = res.headers.get("content-type") || "";
      const isHtml = contentType.includes("text/html");
      if (isHtml && status < 400) {
        body = await res.text();
      } else {
        await res.body?.cancel().catch(() => {});
      }
    } catch {
      status = 0; // network/fetch error
    }

    if (status === 0 || status >= 400) {
      broken.push({ url: url.href, status, linkedFrom });
    }

    if (body !== null) {
      let m: RegExpExecArray | null;
      HREF_RE.lastIndex = 0;
      while ((m = HREF_RE.exec(body)) !== null) {
        const raw = m[1];
        let next: URL;
        try {
          next = new URL(raw, url);
        } catch {
          continue;
        }
        next.hash = ""; // strip fragments
        if (next.origin !== origin) continue;
        const k = keyOf(next);
        if (queued.has(k)) continue;
        queued.add(k);
        queue.push({ url: next, linkedFrom: url.href });
      }
    }
  }

  if (capped) {
    process.stderr.write(`crawlLinks: hit page cap (${cap}); crawl stopped early\n`);
  }

  // Orphans: html files on disk whose site path was never visited.
  const htmlFiles: string[] = [];
  walkHtml(path.resolve(docsDir), path.resolve(docsDir), htmlFiles);
  const orphans: string[] = [];
  for (const sitePath of htmlFiles) {
    if (isReached(sitePath, visitedPaths)) continue;
    orphans.push(sitePath);
  }

  return { broken, orphans, pagesVisited, capped };
};

/** A file is "reached" if its own path was visited, or (for index files) its directory was. */
function isReached(sitePath: string, visited: Set<string>): boolean {
  if (visited.has(sitePath)) return true;
  const base = path.posix.basename(sitePath);
  if (base === "index.html" || base === "index.htm") {
    const dir = sitePath.slice(0, sitePath.length - base.length); // e.g. "/" or "/api/"
    if (visited.has(dir)) return true;
    const noSlash = dir.replace(/\/$/, "");
    if (noSlash && visited.has(noSlash)) return true;
  }
  return false;
}
