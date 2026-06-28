import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "cjs", target: "node20", sourcemap: true, logLevel: "info" };

// Extension host: bundle our code + the ESM MCP SDK + zod into one CJS file; only `vscode` is external.
await build({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
});

// Playwright sidecar: standalone child process. Keep playwright-core external (it resolves its
// browser registry relative to its install dir and does dynamic requires — must not be bundled).
await build({
  ...common,
  entryPoints: ["sidecar/main.ts"],
  outfile: "dist/sidecar/main.js",
  external: ["playwright-core"],
});

console.log("build complete: dist/extension.js, dist/sidecar/main.js");
