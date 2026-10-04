#!/usr/bin/env node
// `npm run check`: every automated check in one command, the same thing CI runs (docs/dev/checks-and-ci.md).
//
//   sanity     scripts/check-source-sanity.mjs: 0-byte files, BOM, mixed line endings, mojibake
//   typecheck  tsc --noEmit (TypeScript 7 native)
//   lint       ESLint (tools/lint toolchain; type-aware unless --fast)
//   wgsl       the WGSL static check test (only as its own step in --fast mode; the full test run includes it)
//   test       vitest run (whole suite)
//
// Flags:  --fast            sanity + typecheck + lint without type info + wgsl; no full test run (pre-commit use)
//         --steps=a,b       run only these steps (names above)
//         --bail            stop at the first failing step (default: run everything, then summarise)
// Every step runs even if an earlier one failed, so one run shows every problem. Exit 1 if any step failed.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const bail = args.includes('--bail');
const stepsArg = args.find((a) => a.startsWith('--steps='));
const only = stepsArg ? new Set(stepsArg.slice('--steps='.length).split(',')) : null;

const ESLINT = 'tools/lint/node_modules/eslint/bin/eslint.js';
const TSC = 'node_modules/typescript/bin/tsc';
const VITEST = 'node_modules/vitest/vitest.mjs';
const WGSL_TEST = 'src/renderer/3d/wgsl-static-check.test.ts';

const steps = [
  { name: 'sanity', cmd: ['scripts/check-source-sanity.mjs'] },
  { name: 'typecheck', cmd: [TSC, '--noEmit', '-p', '.'] },
  {
    // --quiet: errors only (warn-level rules are skipped, which is also faster). `npm run lint` shows the warnings.
    // --pass-on-unpruned-suppressions: fixing a baselined error (or --fast skipping a type-aware one) must not fail.
    name: 'lint', cmd: [ESLINT, '.', '--quiet', '--pass-on-unpruned-suppressions'],
    env: fast ? { LINT_NO_TYPES: '1' } : {},
    pre: () => existsSync(ESLINT) || 'lint toolchain not installed: run `npm run lint:install` (npm ci in tools/lint)',
  },
  { name: 'wgsl', cmd: [VITEST, 'run', WGSL_TEST], when: () => fast || (only && only.has('wgsl')) },
  { name: 'test', cmd: [VITEST, 'run'], when: () => !fast },
];

const results = [];
for (const step of steps) {
  if (only ? !only.has(step.name) : step.when && !step.when()) continue;
  console.log(`\n=== ${step.name} ${'='.repeat(Math.max(0, 70 - step.name.length))}`);
  const t0 = Date.now();
  let ok;
  const pre = step.pre ? step.pre() : true;
  if (pre !== true) {
    console.error(pre);
    ok = false;
  } else {
    const r = spawnSync(process.execPath, step.cmd, {
      stdio: 'inherit',
      env: { ...process.env, ...(step.env || {}) },
    });
    ok = r.status === 0;
  }
  results.push({ name: step.name, ok, secs: ((Date.now() - t0) / 1000).toFixed(1) });
  if (!ok && bail) break;
}

console.log('\n=== summary ' + '='.repeat(62));
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(10)} ${r.secs}s`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\ncheck: ${failed.length} step(s) failed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log('\ncheck: all passed');
