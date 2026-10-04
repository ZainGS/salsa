// SPATIAL CHUNKING for the city's merged layers (docs/specs/polish-round-3.md "Round 5 — culling").
//
// The city merges most of its content CITY-WIDE — one mesh per layer / colour (roads, pavements, kerbs, road paint,
// building detail, signs, the static crowd per colour, parked cars per colour, poles, wires …). One mesh's AABB then
// spans the whole city, so the renderer's per-mesh frustum cull can never reject it: at street level ~88 % of the
// city's triangles were submitted every frame even though most of them were behind the camera.
//
// `chunkCityLayers` splits every BIG layer into an nx × nz grid of cells over the layer's own XZ bounds, by TRIANGLE
// CENTROID (world-baked geometry) or by INSTANCE POSITION (GPU-instanced array layers), so off-screen cells cull.
// It is purely a partition: every output layer is the input layer (same name, material fields, pattern, GARP marker,
// instance key …) with a subset of its triangles / instances — no triangle is dropped, duplicated or moved, and the
// per-cell triangle order is the original order. Names are NOT suffixed: every name-keyed rule (the day/night GLOW
// table, the DETAIL/PROPS/FLATMAP LOD regexes, snow/wet, SIGNAL_LAMP_RE, the drape tiers …) keeps matching, and the
// consumers all iterate EVERY mesh (none looks one up by name). The cell id rides on `chunk` for diagnostics only.
//
// Grid choice per layer: n = floor(sqrt(tris / TARGET_TRIS)) cells per axis, capped by the layer's extent / MIN_CELL
// and by MAX_CELLS — so a layer only splits when each cell still carries a worthwhile batch of triangles (draw calls
// stay modest) AND is at least MIN_CELL wide (a compact layer is not shredded). Small layers pass through unchanged.
//
// Left alone (a split would change what you see, or buys nothing):
//   · transparent layers (opacity < 1) — they sort back-to-front PER MESH; splitting would change the blend order;
//   · layers with per-object `outlineRanges` (landmark hover silhouettes index into the merged index buffer);
//   · per-instance-mesh layers (instances without arrayGroup) — already one mesh per copy, they cull individually.
//
// PROCEDURAL GROUND: the renderer derives a per-mesh world-units-per-uv scale from (up to) 64 sampled triangles
// (ground-uv-scale.ts). Different chunks would sample different triangles — on draped (sloped) ground that is a
// slightly different scale per chunk, i.e. a visible paver-phase SEAM at every cell border. So a ground layer's
// chunks all carry `groundUvSample`: exactly the triangles the UNSPLIT layer would have sampled, which reproduces the
// unsplit scale bit-for-bit (see groundUvSampleGeometry).
//
// Pure + deterministic (no RNG, no globals besides the instance-key counter, which only names GPU pool shares).

import { FLOATS_PER_VERT, type MeshGeometry } from '../renderer/3d/mesh-generators';
import type { LayoutPreviewLayer } from './types';
import type { CrowdGeometry, CrowdMeta, CrowdPerson } from './crowd-live';

export interface ChunkOptions {
    /** Aim for at least this many triangles per cell (the draw-call vs cull-granularity trade). */
    targetTris?: number;
    /** Minimum cell width in world units — a layer narrower than 2 × this never splits along that axis. */
    minCell: number;
    /** Cap on cells per axis. */
    maxCells?: number;
    /** Instanced layers: minimum average instances per cell. */
    minInstances?: number;
}

export const CHUNK_TARGET_TRIS = 1500;
export const CHUNK_MAX_CELLS = 10;
export const CHUNK_MIN_INSTANCES = 4;
/** P7: instances with at least this many triangles each may sit alone in a cell (minInstances → 1). */
export const CHUNK_HEAVY_INSTANCE_TRIS = 300;

/** Default minimum cell width for a city of `radius` — 0.15 × radius (1.5 units ≈ 22 m at the default radius 10). */
export function chunkMinCell(radius: number): number {
    return Math.max(1e-3, radius * 0.15);
}

