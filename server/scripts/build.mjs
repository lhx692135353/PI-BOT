import { build } from "esbuild";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const workspace = {
  name: "pi-bot-workspace",
  setup(build) {
    build.onResolve({ filter: /^@pi-bot\/agent\/images$/ }, () => ({ path: resolve(root, 'packages/agent/src/images.ts') }));
    build.onResolve({filter:/^zod$/}, args => args.importer.includes("packages/a2ui/") ? {path:createRequire(resolve(root,"packages/a2ui/package.json")).resolve("zod")} : undefined);
    build.onResolve({ filter: /^@pi-bot\/(agent|bot-face|a2ui|runtime-contracts)$/ }, (args) => ({
      path: resolve(root, "packages", args.path.split("/")[1], "src/index.ts"),
    }));
  },
};
await build({
  entryPoints: ["src/main.ts", "src/worker.ts", "src/runner.ts"],
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  plugins: [workspace],
  sourcemap: true,
});

await build({entryPoints:["src/report-viewer.tsx"],outfile:"dist/report-viewer.js",bundle:true,platform:"browser",format:"esm",target:"es2022",minify:true});
