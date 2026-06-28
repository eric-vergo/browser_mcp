// Run from the repo root: `node extension/run-integration.mjs`
import { build } from "esbuild";
import { spawnSync } from "node:child_process";

await build({
  entryPoints: ["extension/test/integration.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["playwright-core"],
  outfile: "/tmp/dcb-integ.cjs",
  sourcemap: "inline",
});

const r = spawnSync(process.execPath, ["/tmp/dcb-integ.cjs"], { stdio: "inherit" });
process.exit(r.status ?? 1);
