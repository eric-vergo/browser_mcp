import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { startDocsServer } from "./docsServer";
import { createBrowserEngine } from "./browserClient";
import { createPaneController } from "./paneController";
import { createMcpServer } from "./mcpServer";
import { crawlLinks } from "./checkLinks";
import { buildTools } from "./tools";
import type { BrowserEngine, DocsServer, McpServerHandle, McpToolCtx, PaneController } from "./types";

const VERSION = "0.2.0";
const OPEN_ITEM = " open-docs";

let docsServer: DocsServer | undefined;
let pane: PaneController | undefined;
let mcp: McpServerHandle | undefined;
let engine: BrowserEngine | undefined;
let started = false;
let startingPromise: Promise<boolean> | undefined;
let pagesProvider: PagesProvider | undefined;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
function docsDirAbs(root: string): string {
  const cfg = vscode.workspace.getConfiguration("docsBrowser").get<string>("docsDir", "docs");
  return path.isAbsolute(cfg) ? cfg : path.join(root, cfg);
}
function resolveUrl(target: string): { url: string; path: string } {
  const base = docsServer!.baseUrl.endsWith("/") ? docsServer!.baseUrl : docsServer!.baseUrl + "/";
  const u = new URL(target, base);
  return { url: u.toString(), path: u.pathname + u.search + u.hash };
}

/**
 * Where playwright-core keeps its browser binaries. Mirrors playwright-core's own resolution:
 * the PLAYWRIGHT_BROWSERS_PATH env override, else the per-OS default cache. Returns undefined
 * when we can't determine it (e.g. PLAYWRIGHT_BROWSERS_PATH=0 means "in the package") — callers
 * then assume the browser is present and skip provisioning.
 */
function browsersCacheDir(): string | undefined {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (env) return env === "0" ? undefined : env;
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Caches", "ms-playwright");
    case "win32":
      return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright");
    default:
      return path.join(home, ".cache", "ms-playwright");
  }
}

/** Cheap check: is a chromium build already present in the cache? Avoids running the installer
 *  (and its startup latency) on machines that already have it. */
function chromiumPresent(): boolean {
  const dir = browsersCacheDir();
  if (!dir) return true; // can't tell / in-package: assume present, let launch surface any error
  try {
    return fs.readdirSync(dir).some((d) => d.startsWith("chromium"));
  } catch {
    return false; // cache dir missing => not installed
  }
}

/** Locate playwright-core's CLI (`cli.js`) across the installed (sideload) and dev (workspace) layouts. */
function findPlaywrightCli(extensionPath: string): string | undefined {
  const candidates = [
    path.join(extensionPath, "node_modules", "playwright-core", "cli.js"), // installed layout
    path.join(extensionPath, "..", "node_modules", "playwright-core", "cli.js"), // dev: workspace hoist
  ];
  return candidates.find((p) => fs.existsSync(p));
}

let chromiumReady: Promise<void> | undefined;
/**
 * Ensure a headless Chromium is available before the first sidecar launch. On a fresh machine
 * playwright-core ships no browser, so `chromium.launch()` would fail; here we download it once
 * via the playwright-core CLI (idempotent), shown as a progress notification. Cached so the
 * self-healing re-spawn path never re-runs it. Uses the SAME (default) env as the sidecar spawn
 * so the installed browser lands in the cache the sidecar reads.
 */