/** Cells per axis for a layer of `tris` triangles spanning `extX` × `extZ`. */
export function chunkGridFor(tris: number, extX: number, extZ: number, o: ChunkOptions): [number, number] {
    const target = o.targetTris ?? CHUNK_TARGET_TRIS, max = o.maxCells ?? CHUNK_MAX_CELLS;
    const n = Math.floor(Math.sqrt(Math.max(0, tris) / target));
    const nx = Math.max(1, Math.min(n, max, Math.floor(extX / o.minCell)));
    const nz = Math.max(1, Math.min(n, max, Math.floor(extZ / o.minCell)));
    return [nx, nz];
}

/** Triangles the renderer's ground-uv-scale sampler would visit on `geo` (the same stride rule as
 *  groundUvWorldScale: step = max(1, floor(tris / 64))), as a small standalone geometry. Run on this sample the
 *  sampler visits every triangle (≤ 127 of them → step 1) in the same order → the identical scale. */
export function groundUvSampleGeometry(geo: MeshGeometry): MeshGeometry {
    const ix = geo.indices, v = geo.vertices, S = FLOATS_PER_VERT;
    const tris = Math.floor(ix.length / 3);
    const step = Math.max(1, Math.floor(tris / 64));
    const picked: number[] = [];
    for (let t = 0; t < tris; t += step) picked.push(t);
    const vo = new Float32Array(picked.length * 3 * S), io = new Uint32Array(picked.length * 3);
    let k = 0;
    for (const t of picked) for (let c = 0; c < 3; c++, k++) {
        vo.set(v.subarray(ix[t * 3 + c] * S, ix[t * 3 + c] * S + S), k * S);
        io[k] = k;
    }
    return { vertices: vo, indices: io, format: '12float' };
}

/** Split one world-baked geometry into an nx × nz grid over [x0, x0 + nx·cw) × [z0, z0 + nz·cz) by triangle
 *  centroid (a centroid outside the grid clamps to the edge cell). Returns the NON-EMPTY cells in (iz, ix) order,
 *  each with compacted vertices (shared vertices are copied into every cell that uses them), remapped indices in the
 *  original triangle order, and precomputed `bounds` (Mesh3D skips its O(verts) scan). */
export function splitGeometryXZ(geo: MeshGeometry, nx: number, nz: number, x0: number, z0: number, cw: number, cz: number,
    cellOfIn?: Int32Array): { ix: number; iz: number; geometry: MeshGeometry }[] {
    const S = FLOATS_PER_VERT, v = geo.vertices, idx = geo.indices, vc = geo.vertexColors;
    const tris = Math.floor(idx.length / 3), nCells = nx * nz, nVerts = Math.floor(v.length / S);
    const cellOf = cellOfIn ?? triangleCells(geo, nx, nz, x0, z0, cw, cz), counts = new Int32Array(nCells);
    for (let t = 0; t < tris; t++) counts[cellOf[t]]++;
    // Counting sort of triangle ids by cell (stable → original order within each cell).
    const start = new Int32Array(nCells + 1);
    for (let i = 0; i < nCells; i++) start[i + 1] = start[i] + counts[i];
    const order = new Int32Array(tris), fill = start.slice(0, nCells);
    for (let t = 0; t < tris; t++) order[fill[cellOf[t]]++] = t;
    const remap = new Int32Array(nVerts), stamp = new Int32Array(nVerts).fill(-1);
    const out: { ix: number; iz: number; geometry: MeshGeometry }[] = [];
    for (let cell = 0; cell < nCells; cell++) {
        const n = counts[cell];
        if (!n) continue;
        const io = new Uint32Array(n * 3);
        let vCount = 0;
        // First pass: assign compacted vertex ids (in first-use order).
        for (let k = 0; k < n; k++) {
            const t = order[start[cell] + k];
            for (let c = 0; c < 3; c++) {
                const vi = idx[t * 3 + c];
                if (stamp[vi] !== cell) { stamp[vi] = cell; remap[vi] = vCount++; }
                io[k * 3 + c] = remap[vi];
            }
        }
        const vo = new Float32Array(vCount * S), co = vc ? new Float32Array(vCount * 4) : undefined;
        let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
        for (let k = 0; k < n; k++) {
            const t = order[start[cell] + k];
            for (let c = 0; c < 3; c++) {
                const vi = idx[t * 3 + c], o = remap[vi];
                if (stamp[vi] !== cell) continue;
                stamp[vi] = -2 - cell;   // written (distinct from 'assigned' so a vertex is copied once)
                vo.set(v.subarray(vi * S, vi * S + S), o * S);
                if (co && vc) co.set(vc.subarray(vi * 4, vi * 4 + 4), o * 4);
                const px = v[vi * S], py = v[vi * S + 1], pz = v[vi * S + 2];
                if (px < bx0) bx0 = px; if (px > bx1) bx1 = px;
                if (py < by0) by0 = py; if (py > by1) by1 = py;
                if (pz < bz0) bz0 = pz; if (pz > bz1) bz1 = pz;
            }
        }
        const g: MeshGeometry & { bounds?: Float32Array } = { vertices: vo, indices: io, format: geo.format ?? '12float' };
        if (co) g.vertexColors = co;
        g.bounds = Float32Array.of(bx0, by0, bz0, bx1, by1, bz1);
        out.push({ ix: cell % nx, iz: Math.floor(cell / nx), geometry: g });
    }
    return out;
}

