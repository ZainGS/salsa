/**
 * src/renderer/ground-shader-contract.test.ts — source-level guards on the procedural-ground WGSL.
 *
 * WHY A SOURCE-SCANNING TEST: the ground shader is a JS template literal compiled by the GPU driver at
 * `createShaderModule` — RUNTIME. Neither `tsc` nor the rest of the suite can see inside it, so a whole
 * class of defects (a WGSL reserved word used as an identifier, a stray backtick terminating the literal,
 * a call site left on an old signature after a refactor) ships green and only fails in the browser. That
 * has bitten this file twice: `let macro = ...` (reserved keyword) and a backtick inside a WGSL comment.
 * These assertions are cheap and catch exactly those.
 */

import { describe, it, expect } from 'vitest';
import { MESH3D_FRAGMENT_SHADER, MESH3D_FRAGMENT_SHADER_UNTEXTURED } from '../renderer/3d/shaders/mesh3d-shaders';

// Negative assertions ("this construct is gone") must scan CODE, not prose — the comments in this
// shader deliberately quote the constructs they replaced, and a naive substring match hits those.
const stripComments = (s: string): string => s.replace(/\/\/.*$/gm, '');

const SHADERS: Array<[string, string, string]> = [
  ['MESH3D_FRAGMENT_SHADER', MESH3D_FRAGMENT_SHADER, stripComments(MESH3D_FRAGMENT_SHADER)],
  ['MESH3D_FRAGMENT_SHADER_UNTEXTURED', MESH3D_FRAGMENT_SHADER_UNTEXTURED, stripComments(MESH3D_FRAGMENT_SHADER_UNTEXTURED)],
];

// WGSL reserved words that read like ordinary variable names — the ones a shader author actually
// reaches for. Using any of these as an identifier fails at createShaderModule only.
const WGSL_RESERVED = [
  'macro', 'match', 'mod', 'type', 'shared', 'template', 'filter', 'this', 'new', 'use', 'enum',
  'do', 'typedef', 'union', 'using', 'auto', 'class', 'delete', 'export', 'extern', 'final',
  'friend', 'get', 'goto', 'handle', 'inline', 'interface', 'layout', 'mutable', 'namespace',
  'operator', 'package', 'private', 'protected', 'public', 'reference', 'set', 'signed', 'sizeof',
  'static', 'super', 'trait', 'try', 'typename', 'virtual', 'where', 'with', 'yield',
];

// WGSL builtins + type constructors + keywords — anything a shader may call without defining.
const WGSL_BUILTINS = new Set([
  'abs','acos','acosh','all','any','asin','asinh','atan','atan2','atanh','bitcast','ceil','clamp','cos',
  'cosh','countLeadingZeros','countOneBits','countTrailingZeros','cross','degrees','determinant','distance',
  'dot','dpdx','dpdxCoarse','dpdxFine','dpdy','dpdyCoarse','dpdyFine','exp','exp2','extractBits','faceForward',
  'firstLeadingBit','firstTrailingBit','floor','fma','fract','frexp','fwidth','fwidthCoarse','fwidthFine',
  'insertBits','inverseSqrt','ldexp','length','log','log2','max','min','mix','modf','normalize','pack2x16float',
  'pack4x8snorm','pack4x8unorm','pow','quantizeToF16','radians','reflect','refract','reverseBits','round',
  'saturate','select','sign','sin','sinh','smoothstep','sqrt','step','tan','tanh','textureDimensions',
  'textureLoad','textureSample','textureSampleCompare','textureSampleCompareLevel','textureSampleLevel',
  'transpose','trunc','unpack2x16float','unpack4x8snorm','unpack4x8unorm','arrayLength','atomicLoad',
  // type constructors
  'f32','i32','u32','bool','vec2','vec3','vec4','mat2x2','mat2x3','mat2x4','mat3x2','mat3x3','mat3x4',
  'mat4x2','mat4x3','mat4x4','array','ptr','atomic',
  // keywords that read like calls
  'if','for','while','switch','case','return','let','var','const','fn','struct','discard','loop','break','continue',
]);

