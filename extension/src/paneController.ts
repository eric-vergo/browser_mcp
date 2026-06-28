import * as vscode from "vscode";
import type { CreatePaneController, PaneController, PaneState } from "./types";

// ───────────────────────── paneController.ts ─────────────────────────
// ONE custom webview panel that renders generated docs inside a localhost <iframe>.
// The iframe is REAL, selectable DOM served by docsServer (a separate same-machine
// origin), and we navigate it IN PLACE via postMessage. This deliberately replaces the
// VSCode 1.126 built-in Simple Browser, which opens a brand-new editor tab on every
// navigation instead of reusing the existing pane.
//
// KNOWN CAVEATS (cross-origin iframe inside a webview):
//   - VSCode find-in-page (Cmd+F / Ctrl+F) will almost certainly NOT reach text inside
//     the iframe: it is a separate, cross-origin browsing context and the editor's find
//     widget only sees the webview's own (essentially empty) document.
//   - While focus is inside the iframe, the inner document can swallow some VSCode
//     keyboard shortcuts and the native copy/paste path may route through the iframe
//     rather than the editor. Selection + Cmd/Ctrl+C generally works because it is the
//     iframe's own DOM, but editor-level chords are not guaranteed to bubble out.
//   - window.onerror wired below belongs to the WEBVIEW document, not the iframe. Errors
//     thrown by the doc page itself live in the cross-origin iframe and are NOT visible
//     here; this only surfaces failures in our own bootstrap script.

/** Exact origin of an absolute URL. 127.0.0.1 and localhost are DIFFERENT origins. */
function originOf(absoluteUrl: string): string {
  return new URL(absoluteUrl).origin;
}

/** 32-char cryptographically-arbitrary nonce for the inline <script>. */
export function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/** Escape a string for safe interpolation into a double-quoted HTML attribute. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * PURE: build the webview HTML for the docs pane. No VSCode/runtime dependencies so it
 * is unit-testable in plain node.
 *   cspSource   - panel.webview.cspSource (used for style-src so VSCode can inject styles)
 *   frameOrigin - exact origin allowed in frame-src/connect-src (= origin of the doc URL)
 *   nonce       - per-load nonce; the ONLY script allowed to run
 *   initialUrl  - the URL the iframe loads on first paint (set as an attribute so the
 *                 first navigation cannot be lost to a webview-not-ready postMessage race)
 */
export function buildHtml(
  cspSource: string,
  frameOrigin: string,
  nonce: string,
  initialUrl: string,
): string {
  const csp =
    `default-src 'none'; ` +
    `style-src ${cspSource} 'unsafe-inline'; ` +
    `script-src 'nonce-${nonce}'; ` +
    `frame-src ${frameOrigin}; ` +
    `connect-src ${frameOrigin};`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Docs</title>
  <style nonce="${nonce}">
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: #fff; }
    #f { border: 0; width: 100%; height: 100vh; display: block; }
  </style>
</head>
<body>
  <iframe id="f" src="${escapeAttr(initialUrl)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const f = document.getElementById("f");
      // Last URL we were asked to show (without any cache-bust query we appended).
      let currentUrl = ${JSON.stringify(initialUrl)};

      function cacheBust(u) {
        // Drop any prior ?v=/&v= we added, then append a fresh one.
        const stripped = u.replace(/([?&])v=\\d+(&|$)/, function (_m, p1, p2) {
          return p2 === "&" ? p1 : (p1 === "?" ? "" : "");
        });
        return stripped + (stripped.indexOf("?") >= 0 ? "&" : "?") + "v=" + Date.now();
      }

      f.addEventListener("load", function () {
        vscode.postMessage({ type: "loaded", msg: currentUrl });
      });

      window.onerror = function (message) {
        vscode.postMessage({ type: "error", msg: String(message) });
        return false;
      };

      window.addEventListener("message", function (event) {
        const m = event.data || {};
        if (m.type === "navigate" && typeof m.url === "string") {
          // Only (re)assign src when the target actually changes. On first show the host
          // posts a navigate for the SAME url the iframe already loaded via its src
          // attribute; re-setting src would trigger a redundant second load. (To force a
          // refresh of the same url, use reload.)
          if (m.url !== currentUrl) {
            f.src = m.url;
          }
          currentUrl = m.url;
        } else if (m.type === "reload") {
          f.src = cacheBust(currentUrl);
        }
      });
    })();
  </script>
</body>
</html>`;
}

export const createPaneController: CreatePaneController = (
  context: vscode.ExtensionContext,
): PaneController => {
  let panel: vscode.WebviewPanel | undefined;

  const state: PaneState = {
    panelExists: false,
    events: [],
  };

  function pushEvent(type: string, msg: string): void {
    state.events.push({ t: Date.now(), type, msg });
    if (state.events.length > 50) state.events.shift();
  }

  async function show(absoluteUrl: string): Promise<void> {
    // (1) Host-side preflight: an authoritative status from the extension host itself,
    //     independent of whatever the webview iframe ends up doing. 2s hard cap.
    try {
      const res = await fetch(absoluteUrl, { signal: AbortSignal.timeout(2000) });
      state.preflightStatus = res.status;
      pushEvent("preflight", `${res.status} ${absoluteUrl}`);
    } catch (err) {
      state.preflightStatus = 0;
      pushEvent("preflight-error", `${absoluteUrl} ${err instanceof Error ? err.message : String(err)}`);
    }

    // (2) Create the panel once; otherwise just reveal it (preserving focus).
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "docsBrowser",
        "Docs",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = buildHtml(
        panel.webview.cspSource,
        originOf(absoluteUrl),
        getNonce(),
        absoluteUrl,
      );
      panel.webview.onDidReceiveMessage((m: { type?: unknown; msg?: unknown }) => {
        const type = typeof m?.type === "string" ? m.type : "unknown";
        const msg = typeof m?.msg === "string" ? m.msg : "";
        pushEvent(type, msg);
        if (type === "loaded") state.webviewLoaded = true;
      });
      panel.onDidDispose(() => {
        panel = undefined;
        state.panelExists = false;
      });
      state.panelExists = true;
      context.subscriptions.push(panel);
    } else {
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, true);
    }

    // (3) Navigate in place. On first show this targets the same URL the iframe already
    //     loaded via its src attribute (a no-op re-set); on later shows it changes pages.
    panel.webview.postMessage({ type: "navigate", url: absoluteUrl }).then(undefined, () => {});
    state.requestedUrl = absoluteUrl;
  }

  async function reload(): Promise<void> {
    if (panel) {
      panel.webview.postMessage({ type: "reload" }).then(undefined, () => {});
    }
  }

  function getState(): PaneState {
    // Defensive copy so callers cannot mutate our internal state (incl. the events array).
    return {
      panelExists: state.panelExists,
      requestedUrl: state.requestedUrl,
      preflightStatus: state.preflightStatus,
      webviewLoaded: state.webviewLoaded,
      events: state.events.map((e) => ({ ...e })),
    };
  }

  function dispose(): void {
    panel?.dispose();
    panel = undefined;
    state.panelExists = false;
  }

  return { show, reload, state: getState, dispose };
};
