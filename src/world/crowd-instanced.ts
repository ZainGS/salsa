// ── World generation — the INSTANCED static crowd (performance-plan P12) ───────────────────────────────────────────
// The baked crowd (pedestrians.ts, `instancedCrowd: false`) merges every person's posed vertices into per-colour layers,
// three times (near / mid / xfar tiers): ~87 MB of vertex data per full tile and one 18 MB upload when a tile lands.
// Its people are nearly all DIFFERENT (clothes cut x hair x bag x pose x height: ~3 people share a shape), so a shared
// mesh cannot stand in for the close-up ones. This build therefore splits the crowd by distance:
//
//   · XFAR (past ~100 m, ~15 px tall): GPU-INSTANCED shared variants. A variant is a coarse silhouette CLASS (garment,
//     skirt length, hair length, bag kind, umbrella, pose silhouette — see xfarSignature) emitted ONCE at the cheapest
//     tessellation (lod 2) for a canonical 1.70 m person; each person is a copy with a (width, height, width) scale
//     and its own palette (crowd-palette.ts: per-vertex SLOT codes, per-instance colours). One ArrayGroup per (tile,
//     variant) — ~65 a tile (CROWD_XFAR). The variant geometry is shared by every tile (instanceKey → one allocation).
//   · NEAR / MID (inside ~30 m / ~100 m): the EXACT baked people (same emitPerson call, same tessellation), built
//     lazily on the main thread for the tile-aligned 50 m cells around the camera only (services/managers/world-crowd.ts), one
//     palette-coded mesh per cell (no per-colour split) — so street level looks identical to the baked crowd.
//
// What this module produces per build: the xfar instanced layers, and ONE AUX layer that is never a mesh: its geometry
// is the people's ground footprints (the contact-blob pass sees it like any crowd layer: one blob per person /
// conversation group, as before) and it carries the person RECORDS (CREC_*) — every input the main thread needs to
// emit any person exactly like the baked build. The drape pass fills each record's build → render offset (a RIGID
// per-person offset sampled at the feet: the baked crowd draped per vertex, which on flat paving is the same).
// Pure + worker-safe.

import type { WorldGraph, LayoutPreviewLayer, CrowdRecords, InstanceXform } from './types';
import { cityMetresPerUnit } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../renderer/3d/mesh-generators';
import { Accum3D } from './meshbuild';
import { pavementLift } from './street-slots';
import { staticCrowd, staticPersonSpec, PED_NEAR_M, PED_XFAR_M, type StaticPerson } from './pedestrians';
import {
    emitPerson, personLook, armHold, poseLeadSide, pedShadeColor, PED_SHADE, PV_COUNT,
    type PersonLook, type PersonSink, type PedColor, type Pose,
} from './mannequin';
import { crowdPaletteIndex, packCrowdSlots, CROWD_SLOT_BASE, CROWD_PALETTE } from '../renderer/3d/crowd-palette';
import type { CrowdPerson, CrowdMeta, CrowdGeometry } from './crowd-live';
import { triRunBoxes } from '../game/collision-cells';

/** Near / mid cells per tile edge: the lazily built tiers are resident per cell, so a cell is what the camera pays for.
 *  6 → 50 m at the default scale (a 300 m tile). Cells are TILE-ALIGNED (the centre tile spans [-R, R], tile (tx, tz)
 *  is offset by 2R), so no cell straddles two tiles. */
export const CROWD_CELLS_PER_TILE = 6;
/** XFAR tuning: one xfar cell = `bigK` x `bigK` near cells (default: the whole tile — one instanced group per variant per
 *  tile, ~65 a tile; single people hide per instance. A quarter tile measured 2x the groups and ~+3 ms renderer CPU in
 *  a 3x3); `detail` = how fine the shared silhouette classes are (0 coarse, 1 finer — see xfarSignature). A plain
 *  object so probes can sweep it; builds read it at build time (workers: the defaults). */
export const CROWD_XFAR = { bigK: CROWD_CELLS_PER_TILE, detail: 0 };

export const CROWD_POSES: readonly Pose[] = ['stand', 'sit', 'clasp', 'phone', 'stride', 'ride', 'rest', 'talk', 'lean', 'rail'];
export const CROWD_KINDS: readonly StaticPerson['kind'][] = ['stroll', 'group', 'window', 'wait', 'seat', 'vend', 'stall', 'crowd', 'lean', 'rail'];