describe('WGSL symbol resolution — every call must resolve in ITS OWN shader', () => {
  for (const [name, src] of SHADERS) {
    it(`${name}: calls no undefined function`, () => {
      // ★ Shaders are assembled from interpolated preludes, and NOT every prelude reaches every shader —
      // FOLIAGE_WIND_WGSL goes into the VERTEX shaders only. Calling one of its helpers from a fragment
      // shader compiles fine as TypeScript, passes every other test, and then fails at
      // createShaderModule with "unresolved call target" the moment the page renders. That is exactly how
      // `fq_hash12` reached the glass path.
      const code = stripComments(src);
      const defined = new Set([...code.matchAll(/fn\s+([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]));
      const called = [...code.matchAll(/([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]);
      const missing = [...new Set(called.filter((c) => !defined.has(c) && !WGSL_BUILTINS.has(c)))];
      expect(missing, `undefined in ${name}`).toEqual([]);
    });
  }
});

// ── A tiny WGSL type inferencer, used only to check call arguments ──────────────────────────────
// Resolving a call TARGET is not enough: `pg_vnoise(p * 22.0)` where p is a vec3 resolves fine and then
// dies at createShaderModule with "type mismatch for argument 1". This infers ONLY what it can be sure
// of (vector constructors, swizzles, arithmetic on a known operand, calls with a declared return type)
// and returns null everywhere else, so an unknown never becomes a false failure.

interface Sig { params: string[]; ret: string | null }

const signatures = (code: string): Map<string, Sig> => {
  const out = new Map<string, Sig>();
  for (const m of code.matchAll(/fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([A-Za-z_][\w<>]*))?/g)) {
    // WGSL permits a TRAILING COMMA in both declarations and calls, and this shader uses it. Drop the
    // empty tail here exactly as splitArgs() does for call sites — counting it on one side only reports
    // every multi-line call in the file as an arity mismatch.
    const params = m[2].split(',').map((p) => p.trim()).filter((p) => p.length > 0)
      .map((p) => (p.split(':')[1] ?? '').trim());
    out.set(m[1], { params, ret: m[3] ?? null });
  }
  return out;
};

/** Split an argument list on TOP-LEVEL commas only (nested calls and vec3<f32>(...) must survive). */
const splitArgs = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0, angle = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '<') angle++;
    else if (c === '>') angle--;
    else if (c === ',' && depth === 0 && angle === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  const tail = s.slice(start);
  if (tail.trim() || out.length) out.push(tail);
  return out.map((a) => a.trim()).filter((a) => a.length > 0);
};

/** The matching ')' for the '(' at `open`. */
const matchParen = (s: string, open: number): number => {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')' && --d === 0) return i;
  }
  return -1;
};

const VEC = /^vec([234])(?:<[^>]*>)?$/;