/** Grid cell of every triangle of `geo` by centroid (clamped to the grid). */
function triangleCells(geo: MeshGeometry, nx: number, nz: number, x0: number, z0: number, cw: number, cz: number): Int32Array {
    const S = FLOATS_PER_VERT, v = geo.vertices, idx = geo.indices, tris = Math.floor(idx.length / 3);
    const cellOf = new Int32Array(tris);
    for (let t = 0; t < tris; t++) {
        const a = idx[t * 3] * S, b = idx[t * 3 + 1] * S, c = idx[t * 3 + 2] * S;
        const cx = (v[a] + v[b] + v[c]) / 3, czz = (v[a + 2] + v[b + 2] + v[c + 2]) / 3;
        let gx = Math.floor((cx - x0) / cw), gz = Math.floor((czz - z0) / cz);
        if (!(gx >= 0)) gx = 0; else if (gx >= nx) gx = nx - 1;   // !(>=0) also catches NaN
        if (!(gz >= 0)) gz = 0; else if (gz >= nz) gz = nz - 1;
        cellOf[t] = gz * nx + gx;
    }
    return cellOf;
}

/** LIVE-CROWD layers (geometry.crowd, crowd-live.ts): every triangle of one PERSON goes to the cell of that person's
 *  first triangle, so a person never straddles two cells and their part ranges stay contiguous (the stable split
 *  keeps the order) — then each cell gets its own remapped CrowdMeta. */
function crowdCells(geo: CrowdGeometry, base: Int32Array): Int32Array {
    const m = geo.crowd!, R = m.ranges, cellOf = base.slice();
    let person = -1, cell = 0;
    for (let r = 0; r < R.length; r += 4) {
        const t0 = R[r + 2] / 3, nt = R[r + 3] / 3;
        if (R[r] !== person) { person = R[r]; cell = base[t0]; }
        for (let t = t0; t < t0 + nt; t++) cellOf[t] = cell;
    }
    return cellOf;
}
/** LIVE-CROWD layers on a NEAR/FAR TWIN grid (the static crowd's HIGH + cheap bakes): each PERSON goes to the cell of
 *  their render-space ANCHOR (the build-space anchor + that range's build → render drift), memoised per person in
 *  `memo` so the two twins of one person always land in the SAME cell (exactly one of them draws per cell). */