// ── Records ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const CREC_X = 0, CREC_Y = 1, CREC_Z = 2, CREC_FX = 3, CREC_FZ = 4, CREC_ARCH = 5, CREC_LOOK = 6, CREC_POSE = 7,
    CREC_UMB = 8, CREC_CLOSED = 9, CREC_FLIP = 10, CREC_RAILY = 11, CREC_RAILD = 12, CREC_GROUP = 13, CREC_SEED = 14,
    CREC_DECK = 15, CREC_KIND = 16, CREC_DX = 17, CREC_DY = 18, CREC_DZ = 19, CREC_CX = 20, CREC_CZ = 21;
export const CREC_STRIDE = 22;

/** Small-cell grid coordinates → one integer key (and back). */
export const CELL_OFF = 32768;
export const cellKey = (cx: number, cz: number): number => (cx + CELL_OFF) * 65536 + (cz + CELL_OFF);
export const cellOfKey = (k: number): [number, number] => [Math.floor(k / 65536) - CELL_OFF, (k % 65536) - CELL_OFF];

/** One record's emit inputs (main thread). */
export interface CrowdEmitInput { o: [number, number, number]; f: [number, number]; look: PersonLook; pose: Pose; umb: PedColor | null; closed: boolean; flip: boolean; rail?: { y: number; d: number } }
const PAL_NAMES = CROWD_PALETTE.map(e => e[0]) as PedColor[];
export function recordInput(r: CrowdRecords, i: number): CrowdEmitInput {
    const R = r.recs, o = i * CREC_STRIDE;
    const ui = R[o + CREC_UMB];
    const inp: CrowdEmitInput = {
        o: [R[o + CREC_X], R[o + CREC_Y], R[o + CREC_Z]], f: [R[o + CREC_FX], R[o + CREC_FZ]],
        look: personLook(R[o + CREC_ARCH], R[o + CREC_LOOK]), pose: CROWD_POSES[R[o + CREC_POSE]] ?? 'stand',
        umb: ui >= 0 ? PAL_NAMES[ui] : null, closed: R[o + CREC_CLOSED] > 0, flip: R[o + CREC_FLIP] > 0,
    };
    if (R[o + CREC_RAILY] === R[o + CREC_RAILY]) inp.rail = { y: R[o + CREC_RAILY], d: R[o + CREC_RAILD] };   // (NaN = none)
    return inp;
}

/** The live crowd's per-person record (crowd-live.ts CrowdPerson) for every record — built once per block; the pivots
 *  are filled by the first near / mid emission of that person. */
export function crowdPeopleOf(r: CrowdRecords): CrowdPerson[] {
    const out: CrowdPerson[] = [];
    for (let i = 0; i < r.n; i++) {
        const R = r.recs, o = i * CREC_STRIDE, inp = recordInput(r, i);
        const cu = !!(inp.umb && inp.closed);
        out.push({
            x: R[o + CREC_X], z: R[o + CREC_Z], yaw: Math.atan2(-R[o + CREC_FZ], R[o + CREC_FX]), pose: inp.pose,
            kind: CROWD_KINDS[R[o + CREC_KIND]] ?? 'stroll', group: R[o + CREC_GROUP], seed: R[o + CREC_SEED],
            k: inp.look.heightM / 1.7, u: r.u, lead: poseLeadSide(inp.flip),
            holdL: armHold(inp.look, inp.pose, -1, inp.umb, cu), holdR: armHold(inp.look, inp.pose, 1, inp.umb, cu),
            piv: new Array<number>(PV_COUNT * 3).fill(0),
        });
    }
    return out;
}

/** Drape the records (the rigid per-person build → render offset): the height tier at the feet (bridge-deck people on
 *  the SMOOTH field, like their baked layer), then the domain warp displacement at the feet. Idempotent. */
export function drapeCrowdRecords(r: CrowdRecords, heightFn: (x: number, z: number) => number, smoothFn: (x: number, z: number) => number,
    warpInto: ((x: number, z: number, out: [number, number]) => void) | null): void {
    if (r.draped) return;
    const R = r.recs, ws: [number, number] = [0, 0];
    for (let i = 0; i < r.n; i++) {
        const o = i * CREC_STRIDE, x = R[o + CREC_X], z = R[o + CREC_Z];
        R[o + CREC_DY] = (R[o + CREC_DECK] > 0 ? smoothFn : heightFn)(x, z);
        if (warpInto) { warpInto(x, z, ws); R[o + CREC_DX] = ws[0]; R[o + CREC_DZ] = ws[1]; }
    }
    r.draped = true;
}

