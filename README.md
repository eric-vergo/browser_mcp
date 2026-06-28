# browser_mcp — VSCode docs viewer + MCP browser control

View auto-generated, self-contained HTML documentation inside VSCode's built-in **Simple Browser**, and let Claude (via the [Model Context Protocol](https://modelcontextprotocol.io)) **navigate** and **screenshot** those same pages while you work from the integrated terminal.

It's two cooperating pieces that share one `localhost` URL:

```
                 ┌──────────────────────── VSCode ───────────────────────────┐
                 │  Extension (extension host)                                 │
   you ◀─ view ──┤   • serves the docs dir + /__control__ endpoint (one server)│
                 │   • Activity Bar "Docs Browser": launch button + page list  │
                 │   • opens/refreshes the Simple Browser pane                  │
                 │   • file watcher → auto-refresh; writes a discovery lockfile │
                 └───────────────▲────────────────────────────────────────────┘
                                 │ pane-sync (HTTP)            ▲ same URL
   Claude ◀─ tools ─ MCP server (node, via .mcp.json) ────────┘
                       • one persistent headless Chromium (Playwright)
                       • navigate / screenshot / get_page_text / get_links / …
```

**Why two pieces?** Only a VSCode *extension* can open the Simple Browser, and VSCode has **no API to screenshot a webview's rendered content**. So screenshots come from a headless Chromium rendering the *same URL* — pixel-equivalent for static docs. A `navigate` call moves both the headless page and your VSCode pane together.

## Requirements

- Node.js ≥ 18 (developed on 25)
- VSCode ≥ 1.101
- [Claude Code](https://code.claude.com/docs/en/mcp)

## Setup

```bash
npm install        # installs deps; postinstall fetches the Playwright Chromium binary (~170 MB)
npm run build      # compiles the MCP server and the extension
```

## Install the VSCode extension

**Option A — sideload (scripted):**

```bash
npm run install:ext     # builds + copies into ~/.vscode/extensions, then asks you to reload
```

Then run **Developer: Reload Window** in VSCode. Re-run this whenever you change the extension's source (the installed copy is a snapshot).

**Option B — package a `.vsix`:**

```bash
npm run package:ext     # produces extension/docs-browser-extension.vsix
```

In VSCode: Extensions view → `⋯` menu → **Install from VSIX…** → pick the file. (If you previously sideloaded, remove `~/.vscode/extensions/local.docs-browser-extension-*` first to avoid a duplicate.)

## Connect the MCP server to Claude Code

`.mcp.json` (project scope) is already present:

```json
{
  "mcpServers": {
    "docs-browser": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/mcp-server/dist/index.js"],
      "env": { "DOCS_DIR": "${CLAUDE_PROJECT_DIR:-.}/docs" },
      "timeout": 600000
    }
  }
}
```

Start (or restart) Claude Code in this folder and **approve** the `docs-browser` server when prompted (`/mcp` shows status). Point `DOCS_DIR` (here) and the `docsBrowser.docsDir` setting (extension) at your real generated-docs directory; both default to `docs/` (a sample set ships in this repo).

## Usage

- **Activity Bar → Docs Browser**: click the document icon for a panel with an **Open Docs Browser** button, a clickable **page list**, and **Open/Refresh** title-bar buttons.
- **Command Palette**: `Docs Browser: Open`, `Docs Browser: Refresh`.
- **From Claude**: e.g. *"navigate to api/strings.html and screenshot it"* — the pane follows, and Claude captures the same page. The page list and pane auto-refresh when docs regenerate.

### MCP tools

| Tool | Args | Purpose |
|---|---|---|
| `open_docs` | `path?` | Open docs (defaults to the home page) |
| `navigate` | `path` | Go to a page (relative path or in-site URL); moves the pane too |
| `screenshot` | `fullPage?`, `savePath?` | PNG of the current page (viewport by default; `savePath` also writes it to disk) |
| `get_page_text` | — | Rendered visible text |
| `get_links` | — | Anchor text + resolved hrefs (the doc graph) |
| `list_pages` | — | HTML files under the docs dir |
| `reload` | — | Reload current page (after regen) |
| `back` / `forward` | — | History navigation |

### Extension settings

| Setting | Default | Meaning |
|---|---|---|
| `docsBrowser.docsDir` | `docs` | Docs directory (relative to workspace, or absolute) |
| `docsBrowser.baseUrl` | `""` | Use an existing docs server instead of the built-in one (control-only mode) |
| `docsBrowser.controlPort` | `0` | Port for the docs/control server (`0` = ephemeral) |

## Notes & caveats

- **Screenshots are a headless render of the same URL**, not the literal pane pixels — equivalent for static docs (the only feasible approach; VSCode exposes no webview capture API).
- **Token budget:** MCP image output counts against `MAX_MCP_OUTPUT_TOKENS` (default 25k). Screenshots default to the viewport; `fullPage` on long pages can be large — raise the limit if needed.
- **Remote dev:** the extension wraps URLs in `vscode.env.asExternalUri`, so it works under Remote-SSH / Codespaces port forwarding.
- **One Simple Browser pane:** Claude's navigation retargets your single pane (by design).

## Layout

```
mcp-server/   MCP stdio server (Playwright headless browser, tools)
extension/    VSCode extension (docs+control server, Simple Browser pane, Activity Bar view)
docs/         sample docs (replace with your generated output)
scripts/      install-extension.sh (sideload helper)
.mcp.json     Claude Code MCP registration
```