function twinCrowdCells(geo: CrowdGeometry, tg: { nx: number; nz: number; x0: number; z0: number; cw: number; cz: number }, memo: Map<CrowdPerson, number>): Int32Array {
    const m = geo.crowd!, R = m.ranges, v = geo.vertices, ix = geo.indices;
    const cellOf = triangleCells(geo, tg.nx, tg.nz, tg.x0, tg.z0, tg.cw, tg.cz);
    for (let r = 0; r < R.length; r += 4) {
        const person = m.people[R[r]];
        let cell = memo.get(person);
        if (cell === undefined) {
            const vi = ix[R[r + 2]] * FLOATS_PER_VERT, q = (r / 4) * 3;
            const x = person.x + v[vi] - m.refs[q], z = person.z + v[vi + 2] - m.refs[q + 2];
            let gx = Math.floor((x - tg.x0) / tg.cw), gz = Math.floor((z - tg.z0) / tg.cz);
            if (!(gx >= 0)) gx = 0; else if (gx >= tg.nx) gx = tg.nx - 1;
            if (!(gz >= 0)) gz = 0; else if (gz >= tg.nz) gz = tg.nz - 1;
            cell = gz * tg.nx + gx;
            memo.set(person, cell);
        }
        const t0 = R[r + 2] / 3, nt = R[r + 3] / 3;
        for (let t = t0; t < t0 + nt; t++) cellOf[t] = cell;
    }
    return cellOf;
}
function remapCrowd(m: CrowdMeta, cellOf: Int32Array, nCells: number): Map<number, CrowdMeta> {
    const pos = new Int32Array(cellOf.length), run = new Int32Array(nCells);
    for (let t = 0; t < cellOf.length; t++) pos[t] = run[cellOf[t]]++;
    const acc = new Map<number, { r: number[]; f: number[] }>();
    const R = m.ranges;
    for (let r = 0; r < R.length; r += 4) {
        const t0 = R[r + 2] / 3, c = cellOf[t0];
        let e = acc.get(c); if (!e) { e = { r: [], f: [] }; acc.set(c, e); }
        e.r.push(R[r], R[r + 1], pos[t0] * 3, R[r + 3]);
        const q = (r / 4) * 3; e.f.push(m.refs[q], m.refs[q + 1], m.refs[q + 2]);
    }
    const out = new Map<number, CrowdMeta>();
    for (const [c, e] of acc) out.set(c, { people: m.people, ranges: Uint32Array.from(e.r), refs: Float32Array.from(e.f) });
    return out;
}

/** Whether `L`'s WORLD-BAKED geometry may be split (see the header's exclusions). */
function geometrySplittable(L: LayoutPreviewLayer): boolean {
    if (L.instances && L.instances.length) return false;
    if (L.outlineRanges && L.outlineRanges.length) return false;
    if (L.opacity !== undefined && L.opacity < 1) return false;
    const g = L.geometry;
    if (!g || !g.indices || !g.vertices) return false;
    if (g.format === '8float') return false;
    return g.vertices.length % FLOATS_PER_VERT === 0;
}

const _chunkKeys = new WeakMap<MeshGeometry, string>();
/** A GPU pool-share key for a canonical instanced geometry split across cells (one allocation for every cell's
 *  source mesh). CONTENT-derived (two FNV-1a hashes over the raw vertex + index words, plus the lengths): chunking
 *  runs both in the centre-build WORKER and on the main thread, so a per-context counter would hand two DIFFERENT
 *  geometries the same key (= the renderer drawing the wrong mesh). Equal content → equal key is always a valid share. */
export function chunkShareKey(g: MeshGeometry): string {
    let k = _chunkKeys.get(g);
    if (k) return k;
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    const mix = (w: ArrayLike<number>): void => {
        for (let i = 0; i < w.length; i++) {
            const x = w[i];
            h1 = Math.imul(h1 ^ x, 0x01000193);
            h2 = Math.imul(h2 ^ (x >>> 16 | x << 16), 0x85ebca6b);
        }
    };
    mix(new Uint32Array(g.vertices.buffer, g.vertices.byteOffset, g.vertices.length));
    mix(g.indices);
    k = `chunk:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${g.vertices.length}:${g.indices.length}`;
    _chunkKeys.set(g, k);
    return k;
}

/** City layer-GROUPS never chunked: the sky dome (stars / moon / clouds on a 2.2R dome — nothing to gain), the
 *  border glow (its edit pulse owns those meshes), the movers / visit doors (not built through the chunk step). */
export const CHUNK_SKIP_GROUPS = /World Sky|World Border Glow|World Traffic|World Visit Doors/;

/** Split `layers` into spatial cells (see the header). Unsplittable / small layers pass through as the SAME object;
 *  split layers are replaced, in place of the original, by their cells in (iz, ix) order. */
