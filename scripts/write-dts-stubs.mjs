// Post-build: re-create the top-level entry .d.ts forwarding files that
// vite-plugin-dts used to synthesize (we dropped the plugin so nothing in the
// Vite path imports the TypeScript compiler API — which is what blocks TS7).
//
// `tsc --emitDeclarationOnly` emits declarations mirroring src/, so
// src/services/shape-manager.ts -> dist/services/shape-manager.d.ts. But the
// package.json "exports" advertise those entries at the dist ROOT (next to the
// top-level JS bundles Vite emits), e.g. "./shape-manager" -> dist/shape-manager.d.ts.
// These 3-line stubs bridge the published path to the real emitted declarations,
// keeping the dist/ layout byte-identical to the old plugin output so nothing
// downstream (Frogmarks) changes.
//
// `main` needs no stub: src/main.ts is already at the source root, so tsc emits
// dist/main.d.ts at the top level directly.
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// published entry name -> path of the real emitted .d.ts (relative to dist, no extension)
const STUBS = {
  'shape-manager': './services/shape-manager',
  'world-manager': './services/world-manager',
};

for (const [name, target] of Object.entries(STUBS)) {
  const body = `export * from '${target}';\nexport { default } from '${target}';\n`;
  writeFileSync(resolve(dist, `${name}.d.ts`), body, 'utf8');
  console.log(`[dts-stubs] wrote dist/${name}.d.ts -> ${target}`);
}
