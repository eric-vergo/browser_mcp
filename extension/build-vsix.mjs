// Build a distributable .vsix.
//
// The extension code is esbuild-bundled (SDK + zod inlined into dist/extension.js), so the ONLY
// runtime node_modules dependency is playwright-core, which the sidecar bundle keeps external (it
// does dynamic requires + resolves its browser registry relative to its install dir, so it must
// not be bundled). `vsce package --no-dependencies` skips node_modules entirely, so we inject
// playwright-core into the resulting .vsix afterwards: a .vsix is a plain zip, and VSCode extracts
// the whole `extension/` subtree on install, so files added under `extension/node_modules/...`
// land in the installed extension dir where the sidecar's `require('playwright-core')` resolves.
//
// Requires the `zip` CLI on the BUILD machine (macOS/Linux have it). End users only install the
// finished .vsix and need nothing extra. Chromium itself is fetched on first run (see ensureChromium).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(EXT, "..");
const VSIX = path.join(EXT, "docs-browser-extension.vsix");

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${path.basename(cmd)} ${args.join(" ")} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

// 1. Bundle extension host + sidecar.
run(process.execPath, [path.join(EXT, "build.mjs")], EXT);

// 2. Package the bundle (no node_modules — injected next).
const vsce = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
run(vsce, ["package", "--no-dependencies", "--allow-missing-repository", "-o", VSIX], EXT);

// 3. Inject playwright-core into the .vsix under extension/node_modules/playwright-core.
const src = path.join(ROOT, "node_modules", "playwright-core");
if (!fs.existsSync(src)) {
  console.error(`playwright-core not found at ${src}. Run \`npm install\` at the repo root first.`);
  process.exit(1);
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dcb-vsix-"));
try {
  const nm = path.join(stage, "extension", "node_modules", "playwright-core");
  fs.mkdirSync(path.dirname(nm), { recursive: true });
  fs.cpSync(src, nm, { recursive: true });
  // cwd=stage so archive entries are "extension/node_modules/playwright-core/..."
  run("zip", ["-rqX", VSIX, "extension/node_modules"], stage);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
console.log(`\nwrote ${path.relative(ROOT, VSIX)} (with playwright-core injected)`);
