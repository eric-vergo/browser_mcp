#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { getPage, closeBrowser, serial } from "./browser.js";
import { resolveDocsTarget, resolveUrl, paneSync, closeFallback, docsDir, workspaceRoot } from "./docsClient.js";

const server = new McpServer({ name: "docs-browser", version: "0.1.0" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** Navigate the headless page to a target and mirror it into the VSCode pane. */
async function gotoAndSync(target: string) {
  const { baseUrl, controlUrl } = await resolveDocsTarget();
  const { fullUrl, urlPath } = resolveUrl(baseUrl, target);
  const page = await getPage();
  await page.goto(fullUrl, { waitUntil: "load" });
  await paneSync(controlUrl, "show", urlPath);
  const title = await page.title();
  return text(`Loaded ${page.url()}\nTitle: ${title || "(none)"}`);
}

server.registerTool(
  "open_docs",
  {
    title: "Open docs",
    description:
      "Open the documentation in the headless browser (and the VSCode Simple Browser pane, if the extension is running). Optional path selects a page; defaults to the docs root.",
    inputSchema: { path: z.string().optional() },
  },
  ({ path: p }) => serial(() => gotoAndSync(p ?? "/")),
);

server.registerTool(
  "navigate",
  {
    title: "Navigate",
    description:
      "Navigate to a documentation page. Accepts a site-relative path ('api/index.html' or '/api/index.html') or an absolute in-site URL. Moves both the headless browser and the VSCode pane.",
    inputSchema: { path: z.string() },
  },
  ({ path: p }) => serial(() => gotoAndSync(p)),
);

server.registerTool(
  "screenshot",
  {
    title: "Screenshot",
    description:
      "Capture a PNG screenshot of the current docs page. Viewport-only by default; set fullPage=true to capture the whole page (larger — counts against the MCP output token budget). Set savePath to also write the PNG to disk (relative paths resolve against the workspace root) — useful for saving reference screenshots to compare against.",
    inputSchema: { fullPage: z.boolean().optional(), savePath: z.string().optional() },
  },
  ({ fullPage, savePath }) =>
    serial(async () => {
      const page = await getPage();
      const buf = await page.screenshot({ fullPage: fullPage ?? false });
      const content: Array<
        { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
      > = [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }];
      if (savePath) {
        const abs = path.isAbsolute(savePath) ? savePath : path.join(workspaceRoot(), savePath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        content.push({ type: "text", text: `Saved screenshot to ${abs}` });
      }
      return { content };
    }),
);

server.registerTool(
  "get_page_text",
  {
    title: "Get page text",
    description: "Return the rendered visible text of the current docs page.",
  },
  () =>
    serial(async () => {
      const page = await getPage();
      const t = await page.innerText("body").catch(() => "");
      return text(t || "(no text)");
    }),
);

server.registerTool(
  "get_links",
  {
    title: "Get links",
    description:
      "List the links (anchor text and resolved href) on the current docs page — the documentation graph.",
  },
  () =>
    serial(async () => {
      const page = await getPage();
      const links = await page.$$eval("a[href]", (els) =>
        els.map((a) => ({
          href: (a as HTMLAnchorElement).href,
          text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        })),
      );
      if (!links.length) return text("(no links on this page)");
      return text(links.map((l) => `- ${l.text || "(no text)"} -> ${l.href}`).join("\n"));
    }),
);

server.registerTool(
  "list_pages",
  {
    title: "List pages",
    description: "List the documentation pages (HTML files) available in the docs directory.",
  },
  () =>
    serial(async () => {
      const dir = docsDir();
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
      out.sort();
      if (!out.length) return text(`(no .html pages found in ${dir})`);
      return text(out.map((p) => `- ${p}`).join("\n"));
    }),
);

server.registerTool(
  "reload",
  {
    title: "Reload",
    description:
      "Reload the current docs page in both the headless browser and the VSCode pane (use after regenerating docs).",
  },
  () =>
    serial(async () => {
      const page = await getPage();
      await page.reload({ waitUntil: "load" });
      const { baseUrl, controlUrl } = await resolveDocsTarget();
      const { urlPath } = resolveUrl(baseUrl, page.url());
      await paneSync(controlUrl, "show", urlPath);
      return text(`Reloaded ${page.url()}`);
    }),
);

function historyTool(name: string, title: string, dir: "back" | "forward") {
  server.registerTool(
    name,
    { title, description: `Go ${dir} in the browser history and sync the VSCode pane.` },
    () =>
      serial(async () => {
        const page = await getPage();
        const resp =
          dir === "back"
            ? await page.goBack({ waitUntil: "load" })
            : await page.goForward({ waitUntil: "load" });
        if (!resp) return text(`No ${dir} history.`);
        const { baseUrl, controlUrl } = await resolveDocsTarget();
        const { urlPath } = resolveUrl(baseUrl, page.url());
        await paneSync(controlUrl, "show", urlPath);
        return text(`${title}: ${page.url()}`);
      }),
  );
}
historyTool("back", "Back", "back");
historyTool("forward", "Forward", "forward");

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[docs-browser] MCP server ready");
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  Promise.allSettled([closeBrowser(), closeFallback()]).finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

main().catch((err) => {
  console.error("[docs-browser] fatal:", err);
  process.exit(1);
});