// ── Palette-coded emission ───────────────────────────────────────────────────────────────────────────────────────
/** Merge per-code accumulators into ONE geometry whose vertices carry their code in uv.x (crowd-palette.ts). Returns the
 *  geometry and each accumulator's first index (to rebase recorded index ranges). */
function mergeCoded(accs: Map<number, Accum3D>): { geometry: MeshGeometry & { bounds?: Float32Array }; base: Map<Accum3D, { v: number; i: number }> } {
    let nv = 0, ni = 0;
    for (const a of accs.values()) { nv += a.vertCount; ni += a.indexCount; }
    const V = new Float32Array(nv * FLOATS_PER_VERT), I = new Uint32Array(ni);
    const base = new Map<Accum3D, { v: number; i: number }>();
    let vo = 0, io = 0;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const [code, a] of accs) {
        base.set(a, { v: vo, i: io });
        const av = a.vertexView, ai = a.indexView, n = a.vertCount;
        V.set(av, vo * FLOATS_PER_VERT);
        for (let k = 0; k < n; k++) {
            const o = (vo + k) * FLOATS_PER_VERT;
            V[o + 6] = code; V[o + 7] = 0;
            const x = V[o], y = V[o + 1], z = V[o + 2];
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        for (let k = 0; k < ai.length; k++) I[io + k] = ai[k] + vo;
        vo += n; io += ai.length;
    }
    const geometry: MeshGeometry & { bounds?: Float32Array } = { vertices: V, indices: I, format: '12float' };
    if (nv) geometry.bounds = Float32Array.of(x0, y0, z0, x1, y1, z1);
    return { geometry, base };
}

/** Palette code of a colour name (a fixed colour). */
const codeOf = (c: PedColor): number => Math.max(0, crowdPaletteIndex(c));

/**
 * Emits a set of records' people at one tier (0 = HIGH / near, 1 = mid) into ONE palette-coded geometry with the live
 * crowd's per-(person, part) ranges — exactly the vertices the baked build would put in its per-colour layers (same
 * emitPerson call, same pivots), translated by each person's drape offset. Time-sliced: `step(ms)` emits people until
 * the budget is spent; `finish()` merges.
 */
