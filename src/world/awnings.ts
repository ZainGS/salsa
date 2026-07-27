// ── World generation — Phase B: awnings + shopfronts ────────────────────────────────────────────
// Dresses the GROUND FLOOR of shop buildings. Reusing the same frontage split as signage (a building's longest
// edge → n shops), each shopfront gets: a dark glass band at the base (the storefront window), a projecting
// STRIPED AWNING canopy (+ a short valance skirt), and — on some — a hanging noren door curtain. Merged per
// colour; awning layers carry the shader `stripes` pattern (the classic canvas awning) so it's a few draws.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { makeRng, Rng, centroid, frontageEdge, hash2, graphLookups } from './util';
import { Accum3D } from './meshbuild';
import { makeElevation } from './elevation';

type V3 = [number, number, number];

// Canvas-awning colours (striped with cream via the pattern); indigo noren; near-black shopfront glass.
const AWN: [number, number, number][] = [[0.74, 0.20, 0.18], [0.16, 0.30, 0.55], [0.20, 0.52, 0.36], [0.86, 0.52, 0.18]];
const AWN_NAMES = ['red', 'blue', 'green', 'amber'];
const STRIPE: [number, number, number] = [0.95, 0.93, 0.87];   // the light stripe on the awning
const NOREN: [number, number, number] = [0.16, 0.20, 0.34];    // indigo door curtain
const GLASS: [number, number, number] = [0.13, 0.15, 0.19];    // dark storefront glazing

const nrm2 = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

/** Ground-floor awnings + shopfront glass + noren, per shop along each building's street frontage. Region-filterable. */
export function buildAwnings(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const p = graph.params; if (!(p.awnings ?? true)) return [];
    const gy = p.groundY, s = p.radius / 10;
    const rng = makeRng((p.seed ^ 0x0a3b19d) >>> 0);
    // ★ TWO accumulator sets per colour: STRIPED and SOLID. The stripe motif is a layer-level pattern, so
    // variety cannot come from within one layer — a plain-canvas awning needs its own layer. Roughly a
    // third come out solid, which stops a street of striped awnings reading as wallpaper.
    const awn = AWN.map(() => new Accum3D());
    const awnSolid = AWN.map(() => new Accum3D());
    const glass = new Accum3D(), noren = new Accum3D(), cafe = new Accum3D();
    const shopW = 0.22 * s;
    const { regionByBlock, distByBlock: distById, blockCentroid: blockC } = graphLookups(graph);
    const elev = makeElevation(graph);   // shopfront dressing bakes the building's anchor lift (routed heightless)
    for (const lot of graph.lots) {
        if (lot.slot !== 'building') continue;
        if (keep && !keep(regionByBlock.get(lot.block) ?? -1)) continue;
        const downtown = distById.get(lot.block) === 'downtown';
        if (lot.zone === 'residential' && !downtown && !rng.chance(0.2)) continue;   // shops = commercial/civic/downtown + a few houses
        const foot = insetToward(lot.poly, lot.center, 0.12);
        if (foot.length < 3) continue;
        // Street-facing frontage with jitter → shopfronts face the street and vary per building.
        const fr = frontageEdge(foot, blockC.get(lot.block) ?? null, hash2(lot.center[0] * 991, lot.center[1] * 761, p.seed) * 100);
        if (fr.len < shopW * 0.8) continue;

        const eDir = nrm2([fr.b[0] - fr.a[0], fr.b[1] - fr.a[1]]);
        let outward: V2 = [-eDir[1], eDir[0]];
        const mid: V2 = [(fr.a[0] + fr.b[0]) / 2, (fr.a[1] + fr.b[1]) / 2], cen = centroid(foot);
        if ((mid[0] - cen[0]) * outward[0] + (mid[1] - cen[1]) * outward[1] < 0) outward = [-outward[0], -outward[1]];   // face the street
        const eW: V3 = [eDir[0], 0, eDir[1]], oW: V3 = [outward[0], 0, outward[1]], up: V3 = [0, 1, 0];
        const gyL = gy + elev(lot.center[0], lot.center[1]);   // match the rigid building's anchor height

        // Storefront glass band along the whole frontage base (one dark strip proud of the wall).
        glass.obox([mid[0] + oW[0] * 0.006 * s, gyL + 0.05 * s, mid[1] + oW[2] * 0.006 * s], eW, up, oW, fr.len * 0.5, 0.05 * s, 0.006 * s);

        const n = Math.max(1, Math.floor(fr.len / shopW));   // n shops side by side
        const halfShop = (fr.len / n) * 0.46;
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n, px = fr.a[0] + (fr.b[0] - fr.a[0]) * t, pz = fr.a[1] + (fr.b[1] - fr.a[1]) * t;
            const ai = (rng.next() * AWN.length) | 0;
            const striped = rng.next() > 0.34;
            addAwning(striped ? awn[ai] : awnSolid[ai], [px, pz], eDir, outward, halfShop, gyL, s, rng);
            if (rng.chance(0.4)) noren.obox([px + oW[0] * 0.012 * s, gyL + 0.055 * s, pz + oW[2] * 0.012 * s], eW, up, oW, halfShop * 0.55, 0.03 * s, 0.004 * s);   // hanging door curtain
            // CAFÉ TERRACE: some shops spill onto the sidewalk — a round table, chairs, and a striped umbrella.
            // Pushed 0.17·s off the wall so the umbrella canopy clears the awning's projection (no clipping).
            if (rng.chance(0.16)) addCafeTerrace(cafe, awn[ai], [px + outward[0] * 0.17 * s, pz + outward[1] * 0.17 * s], eDir, gyL, s, rng);
            // SANDWICH BOARD: an A-frame sign on the sidewalk beside the door (striped — shares the awning layer).
            if (rng.chance(0.22)) addSandwichBoard(awn[(ai + 1) % AWN.length], [px + eDir[0] * halfShop * 0.7 + outward[0] * 0.07 * s, pz + eDir[1] * halfShop * 0.7 + outward[1] * 0.07 * s], eDir, gyL, s);
        }
    }

    const out: LayoutPreviewLayer[] = [];
    // A shopfront is the one piece of glass at eye level in the whole city — it should catch the sky.
    if (!glass.empty) out.push({ name: 'world:shopfront', color: GLASS, y: gy, geometry: glass.geometry(), glass: true });
    if (!noren.empty) out.push({ name: 'world:noren', color: NOREN, y: gy, geometry: noren.geometry() });
    if (!cafe.empty) out.push({ name: 'world:cafe-terrace', color: [0.28, 0.24, 0.21], y: gy, geometry: cafe.geometry() });   // tables/chairs/umbrella poles (umbrella canopies live in the striped awning layers)
    // Awning layers carry the striped pattern (secondary = cream). freq = stripe count across the canopy UV.
    awn.forEach((acc, i) => { if (!acc.empty) out.push({ name: 'world:awning-' + AWN_NAMES[i], color: AWN[i], y: gy, geometry: acc.geometry(), pattern: { color: STRIPE, freq: 9, scale: 0.5, mode: 'stripes' } }); });
    // Plain canvas — same colours, no stripe motif.
    awnSolid.forEach((acc, i) => { if (!acc.empty) out.push({ name: 'world:awning-plain-' + AWN_NAMES[i], color: AWN[i], y: gy, geometry: acc.geometry() }); });
    return out;
}

