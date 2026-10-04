# Checks, lint and CI (Salsa + Frogmarks)

Added 2026-10-04 (audit 2026-09-28 T2, plus part of T5). The goal is to catch, automatically, the problems that
kept slipping through: files truncated to 0 bytes by scripted edits, CRLF/LF churn, encoding mangling (BOMs,
mojibake), WGSL mistakes that only show up in the browser, and types that break across the Salsa/Frogmarks boundary.
Everything here is tooling only. No runtime code changed.

> **Status (2026-10-04): built but NOT committed.** `scripts/check.mjs`, `scripts/check-source-sanity.mjs`,
> `scripts/source-sanity-baseline.json`, `scripts/git-hooks/`, `eslint.config.mjs`, `eslint-suppressions.json`,
> `tools/lint/` (incl. its `package-lock.json`), `.gitattributes` and this doc are untracked, and `.github/workflows/ci.yml`
> is modified. CI points at `npm run check`, so it only works once these are committed together. Layout / shader-contract
> guards run inside vitest (step 4): `mesh-instance-layout.test.ts`, `scene-uniforms.test.ts`, `vertex-pack.test.ts`,
> `shader-variants.test.ts`, `wgsl-static-check.test.ts`.

## TL;DR

| Command (Salsa) | What it does | Time |
|---|---|---|
| `npm run check` | sanity → typecheck → lint (type-aware, errors only) → full vitest. What CI runs. | ~2.5 min |
| `npm run check:fast` | sanity → typecheck → lint (no type info) → WGSL static check. For the pre-commit hook. | ~25 s |
| `npm run lint` | ESLint with warnings shown | ~30–75 s |
| `npm run sanity` | the source sanity check alone | <1 s |
| `npm run lint:fast` | the fast (no type info) lint step alone (`check.mjs --fast --steps=lint`) | |
| `npm run lint:install` | one-time: installs the lint toolchain in `tools/lint/` (`npm ci --prefix tools/lint`) | |

The same commands exist in Frogmarks `ClientApp/` (`check`, `check:fast`, `lint`, `sanity`). There the check is
sanity → `tsc -p tsconfig.app.json --noEmit` → lint → the `sm-types` and `templates` guards. There's no `ng build`.

`check` runs **every** step even after one fails, then prints a PASS/FAIL summary, so one run shows all the
problems. Other options: `--bail` (stop at the first failure) and `--steps=lint,sanity` (run a subset).

## What each step catches

### 1. Source sanity: `scripts/check-source-sanity.mjs`
This script has no dependencies and is the same file in both repos (keep the copies in sync). By default it scans
`src/` and `scripts/`.

| Kind | Meaning | Typical cause |
|---|---|---|
| `zero-byte` | a `.ts/.js/.mjs/.json/.wgsl/.html` file is empty (empty `.css/.scss` is allowed) | a failed scripted write |
| `bom` | starts with a UTF-8 BOM | PowerShell 5.1 `Out-File` / `Set-Content` |
| `utf16` | the file is UTF-16 | PowerShell `>` redirection |
| `mixed-eol` | **one file** mixes CRLF and LF lines (a file that is all CRLF or all LF is fine) | an LF-writing tool editing a CRLF file |
| `mojibake` | UTF-8 decoded as Windows-1252 and saved again (an em dash becomes `â€”`, `é` becomes `Ã©`) | the PowerShell double-encode ([memory: reference_powershell_encoding]) |
| `replacement` | U+FFFD, meaning bytes were lost in a bad decode | the same |

**Baseline:** `scripts/source-sanity-baseline.json` maps `path → [kinds]` for problems that already existed. They are
printed as "baselined" and don't fail the run. When one is fixed, the script reports a *stale* entry; delete it.
Both baselines are **empty** since 2026-10-04: the original Salsa entries (BOM + mojibake in `webgpu-renderer.ts`,
mojibake in `raster-interaction-controller.ts` and `scene3d-flat-group-pieces.test.ts`, U+FFFD in `mesh3d-shaders.ts`,
mixed EOL in `skirt-leg-follow.test.ts` / `ui-manager.test.ts`) and the four Frogmarks entries were all repaired.

### 2. Typecheck: `tsc --noEmit -p .`
This is TypeScript 7 native and takes about 2 s. In Frogmarks, `tsc -p tsconfig.app.json --noEmit` types Salsa from
its **built** `dist/*.d.ts`. That's how renamed APIs on the Salsa side surface.

