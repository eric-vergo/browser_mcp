import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { McpToolCtx, ToolDef, ToolResult } from "./types";

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

/** Flag a non-OK HTTP status so navigations to 404/500 pages aren't reported as a plain success. */
const httpNote = (status?: number): string => (status && status >= 400 ? `  (HTTP ${status})` : "");

function listHtml(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), childRel);
      else if (/\.html?$/i.test(e.name)) out.push(childRel);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** Build the MCP tool suite. All ops run against the Playwright engine; navigations mirror to the pane. */
export function buildTools(ctx: McpToolCtx): ToolDef[] {
  const syncPane = async (url: string) => {
    try {
      await ctx.pane.show(url);
    } catch {
      /* pane is best-effort / optional */
    }
  };

  const goto = async (target: string): Promise<ToolResult> => {
    const { url } = ctx.resolve(target);
    const r = await ctx.engine.goto(url);
    await syncPane(r.url);
    return text(`Loaded ${r.url}${httpNote(r.status)}\nTitle: ${r.title || "(none)"}`);
  };

  return [
    {
      name: "open_docs",
      title: "Open docs",
      description: "Open the documentation (defaults to the home page) in the headless browser and the VSCode pane.",
      inputSchema: { path: z.string().optional() },
      handler: (a) => goto((a.path as string | undefined) ?? "/"),
    },
    {
      name: "navigate",
      title: "Navigate",
      description: "Navigate to a documentation page (site path like 'api/x.html' or an in-site URL). Moves both the headless browser and the VSCode pane.",
      inputSchema: { path: z.string() },
      handler: (a) => goto(a.path as string),
    },
    {
      name: "get_page_title",
      title: "Get page title",
      description: "Return the current page title and URL — a lightweight confirmation of where you landed.",
      handler: async () => {
        const r = await ctx.engine.getTitle();
        return text(`Title: ${r.title || "(none)"}\nURL: ${r.url}`);
      },
    },
    {
      name: "get_page_text",
      title: "Get page text",
      description: "Return the rendered visible text of the current page.",
      handler: async () => text((await ctx.engine.getText()) || "(no text)"),
    },
    {
      name: "get_links",
      title: "Get links",
      description: "List anchor text + resolved href on the current page (the documentation graph).",
      handler: async () => {
        const ls = await ctx.engine.getLinks();
        return text(ls.length ? ls.map((l) => `- ${l.text || "(no text)"} -> ${l.href}`).join("\n") : "(no links)");
      },
    },
    {
      name: "list_pages",
      title: "List pages",
      description: "List the HTML pages available in the docs directory.",
      handler: async () => {
        const ps = listHtml(ctx.docsServer.docsDir);
        return text(ps.length ? ps.map((p) => `- ${p}`).join("\n") : `(no .html pages in ${ctx.docsServer.docsDir})`);
      },
    },
    {
      name: "screenshot",
      title: "Screenshot",
      description:
        "Capture a PNG of the current page. Viewport by default; set fullPage for the whole page; set selector to capture one element; set savePath to also write the PNG to disk (relative paths resolve against the workspace root).",
      inputSchema: { fullPage: z.boolean().optional(), selector: z.string().optional(), savePath: z.string().optional() },
      handler: async (a) => {
        const buf = await ctx.engine.screenshot({ fullPage: a.fullPage as boolean | undefined, selector: a.selector as string | undefined });
        const content: ToolResult["content"] = [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }];
        if (a.savePath) {
          const sp = a.savePath as string;
          const abs = path.isAbsolute(sp) ? sp : path.join(ctx.workspaceRoot, sp);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, buf);
          content.push({ type: "text", text: `Saved screenshot to ${abs}` });
        }
        return { content };
      },
    },
    {
      name: "read_console",
      title: "Read console",
      description: "Console messages (incl. errors/warnings) captured on the current page since the last navigation.",
      handler: async () => {
        const es = await ctx.engine.getConsole();
        return text(es.length ? es.map((e) => `[${e.type}] ${e.text}${e.location ? ` (${e.location})` : ""}`).join("\n") : "(no console messages)");
      },
    },
    {
      name: "read_network",
      title: "Read network",
      description: "Failed / non-2xx network requests on the current page (broken assets, 404s) since the last navigation.",
      handler: async () => {
        const ns = (await ctx.engine.getNetwork()).filter((n) => n.failed || n.status >= 400);
        return text(ns.length ? ns.map((n) => `${n.failed ? "FAILED" : n.status} ${n.method} ${n.url}`).join("\n") : "(no failed requests)");
      },
    },
    {
      name: "check_links",
      title: "Check links",
      description: "Crawl internal links across the doc set from a start path (default home) and report broken targets + orphan pages.",
      inputSchema: { startPath: z.string().optional() },
      handler: async (a) => {
        const r = await ctx.crawlLinks(ctx.docsServer.baseUrl, ctx.docsServer.docsDir, (a.startPath as string | undefined) ?? "/", ctx.maxCrawlPages);
        const parts = [`Visited ${r.pagesVisited} page(s).`];
        if (r.capped) parts.push(`WARNING: hit the ${r.pagesVisited}-page crawl cap; results are PARTIAL. Raise "docsBrowser.maxCrawlPages" for full coverage.`);
        parts.push(r.broken.length ? `Broken (${r.broken.length}):\n` + r.broken.map((b) => `- ${b.status || "ERR"} ${b.url}  (from ${b.linkedFrom})`).join("\n") : "No broken links.");
        parts.push(r.orphans.length ? `Orphans (${r.orphans.length}):\n` + r.orphans.map((o) => `- ${o}`).join("\n") : "No orphan pages.");
        return text(parts.join("\n\n"));
      },
    },
    {
      name: "click",
      title: "Click",
      description: "Click an element by CSS selector or visible text. If it navigates, the pane follows.",
      inputSchema: { selector: z.string().optional(), text: z.string().optional() },
      handler: async (a) => {
        const r = await ctx.engine.click({ selector: a.selector as string | undefined, text: a.text as string | undefined });
        if (r.navigated) await syncPane(r.url);
        return text(`${r.navigated ? "Navigated to" : "Clicked; still at"} ${r.url}\nTitle: ${r.title || "(none)"}`);
      },
    },
    {
      name: "pane_state",
      title: "Pane state",
      description: "Current VSCode pane state (requested URL, host-side preflight status, recent webview events) — sync confirmation & debugging.",
      handler: async () => text(JSON.stringify(ctx.pane.state(), null, 2)),
    },
    {
      name: "reload",
      title: "Reload",
      description: "Reload the current page (after regenerating docs).",
      handler: async () => {
        const r = await ctx.engine.reload();
        await ctx.pane.reload();
        return text(`Reloaded ${r.url}${httpNote(r.status)}`);
      },
    },
    {
      name: "back",
      title: "Back",
      description: "Go back in history; the pane follows.",
      handler: async () => {
        const r = await ctx.engine.back();
        if (!r) return text("No back history.");
        await syncPane(r.url);
        return text(`Back: ${r.url}${httpNote(r.status)}`);
      },
    },
    {
      name: "forward",
      title: "Forward",
      description: "Go forward in history; the pane follows.",
      handler: async () => {
        const r = await ctx.engine.forward();
        if (!r) return text("No forward history.");
        await syncPane(r.url);
        return text(`Forward: ${r.url}${httpNote(r.status)}`);
      },
    },
  ];
}