/** A REAL awning: a sloped canvas wedge pitching down-and-out from the wall, closed with side gores and a
 *  hanging front valance. Three seeded variants (classic / deep shallow / steep short two-tier) so a street of
 *  shops doesn't repeat one silhouette. Slope UVs come from quad4 → the stripe pattern runs across the canvas. */
function addAwning(a: Accum3D, at: V2, eDir: V2, outward: V2, half: number, gy: number, s: number, rng: Rng): void {
    const kind = (rng.next() * 3) | 0;
    const attachY = gy + (kind === 2 ? 0.145 : 0.13) * s;                       // where the canvas meets the wall
    const proj = (kind === 1 ? 0.095 : kind === 2 ? 0.055 : 0.075) * s;         // outward reach
    const drop = (kind === 1 ? 0.02 : kind === 2 ? 0.035 : 0.03) * s;           // slope fall over the projection
    const ex = eDir[0] * half, ez = eDir[1] * half;
    const wallL: V3 = [at[0] - ex, attachY, at[1] - ez], wallR: V3 = [at[0] + ex, attachY, at[1] + ez];
    const frontY = attachY - drop;
    const frontL: V3 = [wallL[0] + outward[0] * proj, frontY, wallL[2] + outward[1] * proj];
    const frontR: V3 = [wallR[0] + outward[0] * proj, frontY, wallR[2] + outward[1] * proj];
    // ★ SAG + SCALLOP. The canvas was ONE flat quad wall-to-front with a straight rectangular hem, which
    // is why awnings read as folded card: real fabric is pulled taut over RIBS and dips between them, and
    // that dip is what scallops the front edge. Subdividing along the length gives both from one change —
    // the sag drops the front edge mid-bay, and the valance hem follows it and dips a little further.
    const bays = Math.max(2, Math.min(6, Math.round((half * 2) / (0.055 * s))));
    const segs = bays * 3;                       // samples per span; 3 per bay is enough for the curve
    const sag = drop * 0.5;                      // how far the canvas dips between ribs
    const hem = 0.016 * s;                       // valance depth at a rib
    const scallop = 0.011 * s;                   // extra hem dip mid-bay
    const spanU = half * 2;                      // the awning's full width in world units = the u run
    const lerp = (A: V3, B: V3, t: number): V3 => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
    // Bay-local 0..1, peaking mid-bay and zero at every rib.
    const dip = (t: number): number => Math.sin((t * bays - Math.floor(t * bays)) * Math.PI);
    let pw = wallL, pf: V3 = [frontL[0], frontY - sag * dip(0), frontL[2]];
    let ph = hem + scallop * dip(0);
    for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const w = lerp(wallL, wallR, t);
        const fBase = lerp(frontL, frontR, t);
        const d = dip(t);
        const f: V3 = [fBase[0], frontY - sag * d, fBase[2]];
        const h = hem + scallop * d;
        // ★ CONTINUOUS U across the whole canvas. quad4 derives u from each quad's own world width, so
        // after subdivision u restarted at every bay — each bay ended up narrower than a single stripe and
        // the pattern collapsed to flat colour. That is why the awnings stopped being striped.
        const u0 = (i - 1) / segs * spanU, u1 = i / segs * spanU;
        a.quad4u(pw, w, f, pf, u0, u1);                                          // canvas bay
        a.quad4u(pf, f, [f[0], f[1] - h, f[2]], [pf[0], pf[1] - ph, pf[2]], u0, u1);   // scalloped valance
        pw = w; pf = f; ph = h;
    }
    a.quad4(wallL, frontL, [wallL[0], frontY, wallL[2]], wallL);                 // side gores (closed triangular ends)
    a.quad4(wallR, [wallR[0], frontY, wallR[2]], frontR, wallR);
    // (The old kind-2 "two-tier" second canvas below is GONE — it read as a broken doubled-up awning.)
}

