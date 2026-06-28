# Docs Browser (VSCode extension)

Serves a directory of generated HTML documentation over a local server and displays it in VSCode's built-in **Simple Browser**, with an Activity Bar view (launch button + page list) and a `/__control__` endpoint so the companion `docs-browser` MCP server can drive the pane.

See the repository README (top level of the `browser_mcp` project) for full setup, install, and usage.

## Commands

- **Docs Browser: Open** — open the docs in the Simple Browser pane
- **Docs Browser: Refresh** — reload the current page

## Settings

- `docsBrowser.docsDir` (default `docs`) — docs directory to serve
- `docsBrowser.baseUrl` — use an existing docs server instead of the built-in one
- `docsBrowser.controlPort` (default `0`) — port for the docs/control server
