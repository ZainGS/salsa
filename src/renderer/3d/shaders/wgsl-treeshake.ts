/**
 * WGSL TREE-SHAKER for the specialised mesh fragment shaders (docs/specs/shader-split.md §3.3).
 *
 * After the preprocessor removed a key's unused feature blocks, most of the helper library (ground, windows, SSR
 * trace, CD, ...) is no longer called. Tint drops uncalled functions itself, but NOT ones reachable through a
 * runtime-false branch, and a driver still parses whatever text it receives; so the generator removes every top-level
 * declaration `fs_main` cannot reach: functions, structs, module constants, private variables, aliases and resource
 * bindings.
 *
 * Bindings: every mesh pipeline uses an EXPLICIT layout (Pipeline3D._pipelineLayout*), so a module may declare a
 * subset of its layout's bindings. Dropping an unused binding keeps the layouts and bind groups the same for every
 * key (draws never re-bind when the key changes).
 *
 * Method: split the module into top-level items with a brace / paren / bracket matching scanner, take each item's
 * identifier tokens as its references (a member access `.name` is not a reference), and keep the transitive closure
 * of the roots. WGSL has no recursion and no forward-declaration rules that matter here, so this is exact up to name
 * collisions with locals (which only ever KEEP an extra item, never drop a needed one). Kept items keep their
 * original text and order.
 *
 * Input must be comment-free (stripWgslComments / compactWgsl): a brace inside a comment would unbalance the scan.
 */

/** One top-level declaration. */
export interface WgslItem {
  /** The declared name ('' for directives such as `enable` / `diagnostic`, which are always kept). */
  name: string;
  kind: 'fn' | 'struct' | 'const' | 'override' | 'var' | 'alias' | 'other';
  text: string;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

/** Split a comment-free WGSL module into its top-level items, in order. Throws on unbalanced brackets. */
export function splitWgslItems(src: string): WgslItem[] {
  const items: WgslItem[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    const start = i;
    // leading attributes: @name or @name(...)
    let j = i;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] !== '@') break;
      j++;
      IDENT.lastIndex = j; const a = IDENT.exec(src); if (!a) throw new Error(`wgsl-treeshake: bad attribute at ${j}`);
      j = IDENT.lastIndex;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '(') j = matchClose(src, j, '(', ')') + 1;
    }
    IDENT.lastIndex = j;
    const kw = IDENT.exec(src)?.[0] ?? '';
    let kind: WgslItem['kind'] = 'other';
    if (kw === 'fn' || kw === 'struct' || kw === 'const' || kw === 'override' || kw === 'var' || kw === 'alias') kind = kw;
    let end: number;
    if (kind === 'fn' || kind === 'struct') {
      // the body = the first '{' outside parentheses (parameter attributes carry parens; no braces before the body)
      let k = j, paren = 0;
      while (k < n && !(src[k] === '{' && paren === 0)) { if (src[k] === '(') paren++; else if (src[k] === ')') paren--; k++; }
      if (k >= n) throw new Error(`wgsl-treeshake: ${kind} without a body at ${start}`);
      end = matchClose(src, k, '{', '}') + 1;
      let k2 = end; while (k2 < n && /[ \t]/.test(src[k2])) k2++;
      if (src[k2] === ';') end = k2 + 1;   // struct S { ... };
    } else {
      // up to the ';' at depth 0
      let k = j, depth = 0;
      while (k < n) {
        const c = src[k];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ';' && depth === 0) break;
        k++;
      }
      if (k >= n) throw new Error(`wgsl-treeshake: unterminated declaration at ${start}: ${src.slice(start, start + 60)}`);
      end = k + 1;
    }
    const text = src.slice(start, end);
    items.push({ name: declName(text, kind), kind, text });
    i = end;
  }
  return items;
}

/** Index of the bracket closing the one at `open`. */
function matchClose(src: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === o) depth++;
    else if (src[k] === c) { depth--; if (depth === 0) return k; }
  }
  throw new Error(`wgsl-treeshake: unbalanced "${o}" at ${open}`);
}

function declName(text: string, kind: WgslItem['kind']): string {
  const body = text.replace(/^(\s*@[A-Za-z_][A-Za-z0-9_]*(\s*\([^)]*\))?)*\s*/, '');
  let m: RegExpExecArray | null = null;
  if (kind === 'fn') m = /^fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
  else if (kind === 'struct') m = /^struct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
  else if (kind === 'const' || kind === 'override' || kind === 'alias') m = /^(?:const|override|alias)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
  else if (kind === 'var') m = /^var\s*(?:<[^>]*>)?\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
  return m ? m[1] : '';
}

/** The identifiers `text` references (member accesses `.x` excluded). */
function refsOf(text: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let p = m.index - 1;
    while (p >= 0 && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n' || text[p] === '\r')) p--;
    if (p >= 0 && text[p] === '.') continue;
    out.add(m[0]);
  }
  return out;
}

/** Keep the items reachable from `roots` (default `fs_main`); returns the kept items' text joined by newlines.
 *  Throws when a root is missing. */
export function treeShakeWgsl(src: string, roots: readonly string[] = ['fs_main']): string {
  return shakeItems(splitWgslItems(src), roots).map((it) => it.text).join('\n');
}

/** The reachable subset of `items` (original order). */
export function shakeItems(items: readonly WgslItem[], roots: readonly string[]): WgslItem[] {
  const byName = new Map<string, number>();
  items.forEach((it, idx) => { if (it.name) byName.set(it.name, idx); });
  const keep = new Uint8Array(items.length);
  const work: number[] = [];
  for (const r of roots) {
    const idx = byName.get(r);
    if (idx === undefined) throw new Error(`wgsl-treeshake: root "${r}" not found`);
    if (!keep[idx]) { keep[idx] = 1; work.push(idx); }
  }
  items.forEach((it, idx) => { if (!it.name && !keep[idx]) { keep[idx] = 1; work.push(idx); } });
  while (work.length) {
    const it = items[work.pop()!];
    for (const ref of refsOf(it.text)) {
      const idx = byName.get(ref);
      if (idx !== undefined && !keep[idx]) { keep[idx] = 1; work.push(idx); }
    }
  }
  return items.filter((_, idx) => keep[idx] === 1);
}