export class CrowdCellBuilder {
    private readonly accs = new Map<number, Accum3D>();
    private readonly segs = new Map<Accum3D, { start: number; out: number[] }>();
    private readonly touched: Accum3D[] = [];
    private curPart = 0;
    private curPerson = 0;
    private next = 0;
    constructor(private readonly rec: CrowdRecords, private readonly people: CrowdPerson[], private readonly list: ArrayLike<number>, readonly lod: 0 | 1) {}
    get done(): boolean { return this.next >= this.list.length; }
    get count(): number { return this.list.length; }
    private acc(c: PedColor): Accum3D {
        const code = codeOf(c);
        let a = this.accs.get(code);
        if (!a) { a = new Accum3D(); this.accs.set(code, a); this.segs.set(a, { start: 0, out: [] }); }
        if (!this.touched.includes(a)) { this.segs.get(a)!.start = a.indexCount; this.touched.push(a); }
        return a;
    }
    private flush(): void {
        for (const a of this.touched) {
            const sg = this.segs.get(a)!, n = a.indexCount - sg.start;
            if (n > 0) sg.out.push(this.curPerson, this.curPart, sg.start, n);
            sg.start = a.indexCount;
        }
    }
    /** Emit people until `budgetMs` is spent (at least one). Returns true when every person is emitted. */
    step(budgetMs = Infinity): boolean {
        const t0 = budgetMs === Infinity ? 0 : now();
        while (this.next < this.list.length) {
            this.emitOne(this.list[this.next++]);
            if (budgetMs !== Infinity && now() - t0 >= budgetMs) break;
        }
        return this.done;
    }
    private emitOne(i: number): void {
        const inp = recordInput(this.rec, i), look = inp.look, R = this.rec.recs, o = i * CREC_STRIDE;
        const sink: PersonSink = {
            top: () => this.acc(look.top), skin: () => this.acc('skin'), hair: () => this.acc(look.hair),
            leg: () => this.acc(look.legs), shoes: () => this.acc(look.shoes), skirt: () => look.skirt ? this.acc(look.skirt) : null,
            bag: () => this.acc(look.bagColor), umbrella: () => inp.umb ? this.acc(inp.umb) : null, collar: () => look.collar ? this.acc(look.collar) : null,
            extra: (c) => this.acc(c),
            mark: (part) => { this.flush(); this.curPart = part; },
        };
        // every accumulator's vertex count before this person (the rigid drape offset is applied to the new ones)
        const before = new Map<Accum3D, number>();
        for (const a of this.accs.values()) before.set(a, a.vertCount);
        this.touched.length = 0; this.curPerson = i; this.curPart = 0;
        emitPerson(sink, { o: inp.o, f: inp.f, u: this.rec.u }, look, {
            pose: inp.pose, umbrella: inp.umb, umbrellaClosed: inp.closed, lod: this.lod, flip: inp.flip, pivots: this.people[i].piv,
            ...(inp.rail ? { rail: inp.rail } : {}),
        });
        this.flush();
        const dx = R[o + CREC_DX], dy = R[o + CREC_DY], dz = R[o + CREC_DZ];
        if (dx || dy || dz) for (const a of this.accs.values()) { const b = before.get(a) ?? 0; if (a.vertCount > b) a.offsetFrom(b, dx, dy, dz); }
    }
    /** Merge into the cell geometry + its live-crowd metadata. */
    finish(): CrowdGeometry & { bounds?: Float32Array } {
        this.step();
        const { geometry, base } = mergeCoded(this.accs);
        const g = geometry as CrowdGeometry & { bounds?: Float32Array };
        const flat: number[] = [];
        for (const a of this.accs.values()) {
            const b = base.get(a)!.i, out = this.segs.get(a)!.out;
            for (let k = 0; k < out.length; k += 4) flat.push(out[k], out[k + 1], out[k + 2] + b, out[k + 3]);
        }
        const ranges = Uint32Array.from(flat), n = ranges.length / 4, refs = new Float32Array(n * 3), R = this.rec.recs;
        for (let r = 0; r < n; r++) {
            const vi = g.indices[ranges[r * 4 + 2]] * FLOATS_PER_VERT, o = ranges[r * 4] * CREC_STRIDE;
            // build-space reference = the render vertex minus the person's drape offset (crowd-live.ts CrowdMeta.refs)
            refs[r * 3] = g.vertices[vi] - R[o + CREC_DX]; refs[r * 3 + 1] = g.vertices[vi + 1] - R[o + CREC_DY]; refs[r * 3 + 2] = g.vertices[vi + 2] - R[o + CREC_DZ];
        }
        const meta: CrowdMeta = { people: this.people, ranges, refs };
        g.crowd = meta;
        return g;
    }
}
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ── Step 3: a cell build OFF the main thread (the 'near' worker lane, services/workers/near-jobs.ts) ────────────────
/** One cell's people as a self-contained job: their record ROWS only (the main thread keeps the block). */
export interface CrowdCellJob { recs: Float64Array; n: number; u: number; cell: number; d1: number; d2: number; id: string; lod: 0 | 1 }
/** The worker's answer: the merged cell geometry, its live-crowd ranges / refs with LOCAL person indices (row order
 *  of the job), and every person's joint pivots (PV_COUNT x 3 each — emitPerson's OUT pivots). */
export interface CrowdCellResult { vertices: Float32Array; indices: Uint32Array; bounds: Float32Array | null; ranges: Uint32Array; refs: Float32Array; piv: Float64Array;
    /** The Play collision cells' run boxes (collision-cells.ts triRunBoxes), computed with the build. */
    runBoxes?: Float32Array }

/** The record rows of `list` (in list order) as a CrowdCellJob. */
export function crowdCellJob(rec: CrowdRecords, list: ArrayLike<number>, lod: 0 | 1): CrowdCellJob {
    const n = list.length, recs = new Float64Array(n * CREC_STRIDE);
    for (let k = 0; k < n; k++) recs.set(rec.recs.subarray(list[k] * CREC_STRIDE, (list[k] + 1) * CREC_STRIDE), k * CREC_STRIDE);
    return { recs, n, u: rec.u, cell: rec.cell, d1: rec.d1, d2: rec.d2, id: rec.id, lod };
}

