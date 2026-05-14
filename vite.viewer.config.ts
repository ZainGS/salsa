import { defineConfig } from 'vite';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/viewer/index.ts'),
      formats: ['es'],
      fileName: 'viewer',
    },
    outDir: 'dist-viewer',
    rollupOptions: {
      // Bundle everything — gl-matrix, fflate, and the Salsa renderer all inline.
      external: [],
    },
    target: 'chrome113',
    minify: true,
  },
});