export function chunkCityLayers(layers: LayoutPreviewLayer[], o: ChunkOptions): LayoutPreviewLayer[] {
    const out: LayoutPreviewLayer[] = [];
    const twinGrids = nearTwinGrids(layers, o);
    const twinPeople = new Map<string, Map<CrowdPerson, number>>();   // twin key → person → cell (both twins agree)
    const twinCells: { key: string; cell: number; geometry: MeshGeometry }[] = [];
    const twinInstGrids = new Map<string, [number, number]>();        // P8: instanced twin key + instance set → grid
    for (const L of layers) {
        if (L.chunk) { out.push(L); continue; }   // already a cell (worker-chunked centre build) — never re-split
        // ── E2 near/far TWINS: every layer of a key splits on the family's ONE grid (so the pairs cover identical cells) ──
        const tg = L.nearTwin && geometrySplittable(L) ? twinGrids.get(L.nearTwin.key) : undefined;
        if (tg) {
            const crowd = (L.geometry as CrowdGeometry).crowd;
            let memo = twinPeople.get(L.nearTwin!.key);
            if (crowd && !memo) { memo = new Map(); twinPeople.set(L.nearTwin!.key, memo); }
            const tCells = crowd ? twinCrowdCells(L.geometry as CrowdGeometry, tg, memo!) : undefined;
            const cells = splitGeometryXZ(L.geometry, tg.nx, tg.nz, tg.x0, tg.z0, tg.cw, tg.cz, tCells);
            const tCrowd = crowd && tCells ? remapCrowd(crowd, tCells, tg.nx * tg.nz) : null;
            // Ground twins share the FAR (clean, exactly world-proportional) layer's uv-scale sample, so the chipped twin's
            // tiles land exactly where the clean one's do (chamfer strips would skew a sample of their own). P9 prop far
            // twins are the DEGRADED copy, so those take the near (original) layer's sample instead — the pre-twin scale.
            if (L.ground && !tg.sample) tg.sample = groundUvSampleGeometry((L.nearTwin!.uvFromNear ? tg.nearGeo : tg.farGeo) ?? L.geometry);
            const sample = L.ground ? tg.sample : undefined;
            for (const c of cells) {
                if (tCrowd) { const cm = tCrowd.get(c.iz * tg.nx + c.ix); if (cm) (c.geometry as CrowdGeometry).crowd = cm; }
                const cl: LayoutPreviewLayer = { ...L, geometry: c.geometry, chunk: `${c.ix}_${c.iz}/${tg.nx}x${tg.nz}` };
                if (sample) cl.groundUvSample = sample;
                out.push(cl);
                twinCells.push({ key: L.nearTwin!.key, cell: c.iz * tg.nx + c.ix, geometry: c.geometry });
            }
            continue;
        }
        // ── GPU-instanced array layer: partition the TRANSFORMS by position ──
        if (L.instances && L.instances.length && L.arrayGroup) {
            const T = L.instances;
            if (L.opacity !== undefined && L.opacity < 1) { out.push(L); continue; }
            let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
            for (const t of T) { if (t.x < x0) x0 = t.x; if (t.x > x1) x1 = t.x; if (t.z < z0) z0 = t.z; if (t.z > z1) z1 = t.z; }
            const triPer = Math.floor((L.geometry?.indices?.length ?? 0) / 3);
            // P8: instanced NEAR/FAR TWINS (the far tree crowns) must partition their identical transforms on ONE grid,
            // or a cell's near and far groups would cover different trees (both or neither drawn at the swap). The
            // first layer of a twin key + instance set fixes the grid (from the larger, near-twin-sized triangle
            // count), every later one reuses it.
            const twinSig = L.nearTwin ? `${L.nearTwin.key}|${T.length}|${x0},${z0},${x1},${z1}` : '';
            const twinGrid = twinSig ? twinInstGrids.get(twinSig) : undefined;
            const triGrid = twinSig ? Math.max(triPer, L.nearTwin!.gridTris ?? 0) : triPer;
            let [nx, nz] = twinGrid ?? chunkGridFor(triGrid * T.length, x1 - x0, z1 - z0, o);
            // P7: HEAVY instances (a tree's leaf cards, a vending machine's cans: hundreds of triangles each) are worth
            // a cell of their own — with ≥ 4 per cell a species/variant of ~13 trees stayed one or two city-wide boxes
            // that neither the frustum nor the distance LOD could ever drop. The triangle target still bounds the
            // cell count (chunkGridFor), so light instances (grates, planters, trim) chunk exactly as before.
            if (!twinGrid) {
                const minInst = triGrid >= CHUNK_HEAVY_INSTANCE_TRIS ? 1 : (o.minInstances ?? CHUNK_MIN_INSTANCES);
                const byCount = Math.max(1, Math.floor(Math.sqrt(T.length / minInst)));
                nx = Math.min(nx, byCount); nz = Math.min(nz, byCount);
                if (twinSig) twinInstGrids.set(twinSig, [nx, nz]);
            }
            if (nx * nz <= 1) { out.push(L); continue; }
            const cw = (x1 - x0) / nx || 1, cz = (z1 - z0) / nz || 1;
            const cells: (typeof T)[] = Array.from({ length: nx * nz }, () => []);
            for (const t of T) {
                let gx = Math.floor((t.x - x0) / cw), gz = Math.floor((t.z - z0) / cz);
                if (!(gx >= 0)) gx = 0; else if (gx >= nx) gx = nx - 1;
                if (!(gz >= 0)) gz = 0; else if (gz >= nz) gz = nz - 1;
                cells[gz * nx + gx].push(t);
            }
            const key = L.instanceKey ?? chunkShareKey(L.geometry);
            cells.forEach((inst, cell) => {
                if (!inst.length) return;
                const c: LayoutPreviewLayer = { ...L, instances: inst, instanceKey: key, chunk: `${cell % nx}_${Math.floor(cell / nx)}/${nx}x${nz}` };
                out.push(c);
            });
            continue;
        }
        if (!geometrySplittable(L)) { out.push(L); continue; }
        // ── World-baked geometry: partition the TRIANGLES by centroid ──
        const g = L.geometry, v = g.vertices, tris = Math.floor(g.indices.length / 3);
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        const pre = (g as { bounds?: ArrayLike<number> }).bounds;
        if (pre && pre.length >= 6) { x0 = pre[0]; z0 = pre[2]; x1 = pre[3]; z1 = pre[5]; }
        else for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
            if (v[i] < x0) x0 = v[i]; if (v[i] > x1) x1 = v[i];
            if (v[i + 2] < z0) z0 = v[i + 2]; if (v[i + 2] > z1) z1 = v[i + 2];
        }
        const [nx, nz] = chunkGridFor(tris, x1 - x0, z1 - z0, o);
        if (nx * nz <= 1) { out.push(L); continue; }
        const cw = (x1 - x0) / nx || 1, czw = (z1 - z0) / nz || 1;
        const crowd = (g as CrowdGeometry).crowd;
        const cellOf = crowd ? crowdCells(g as CrowdGeometry, triangleCells(g, nx, nz, x0, z0, cw, czw)) : undefined;
        const cells = splitGeometryXZ(g, nx, nz, x0, z0, cw, czw, cellOf);
        if (cells.length <= 1) { out.push(L); continue; }
        const crowdByCell = crowd && cellOf ? remapCrowd(crowd, cellOf, nx * nz) : null;
        const sample = L.ground ? groundUvSampleGeometry(g) : undefined;
        for (const c of cells) {
            if (crowdByCell) { const cm = crowdByCell.get(c.iz * nx + c.ix); if (cm) (c.geometry as CrowdGeometry).crowd = cm; }
            const cl: LayoutPreviewLayer = { ...L, geometry: c.geometry, chunk: `${c.ix}_${c.iz}/${nx}x${nz}` };
            if (sample) cl.groundUvSample = sample;
            out.push(cl);
        }
    }
    shareTwinBounds(twinCells);
    return out;
}