/** Build one cell from its rows: CrowdCellBuilder over the job's own records (every input of a person is in its row,
 *  so the geometry is the main-thread build's, number for number). */
export function buildCrowdCell(job: CrowdCellJob): CrowdCellResult {
    const rec: CrowdRecords = { id: job.id, recs: job.recs, n: job.n, u: job.u, cell: job.cell, d1: job.d1, d2: job.d2, draped: true };
    const people = crowdPeopleOf(rec);
    const list = new Uint32Array(job.n); for (let k = 0; k < job.n; k++) list[k] = k;
    const g = new CrowdCellBuilder(rec, people, list, job.lod).finish();
    const P = PV_COUNT * 3, piv = new Float64Array(job.n * P);
    for (let k = 0; k < job.n; k++) { const pv = people[k].piv; for (let j = 0; j < P; j++) piv[k * P + j] = pv[j]; }
    return { vertices: g.vertices, indices: g.indices, bounds: g.bounds ?? null, ranges: g.crowd!.ranges, refs: g.crowd!.refs, piv, runBoxes: triRunBoxes(g.vertices, g.indices) };
}

/** The main-thread side of a worker cell: the CrowdGeometry CrowdCellBuilder.finish would have returned for `list`
 *  of `people` (ranges' person indices back to the block's, the meta on the block's people), and the pivots written
 *  into those people as the emission would have. */
export function adoptCrowdCell(res: CrowdCellResult, people: CrowdPerson[], list: ArrayLike<number>): CrowdGeometry & { bounds?: Float32Array } {
    const P = PV_COUNT * 3;
    for (let k = 0; k < list.length; k++) { const pv = people[list[k]].piv; for (let j = 0; j < P; j++) pv[j] = res.piv[k * P + j]; }
    const ranges = res.ranges;
    for (let r = 0; r < ranges.length; r += 4) ranges[r] = list[ranges[r]];
    const g: CrowdGeometry & { bounds?: Float32Array } = { vertices: res.vertices, indices: res.indices, format: '12float' };
    if (res.bounds) g.bounds = res.bounds;
    if (res.runBoxes) (g as { runBoxes?: Float32Array }).runBoxes = res.runBoxes;
    g.crowd = { people, ranges, refs: res.refs };
    return g;
}

// ── XFAR variants ────────────────────────────────────────────────────────────────────────────────────────────────
/** Per-instance palette SLOTS of a shared variant (crowd-palette.ts: code = CROWD_SLOT_BASE + slot). */
export const SLOT_TOP = 0, SLOT_HAIR = 1, SLOT_LEGS = 2, SLOT_SHOES = 3, SLOT_SKIRT = 4, SLOT_BAG = 5, SLOT_UMB = 6, SLOT_COLLAR = 7, SLOT_HAT = 8, SLOT_TIE = 9;
/** The canonical variant look's stand-in colours for the parts emitted through `extra(colour)` (the collar / obi,
 *  the tie, the hat) — unique, so the variant sink can tell which slot an extra belongs to. */
const CANON = { top: 'olive', collarShirt: 'shirt', collar: 'cream', tie: 'navy', hat: 'khaki' } as const;

/** The coarse silhouette CLASS an xfar copy shares (see the header) — what still reads at ~15 px: the garment and its
 *  length, a skirt (short pleats / long), long or short hair, a backpack or a side bag, an open or a furled umbrella,
 *  and the pose's silhouette (standing — the arm holds and the mirroring merge — striding, seated, wall-leaning, at a
 *  rail). detail 1 also splits the figure (fem), a hat and a white shirt front. ~50 classes a tile at detail 0 (~77
 *  at 1) vs ~400 exact shapes; ~85 over a 3x3 window. The colours are the copy's own either way. */