function ensureChromium(context: vscode.ExtensionContext): Promise<void> {
  if (chromiumReady) return chromiumReady;
  chromiumReady = (async () => {
    if (chromiumPresent()) return;
    const cli = findPlaywrightCli(context.extensionPath);
    if (!cli) {
      void vscode.window.showWarningMessage(
        "Docs Browser: could not locate the playwright-core CLI to install Chromium; the headless browser may fail to launch.",
      );
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Docs Browser: downloading Chromium (first run)…" },
      () =>
        new Promise<void>((resolve) => {
          const p = cp.spawn(process.execPath, [cli, "install", "chromium"], {
            cwd: context.extensionPath,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          p.stdout?.on("data", (d) => console.error("[docs-browser chromium-install]", String(d).trimEnd()));
          p.stderr?.on("data", (d) => console.error("[docs-browser chromium-install]", String(d).trimEnd()));
          p.on("exit", (code) => {
            if (code !== 0) {
              void vscode.window.showErrorMessage(
                `Docs Browser: Chromium install exited with code ${code}; the headless browser may fail to launch.`,
              );
            }
            resolve();
          });
          p.on("error", (e) => {
            void vscode.window.showErrorMessage(`Docs Browser: Chromium install failed: ${String(e)}`);
            resolve(); // don't wedge startup; the launch attempt will surface the real error
          });
        }),
    );
    // Re-check after install; if it still isn't there, the cli failed — warn but proceed.
    if (!chromiumPresent()) {
      void vscode.window.showWarningMessage("Docs Browser: Chromium still not found after install; check the output log.");
    }
  })();
  return chromiumReady;
}

/**
 * Self-healing Playwright engine: a STABLE BrowserEngine that lazily spawns the sidecar child
 * and transparently re-spawns it if it dies — so a Chromium/sidecar crash doesn't permanently
 * wedge every tool. docsServer/pane/MCP are started once (in ensureStarted) and are unaffected
 * by sidecar restarts, so we never re-run the one-time MCP port bind.
 */
function makeEngine(context: vscode.ExtensionContext): BrowserEngine {
  let child: cp.ChildProcess | undefined;
  let inner: BrowserEngine | undefined;
  let spawning: Promise<BrowserEngine> | undefined;

  const alive = () => !!child && child.exitCode === null && !child.killed;

  async function get(): Promise<BrowserEngine> {
    if (inner && alive()) return inner;
    if (spawning) return spawning;
    spawning = (async () => {
      await ensureChromium(context); // download the browser once on a fresh machine before launching
      const sidecarPath = path.join(context.extensionPath, "dist", "sidecar", "main.js");
      const c = cp.spawn(process.execPath, [sidecarPath], {
        cwd: context.extensionPath, // so the sidecar's `require('playwright-core')` resolves
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1" },
        detached: true, // own a process group so we can group-kill Chromium on teardown
        stdio: ["pipe", "pipe", "pipe"],
      });
      c.stderr?.on("data", (d) => console.error("[docs-browser sidecar]", String(d).trimEnd()));
      c.on("exit", (code) => {
        console.error(`[docs-browser sidecar] exited (${code})`);
        if (child === c) {
          child = undefined;
          inner = undefined; // next call re-spawns
        }
      });
      child = c;
      inner = createBrowserEngine(c);
      return inner;
    })();
    try {
      return await spawning;
    } finally {
      spawning = undefined;
    }
  }

  return {
    goto: async (u) => (await get()).goto(u),
    screenshot: async (o) => (await get()).screenshot(o),
    click: async (t) => (await get()).click(t),
    getText: async () => (await get()).getText(),
    getLinks: async () => (await get()).getLinks(),
    getTitle: async () => (await get()).getTitle(),
    getConsole: async () => (await get()).getConsole(),
    getNetwork: async () => (await get()).getNetwork(),
    back: async () => (await get()).back(),
    forward: async () => (await get()).forward(),
    reload: async () => (await get()).reload(),
    currentUrl: async () => (await get()).currentUrl(),
    dispose: async () => {
      const c = child;
      const i = inner;
      child = undefined;
      inner = undefined;
      try {
        await i?.dispose(); // graceful shutdown (sidecar closes Chromium, exits)
      } catch {
        /* ignore */
      }
      // Group-kill only if still alive (avoid PID-reuse hazard once the child has been reaped);
      // POSIX-only — process.kill(-pid) is invalid on win32.
      if (c?.pid && c.exitCode === null && !c.killed && process.platform !== "win32") {
        try {
          process.kill(-c.pid);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/** Start docs server + pane + MCP once; create the (lazy) self-healing engine. Idempotent. */
async function ensureStarted(context: vscode.ExtensionContext): Promise<boolean> {
  if (started) return true;
  if (startingPromise) return startingPromise;
  startingPromise = (async () => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("Docs Browser: open a folder/workspace first.");
      return false;
    }
    const dir = docsDirAbs(root);
    if (!fs.existsSync(dir)) {
      void vscode.window.showErrorMessage(`Docs Browser: docs directory not found: ${dir}. Set "docsBrowser.docsDir".`);
      return false;
    }

    const ds = await startDocsServer(dir, 0); // ephemeral port; nothing external references it
    try {
      docsServer = ds;
      engine = makeEngine(context);
      pane = createPaneController(context);
      const cfg = vscode.workspace.getConfiguration("docsBrowser");
      const maxCrawlPages = cfg.get<number>("maxCrawlPages", 500);
      const ctx: McpToolCtx = { engine, pane, docsServer, crawlLinks, workspaceRoot: root, maxCrawlPages, resolve: resolveUrl };
      const port = cfg.get<number>("mcpPort", 8765);
      const server = createMcpServer(buildTools(ctx), { name: "docs-browser", version: VERSION });
      try {
        await server.listen(port);
        mcp = server;
        console.error(`[docs-browser] MCP listening on http://127.0.0.1:${port}/mcp`);
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Docs Browser: MCP port ${port} is unavailable (${String(e)}). Close the other window or change "docsBrowser.mcpPort", then reload.`,
        );
        mcp = undefined; // degraded: pane still works; Claude can't connect until the port is free
      }
      started = true;
      return true;
    } catch (e) {
      await ds.close().catch(() => {}); // don't leak the docs server if later setup throws
      docsServer = undefined;
      engine = undefined;
      pane = undefined;
      throw e;
    }
  })();
  try {
    return await startingPromise;
  } finally {
    startingPromise = undefined;
  }
}

/** Sidebar tree: an "Open Docs Browser" action row, then one row per HTML page. */
class PagesProvider implements vscode.TreeDataProvider<string> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  refresh(): void {
    this._onDidChange.fire();
  }
  getTreeItem(element: string): vscode.TreeItem {
    if (element === OPEN_ITEM) {
      const item = new vscode.TreeItem("Open Docs Browser", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("open-preview");
      item.command = { command: "docsBrowser.open", title: "Open Docs Browser" };
      item.tooltip = "Open the documentation home page in the pane";
      return item;
    }
    const item = new vscode.TreeItem(element, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("file-code");
    item.command = { command: "docsBrowser.open", title: "Open page", arguments: [element] };
    item.tooltip = `Open ${element}`;
    return item;
  }
  getChildren(): string[] {
    const root = workspaceRoot();
    if (!root) return [];
    const dir = docsDirAbs(root);
    // No docs dir yet => return nothing so the viewsWelcome (set docsDir / create MCP config)
    // shows instead of a lone "Open Docs Browser" row that would just error on click.
    if (!fs.existsSync(dir)) return [];
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
    return [OPEN_ITEM, ...out];
  }
}

/**
 * Scaffold (or merge) a `.mcp.json` in the workspace root so Claude Code can reach this
 * extension's hosted MCP server. Preserves any other servers already listed; never clobbers
 * a file we can't parse. User-invoked only (writes a local config in the open workspace).
 */
async function createMcpConfig(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage("Docs Browser: open a folder/workspace first.");
    return;
  }
  const port = vscode.workspace.getConfiguration("docsBrowser").get<number>("mcpPort", 8765);
  const file = path.join(root, ".mcp.json");

  let json: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(file)) {
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch {
      void vscode.window.showErrorMessage(`Docs Browser: ${file} exists but isn't valid JSON; leaving it untouched. Fix or remove it, then retry.`);
      return;
    }
  }
  json.mcpServers = json.mcpServers || {};
  json.mcpServers["docs-browser"] = { type: "http", url: `http://127.0.0.1:${port}/mcp` };
  try {
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  } catch (e) {
    void vscode.window.showErrorMessage(`Docs Browser: could not write ${file}: ${String(e)}`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc);
  void vscode.window.showInformationMessage('Wrote .mcp.json ("docs-browser"). Run /mcp in Claude Code (or restart it) to connect.');
}

export function activate(context: vscode.ExtensionContext): void {
  pagesProvider = new PagesProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("docsBrowser.pages", pagesProvider),
    vscode.commands.registerCommand("docsBrowser.open", async (target?: unknown) => {
      if (!(await ensureStarted(context))) return;
      const { url } = resolveUrl(typeof target === "string" ? target : "/");
      await engine!.goto(url);
      await pane!.show(url);
    }),
    vscode.commands.registerCommand("docsBrowser.refresh", async () => {
      pagesProvider?.refresh();
      if (started) {
        await engine?.reload();
        await pane?.reload();
      }
    }),
    vscode.commands.registerCommand("docsBrowser.createMcpConfig", () => createMcpConfig()),
    vscode.commands.registerCommand("docsBrowser.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "docsBrowser"),
    ),
  );
  // Start early (onStartupFinished) so the MCP server is listening before Claude Code connects.
  void ensureStarted(context).catch((e) => console.error("[docs-browser] startup error", e));
}

export async function deactivate(): Promise<void> {
  try {
    await engine?.dispose(); // graceful sidecar shutdown + conditional group-kill
  } catch {
    /* ignore */
  }
  try {
    await mcp?.close();
  } catch {
    /* ignore */
  }
  try {
    await docsServer?.close();
  } catch {
    /* ignore */
  }
  pane?.dispose();
}