### 3. ESLint: `eslint.config.mjs`
- **Why `tools/lint/`:** typescript-eslint needs the TypeScript 5.x/6.0 JS API (`ts.createSourceFile`, the program
  API). TypeScript 7 native's `typescript` package no longer has it: `require('typescript')` only gives the version.
  So the lint toolchain (eslint 9.39, typescript-eslint 8.71, **typescript 5.9** just for the parser, and globals)
  lives in `tools/lint/` with its own `package.json` and lockfile. `eslint.config.mjs` loads it from there with
  `createRequire`. The root toolchain (TS7, rolldown-vite, vitest 5) is untouched. The stale root devDeps
  `eslint@^8` and `prettier@^2` are unused; they were left in place (see Follow-ups).
- **Rule set:** bug-finding rules only, with no style or formatting rules. Errors: `eqeqeq` (smart), `no-fallthrough`,
  `no-self-assign`, `no-dupe-keys`, `no-duplicate-case`, `no-unreachable`, `no-unsafe-finally`,
  `no-constant-binary-expression`, `no-cond-assign`, `use-isnan`, `valid-typeof`, `no-sparse-arrays`,
  `no-async-promise-executor`, `no-debugger`, `no-unsafe-optional-chaining`, `no-loss-of-precision`, ...;
  type-aware `await-thenable`, `no-for-in-array`, `no-array-delete`; and TS `no-duplicate-enum-values`,
  `no-non-null-asserted-optional-chain`, `no-misused-new`, `no-unsafe-declaration-merging`. Warnings:
  `@typescript-eslint/no-unused-vars` (`_` prefix ignored), **`no-floating-promises`**, `no-misused-promises`,
  `no-empty`, `no-constant-condition`. (Status 2026-10-04: `no-floating-promises` is now an **error**
  (`eslint.config.mjs`), see "After the 2026-10-04 clean-up" below.)
  - `no-undef` is on for JS only. In TS, tsc already reports undefined names, and the rule misfires on type-only
    names and on `@webgpu` globals.
  - `no-self-compare` is **off**: the code deliberately uses `x !== x` as a fast NaN test in hot loops.
- **Type-aware lint is fast enough:** a full type-aware run over ~940 files takes ~30–75 s. Setting
  `LINT_NO_TYPES=1` (which `--fast` does) skips the type program and the type-aware rules (~20 s).
- **Error baseline = ESLint bulk suppressions** (`eslint-suppressions.json`, ESLint ≥ 9.24). Errors that already
  existed are counted per file and rule. They don't fail the run, but **any new error does**, including one more in
  a file that is already baselined. After fixing some, run `npm run lint -- --prune-suppressions` to shrink the
  file. To baseline a newly enabled rule, run `--suppress-rule <rule>`. `--pass-on-unpruned-suppressions` is
  always passed, so fixing a baselined error never breaks the run.

**Salsa lint baseline (2026-10-04):** 0 errors and 503 warnings once the suppressions are applied.
- Warnings: 452 `no-unused-vars`, 49 `no-floating-promises`, 2 `no-empty`.
- 10 errors are suppressed: 7 `eqeqeq` (`raster-interaction-controller.ts` ×4, `shape-manager.ts` ×2,
  `webgpu-renderer.ts` ×1), 2 `no-self-assign` (`node.ts` `containsPoint`: `x = x; y = y;`, used to silence
  unused parameters), and 1 `no-non-null-asserted-optional-chain` (`shapes-render-gcache.ts:188`,
  `shape.getGeometryIndices?.()!`).

**Frogmarks lint baseline:** 0 errors and 201 warnings (99 `no-floating-promises`, 75 template `eqeqeq`, 23 unused
vars, ...). 41 errors are suppressed; see `ClientApp/salsa-tracker.md` (2026-10-04) for the list. Notable:
**7 `await-thenable`** where Frogmarks still `await`s Salsa methods that are now synchronous (this is exactly the
cross-boundary drift this setup is meant to show), and 12 duplicate `class="..."` attributes in `board.component.html`.
Frogmarks uses ESLint 9 + typescript-eslint + angular-eslint 20 (plugins only, no builder; fine with Angular 17)
directly, because it is on TypeScript 5.4.

**After the 2026-10-04 clean-up (follow-ups 1–4), behaviour-neutral:** `no-floating-promises` is now an **error**
in both repos (fire-and-forget calls are marked `void`; nothing was re-ordered or newly awaited).
- Salsa suppressions: 10 errors → **7**: `no-floating-promises` ×6 (`webgpu-renderer.ts` ×4, `pipeline-3d.ts` ×1,
  `scene3d-manager.ts` ×1, all in files other agents were editing) and the `shapes-render-gcache.ts`
  `getGeometryIndices?.()!` (kept: `?.()` + `!` is not the same as `!()`, which would throw). All 7 `eqeqeq` were
  converted (`fillColor !== shapeColor` compares two `RGBA` objects, so `!=` was already identity); `node.ts`
  `x = x; y = y;` became `void x; void y;`. Floating-promise warnings 49 → 0.