export function xfarSignature(look: PersonLook, pose: Pose, umb: PedColor | null, closed: boolean, detail = CROWD_XFAR.detail): string {
    const fine = detail >= 1;
    return [fine ? (look.fem ? 'f' : 'm') : '', look.garment, !look.skirt ? '-' : look.skirtCut === 'pleat' ? 's' : 'l', hairClass(look) ? 'L' : 'S',
        look.bag === 'none' ? '-' : look.bag === 'backpack' ? 'b' : 's', fine && look.hat !== 'none' ? 'h' : '-', fine && collarPlate(look) ? 'p' : '-',
        umb ? (closed ? 'c' : 'o') : '-', xfarPose(pose), fine ? '' : '0'].join('');
}
const hairClass = (look: PersonLook): boolean => look.hairStyle === 'long' || look.hairStyle === 'bob';
const collarPlate = (look: PersonLook): boolean => !!look.collar && look.collar !== look.top;
/** The pose a class is emitted in. */
export function xfarPose(pose: Pose): Pose { return pose === 'stride' || pose === 'sit' || pose === 'lean' || pose === 'rail' || pose === 'ride' ? pose : 'stand'; }
/** The canonical 1.70 m look of a class (stand-in colours; the real ones come from the copy's slots). */
function canonicalLook(look: PersonLook, detail = CROWD_XFAR.detail): PersonLook {
    const robe = look.garment === 'robe', fine = detail >= 1;
    const fem = fine ? look.fem : !!look.skirt;   // (a pure function of the class: the key must name ONE geometry)
    return {
        ...look, fem, heightM: 1.7, build: 1, top: CANON.top as PedColor, legs: 'denim', shoes: 'brown', hair: 'hairBrown',
        hairStyle: hairClass(look) ? 'bob' : look.fem ? 'bun' : 'short',
        skirt: look.skirt ? 'teal' : null, skirtCut: look.skirt && look.skirtCut === 'pleat' ? 'pleat' : 'aline',
        bag: look.bag === 'none' ? 'none' : look.bag === 'backpack' ? 'backpack' : 'shoulder', bagColor: 'camel',
        hat: fine && look.hat !== 'none' ? 'cap' : 'none', hatColor: CANON.hat as PedColor,
        collar: robe ? (look.collar ? CANON.collar as PedColor : null) : fine && collarPlate(look) ? CANON.collar as PedColor : null,
        sleeve: look.sleeve === 'wide' ? 'wide' : 'long', open: false, phone: false, shoe: look.shoe === 'geta' ? 'geta' : look.fem ? 'pump' : 'dress',
    };
}
/** A copy's packed palette slots (its real colours). */
export function personSlots(look: PersonLook, umb: PedColor | null): [number, number, number] {
    const s: number[] = new Array(10).fill(0);
    s[SLOT_TOP] = codeOf(look.top); s[SLOT_HAIR] = codeOf(look.hair); s[SLOT_LEGS] = codeOf(look.legs); s[SLOT_SHOES] = codeOf(look.shoes);
    s[SLOT_SKIRT] = look.skirt ? codeOf(look.skirt) : 0; s[SLOT_BAG] = codeOf(look.bagColor); s[SLOT_UMB] = umb ? codeOf(umb) : 0;
    s[SLOT_COLLAR] = look.collar ? codeOf(look.collar) : 0; s[SLOT_HAT] = codeOf(look.hatColor);
    s[SLOT_TIE] = codeOf(look.top === 'navy' ? 'charcoal' : 'navy');
    return packCrowdSlots(s);
}

export interface XfarVariant {
    key: string;
    geometry: MeshGeometry & { bounds?: Float32Array };
    /** Ground footprint (local XZ convex hull, metres x u, canonical person) + its lowest local Y. */
    hull: number[]; minY: number;
}
const _variants = new Map<string, XfarVariant>();
/** Tests: forget the cached variants (the next build re-emits them). */
export function clearXfarVariantCache(): void { _variants.clear(); }
/** The shared xfar variant of a person (module-cached; the key is content-complete, so every build / tile / thread
 *  that names a key emits the identical geometry — the GPU pool shares it by key). */
