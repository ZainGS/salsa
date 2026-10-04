// ESLint flat config for Salsa. Bug-finding rules only, no style rules (formatting is not linted).
//
// The lint toolchain lives in tools/lint/ with its own node_modules (install: `npm run lint:install`), because
// typescript-eslint needs the TypeScript 5.x/6.0 JS API and the repo's TypeScript 7 (native) no longer has one.
// Packages are therefore resolved from tools/lint/, not from the repo root. Run via `npm run lint`.
// Baseline + rationale: docs/dev/checks-and-ci.md.
//
// Baseline: errors that already existed when lint was introduced are recorded in eslint-suppressions.json (ESLint
// bulk suppressions, counted per file + rule). They do not fail the run, but any NEW error in that file does.
// After fixing some, run `npm run lint -- --prune-suppressions` to shrink the file.
//
// LINT_NO_TYPES=1 skips type information (and the type-aware rules): ~4x faster, for the optional pre-commit hook.
import { createRequire } from 'node:module';

const requireLint = createRequire(new URL('./tools/lint/package.json', import.meta.url));
const tseslint = requireLint('typescript-eslint');
const globals = requireLint('globals');

const typeAware = !process.env.LINT_NO_TYPES;
// Rules that need the TypeScript program (parserOptions.projectService).
const typeAwareRules = typeAware ? {
  // Promise misuse: the class of bug where an async save / load / pipeline creation silently rejects.
  // error since 2026-10-04: the 31 hot-spot sites were triaged (`void` = intentional fire-and-forget);
  // the remaining ones are recorded in eslint-suppressions.json. Mark new fire-and-forget calls with `void`.
  '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true, ignoreIIFE: true }],
  '@typescript-eslint/no-misused-promises': ['warn', { checksVoidReturn: false }],
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-for-in-array': 'error',
  '@typescript-eslint/no-array-delete': 'error',
} : {};

// Core rules that catch real bugs. Most are in eslint:recommended; listed explicitly so the set is visible here.
const coreBugRules = {
  'eqeqeq': ['error', 'smart'],
  'no-fallthrough': 'error',
  'no-self-assign': 'error',
  // no-self-compare is OFF: the codebase deliberately uses `x !== x` / `x === x` as a fast NaN test (hot loops).
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-dupe-else-if': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-binary-expression': 'error',
  'no-compare-neg-zero': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-sparse-arrays': 'error',
  'no-async-promise-executor': 'error',
  'no-debugger': 'error',
  'no-unused-labels': 'error',
  'no-empty-pattern': 'error',
  'no-useless-backreference': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-loss-of-precision': 'error',
  'no-constant-condition': ['warn', { checkLoops: false }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
};

export default [
  {
    ignores: [
      'dist/**', 'dist-ssr/**', 'node_modules/**', 'tools/**', 'wasm/**', 'public/**', 'docs/**', 'coverage/**',
      '**/*.d.ts',
    ],
  },
  {
    // Existing code carries disable comments for rules this config does not enable (no-explicit-any, no-console,
    // ...); reporting them as unused would be pure noise.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },

  // ── JavaScript (scripts/, config files) ──────────────────────────────────────────────────────────────────────
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: {
      ...coreBugRules,
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },

  // ── TypeScript (src/, type-aware) ────────────────────────────────────────────────────────────────────────────
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: typeAware ? {
        projectService: { allowDefaultProject: ['*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      } : {},
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...coreBugRules,
      // tsc already reports undefined identifiers in TS (and no-undef misfires on type-only names / @webgpu globals).
      'no-undef': 'off',
      // TS overloads / declaration merging make the core versions misfire.
      'no-redeclare': 'off',
      'no-dupe-class-members': 'off',

      '@typescript-eslint/no-unused-vars': ['warn', {
        args: 'none', caughtErrors: 'none', ignoreRestSiblings: true,
        varsIgnorePattern: '^_', argsIgnorePattern: '^_',
      }],
      ...typeAwareRules,
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/no-extra-non-null-assertion': 'error',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/no-this-alias': 'off',
    },
  },

  // Tests: floating expect(...).resolves chains / fire-and-forget setup are common and harmless.
  ...(typeAware ? [{
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  }] : []),
];
