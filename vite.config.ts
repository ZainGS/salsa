import { defineConfig } from "vite";
import * as path from "path";
import { fileURLToPath } from "url";
import dts from "vite-plugin-dts";

// Fix `__dirname` for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  },
  plugins: [dts({ insertTypesEntry: true })]
});