/** P9: every twin layer of one (key, cell) gets the SAME box — the union of their geometries' bounds. The renderer
 *  decides near / mid / far per mesh from its own box with its own hysteresis state, so twins whose boxes differ (a
 *  far twin drops the bolts that stick out; the crowd's HIGH and cheap bakes differ by a few centimetres) could
 *  disagree for a frame right at the threshold (both or neither drawn). Identical boxes make them agree exactly. */
function shareTwinBounds(cells: { key: string; cell: number; geometry: MeshGeometry }[]): void {
    const union = new Map<string, Float32Array>();
    for (const c of cells) {
        const b = (c.geometry as { bounds?: Float32Array }).bounds;
        if (!b || b.length !== 6) continue;
        const k = c.key + '|' + c.cell;
        const u = union.get(k);
        if (!u) { union.set(k, Float32Array.from(b)); continue; }
        for (let i = 0; i < 3; i++) { if (b[i] < u[i]) u[i] = b[i]; if (b[i + 3] > u[i + 3]) u[i + 3] = b[i + 3]; }
    }
    for (const c of cells) {
        const u = union.get(c.key + '|' + c.cell);
        if (u) (c.geometry as { bounds?: Float32Array }).bounds = Float32Array.from(u);
    }
}

/** Cap on E2 twin cells per axis. */
export const TWIN_MAX_CELLS = 16;

