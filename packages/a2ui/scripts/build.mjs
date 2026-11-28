import { build } from "vite";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  root: root + "web",
  base: "./",
  configFile: false,
  build: {
    outDir: root + "dist",
    emptyOutDir: true,
    target: "es2020",
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: "renderer.js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});

// Ship dependency licenses with every native/web bundle; debug fixtures have no page route.
await mkdir(resolve(root,"dist/licenses"),{recursive:true});
await cp(resolve(root,"../markdown/licenses"),resolve(root,"dist/licenses"),{recursive:true});
await cp(resolve(root,"../markdown/tests/native-smoke.js"),resolve(root,"dist/math-smoke.js"));
await cp(resolve(root,"../markdown/fixtures/smoke.json"),resolve(root,"dist/math-smoke.json"));