/** A sidewalk café terrace: a round table + 2–3 chair stubs + a STRIPED umbrella (canopy shares the awning
 *  colour layer so it picks up the stripe pattern). */
function addCafeTerrace(cafe: Accum3D, umbrella: Accum3D, at: V2, eDir: V2, gy: number, s: number, rng: Rng): void {
    const tr = 0.016 * s;
    cafe.prism([at[0], gy, at[1]], 0.0035 * s, 0.0035 * s, 0.028 * s, 4);                 // table leg
    cafe.disc([at[0], gy + 0.03 * s, at[1]], [0, 1, 0], tr, 8);                            // table top
    const nCh = 2 + (rng.next() * 2 | 0);
    for (let c = 0; c < nCh; c++) {
        const ang = rng.next() * Math.PI * 2, cx = at[0] + Math.cos(ang) * tr * 1.7, cz = at[1] + Math.sin(ang) * tr * 1.7;
        cafe.obox([cx, gy + 0.011 * s, cz], [eDir[0], 0, eDir[1]], [0, 1, 0], [-eDir[1], 0, eDir[0]], 0.007 * s, 0.011 * s, 0.007 * s);   // chair
    }
    cafe.prism([at[0], gy + 0.03 * s, at[1]], 0.0028 * s, 0.0028 * s, 0.055 * s, 4);       // umbrella pole
    umbrella.cone([at[0], gy + 0.082 * s, at[1]], 0.032 * s, 0.022 * s, 8, rng.next() * Math.PI);   // striped canopy
}

/** An A-FRAME SANDWICH BOARD on the sidewalk: two quads leaning against each other (both faces visible). */
function addSandwichBoard(a: Accum3D, at: V2, eDir: V2, gy: number, s: number): void {
    const hw = 0.011 * s, topY = gy + 0.026 * s, lean = 0.007 * s;
    const perp: V2 = [-eDir[1], eDir[0]];
    const L: V2 = [at[0] - eDir[0] * hw, at[1] - eDir[1] * hw], R: V2 = [at[0] + eDir[0] * hw, at[1] + eDir[1] * hw];
    for (const side of [-1, 1]) {
        a.quad4([L[0], topY, L[1]], [R[0], topY, R[1]],
            [R[0] + perp[0] * lean * side, gy, R[1] + perp[1] * lean * side],
            [L[0] + perp[0] * lean * side, gy, L[1] + perp[1] * lean * side]);
    }
}

function insetToward(poly: V2[], c: V2, f: number): V2[] {
    return poly.map(pp => [pp[0] + (c[0] - pp[0]) * f, pp[1] + (c[1] - pp[1]) * f] as V2);
}
