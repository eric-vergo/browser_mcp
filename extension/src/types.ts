// Frozen shared contracts. Every module codes against these; do not change shapes
// during the parallel build stage without coordinating all modules.
import type { ZodRawShape } from "zod";

// ───────────────────────── Sidecar IPC protocol ─────────────────────────
// Extension host <-> Playwright child process. Newline-delimited JSON:
//   host writes SidecarRequest objects to child.stdin (one JSON per line),
//   child writes SidecarResponse objects to child.stdout (one JSON per line).
//   child.stderr is for human/debug logs only.

export type SidecarRequest =
  | { id: number; cmd: "goto"; url: string }
  | { id: number; cmd: "screenshot"; fullPage?: boolean; selector?: string }
  | { id: number; cmd: "click"; selector?: string; text?: string }
  | { id: number; cmd: "getText" }
  | { id: number; cmd: "getLinks" }
  | { id: number; cmd: "getTitle" }
  | { id: number; cmd: "getConsole" }
  | { id: number; cmd: "getNetwork" }
  | { id: number; cmd: "currentUrl" }
  | { id: number; cmd: "back" }
  | { id: number; cmd: "forward" }
  | { id: number; cmd: "reload" }
  | { id: number; cmd: "shutdown" };

export interface SidecarResponse {
  id: number;
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  pngBase64?: string;
  text?: string;
  links?: LinkInfo[];
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
  navigated?: boolean; // for click/back/forward: did a navigation occur
  status?: number; // HTTP status of the navigation's main response (goto/back/forward/reload)
}

export interface LinkInfo { href: string; text: string }
export interface ConsoleEntry { type: string; text: string; location?: string; t: number }
export interface NetworkEntry { url: string; status: number; method: string; failed: boolean; t: number }

export interface NavResult { url: string; title: string; status?: number }

// ───────────────────────── BrowserEngine ─────────────────────────
// Extension-host-side client to the sidecar (browserClient.ts implements this over a
// child process). Diagnostics buffers are cleared by the sidecar at the start of each
// goto/back/forward/reload so getConsole/getNetwork reflect the current page.
export interface BrowserEngine {
  goto(url: string): Promise<NavResult>;
  screenshot(opts?: { fullPage?: boolean; selector?: string }): Promise<Buffer>;
  click(target: { selector?: string; text?: string }): Promise<NavResult & { navigated: boolean }>;
  getText(): Promise<string>;
  getLinks(): Promise<LinkInfo[]>;
  getTitle(): Promise<NavResult>;
  getConsole(): Promise<ConsoleEntry[]>;
  getNetwork(): Promise<NetworkEntry[]>;
  back(): Promise<NavResult | null>;
  forward(): Promise<NavResult | null>;
  reload(): Promise<NavResult>;
  currentUrl(): Promise<string>;
  dispose(): Promise<void>;
}

// browserClient.ts exports this factory. `child` is an already-spawned sidecar process
// (extension.ts owns spawning/lifecycle). The factory wires stdin/stdout JSON framing.
export type CreateBrowserEngine = (child: import("node:child_process").ChildProcess) => BrowserEngine;

// ───────────────────────── DocsServer ─────────────────────────
// docsServer.ts: zero-dep static file server over docsDir. strictPort: throw on EADDRINUSE.
export interface DocsServer { baseUrl: string; port: number; docsDir: string; close(): Promise<void> }
export type StartDocsServer = (docsDir: string, port: number) => Promise<DocsServer>;

// ───────────────────────── PaneController ─────────────────────────
// paneController.ts: the single real-DOM webview pane. createPaneController(context) returns it.
// show(absoluteUrl) creates the panel once (CSP frame-src for that origin) then navigates the
// iframe in place via postMessage; reveal uses preserveFocus. Does a host-side preflight
// (fetch the url) to record an authoritative status. Relays webview window.onerror/load events.
export interface PaneController {
  show(absoluteUrl: string): Promise<void>;
  reload(): Promise<void>;
  state(): PaneState;
  dispose(): void;
}
export interface PaneState {
  panelExists: boolean;
  requestedUrl?: string;
  preflightStatus?: number;
  webviewLoaded?: boolean;
  events: { t: number; type: string; msg: string }[];
}
export type CreatePaneController = (context: import("vscode").ExtensionContext) => PaneController;

// ───────────────────────── MCP server ─────────────────────────
// mcpServer.ts: stateless StreamableHTTPServerTransport over plain http on a fixed port.
// It is handed a flat list of ToolDef (built by tools.ts) and exposes them at POST/GET/DELETE /mcp.
export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema?: ZodRawShape; // raw Zod shape (NOT z.object(...))
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}
export interface ToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
}
export interface McpServerHandle { listen(port: number): Promise<void>; close(): Promise<void> }
export type CreateMcpServer = (tools: ToolDef[], info: { name: string; version: string }) => McpServerHandle;

// ───────────────────────── check_links ─────────────────────────
// checkLinks.ts: crawl internal links from the docs origin; report broken + orphan pages.
export interface LinkReport {
  broken: { url: string; status: number; linkedFrom: string }[];
  orphans: string[]; // html files in docsDir never reached by the crawl
  pagesVisited: number;
}
export type CrawlLinks = (baseUrl: string, docsDir: string, startPath?: string) => Promise<LinkReport>;

// ───────────────────────── Tool context ─────────────────────────
// Passed to tools.ts to build ToolDef[]. resolve() turns a site path or in-site URL into
// an absolute url (for the engine) + the site path (for pane sync / display).
export interface McpToolCtx {
  engine: BrowserEngine;
  pane: PaneController;
  docsServer: DocsServer;
  crawlLinks: CrawlLinks;
  workspaceRoot: string; // for resolving relative screenshot savePath
  resolve(target: string): { url: string; path: string };
}