- Frogmarks suppressions: 41 → **3**: `await-thenable` ×1 (`character-panel.component.ts`, `setPartTexture3D`;
  file owned by another agent), `no-floating-promises` ×1 (`cloth-builder.component.ts:384`; same reason), and
  `eqeqeq` ×1 (`api.service.ts` `resultModel.resultType == 3`: the value comes from server JSON, so `===` is not
  provably the same). Floating-promise warnings 99 → 0. The 12 duplicate-`class` reports were 6 elements with
  `class="mt-2" class="properties-panel-border"`; Angular keeps the last static `class`, so only
  `properties-panel-border` was ever applied and that is what remains.

### 4. WGSL static check: `src/renderer/3d/wgsl-static-check.test.ts`
This test catches same-scope redeclarations and `scene.<field>` reads that the struct doesn't declare in every
exported shader string. It is part of the full vitest run, and `--fast` runs it on its own (~1 s).

### 5. Tests: `vitest run`
This is the whole suite (~2,970 tests, ~95 s).

## Line endings: `.gitattributes`

Salsa now has `.gitattributes` with `* text=auto eol=lf` (plus `eol=crlf` for `.bat/.cmd/.ps1` and `binary` for
wasm, images, `.cur`, fonts and archives). Frogmarks already had `* text=auto` at its repo root; it was not changed.

**State when it was added:** the Salsa *index* was already 100% LF (932 text files, because `core.autocrlf=true`
normalised every commit). The working tree was mixed: 671 files LF, 227 CRLF and 34 mixed. The working tree was
**not** renormalised; no `git add --renormalize` was run.

**What happens next:**
- **Committed content: nothing changes.** Every blob is already LF, so `git add --renormalize .` would be a no-op
  for the index.
- **When you stage a CRLF or mixed file:** git converts it to LF in the index (exactly what `autocrlf=true` already
  did). You may see `warning: CRLF will be replaced by LF`. That warning is informational, not a diff.
- **On checkout, reset or switching branches:** git writes the files it touches with **LF** (`eol=lf` overrides
  `autocrlf`). Over time the working tree converges to LF. VS Code and the other tools handle LF fine.
- **What it prevents:** a machine or CI runner with `autocrlf=false`, or a tool that writes CRLF, can no longer put
  CRLF into the repo. Diffs stop showing whole-file churn.
