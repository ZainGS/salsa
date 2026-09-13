/**
 * src/scene-graph/core/svg-path.ts
 *
 * SVG `<path d="...">` data → PathAnchor subpaths (docs/specs/vector-paths.md P3 — SVG path import).
 * Pure module, no engine imports beyond the anchor type. Output stays in SVG USER SPACE (y grows DOWN);
 * the importer (ShapeManager.importSVGPath) scales and y-flips into world space, so this parser can be
 * unit-tested against SVG-spec numbers directly.
 *
 * Supported: M/m L/l H/h V/v C/c S/s Q/q T/t A/a Z/z, implicit command repetition (incl. the
 * moveto→lineto rule), compressed arc flags ("a1 1 0 011 0"), scientific notation, multiple subpaths.
 * Curves map exactly: cubic control points become anchor in/out handle offsets; quadratics are elevated
 * to cubics (c1 = p0 + 2/3(q−p0), c2 = p3 + 2/3(q−p3) — exact, same curve); arcs are converted via the
 * SVG-spec endpoint→center parameterization (F.6.5) then approximated by one cubic per ≤90° slice with
 * the standard k = 4/3·tan(Δθ/4) tangent length (max radial error ≈ 2.7e-4·r — far below visual notice).
 *
 * A `Z` that lands on the subpath's first point merges the terminal point into it (its incoming handle
 * becomes the first anchor's `in`), which is how a two-arc SVG circle becomes a clean 2-anchor closed
 * PathNode ring.
 */

import type { PathAnchor } from "../shapes/path-node";
import type { Pt } from "./bezier";

export interface SVGSubpath {
    anchors: PathAnchor[];
    closed: boolean;
}

/** Working point: position + ABSOLUTE control points of the adjacent segments (offsets computed at the end). */
interface WPt { x: number; y: number; inAbs: Pt | null; outAbs: Pt | null; }

// ── Scanner ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Cursor-based scanner — a global regex can't handle SVG's compressed arc flags ("011" = flag 0, flag 1,
 *  then the number 1 continues), so flags are read as single characters. */
class Scanner {
    private i = 0;
    constructor(private readonly s: string) {}

    private skipSep(): void {
        while (this.i < this.s.length && /[\s,]/.test(this.s[this.i])) this.i++;
    }

    /** Next command letter, or null if a number (or nothing) is ahead. Consumes the letter. */
    readCommand(): string | null {
        this.skipSep();
        const c = this.s[this.i];
        if (c && /[A-Za-z]/.test(c)) { this.i++; return c; }
        return null;
    }

    /** Is a number ahead (i.e. the previous command repeats implicitly)? */
    numberAhead(): boolean {
        this.skipSep();
        const c = this.s[this.i];
        return !!c && /[0-9.+-]/.test(c);
    }

    readNumber(): number {
        this.skipSep();
        const start = this.i;
        if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
        while (/[0-9]/.test(this.s[this.i] ?? '')) this.i++;
        if (this.s[this.i] === '.') { this.i++; while (/[0-9]/.test(this.s[this.i] ?? '')) this.i++; }
        if (this.s[this.i] === 'e' || this.s[this.i] === 'E') {
            this.i++;
            if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
            while (/[0-9]/.test(this.s[this.i] ?? '')) this.i++;
        }
        const n = parseFloat(this.s.slice(start, this.i));
        if (!Number.isFinite(n) || this.i === start) throw new Error(`svg-path: bad number at index ${start}`);
        return n;
    }

    /** Arc large-arc/sweep flag: exactly one '0' or '1' character. */
    readFlag(): 0 | 1 {
        this.skipSep();
        const c = this.s[this.i];
        if (c === '0' || c === '1') { this.i++; return c === '1' ? 1 : 0; }
        throw new Error(`svg-path: bad arc flag at index ${this.i}`);
    }

    atEnd(): boolean {
        this.skipSep();
        return this.i >= this.s.length;
    }
}

// ── Parser ──────────────────────────────────────────────────────────────────────────────────────────────────

