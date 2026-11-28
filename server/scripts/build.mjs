import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const workspace = {
  name: "pi-bot-workspace",
  setup(build) {
    build.onResolve({ filter: /^@pi-bot\/generative-ui$/ }, () => ({ path: resolve(root, 'packages/generative-ui/src/catalog.generated.ts') }));
    build.onResolve({ filter: /^@pi-bot\/agent\/images$/ }, () => ({ path: resolve(root, 'packages/agent/src/images.ts') }));
    build.onResolve({filter:/^zod$/}, args => args.importer.replaceAll('\\','/').includes("packages/a2ui/") ? {path:createRequire(resolve(root,"packages/a2ui/package.json")).resolve("zod")} : undefined);
    build.onResolve({ filter: /^@pi-bot\/(agent|bot-face|a2ui|runtime-contracts)$/ }, (args) => ({
      path: resolve(root, "packages", args.path.split("/")[1], "src/index.ts"),
    }));
  },
};
await build({
  entryPoints: {main:"src/main.ts", worker:"src/worker.ts", runner:"src/runner.ts", "document-worker":"../packages/agent/src/documents/document-worker.ts"},
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

await build({entryPoints:["src/report-viewer.tsx"],outfile:"dist/report-viewer.js",bundle:true,platform:"browser",format:"esm",target:"es2022",minify:true,loader:{".woff2":"file",".woff":"file",".ttf":"file"},assetNames:"markdown-assets/[name]"});

await mkdir("dist/licenses",{recursive:true});
await cp(resolve(root,"packages/markdown/licenses"),"dist/licenses",{recursive:true});