- **Optional one-time cleanup** (the user's call, best done between agent sessions):
  `git add --renormalize . && git status`. This touches the index only. Then, to rewrite working files as LF,
  commit or stash and run `git rm --cached -r . && git reset --hard`, which **discards uncommitted work**. So only
  do this on a clean tree.
- The sanity check stops flagging the 34 mixed files as they get rewritten (only `src/` and `scripts/` are checked,
  and those are baselined).

## CI (GitHub Actions)

Both repos have GitHub remotes (`github.com/ZainGS/salsa`, `github.com/ZainGS/Frogmarks`).

- **Salsa:** `.github/workflows/ci.yml` (it existed from T1 and has been updated). It runs on every push and PR, on
  ubuntu with Node **22.12.0**: `npm ci` → `npm run lint:install` → `npm run check`. The npm cache covers both
  lockfiles. It deliberately never runs `npm run build`. It needs `package-lock.json`, `tools/lint/package-lock.json`
  and `wasm/pkg/` to be committed.
- **Frogmarks:** `Frogmarks/.github/workflows/client-check.yml` runs on push and PR that touch `ClientApp/**`, and
  via manual dispatch with a `salsa_ref` input.
  - **Approach:** check out both repos. `@zaings/salsa` is a `file:../../../salsa` link, not a published package,
    so there is no registry version to pull. Frogmarks is checked out at `$W/fm/Frogmarks` and Salsa at `$W/salsa`,
    which is exactly where `../../../salsa` resolves from `ClientApp/`.
  - **Steps:** Salsa is built with `npm ci && npm run build` (fine in CI, which is a throwaway VM; locally the user
    owns when Salsa is built). Then `ClientApp` runs `npm ci && npm run check`.
  - The client is therefore typed against **Salsa `main`**, so a rename in Salsa breaks Frogmarks CI on its next
    run.
  - **Private Salsa:** add a fine-grained PAT with read-only Contents access to `ZainGS/salsa` as the Frogmarks
    secret `SALSA_READ_TOKEN`. Without it, the checkout falls back to `github.token`, which only works if Salsa is
    public.
  - **Alternative**, if the dual checkout ever gets slow: publish `@zaings/salsa` to GitHub Packages from Salsa CI
    and depend on a version. That trades "always typed against main" for reproducibility.

## Optional pre-commit hook (not installed)

Each hook is a plain shell script with no dependency (no husky or simple-git-hooks needed). Git for Windows runs it
through its bundled sh.

```sh
# Salsa (repo root): runs `npm run check:fast` (~25 s)
git config core.hooksPath scripts/git-hooks
# Frogmarks (repo root, the folder containing ClientApp/): runs ClientApp check:fast when the commit touches ClientApp/
git config core.hooksPath ClientApp/scripts/git-hooks

# disable
git config --unset core.hooksPath
# skip once
git commit --no-verify
```

On Linux or macOS clones, make the hook executable: `chmod +x scripts/git-hooks/pre-commit`. Setting
`SALSA_SKIP_HOOKS=1` (or `FROGMARKS_SKIP_HOOKS=1`) also skips it, which is handy for scripted or agent commits.

## Files added or changed

**Salsa:**
- New: `eslint.config.mjs`, `eslint-suppressions.json`, `tools/lint/package.json` and its `package-lock.json`,
  `scripts/check.mjs`, `scripts/check-source-sanity.mjs`, `scripts/source-sanity-baseline.json`,
  `scripts/git-hooks/pre-commit`, `.gitattributes`, and this doc.
- Changed: `package.json` (scripts only) and `.github/workflows/ci.yml`.

**Frogmarks:**
- New: `ClientApp/eslint.config.mjs`, `ClientApp/eslint-suppressions.json`, `ClientApp/scripts/check.mjs`,
  `ClientApp/scripts/check-source-sanity.mjs` (a copy), `ClientApp/scripts/source-sanity-baseline.json`,
  `ClientApp/scripts/git-hooks/pre-commit`, and `.github/workflows/client-check.yml`.
- Changed: `ClientApp/package.json` (scripts, plus the devDeps `eslint`, `@eslint/js`, `typescript-eslint`,
  `@angular-eslint/{eslint-plugin,eslint-plugin-template,template-parser}`, `globals`) and `package-lock.json`.

## Follow-ups

1. ~~**Fix the sanity baseline**~~ **DONE 2026-10-04**: both baselines are empty.
2. **Triage `no-floating-promises`: DONE 2026-10-04** (Salsa 49 → 6 suppressed, Frogmarks 99 → 1 suppressed; the
   rule is an error in both repos). Left: `webgpu-renderer.ts` ×4 (`beginFrame`, `sweepRetired`,
   `sweepComputeTemps`), `pipeline-3d.ts:512` (`warm`), `scene3d-manager.ts` (`setHtmlTexture3D` on reload) and
   Frogmarks `cloth-builder.component.ts:384` (`disableLiveCloth`). They were skipped only because other agents were
   editing those files; each is a plain `void` once the file is quiet. Then `--prune-suppressions`.
3. **Frogmarks `await-thenable` ×7: 6 DONE**, plus the duplicate `class` attributes, the providers `,` hole and
   `rec.id = rec.id` (now saves the id before `Object.assign`; the preset seeds carry no `id`, so nothing changes).
   Left: `character-panel.component.ts` `await this.shapeManager.setPartTexture3D(...)` (file owned by another agent).
4. **eqeqeq: Salsa DONE (7/7), Frogmarks 19/20.** Left: `api.service.ts` `resultModel.resultType == 3`. The value is
   server JSON, so make sure it is always a number (not `"3"`) before converting it.
5. **Remove the unused root devDeps** `eslint@^8` and `prettier@^2` from Salsa's `package.json`. They are unused,
   and having eslint 8 at the root can confuse editor integrations. Point the VS Code ESLint extension at
   `tools/lint` with `"eslint.nodePath": "tools/lint/node_modules"`.
6. **tsconfig strictness** from T2: `noImplicitOverride`, `noFallthroughCasesInSwitch` and `noUnusedLocals`
   (which would turn the 452 unused-vars warnings into errors, so do it after cleanup); stage
   `noUncheckedIndexedAccess`.
7. **T3 WGSL:** parse every shader with naga or `wgsl_reflect` in a test, and later add a headless-Chrome
   `createShaderModule` smoke test. The current static check is a scanner, not a parser.
8. **Flaky wall-clock tests:** none were flagged in the 2026-10-04 run (the failures were all in-progress gait
   work). If one shows up, use `vi.useFakeTimers()` or an injected clock instead of `performance.now()` deltas.
9. **Cross-repo trigger:** have Salsa CI fire a `repository_dispatch` at Frogmarks so a Salsa push re-checks the
   client immediately, rather than on the next Frogmarks push.
10. **Frogmarks `.gitattributes`:** the root has `* text=auto` without `eol=lf`. Consider a `ClientApp/.gitattributes`
    with `* text=auto eol=lf`; its index is already all LF too.
