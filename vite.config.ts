import { defineConfig } from "vite";
import * as path from "path";
import { fileURLToPath } from "url";

// Fix `__dirname` for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NOTE: declaration (.d.ts) generation is handled by the `tsc` step in the
// `build` script (emitDeclarationOnly) plus scripts/write-dts-stubs.mjs — NOT by
// a Vite plugin. vite-plugin-dts imported the TypeScript compiler API in-process,
// which TS7 (native/tsgo) removed; keeping it out of the Vite path lets us use
// any TypeScript version, TS7 included. Vite here only bundles JS (via esbuild).
export default defineConfig({
  build: {
    lib: {
      entry: {
        main: path.resolve(__dirname, "src/main.ts"),
        "shape-manager": path.resolve(__dirname, "src/services/shape-manager.ts"),
        "world-manager": path.resolve(__dirname, "src/services/world-manager.ts")
      },
      name: "Salsa",
      fileName: (format, entryName) => `${entryName}.${format}.js`,
      formats: ["es", "cjs"]
    },
    rollupOptions: {
      external: ["gl-matrix", "@webgpu/types"], // Mark dependencies as external
      output: {
        exports: "named",
        globals: {
          "gl-matrix": "glMatrix"
        }
      }
    }
  }
});
