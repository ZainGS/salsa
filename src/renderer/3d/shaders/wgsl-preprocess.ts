/**
 * WGSL LINE PREPROCESSOR for the specialised mesh fragment shaders (docs/specs/shader-split.md §3.2).
 *
 * One template (shaders/mesh3d-fs-template.ts) carries every feature; the generator (mesh-fs-generate.ts) keeps only
 * the lines of the features a shader key compiles in. A feature block is guarded by directive LINES written as WGSL
 * line comments, so editors still highlight the file and nothing in it needs a backtick:
 *
 *   //#if NAME && (OTHER || !THIRD)
 *     ...
 *   //#elif EXPR
 *     ...
 *   //#else
 *     ...
 *   //#endif
 *
 * - One directive per line (leading whitespace allowed); nesting is allowed; there are no same-line conditionals, so
 *   diffs stay line-based.
 * - EXPR: identifiers `[A-Z][A-Z0-9_]*`, `!`, `&&`, `||`, parentheses. An identifier must be in the KNOWN set: an
 *   unknown name (a typo), an unbalanced directive or an `//#elif` / `//#else` after `//#else` THROWS (fail loud, the
 *   same policy as mesh3d-shaders.ts replaceMarker), so a drifted guard never silently drops or keeps a feature.
 * - Directive lines are always removed. By default every comment and blank line is removed too (a smaller text for
 *   the driver to parse; the compiled code is the same).
 *
 * The preprocessor ONLY removes lines: it never reorders or rewrites one. That is what keeps every surviving
 * derivative / implicit-LOD sample in the same (uniform) control-flow position as in the full shader (§3.5).
 */

/** A directive line: `//#if EXPR`, `//#elif EXPR`, `//#else`, `//#endif`. */
const DIRECTIVE = /^\s*\/\/#(if|elif|else|endif)\b(.*)$/;
/** Any line that starts like a directive (catches misspellings such as `//#ifdef` or `//#end`). */
const DIRECTIVE_LIKE = /^\s*\/\/#[a-z]/;

export interface WgslPreprocessOptions {
  /** Every identifier a directive may use (the defined ones and the undefined ones). */
  known: ReadonlySet<string>;
  /** Keep comments, blank lines and indentation exactly (default false: comments + blank lines are stripped). */
  keepComments?: boolean;
}

/** Evaluate one directive expression against `defined`. Throws on a syntax error or an unknown identifier. */
export function evalDirectiveExpr(expr: string, defined: ReadonlySet<string>, known: ReadonlySet<string>): boolean {
  const toks = expr.match(/[A-Za-z_][A-Za-z0-9_]*|&&|\|\||!|\(|\)|\S/g) ?? [];
  let i = 0;
  const fail = (why: string): never => { throw new Error(`wgsl-preprocess: ${why} in directive expression "${expr.trim()}"`); };
  const peek = (): string | undefined => toks[i];
  const primary = (): boolean => {
    const t = toks[i++];
    if (t === undefined) return fail('unexpected end');
    if (t === '!') return !primary();
    if (t === '(') { const v = or(); if (toks[i++] !== ')') fail('missing )'); return v; }
    if (!/^[A-Z][A-Z0-9_]*$/.test(t)) return fail(`bad token "${t}"`);
    if (!known.has(t)) return fail(`unknown identifier "${t}"`);
    return defined.has(t);
  };
  const and = (): boolean => { let v = primary(); while (peek() === '&&') { i++; const r = primary(); v = v && r; } return v; };
  const or = (): boolean => { let v = and(); while (peek() === '||') { i++; const r = and(); v = v || r; } return v; };
  if (toks.length === 0) fail('empty expression');
  const v = or();
  if (i !== toks.length) fail(`unexpected "${toks[i]}"`);
  return v;
}

/** Remove WGSL comments: `// ...` to the end of the line and (nestable) block comments. WGSL has no string literals,
 *  so every `//` / `/*` outside a comment starts one. Line structure is kept (a block comment keeps its newlines). */
export function stripWgslComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; continue; }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Strip comments, trailing whitespace and blank lines (indentation is kept, so the output stays readable). */
export function compactWgsl(src: string): string {
  return stripWgslComments(src).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0).join('\n');
}

interface Frame { parentActive: boolean; taken: boolean; active: boolean; sawElse: boolean; line: number }

/** Keep the lines of `src` whose enclosing directives are true for `defined`. See the module doc. */
export function preprocessWgsl(src: string, defined: ReadonlySet<string>, opts: WgslPreprocessOptions): string {
  const lines = src.split('\n');
  const out: string[] = [];
  const stack: Frame[] = [];
  let active: boolean = true;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const m = DIRECTIVE.exec(line);
    if (!m) {
      if (DIRECTIVE_LIKE.test(line)) throw new Error(`wgsl-preprocess: unknown directive at line ${ln + 1}: ${line.trim()}`);
      if (active) out.push(line);
      continue;
    }
    const kind = m[1], rest = m[2].trim();
    if (kind === 'if') {
      const e: boolean = evalDirectiveExpr(rest, defined, opts.known);   // evaluated in a dead branch too (validates the names)
      const v: boolean = active && e;
      stack.push({ parentActive: active, taken: v, active: v, sawElse: false, line: ln + 1 });
      active = v;
    } else if (kind === 'elif' || kind === 'else') {
      const f = stack[stack.length - 1];
      if (!f) throw new Error(`wgsl-preprocess: //#${kind} without //#if at line ${ln + 1}`);
      if (f.sawElse) throw new Error(`wgsl-preprocess: //#${kind} after //#else at line ${ln + 1}`);
      if (kind === 'else') {
        if (rest.length) throw new Error(`wgsl-preprocess: //#else takes no expression (line ${ln + 1})`);
        f.sawElse = true;
        f.active = f.parentActive && !f.taken;
      } else {
        const v = evalDirectiveExpr(rest, defined, opts.known);
        f.active = f.parentActive && !f.taken && v;
      }
      if (f.active) f.taken = true;
      active = f.active;
    } else {
      if (rest.length) throw new Error(`wgsl-preprocess: //#endif takes no expression (line ${ln + 1})`);
      const f = stack.pop();
      if (!f) throw new Error(`wgsl-preprocess: //#endif without //#if at line ${ln + 1}`);
      active = f.parentActive;
    }
  }
  if (stack.length) throw new Error(`wgsl-preprocess: unterminated //#if from line ${stack[stack.length - 1].line}`);
  const text = out.join('\n');
  return opts.keepComments ? text : compactWgsl(text);
}