export function parseSVGPath(d: string): SVGSubpath[] {
    const sc = new Scanner(d);
    const out: SVGSubpath[] = [];

    let pts: WPt[] = [];            // current subpath's points
    let closed = false;
    let cur: Pt = { x: 0, y: 0 };
    let start: Pt = { x: 0, y: 0 };
    let prevC2: Pt | null = null;   // last cubic's 2nd control (S/s reflection)
    let prevQ: Pt | null = null;    // last quadratic's control (T/t reflection)
    let cmd = '';                   // active command (for implicit repetition)

    const flush = () => {
        if (pts.length >= 2) out.push({ anchors: toAnchors(pts), closed });
        pts = [];
        closed = false;
    };

    const moveTo = (p: Pt) => {
        flush();
        cur = { ...p };
        start = { ...p };
        pts = [{ x: p.x, y: p.y, inAbs: null, outAbs: null }];
    };

    /** After a Z, drawing may continue without a moveto — the new subpath starts at `cur` (SVG rule). */
    const seed = () => {
        if (!pts.length) pts.push({ x: cur.x, y: cur.y, inAbs: null, outAbs: null });
    };

    const lineTo = (p: Pt) => {
        seed();
        pts.push({ x: p.x, y: p.y, inAbs: null, outAbs: null });
        cur = { ...p };
    };

    const cubicTo = (c1: Pt, c2: Pt, p: Pt) => {
        seed();
        const a = pts[pts.length - 1];
        if (a) a.outAbs = { ...c1 };
        pts.push({ x: p.x, y: p.y, inAbs: { ...c2 }, outAbs: null });
        cur = { ...p };
    };

    const quadTo = (q: Pt, p: Pt) => {
        // Exact degree elevation — the cubic traces the identical curve.
        cubicTo(
            { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) },
            { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) },
            p,
        );
    };

    const close = () => {
        if (pts.length >= 2) {
            const first = pts[0], last = pts[pts.length - 1];
            const eps = 1e-6 * (1 + Math.max(Math.abs(last.x), Math.abs(last.y)));
            if (Math.hypot(last.x - first.x, last.y - first.y) <= eps) {
                // The path returned to its start — merge the duplicate terminal point.
                first.inAbs = last.inAbs;
                pts.pop();
            }
            closed = true;
        }
        flush();
        cur = { ...start };
    };

    while (!sc.atEnd()) {
        const c = sc.readCommand();
        if (c) {
            if (!cmd && c !== 'M' && c !== 'm') throw new Error('svg-path: data must start with a moveto');
            cmd = c;
        } else if (!cmd) {
            throw new Error('svg-path: data must start with a moveto');
        } else if (cmd === 'M') {
            cmd = 'L';           // implicit repetition after moveto is lineto
        } else if (cmd === 'm') {
            cmd = 'l';
        } else if (cmd === 'Z' || cmd === 'z') {
            throw new Error('svg-path: number after Z');
        }

        const rel = cmd === cmd.toLowerCase();
        const rx = () => (rel ? cur.x : 0) + sc.readNumber();
        const ry = () => (rel ? cur.y : 0) + sc.readNumber();

        switch (cmd.toUpperCase()) {
            case 'M': { const x = rx(), y = ry(); moveTo({ x, y }); prevC2 = prevQ = null; break; }
            case 'L': { const x = rx(), y = ry(); lineTo({ x, y }); prevC2 = prevQ = null; break; }
            case 'H': { const x = rx(); lineTo({ x, y: cur.y }); prevC2 = prevQ = null; break; }
            case 'V': {
                const y = (rel ? cur.y : 0) + sc.readNumber();
                lineTo({ x: cur.x, y }); prevC2 = prevQ = null; break;
            }
            case 'C': {
                const c1 = { x: rx(), y: ry() }, c2 = { x: rx(), y: ry() }, p = { x: rx(), y: ry() };
                cubicTo(c1, c2, p); prevC2 = c2; prevQ = null; break;
            }
            case 'S': {
                // First control = reflection of the previous cubic's c2 (or the current point).
                const c1 = prevC2 ? { x: 2 * cur.x - prevC2.x, y: 2 * cur.y - prevC2.y } : { ...cur };
                const c2 = { x: rx(), y: ry() }, p = { x: rx(), y: ry() };
                cubicTo(c1, c2, p); prevC2 = c2; prevQ = null; break;
            }
            case 'Q': {
                const q = { x: rx(), y: ry() }, p = { x: rx(), y: ry() };
                quadTo(q, p); prevQ = q; prevC2 = null; break;
            }
            case 'T': {
                const q: Pt = prevQ ? { x: 2 * cur.x - prevQ.x, y: 2 * cur.y - prevQ.y } : { ...cur };
                const p = { x: rx(), y: ry() };
                quadTo(q, p); prevQ = q; prevC2 = null; break;
            }
            case 'A': {
                const radX = Math.abs(sc.readNumber());
                const radY = Math.abs(sc.readNumber());
                const rot = sc.readNumber();
                const large = sc.readFlag();
                const sweep = sc.readFlag();
                const p = { x: rx(), y: ry() };
                for (const [c1, c2, e] of arcToCubics(cur, p, radX, radY, rot, large, sweep)) cubicTo(c1, c2, e);
                cur = { ...p };
                prevC2 = prevQ = null;
                break;
            }
            case 'Z': close(); prevC2 = prevQ = null; break;
            default: throw new Error(`svg-path: unsupported command '${cmd}'`);
        }
    }
    flush();
    return out;
}

