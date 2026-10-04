#!/usr/bin/env node
// Source sanity check: catches the file-level damage that scripted / agent edits cause and that neither tsc nor the
// tests notice until much later (see docs/dev/checks-and-ci.md):
//
//   zero-byte    a code file truncated to 0 bytes (a failed write / Set-Content wipe). Empty .css/.scss are allowed
//                (Angular scaffolds them empty).
//   bom          a UTF-8 byte-order mark (PowerShell 5.1 Out-File / Set-Content adds one)
//   utf16        a UTF-16 file (PowerShell ">" redirection in some hosts)
//   mixed-eol    a file that MIXES CRLF and LF lines (one tool wrote LF into a CRLF file or vice versa).
//                Consistently-CRLF and consistently-LF files are both fine.
//   mojibake     UTF-8 text decoded as Windows-1252 and re-encoded: an em dash turned into the three characters
//                U+00E2 U+20AC U+201D, e/acute into U+00C3 U+00A9, an arrow into U+00E2 U+2020 U+2019, ...
//   replacement  U+FFFD (the diamond question mark): bytes lost in a bad decode
//
// Usage:  node scripts/check-source-sanity.mjs [--report] [--no-baseline] [dir ...]
//   dirs default to DEFAULT_ROOTS. --report prints problems but always exits 0.
//   Known, not-yet-fixed problems can be listed in scripts/source-sanity-baseline.json as
//   { "path/from/repo/root.ts": ["bom", "mojibake", ...] } -- they are printed as "baseline" and do not fail the run.
//   A baselined problem that no longer occurs is reported as stale so the list shrinks over time.
// Exit code 1 when any non-baselined problem is found (unless --report). Dependency-free; Node >= 18.
// This file is shared verbatim between Salsa and Frogmarks/ClientApp: keep the copies in sync. The source is
// deliberately pure ASCII (non-ASCII characters are written as escapes) so it never flags itself.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';

const DEFAULT_ROOTS = ['src', 'scripts'];
const BASELINE_FILE = 'scripts/source-sanity-baseline.json';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.angular', 'out-tsc', 'coverage', 'pkg', 'target']);
// Files that must never be empty.
const NONEMPTY_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.wgsl', '.html']);
// Files scanned for encoding damage.
const TEXT_EXT = new Set([...NONEMPTY_EXT, '.css', '.scss', '.md', '.txt', '.yml', '.yaml']);

// Windows-1252 renderings of UTF-8 continuation bytes 0x80-0xBF (C1 controls included for cp1252's undefined slots).
const CONT = '[\\u0080-\\u00BF\\u20AC\\u201A\\u0192\\u201E\\u2026\\u2020\\u2021\\u02C6\\u2030\\u0160\\u2039\\u0152' +
  '\\u017D\\u2018\\u2019\\u201C\\u201D\\u2022\\u2013\\u2014\\u02DC\\u2122\\u0161\\u203A\\u0153\\u017E\\u0178]';
// A lead byte rendered as cp1252 (U+00C2-U+00DF two-byte, U+00E0-U+00EF three-byte, U+00F0-U+00F4 four-byte) followed
// by the matching number of continuation renderings. U+00D7 (multiplication sign) is excluded as a lead: it is common
// in real text ("2x..." with an ellipsis) and as a lead byte would only encode Hebrew.
const MOJIBAKE = new RegExp(
  `[\\u00C2-\\u00D6\\u00D8-\\u00DF]${CONT}|[\\u00E0-\\u00EF]${CONT}{2}|[\\u00F0-\\u00F4]${CONT}{3}`);
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const useBaseline = !args.includes('--no-baseline');
const roots = args.filter((a) => !a.startsWith('--'));
const cwd = process.cwd();

let baseline = {};
if (useBaseline && existsSync(BASELINE_FILE)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  } catch (e) {
    console.error(`source sanity: cannot parse ${BASELINE_FILE}: ${e.message}`);
    process.exit(1);
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (TEXT_EXT.has(extname(name).toLowerCase())) yield { path: p, size: st.size };
  }
}

/** @type {{rel: string, kind: string, msg: string}[]} */
const found = [];
let scanned = 0;
for (const root of roots.length ? roots : DEFAULT_ROOTS) {
  if (!existsSync(root)) continue;
  for (const { path, size } of walk(root)) {
    scanned++;
    const rel = relative(cwd, path).split(sep).join('/');
    const add = (kind, msg, line) => found.push({ rel, kind, msg: `${rel}${line ? ':' + line : ''}  ${kind}  ${msg}` });
    const ext = extname(path).toLowerCase();
    if (size === 0) {
      if (NONEMPTY_EXT.has(ext)) add('zero-byte', 'file is empty (truncated by a failed write?)');
      continue;
    }
    const buf = readFileSync(path);
    if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
      add('utf16', 'file is UTF-16 (expected UTF-8)');
      continue;
    }
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) add('bom', 'starts with a UTF-8 BOM');
    const text = buf.toString('utf8');
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length - crlf;
    if (crlf > 0 && lf > 0) add('mixed-eol', `${crlf} CRLF + ${lf} LF lines`);
    const lines = text.split(/\r?\n/);
    let hits = 0;
    for (let i = 0; i < lines.length && hits < 3; i++) {
      const line = lines[i];
      const m = MOJIBAKE.exec(line);
      const snippet = () => line.trim().slice(0, 100);
      if (m) { add('mojibake', `"${m[0]}" in: ${snippet()}`, i + 1); hits++; continue; }
      if (line.includes(REPLACEMENT_CHAR)) { add('replacement', `U+FFFD in: ${snippet()}`, i + 1); hits++; }
    }
  }
}

const isBaselined = (p) => Array.isArray(baseline[p.rel]) && baseline[p.rel].includes(p.kind);
const errors = found.filter((p) => !isBaselined(p));
const known = found.filter(isBaselined);
const stale = [];
for (const [rel, kinds] of Object.entries(baseline)) {
  if (rel.startsWith('//') || !Array.isArray(kinds)) continue;
  for (const kind of kinds) if (!found.some((p) => p.rel === rel && p.kind === kind)) stale.push(`${rel}  ${kind}`);
}

if (known.length) console.log(`source sanity: ${known.length} baselined (known) problem(s), not failing:\n  ` +
  known.map((p) => p.msg).join('\n  '));
if (stale.length) console.log(`source sanity: stale baseline entries (fixed -- remove them from ${BASELINE_FILE}):\n  ` +
  stale.join('\n  '));
if (errors.length) {
  console.error(`source sanity: ${errors.length} problem(s) in ${scanned} files\n  ` + errors.map((p) => p.msg).join('\n  '));
  if (!reportOnly) {
    console.error('\nFix: re-save the file as UTF-8 (no BOM) with one line-ending style; repair mojibake by hand or by ' +
      're-decoding. Use the Edit tool, never PowerShell Set-Content/Out-File. See docs/dev/checks-and-ci.md.');
    process.exit(1);
  }
} else {
  console.log(`source sanity: OK (${scanned} files)`);
}