/** E2 near/far twins: one grid per twin KEY over the union of its layers' XZ bounds, with cells ~1.5 × the twin
 *  distance (≥ half the normal minimum cell) so "near" means the few chunks around the camera, not a city-wide box.
 *  Keys whose union is one cell get a 1 × 1 grid (still split — it is a no-op partition — so every twin carries the
 *  same chunk id scheme). */
type TwinGrid = { nx: number; nz: number; x0: number; z0: number; cw: number; cz: number; farGeo?: MeshGeometry; nearGeo?: MeshGeometry; sample?: MeshGeometry };
function nearTwinGrids(layers: LayoutPreviewLayer[], o: ChunkOptions): Map<string, TwinGrid> {
    const bounds = new Map<string, { x0: number; z0: number; x1: number; z1: number; dist: number; cell?: number; farGeo?: MeshGeometry; nearGeo?: MeshGeometry; gridTris?: number }>();
    for (const L of layers) {
        if (!L.nearTwin || L.chunk || !geometrySplittable(L)) continue;
        const v = L.geometry.vertices;
        let b = bounds.get(L.nearTwin.key);
        if (!b) { b = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity, dist: L.nearTwin.dist, cell: L.nearTwin.cell }; bounds.set(L.nearTwin.key, b); }
        if (L.nearTwin.role === 'far' && L.ground && !b.farGeo) b.farGeo = L.geometry;
        if (L.nearTwin.role === 'near' && L.ground && !b.nearGeo) b.nearGeo = L.geometry;
        if (L.nearTwin.role === 'near' && L.nearTwin.gridTris) b.gridTris = (b.gridTris ?? 0) + L.nearTwin.gridTris;
        for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
            if (v[i] < b.x0) b.x0 = v[i]; if (v[i] > b.x1) b.x1 = v[i];
            if (v[i + 2] < b.z0) b.z0 = v[i + 2]; if (v[i + 2] > b.z1) b.z1 = v[i + 2];
        }
    }
    const out = new Map<string, TwinGrid>();
    for (const [key, b] of bounds) {
        if (!(b.x1 >= b.x0) || !(b.z1 >= b.z0)) continue;
        let nx: number, nz: number;
        if (b.cell === undefined && b.gridTris) {
            // P9 prop twins (`gridTris` = their near layers' triangles): the grid the PLAIN near layer would have chunked
            // to, so culling granularity and draw calls stay the pre-twin ones (one twin of a cell draws).
            [nx, nz] = chunkGridFor(b.gridTris, b.x1 - b.x0, b.z1 - b.z0, o);
        } else {
            const cell = Math.max(b.cell ?? b.dist * 1.5, o.minCell * 0.5, 1e-6);
            nx = Math.max(1, Math.min(TWIN_MAX_CELLS, Math.ceil((b.x1 - b.x0) / cell)));
            nz = Math.max(1, Math.min(TWIN_MAX_CELLS, Math.ceil((b.z1 - b.z0) / cell)));
        }
        out.set(key, { nx, nz, x0: b.x0, z0: b.z0, cw: (b.x1 - b.x0) / nx || 1, cz: (b.z1 - b.z0) / nz || 1, farGeo: b.farGeo, nearGeo: b.nearGeo });
    }
    return out;
}
