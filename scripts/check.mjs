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
//         --changed[=REF]   while WORKING: lint only the changed files and run only the tests that import them
//                           (`vitest related`, through the module graph — city tests don't run for a 2D change).
//                           Changed = uncommitted + untracked vs HEAD (or vs REF, e.g. --changed=origin/main).
//                           A change to config / package files runs the whole suite. Run the FULL check before
//                           committing — `--changed` misses tests that read files at runtime instead of importing.
//                           Slow test files far from the change are skipped too (see slowTestsToSkip).
//         --steps=a,b       run only these steps (names above)
//         --bail            stop at the first failing step (default: run everything, then summarise)
// Every step runs even if an earlier one failed, so one run shows every problem. Exit 1 if any step failed.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const bail = args.includes('--bail');
const stepsArg = args.find((a) => a.startsWith('--steps='));
const only = stepsArg ? new Set(stepsArg.slice('--steps='.length).split(',')) : null;
const changedArg = args.find((a) => a === '--changed' || a.startsWith('--changed='));

const ESLINT = 'tools/lint/node_modules/eslint/bin/eslint.js';
const TSC = 'node_modules/typescript/bin/tsc';
const VITEST = 'node_modules/vitest/vitest.mjs';
const WGSL_TEST = 'src/renderer/3d/wgsl-static-check.test.ts';

/** --changed: the changed files (repo-relative, forward slashes) and whether the change is global (config). */
function changedFiles() {
  const ref = changedArg && changedArg.includes('=') ? changedArg.slice('--changed='.length) : 'HEAD';
  const git = (a) => (spawnSync('git', a, { encoding: 'utf8' }).stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const files = [...new Set([...git(['diff', '--name-only', ref]), ...git(['ls-files', '--others', '--exclude-standard'])])]
    .filter((f) => existsSync(f));
  const global = files.some((f) => /^(package(-lock)?\.json|tsconfig[^/]*\.json|vitest\.config\.\w+|vite\.config\.\w+)$/.test(f));
  return { files, global };
}
const changed = changedArg ? changedFiles() : null;
const changedSrc = changed ? changed.files.filter((f) => /^src\/.*\.(ts|tsx|js|mjs|wgsl)$/.test(f)) : [];
const changedLintable = changed ? changed.files.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f)) : [];

// Per-file test timings, recorded by every FULL test run (vitest's json reporter). `--changed` uses them to skip the
// slowest test files (city / crowd / vehicle builds, character-v2 garments, cloth …) unless the test file itself or a
// similarly named file in its folder changed — central files (shape-manager.ts …) otherwise pull them in on every run. The full check
// before a commit still runs everything. SLOW_TEST_MS tunes the cut-off.
const TIMINGS_FILE = 'node_modules/.cache/salsa-test-timings.json';
const SLOW_TEST_MS = Number(process.env.SLOW_TEST_MS || 5000);

/** Test files (repo-relative) that took longer than SLOW_TEST_MS in the last full run, minus the ones near a change. */
function slowTestsToSkip() {
  let data;
  try { data = JSON.parse(readFileSync(TIMINGS_FILE, 'utf8')); } catch { return []; }
  const root = process.cwd().replace(/\\/g, '/').replace(/\/?$/, '/').toLowerCase(); // Git Bash may give `c:`
  // "near" = same folder AND same first name word (clothing-fit.ts keeps clothing-regression.test.ts; scene3d-manager.ts
  // doesn't keep skirt-leg-follow.test.ts — big folders like services/managers would otherwise keep everything)
  const near = (f) => { const i = f.lastIndexOf('/'); return f.slice(0, i + 1) + f.slice(i + 1).split(/[-.]/)[0]; };
  const changedNear = new Set(changedSrc.map(near));
  const out = [];
  for (const r of data.testResults || []) {
    const ms = (r.endTime || 0) - (r.startTime || 0);
    if (!(ms > SLOW_TEST_MS) || typeof r.name !== 'string') continue;
    const abs = r.name.replace(/\\/g, '/');
    const rel = abs.toLowerCase().startsWith(root) ? abs.slice(root.length) : abs;
    if (changedSrc.includes(rel) || changedNear.has(near(rel))) continue;
    out.push(rel);
  }
  return out;
}
const slowSkipped = changed && !changed.global ? slowTestsToSkip() : [];

function testCmd() {
  if (!changed || changed.global) {
    // full run: also record per-file timings for --changed (json reporter alongside the normal one)
    return [VITEST, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${TIMINGS_FILE}`];
  }
  // vitest related: the given files' own tests + every test that imports them (transitively), minus slow files
  // far from the change (see slowTestsToSkip)
  return [VITEST, 'related', '--run', '--passWithNoTests', ...slowSkipped.map((f) => `--exclude=${f}`), ...changedSrc];
}
function lintCmd() {
  const base = ['--quiet', '--pass-on-unpruned-suppressions'];
  if (!changed || changed.global) return [ESLINT, '.', ...base];
  return [ESLINT, ...base, '--no-warn-ignored', ...changedLintable];
}

const steps = [
  { name: 'sanity', cmd: ['scripts/check-source-sanity.mjs'] },
  { name: 'typecheck', cmd: [TSC, '--noEmit', '-p', '.'] },
  {
    // --quiet: errors only (warn-level rules are skipped, which is also faster). `npm run lint` shows the warnings.
    // --pass-on-unpruned-suppressions: fixing a baselined error (or --fast skipping a type-aware one) must not fail.
    name: 'lint', cmd: lintCmd(),
    env: fast ? { LINT_NO_TYPES: '1' } : {},
    pre: () => existsSync(ESLINT) || 'lint toolchain not installed: run `npm run lint:install` (npm ci in tools/lint)',
    skip: () => changed && !changed.global && changedLintable.length === 0 && 'no changed lintable files',
  },
  { name: 'wgsl', cmd: [VITEST, 'run', WGSL_TEST], when: () => fast || (only && only.has('wgsl')) },
  {
    name: 'test', cmd: testCmd(), when: () => !fast,
    skip: () => changed && !changed.global && changedSrc.length === 0 && 'no changed source files',
  },
];
if (changed) {
  console.log(changed.global
    ? '--changed: a config / package file changed → full lint + full test suite'
    : `--changed: ${changedSrc.length} changed source file(s) → lint those + only the tests that import them`
      + (slowSkipped.length ? ` (skipping ${slowSkipped.length} slow test file(s) far from the change; the full check runs them)` : ''));
}

const results = [];
for (const step of steps) {
  if (only ? !only.has(step.name) : step.when && !step.when()) continue;
  console.log(`\n=== ${step.name} ${'='.repeat(Math.max(0, 70 - step.name.length))}`);
  const t0 = Date.now();
  let ok;
  const skipped = step.skip ? step.skip() : false;
  const pre = step.pre ? step.pre() : true;
  if (skipped) {
    console.log(`skipped: ${skipped}`);
    ok = true;
  } else if (pre !== true) {
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
