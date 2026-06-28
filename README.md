# browser_mcp — VSCode docs browser + hosted MCP

A **single VSCode extension** that displays auto-generated, self-contained HTML documentation in a real-DOM pane, and hosts an **MCP server** so Claude (via Claude Code) can develop and test that documentation UI — navigating, screenshotting, reading console/network, and crawling links.

One extension process owns everything:

```
┌─ VSCode extension host (one process) ──────────────────────────────────────┐
│  • Docs HTTP server  →  http://127.0.0.1:<ephemeral>/...   (static docs)     │
│  • Webview pane      →  <iframe> of the docs URL — REAL, selectable DOM      │
│  • Stateless MCP HTTP server  →  http://127.0.0.1:8765/mcp                   │
│  • MCP tool handlers ── drive ──► pane (postMessage) + Playwright (IPC)       │
│  • Activity-bar view + commands; spawns & owns the sidecar                   │
└───────────────▲──────────────────────────────────────────────┬─────────────┘
   Claude Code   │ HTTP (.mcp.json type:"http")                 │ stdio JSON
   (terminal)    │                                              ▼
                 │                       ┌─ Playwright sidecar (child process) ─┐
                 └───────────────────────┤  headless Chromium; goto/screenshot/ │
                                         │  click; console + network capture    │
                                         └──────────────────────────────────────┘
```

A `navigate` updates the pane **and** the Playwright page in the same handler — always in sync, no lockfile/discovery. The pane shows real DOM (humans read/select); Playwright is the AI's surface (screenshots + inspection); both render the same URL.

**Why this shape?** VSCode 1.126 routes the built-in Simple Browser to a new "integrated browser" that opens a fresh tab per programmatic navigation, and you can't screenshot a VSCode pane. So we render docs in our own webview and use a co-located headless Chromium for pixels.

## Requirements

- Node.js ≥ 20 (developed on 25), VSCode ≥ 1.101, Claude Code.
- A Chromium build for `playwright-core` (the shared `~/Library/Caches/ms-playwright` cache; downloaded on demand if missing).

## Setup

```bash
npm install          # installs deps (extension workspace)
npm run build        # esbuild → extension/dist/extension.js + dist/sidecar/main.js
npm run install:ext  # builds + sideloads into ~/.vscode/extensions, carrying playwright-core
```

Then **Developer: Reload Window** in VSCode to activate. (Re-run `npm run install:ext` + reload after editing the extension — the installed copy is a snapshot.)

Alternative install: `npm run package:ext` → `extension/docs-browser-extension.vsix` → Extensions view → Install from VSIX (remove any sideloaded copy first).

## Connect Claude Code

`.mcp.json` (project scope) points Claude Code at the extension-hosted server:

```json
{ "mcpServers": { "docs-browser": { "type": "http", "url": "http://127.0.0.1:8765/mcp" } } }
```

The extension activates on VSCode startup and binds `127.0.0.1:8765` (configurable via `docsBrowser.mcpPort`). Start Claude Code in this folder and approve the server. If the tools show "failed" (e.g. Claude Code started before the extension was listening), run `/mcp` to reconnect — the server is **stateless**, so it recovers across VSCode reloads.

## Usage

- **Activity Bar → Docs Browser**: an "Open Docs Browser" button + a clickable page list + Open/Refresh.
- **Command Palette**: `Docs Browser: Open`, `Docs Browser: Refresh`.
- **From Claude**: navigate/screenshot/etc.; the pane mirrors what Claude does.

### MCP tools

| Tool | Purpose |
|---|---|
| `open_docs` / `navigate` | Open/go to a page (mirrors to the pane) |
| `back` / `forward` / `reload` | History + reload |
| `screenshot` | PNG (`fullPage`, `selector`, `savePath`) |
| `get_page_title` | `{title, url}` — confirm where you landed |
| `get_page_text` / `get_links` | Rendered text / link graph |
| `list_pages` | HTML files in the docs dir |
| `read_console` | JS errors/warnings on the current page |
| `read_network` | Failed / 4xx / 5xx requests (broken assets) |
| `check_links` | Crawl internal links → broken targets + orphan pages |
| `click` | Click by selector or text (pane follows) |
| `pane_state` | Pane URL + preflight status + recent webview events (sync/debug) |

### Settings

- `docsBrowser.docsDir` (default `docs`) — directory of generated HTML to serve.
- `docsBrowser.mcpPort` (default `8765`) — fixed MCP port (strict; fails loudly on conflict).

## Layout

```
extension/
  src/        types.ts (contracts), extension.ts, tools.ts, mcpServer.ts,
              paneController.ts, browserClient.ts, docsServer.ts, checkLinks.ts
  sidecar/    main.ts          # Playwright child process
  test/       *.mjs + integration.ts   # standalone module + integration tests
  build.mjs   # esbuild (extension + sidecar)
docs/         # sample docs (replace with your generated output)
.mcp.json     # Claude Code MCP registration (http)
scripts/install-extension.sh
```

## Tests

- Module tests: `node extension/test/{sidecar,pane,mcp,docs}.mjs`
- Full pipeline (headless, real Chromium + MCP HTTP client): `node extension/run-integration.mjs`

## Notes & caveats

- **MCP over HTTP**: if Claude Code starts before the extension is listening, reconnect via `/mcp`. Stateless transport handles VSCode reloads.
- **Pane**: VSCode find-in-page (Cmd+F) may not reach inside the cross-origin iframe; keyboard focus inside the iframe can swallow some VSCode shortcuts/copy.
- **Sidecar**: owned by the extension; group-killed on `deactivate` so Chromium doesn't orphan.
- **Multi-window**: a second VSCode window contends for the fixed MCP port (strict → fails loudly); single-window assumed.
```