const inferType = (expr: string, env: Map<string, string>, sigs: Map<string, Sig>): string | null => {
  let e = expr.trim();
  if (!e) return null;
  // Strip one layer of enclosing parens.
  while (e.startsWith('(') && matchParen(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  if (e.startsWith('-') || e.startsWith('+')) return inferType(e.slice(1), env, sigs);

  // Top-level arithmetic: the result takes the VECTOR operand's type (scalar broadcast).
  let depth = 0, angle = 0;
  for (let i = e.length - 1; i > 0; i--) {
    const c = e[i];
    if (c === ')') depth++; else if (c === '(') depth--;
    else if (c === '>') angle++; else if (c === '<') angle--;
    else if (depth === 0 && angle === 0 && '*/+-'.includes(c) && !'*/+-<>=!&|'.includes(e[i - 1])) {
      const l = inferType(e.slice(0, i), env, sigs);
      const r = inferType(e.slice(i + 1), env, sigs);
      if (l && VEC.test(l.replace(/<.*/, ''))) return l;
      if (r && VEC.test(r.replace(/<.*/, ''))) return r;
      return l === 'f32' && r === 'f32' ? 'f32' : null;
    }
  }

  if (/^[0-9]*\.[0-9]+$/.test(e) || /^[0-9]+\.[0-9]*$/.test(e)) return 'f32';
  // A call: a vector constructor, or a user fn with a declared return type.
  const call = e.match(/^([A-Za-z_]\w*)(?:<[^>]*>)?\s*\(/);
  if (call && matchParen(e, e.indexOf('(')) === e.length - 1) {
    const v = call[1].match(VEC);
    if (v) return `vec${v[1]}<f32>`;
    if (/^(f32|i32|u32|bool)$/.test(call[1])) return call[1];
    return sigs.get(call[1])?.ret ?? null;
  }
  // A swizzle off something whose type we know.
  const sw = e.match(/^(.+)\.([xyzwrgba]{1,4})$/);
  if (sw) {
    const base = inferType(sw[1], env, sigs);
    if (!base || !VEC.test(base.replace(/<.*/, ''))) return null;
    return sw[2].length === 1 ? 'f32' : `vec${sw[2].length}<f32>`;
  }
  if (/^[A-Za-z_]\w*$/.test(e)) return env.get(e) ?? null;
  return null;
};

describe('WGSL call arguments — the type mismatch that only the GPU driver sees', () => {
  for (const [name, , code] of SHADERS) {
    it(`${name}: every inferable call argument matches the declared parameter type`, () => {
      // `pg_vnoise(p * 22.0)` — p a vec3, the param a vec2 — shipped green through tsc, 542 tests and a
      // clean build, then took the whole renderer down at createShaderModule. Nothing but the driver
      // typechecks this file, so this stands in for it on the cases that can be inferred with certainty.
      const sigs = signatures(code);
      const bad: string[] = [];

      for (const fn of code.matchAll(/fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)[^{]*\{/g)) {
        const bodyStart = fn.index! + fn[0].length;
        let d = 1, end = bodyStart;
        while (end < code.length && d > 0) { if (code[end] === '{') d++; else if (code[end] === '}') d--; end++; }
        const body = code.slice(bodyStart, end);

        // Local type environment: the parameters, then each `let`/`var` as it is declared.
        const env = new Map<string, string>();
        for (const p of fn[2].split(',')) {
          const [n, t] = p.split(':').map((x) => x.trim());
          if (n && t) env.set(n, t);
        }
        for (const line of body.split('\n')) {
          const decl = line.match(/^\s*(?:let|var)\s+([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_][\w<>]*))?\s*=\s*(.+?);\s*$/);
          if (!decl) continue;
          const t = decl[2] ?? inferType(decl[3], env, sigs);
          if (t) env.set(decl[1], t);
        }

        // Now check every call to a function this shader defines.
        for (const c of body.matchAll(/([A-Za-z_]\w*)\s*\(/g)) {
          const sig = sigs.get(c[1]);
          if (!sig) continue;
          const open = c.index! + c[0].length - 1;
          const close = matchParen(body, open);
          if (close < 0) continue;
          const args = splitArgs(body.slice(open + 1, close));
          if (args.length !== sig.params.length) {
            bad.push(`${fn[1]}: ${c[1]} called with ${args.length} args, declared ${sig.params.length}`);
            continue;
          }
          args.forEach((a, i) => {
            const got = inferType(a, env, sigs);
            const want = sig.params[i];
            if (!got || !want) return;                                  // not inferable — never guess
            const norm = (t: string): string => t.replace(/\s/g, '');
            if (norm(got) !== norm(want)) {
              bad.push(`${fn[1]}: ${c[1]} arg ${i + 1} "${a}" is ${got}, declared ${want}`);
            }
          });
        }
      }
      expect(bad, `type mismatches in ${name}`).toEqual([]);
    });
  }
});

describe('ground WGSL — source contract (defects that only fail at createShaderModule)', () => {
  for (const [name, src, code] of SHADERS) {
    it(`${name}: declares no identifier that is a WGSL reserved word`, () => {
      const declared = [...src.matchAll(/\b(?:let|var|const|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
      const offenders = [...new Set(declared.filter((d) => WGSL_RESERVED.includes(d)))];
      expect(offenders).toEqual([]);
    });

    it(`${name}: contains no backtick (a stray one silently truncates the template literal)`, () => {
      expect(code).not.toContain('`');
    });

    it(`${name}: calls gr_uvMetres at fragment top level, NOT inside the groundShade branch`, () => {
      // dpdx/dpdy require UNIFORM control flow. Calling the helper inside `if (groundShade)` compiles
      // locally but is rejected by Tint — so pin that the call sits before the branch.
      const call = src.indexOf('gr_uvMetres(uv, worldPos)');
      const branch = src.indexOf('let groundShade =');
      expect(call).toBeGreaterThan(-1);
      expect(branch).toBeGreaterThan(-1);
      expect(call).toBeLessThan(branch);
    });

    it(`${name}: every ground entry point is on the metric signature (uvM threaded through)`, () => {
      expect(src).toContain('fn gr_uvMetres(');
      // Dispatch + height field both take the metres-per-uv vector...
      expect(src).toMatch(/fn groundSurface\(uv: vec2<f32>, uvM: vec2<f32>, mc: vec2<f32>,/);
      expect(src).toMatch(/fn groundHeightM\(p: vec2<f32>, uvM: vec2<f32>,/);
      // ...and no call site was left on the pre-refactor signature.
      expect(code).not.toMatch(/groundSurface\(uv,\s*gMode/);
      expect(code).not.toMatch(/groundSurface\(uv,\s*gUvM,\s*gMode/);   // pre-world-uv signature
      expect(code).not.toMatch(/groundHeightM\(uv\s*\+/);
    });

    it(`${name}: the relief gradient is CENTRAL and sized to the grout, not the tile`, () => {
      // A one-sided difference at a tile-sized epsilon drew a ghost seam a fixed distance from every
      // real one (the "duplicate grout line" — visible even on borderStrip, which has no bond).
      expect(src).toContain('let gE = max(gGroutW * 0.9, 0.002);');
      expect(code).not.toContain('let gE = max(min(gP0, gP1) * 0.15, 0.002);');
      // Both axes sampled on BOTH sides.
      for (const s of ['gP - vec2<f32>(gE, 0.0)', 'gP + vec2<f32>(gE, 0.0)',
                       'gP - vec2<f32>(0.0, gE)', 'gP + vec2<f32>(0.0, gE)']) {
        expect(src).toContain(s);
      }
      // ...and the centre sample is no longer mixed into the gradient (gW.height is weathered, the
      // neighbours are not — that asymmetry biased the normal on top of the doubling).
      expect(code).not.toContain('(gW.height - hR)');
    });

    it(`${name}: every groundMode in the surface library has a dispatch branch AND a height branch`, () => {
      // groundHeightM feeds the relief normal. A mode present in groundSurface but missing from
      // groundHeightM silently falls through to the ashlar cell — i.e. the lighting draws paver seams
      // across a surface whose albedo has none. Pin that both switches cover 0..8.
      for (let mode = 1; mode <= 8; mode++) {
        expect(src, `groundSurface missing mode ${mode}`).toMatch(new RegExp(`mi == ${mode}`));
      }
      const heightFn = src.slice(src.indexOf('fn groundHeightM('));
      for (const mode of [3, 4, 5, 6, 7, 8]) {
        expect(heightFn.slice(0, heightFn.indexOf('gr_cellHeight(')), `groundHeightM missing mode ${mode}`)
          .toMatch(new RegExp(`mi == ${mode}`));
      }
    });

    it(`${name}: grass is multi-scale and its dry flecks are soft (was 22 cm tan squares)`, () => {
      expect(code).not.toContain('floor(p * 4.5)');            // the hard-stepped fleck grid
      expect(code).not.toContain('vec2<f32>(p.x * 2.0, p.y * 16.0)'); // the single global streak
      expect(src).toContain('let clump = gr_fbm2(');          // (b) clump variation, smooth not hashed
      expect(src).toContain('let blade = pg_vnoise(');        // (c) blade striation
    });

    it(`${name}: the pit term is soft + grout-gated (was a hard step on a coarse uv grid)`, () => {
      // The old form darkened a WHOLE floor(uv * 160) cell via step() — a 12 cm axis-aligned black
      // square that ran straight through the grout seam.
      expect(code).not.toContain('floor(uv * 160.0)');
      expect(src).toContain('(1.0 - groutMask)');
    });
  }
});