export function xfarVariant(look: PersonLook, pose0: Pose, umb: PedColor | null, closed: boolean, rail: { y: number; d: number } | undefined, u: number): XfarVariant {
    const pose = xfarPose(pose0), flip = false;
    if (pose !== 'rail') rail = undefined;
    const sig = xfarSignature(look, pose, umb, closed);
    const key = `crowd-xf${CROWD_XFAR.detail}:${u.toFixed(6)}:${rail ? rail.y.toFixed(5) + ',' + rail.d.toFixed(5) : '-'}:${sig}`;
    let v = _variants.get(key);
    if (v) return v;
    const cl = canonicalLook(look);
    const accs = new Map<number, Accum3D>();
    const slotAcc = (code: number): Accum3D => { let a = accs.get(code); if (!a) { a = new Accum3D(); accs.set(code, a); } return a; };
    const S = (slot: number): Accum3D => slotAcc(CROWD_SLOT_BASE + slot);
    const sink: PersonSink = {
        top: () => S(SLOT_TOP), skin: () => slotAcc(codeOf('skin')), hair: () => S(SLOT_HAIR), leg: () => S(SLOT_LEGS), shoes: () => S(SLOT_SHOES),
        skirt: () => cl.skirt ? S(SLOT_SKIRT) : null, bag: () => S(SLOT_BAG), umbrella: () => umb ? S(SLOT_UMB) : null,
        collar: () => cl.collar ? S(SLOT_COLLAR) : null,
        extra: (c) => c === CANON.collar || c === CANON.collarShirt ? S(SLOT_COLLAR) : c === CANON.tie ? S(SLOT_TIE) : c === CANON.hat ? S(SLOT_HAT) : slotAcc(codeOf(c)),
    };
    emitPerson(sink, { o: [0, 0, 0], f: [1, 0], u }, cl, { pose, umbrella: umb ? 'umbRed' : null, umbrellaClosed: closed, lod: 2, flip, ...(rail ? { rail } : {}) });
    const { geometry } = mergeCoded(accs);
    // footprint: convex hull of the XZ positions + the lowest Y
    const vv = geometry.vertices, pts: [number, number][] = [];
    let minY = Infinity;
    for (let o = 0; o < vv.length; o += FLOATS_PER_VERT) { pts.push([vv[o], vv[o + 2]]); if (vv[o + 1] < minY) minY = vv[o + 1]; }
    v = { key, geometry, hull: convexHull(pts), minY: minY === Infinity ? 0 : minY };
    _variants.set(key, v);
    return v;
}
/** Andrew's monotone chain; returns a flat [x0, z0, x1, z1, ...] counter-clockwise hull. */
function convexHull(p: [number, number][]): number[] {
    if (p.length < 3) return p.flat();
    p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo: [number, number][] = [], hi: [number, number][] = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
    return [...lo.slice(0, -1), ...hi.slice(0, -1)].flat();
}

// ── The build ────────────────────────────────────────────────────────────────────────────────────────────────────
let _buildSerial = 0;

/** The instanced crowd's layers for a graph (see the header): xfar instanced layers per (xfar cell, variant, deck) +
 *  the AUX footprint / records layers. Same people, same order, same hashes as the baked build (staticPersonSpec). */