/** WPt list → PathAnchors: absolute controls become handle OFFSETS; kind from handle symmetry. */
function toAnchors(pts: WPt[]): PathAnchor[] {
    return pts.map((p) => {
        const inO = p.inAbs ? { x: p.inAbs.x - p.x, y: p.inAbs.y - p.y } : undefined;
        const outO = p.outAbs ? { x: p.outAbs.x - p.x, y: p.outAbs.y - p.y } : undefined;
        let kind: PathAnchor['kind'] = 'corner';
        if (inO || outO) {
            const eps = 1e-9 * (1 + Math.abs(p.x) + Math.abs(p.y));
            kind = inO && outO
                && Math.abs(inO.x + outO.x) <= eps && Math.abs(inO.y + outO.y) <= eps
                ? 'smooth' : 'cusp';
        }
        return { x: p.x, y: p.y, in: inO, out: outO, kind };
    });
}

// ── Arc → cubics (SVG spec F.6.5 endpoint→center, then ≤90° cubic slices) ───────────────────────────────────

/** Returns [c1, c2, end] triples approximating the arc from `p1` to `p2`. Degenerate radii → one line-ish
 *  cubic (controls on the chord), per the SVG spec's "treat as straight line" rule. */
export function arcToCubics(
    p1: Pt, p2: Pt, rx: number, ry: number, xRotDeg: number, largeArc: 0 | 1, sweep: 0 | 1,
): [Pt, Pt, Pt][] {
    if (rx === 0 || ry === 0 || (p1.x === p2.x && p1.y === p2.y)) {
        const c1 = { x: p1.x + (p2.x - p1.x) / 3, y: p1.y + (p2.y - p1.y) / 3 };
        const c2 = { x: p1.x + 2 * (p2.x - p1.x) / 3, y: p1.y + 2 * (p2.y - p1.y) / 3 };
        return [[c1, c2, { ...p2 }]];
    }
    const phi = (xRotDeg * Math.PI) / 180;
    const cosP = Math.cos(phi), sinP = Math.sin(phi);

    // F.6.5.1 — midpoint frame
    const dx = (p1.x - p2.x) / 2, dy = (p1.y - p2.y) / 2;
    const x1p = cosP * dx + sinP * dy;
    const y1p = -sinP * dx + cosP * dy;

    // F.6.6 — scale radii up if the endpoints can't be reached
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }

    // F.6.5.2 — center in the primed frame
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const k = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
    const cxp = k * (rx * y1p) / ry;
    const cyp = k * (-ry * x1p) / rx;

    // F.6.5.3 — center back in user space
    const cx = cosP * cxp - sinP * cyp + (p1.x + p2.x) / 2;
    const cy = sinP * cxp + cosP * cyp + (p1.y + p2.y) / 2;

    // F.6.5.5/6 — start angle + sweep extent
    const ang = (ux: number, uy: number, vx: number, vy: number) => {
        const sign = ux * vy - uy * vx < 0 ? -1 : 1;
        const dot = ux * vx + uy * vy;
        return sign * Math.acos(Math.min(1, Math.max(-1, dot / (Math.hypot(ux, uy) * Math.hypot(vx, vy)))));
    };
    const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dth > 0) dth -= 2 * Math.PI;
    if (sweep && dth < 0) dth += 2 * Math.PI;

    // Point + tangent on the (rotated) ellipse at parameter θ.
    const at = (t: number): Pt => ({
        x: cx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP,
        y: cy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP,
    });
    const tangent = (t: number): Pt => ({
        x: -rx * Math.sin(t) * cosP - ry * Math.cos(t) * sinP,
        y: -rx * Math.sin(t) * sinP + ry * Math.cos(t) * cosP,
    });

    const slices = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
    const step = dth / slices;
    const out: [Pt, Pt, Pt][] = [];
    for (let i = 0; i < slices; i++) {
        const a = th1 + i * step, b = a + step;
        const kk = (4 / 3) * Math.tan((b - a) / 4);
        const pa = at(a), pb = at(b), ta = tangent(a), tb = tangent(b);
        out.push([
            { x: pa.x + kk * ta.x, y: pa.y + kk * ta.y },
            { x: pb.x - kk * tb.x, y: pb.y - kk * tb.y },
            pb,
        ]);
    }
    // Snap the final endpoint exactly onto p2 (kills accumulated float error so Z-merging works).
    out[out.length - 1][2] = { ...p2 };
    return out;
}
