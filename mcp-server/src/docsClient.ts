import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { startStaticServer, type StaticServer } from "./staticServer.js";

export interface DocsTarget {
  /** http://127.0.0.1:PORT — no trailing slash. */
  baseUrl: string;
  /** Base for the extension's /__control__/* endpoint, if the pane is available. */
  controlUrl?: string;
}

export function workspaceRoot(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function docsDir(): string {
  return process.env.DOCS_DIR || path.join(workspaceRoot(), "docs");
}

/**
 * Lockfile the VSCode extension writes when it starts serving docs. Both sides
 * derive the same path from the workspace root, so the MCP server can discover
 * the extension's base/control URL without configuration.
 */
export function lockfilePath(): string {
  const hash = crypto
    .createHash("sha1")
    .update(path.resolve(workspaceRoot()))
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), "docs-browser", `${hash}.json`);
}

interface Lockfile {
  baseUrl: string;
  port: number;
}

function readLockfile(): Lockfile | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(lockfilePath(), "utf8")) as Lockfile;
    if (data && typeof data.baseUrl === "string") return data;
  } catch {
    // not present / unreadable — extension isn't running
  }
  return undefined;
}

let fallback: StaticServer | undefined;

/**
 * Resolve where docs live, re-checked each call so a late-started extension is
 * picked up. Priority: explicit DOCS_CONTROL_URL env > extension lockfile >
 * our own fallback static server (started once, reused).
 */
export async function resolveDocsTarget(): Promise<DocsTarget> {
  const envUrl = process.env.DOCS_CONTROL_URL;
  if (envUrl) {
    const baseUrl = envUrl.replace(/\/+$/, "");
    return { baseUrl, controlUrl: baseUrl };
  }

  const lf = readLockfile();
  if (lf) {
    const baseUrl = lf.baseUrl.replace(/\/+$/, "");
    return { baseUrl, controlUrl: baseUrl };
  }

  if (!fallback) {
    fallback = await startStaticServer(docsDir());
  }
  return { baseUrl: fallback.baseUrl };
}

export async function closeFallback(): Promise<void> {
  const f = fallback;
  fallback = undefined;
  await f?.close();
}

/** Resolve a target (relative path or absolute in-site URL) against the base URL. */
export function resolveUrl(baseUrl: string, target: string): { fullUrl: string; urlPath: string } {
  const root = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const u = new URL(target, root);
  return { fullUrl: u.toString(), urlPath: u.pathname + u.search + u.hash };
}

/** Best-effort pane sync: tell the extension to show/reload a path. No-op without a control URL. */
export async function paneSync(
  controlUrl: string | undefined,
  action: "show" | "reload",
  urlPath?: string,
): Promise<void> {
  if (!controlUrl) return;
  try {
    await fetch(`${controlUrl}/__control__/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "show" ? { path: urlPath } : {}),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // extension may be down; pane sync is best-effort
  }
}