export function buildPedestriansInstanced(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const p = graph.params;
    const people = staticCrowd(graph, keep);
    if (!people.length) return [];
    const u = 1 / cityMetresPerUnit(p.radius), gy = p.groundY + pavementLift(p);
    const R0 = p.radius, cell = (2 * R0) / CROWD_CELLS_PER_TILE, n = people.length;
    const id = `crowd:${p.seed}:${p.tileOrigin ? p.tileOrigin.join(',') : 'c'}:${n}:${(++_buildSerial).toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
    const rec: CrowdRecords = { id, recs: new Float64Array(n * CREC_STRIDE), n, u, cell, d1: PED_NEAR_M * u, d2: PED_XFAR_M * u };
    const R = rec.recs;
    // xfar layers, keyed by (big cell, deck, variant) in first-seen order (deterministic)
    const groups = new Map<string, { v: XfarVariant; deck: boolean; inst: InstanceXform[] }>();
    // ground footprints (two pseudo-geometries: ground people drape on the full field, deck people on the smooth one)
    const fp = [new Accum3D(), new Accum3D()];
    people.forEach((pp, i) => {
        const sp = staticPersonSpec(p, pp, i), look = sp.look, o = i * CREC_STRIDE, deck = pp.deckY !== undefined;
        R[o + CREC_X] = pp.x; R[o + CREC_Y] = sp.y; R[o + CREC_Z] = pp.z; R[o + CREC_FX] = pp.face[0]; R[o + CREC_FZ] = pp.face[1];
        R[o + CREC_ARCH] = sp.arch; R[o + CREC_LOOK] = sp.lookSeed; R[o + CREC_POSE] = Math.max(0, CROWD_POSES.indexOf(sp.pose));
        R[o + CREC_UMB] = sp.umb ? crowdPaletteIndex(sp.umb) : -1; R[o + CREC_CLOSED] = sp.closed ? 1 : 0; R[o + CREC_FLIP] = sp.flip ? 1 : 0;
        R[o + CREC_RAILY] = pp.rail ? pp.rail.y : NaN; R[o + CREC_RAILD] = pp.rail ? pp.rail.d : NaN;
        R[o + CREC_GROUP] = pp.group ?? -1; R[o + CREC_SEED] = sp.seed; R[o + CREC_DECK] = deck ? 1 : 0;
        R[o + CREC_KIND] = Math.max(0, CROWD_KINDS.indexOf(pp.kind));
        const cx = Math.floor((pp.x + R0) / cell), cz = Math.floor((pp.z + R0) / cell);
        R[o + CREC_CX] = cx; R[o + CREC_CZ] = cz;
        const v = xfarVariant(look, sp.pose, sp.umb, sp.closed, pp.rail, u);
        const k = look.heightM / 1.7, w = look.build, ry = Math.atan2(-pp.face[1], pp.face[0]);
        const gk = `${Math.floor(cx / CROWD_XFAR.bigK)},${Math.floor(cz / CROWD_XFAR.bigK)}|${deck ? 1 : 0}|${v.key}`;
        let g = groups.get(gk);
        if (!g) { g = { v, deck, inst: [] }; groups.set(gk, g); }
        g.inst.push({ x: pp.x, y: sp.y, z: pp.z, ry, sv: [w, k, w], cs: personSlots(look, sp.umb), pi: i });
        // footprint: the variant's hull, scaled + rotated like the copy (Mesh3D rotateY: x' = x c + z s, z' = -x s + z c)
        const acc = fp[deck ? 1 : 0], c = Math.cos(ry), s = Math.sin(ry), h = v.hull, fy = sp.y + v.minY * k;
        if (h.length >= 6) {
            const b = acc.vertCount;
            for (let q = 0; q < h.length; q += 2) {
                const lx = h[q] * w, lz = h[q + 1] * w;
                acc.vertex([pp.x + lx * c + lz * s, fy, pp.z - lx * s + lz * c], [0, 1, 0], 0, 0);
            }
            for (let q = 2; q < h.length / 2; q++) acc.triangle(b, b + q - 1, b + q);
        }
    });
    const color = pedShadeColor([1, 1, 1]);
    const out: LayoutPreviewLayer[] = [];
    for (const g of groups.values()) {
        out.push({
            name: g.deck ? 'world:ped-deck-xfar' : 'world:ped-xfar', color, emissive: PED_SHADE.emissive, y: gy,
            geometry: g.v.geometry, instances: g.inst, arrayGroup: true, instanceKey: g.v.key, chunk: 'crowd', noContact: true,
            crowdInst: { id }, nearTwin: { key: 'crowd', role: 'xfar', dist: rec.d1, dist2: rec.d2 },
            ...(g.deck ? { drape: 'smooth' as const } : {}),
        });
    }
    out.push({ name: 'world:ped-aux', color: [0, 0, 0], y: gy, geometry: fp[0].geometry(), crowdAux: true, crowdRecords: rec, chunk: 'crowd' });
    if (!fp[1].empty) out.push({ name: 'world:ped-deck-aux', color: [0, 0, 0], y: gy, geometry: fp[1].geometry(), crowdAux: true, chunk: 'crowd', drape: 'smooth' });
    return out;
}

/** Bytes of one build's instanced-crowd payload (records + copies' transforms as they land on the GPU: one 240-byte
 *  instance slot per copy) — the per-tile number performance-plan P12 reports. Shared variant geometry excluded. */
export function crowdBuildBytes(layers: readonly LayoutPreviewLayer[]): { records: number; copies: number; slotBytes: number; footprint: number } {
    let records = 0, copies = 0, footprint = 0;
    for (const L of layers) {
        if (L.crowdRecords) records += L.crowdRecords.recs.byteLength;
        if (L.crowdInst && L.instances) copies += L.instances.length;
        if (L.crowdAux) footprint += L.geometry.vertices.byteLength + L.geometry.indices.byteLength;
    }
    return { records, copies, slotBytes: copies * 240, footprint };
}
