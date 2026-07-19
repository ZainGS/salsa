/**
 * hair-generator.ts — procedural chunky low-poly hair.
 *
 * The "no-modeling" hair path: HairParams → a low-poly mesh (cap + bangs + side locks + tails),
 * built in the head's local frame. The caller skins it 100% to the head joint (follows poses, like
 * the eye decal) and shades it with a root→tip gradient texture sampled by `uv.v` (0 = root/scalp,
 * 1 = tip — the reference's blue tips). See docs/specs/hair-generation.md.
 *
 * Lengths are expressed as FACTORS of the head radius so a style scales with head size.
 * Geometry conventions match body-generator.ts (12-float interleave, CCW-outward, smooth normals).
 */

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import { VertGrid } from './vert-grid';

type V3 = [number, number, number];

/** Head frame the hair is built around (centre + half-extents, in body-local space). */
export interface HeadFrame { cx: number; cy: number; cz: number; rx: number; ry: number; rz: number; }

export interface HairParams {
    preset?: string;

    // ── Cap (factors × head radius) ──
    capThickness: number;   // outward offset from the scalp
    backLength: number;     // how far the back flap hangs (× ry)
    crownRound: number;     // extra crown height/pouf (× ry)
    hairlineFront: number;  // forehead hairline height (× ry above centre) — where bangs root
    verticalOffset: number; // raise(+)/lower(−) the BANG hairline, × ry (cap/locks/tails always hug the head; was a whole-build lift that floated the cap)

    // ── Bangs ──
    partingStyle: 'fringe' | 'parted' | 'swept';
    partingPosition: number; // −1..1 (gap centre across the forehead)
    partingWidth: number;    // gap width (× rx)
    bangCount: number;
    bangLength: number;      // × ry
    bangCurve: number;       // forward bend (0..1)
    bangPointiness: number;  // 0 = blunt, 1 = sharp point
    bangOffset: number;      // shift just the bangs up(+)/down(−), × ry (independent of the cap)

    // ── Side locks ──
    sideLock: boolean;
    sideLockLength: number;  // × ry
    sideLockWidth: number;   // × rx (width of ONE lock)
    sideLockCount: number;   // # of locks per side (DENSITY) — separate from width, so a wide lock vs more locks are independent

    // ── Tails ──
    tailStyle: 'none' | 'twin' | 'pony' | 'pig';
    tailHeight: number;      // attach height (× ry from centre; + = up)
    tailSpread: number;      // how far out they splay (0..1)
    tailLength: number;      // × ry
    tailThickness: number;   // root radius (× rx)
    tailTaper: number;       // END taper — thin the TIP (0..1)
    tailStartTaper: number;  // START taper — thin the ROOT (0 = full root, 1 = pointed root); full by ~30% length
    tailCurl: number;        // downward/back curl (0..1)
    tailTip: 'point' | 'flare' | 'blunt';

    // ── Front drape (a hair section swept FORWARD over the shoulder onto the chest — reuses the tail sweep +
    //    spring rig. Additive + default OFF, so existing hair is unchanged when frontDrape = 0.) ──
    frontDrape?: number;                          // 0 = off · 0..1 amount (presence + thickness)
    frontDrapeSide?: 'left' | 'right' | 'both';   // which shoulder(s) it falls over
    frontDrapeLength?: number;                    // × ry — how far down the chest it reaches
    frontDrapeOrigin?: 'front' | 'back';          // 'back' = comes from the BACK hair, over the shoulder onto the chest · 'front' = falls from above the ear down the FRONT of the neck
    frontDrapeWaveX?: number;                     // 0..1 — front-drape waviness along CHEST WIDTH (x, side-to-side)
    frontDrapeWaveZ?: number;                     // 0..1 — front-drape waviness along DEPTH (z, front-to-back)
    frontDrapeStrays?: number;                    // count of thin stray flyaway wisps fanning off the front drape (0 = none)
    frontDrapeStrayX?: number;                    // 0..1 — how far the strays fan out along WIDTH (x)
    frontDrapeStrayZ?: number;                    // 0..1 — how far the strays fan out along DEPTH (z)

    // ── Colour (the caller bakes these into the gradient texture) ──
    rootColor: string;
    tipColor: string;
    gradient: boolean;
    tipFade: number;         // 0..1 — how far up the tip colour reaches

    // ── Render ──
    chunkiness: number;      // 0..1 poly density (low = chunkier)

    // ── Card mode (alpha-card hair — the Elden-Ring/FF realism lean; see hair-generation.md §14) ──
    hairMode: 'chunky' | 'cards';   // 'cards' = alpha-textured ribbon TAILS (cap/bangs stay solid at the root)
    cardWidth: number;       // ribbon width × the tube radius (card mode)
    cardsPerClump: number;   // crossed ribbons per tail → volume from any angle (card mode)
    cardSegments: number;    // length subdivisions per card (card mode)
    strandDensity: number;   // strands across a card width (strand texture)
    alphaCutoff: number;     // strand solidity 0..1 — lower = wispier tips (strand texture)
    cardifyCap: boolean;     // card mode: build the cap ENTIRELY from layered hair cards (no solid dome — ER look); off = solid cap + card tails
    sheen: number;           // 0..1 anisotropic hair highlight (Kajiya-Kay sheen) intensity; 0 = off
    cardDetail: number;      // 0..1 card mode: MORE cards + per-card jitter (the "thousands of strands" breakup)
    volume: number;          // 0..1 float the cap off the skull for thickness
    capLayers: number;       // card mode: # of stacked, phase-shifted cap-card layers (more = fuller/denser cap, fills the translucent strand gaps)

    // ── Phase A: length + curl + layering (docs/specs/hair-styles.md) — hangs scalp hair past the hairline ──
    scalpLength: number;     // how far scalp hair HANGS past the hairline (× ry). 0 = cap only · ~0.5 bob · ~1.4 long
    lengthFront: number;     // per-region length multipliers (front kept short — the bangs cover it)
    lengthSide: number;      // sides → cheek / jaw
    lengthBack: number;      // back → nape / down the back
    scalpBluntness: number;  // 0 = wispy/tapered hem → 1 = blunt bob hem
    curlType: 'none' | 'wave' | 'spiral';   // strand curl applied to the hanging scalp hair
    curlAmount: number;      // 0..1 amplitude
    curlFreq: number;        // oscillations along the strand
    curlPhaseJitter: number; // 0..1 per-strand phase offset so strands don't sync
    layering: number;        // 0..1 vary the hang length across strands (wolf cut / shag)
    chop: number;            // 0..1 choppy / randomized ends

    // ── Spiky hair (Phase D, docs/specs/hair-styles.md) — outward pointed tufts instead of a draped cap ──
    spikeCap?: boolean;                            // enable spiky mode (short base cap + outward spikes)
    spikeLength?: number;                          // × ry — spike length
    spikeJitter?: number;                          // 0..1 — random spread of spike directions
    spikePattern?: 'radial' | 'linear' | 'grid';  // radial = porcupine (scalp normal) · linear = swept up/back · grid = mostly UP (liberty)

    // ── Buns (Phase C1) + short cuts (male styles) ──
    bunStyle?: 'none' | 'round' | 'space' | 'long';   // round = one on top · space = two upper-side · long = man-bun (bun + tapered tuft)
    bunSize?: number;                                 // × rx — bun radius
    sideCut?: number;                                 // 0..1 — undercut / fade: shave the SIDES (raise the cap edge there)
    buzzCut?: boolean;                                // very short uniform cap hugging the scalp (suppresses bangs/tails/locks/etc.)
    capSweep?: number;                                // −1..1 — SIDE PART: sweep the whole cap hair mass to one side (0 = symmetric). Real sweep, unlike the bang-only partingPosition.

    // ── Facial hair (short tufts on the lower face; uses the hair colour, head-skinned) ──
    facialHair?: 'none' | 'stubble' | 'mustache' | 'goatee' | 'full' | 'sideburns';
    beardLength?: number;                             // × ry — how far the beard tufts droop
    beardDensity?: number;                            // 0..1 — tuft coverage / density
}

/** Default = the reference-girl Twintails (cream → blue tips). */
export const DEFAULT_HAIR_PARAMS: HairParams = {
    preset: 'Twintails',
    capThickness: 0.14, backLength: 0.5, crownRound: 0.12, hairlineFront: 0.42, verticalOffset: 0.2,
    partingStyle: 'parted', partingPosition: 0, partingWidth: 0.18,
    bangCount: 6, bangLength: 1.15, bangCurve: 0.5, bangPointiness: 0.8, bangOffset: 0,
    sideLock: true, sideLockLength: 1.8, sideLockWidth: 0.18, sideLockCount: 1,
    tailStyle: 'twin', tailHeight: 0.45, tailSpread: 0.55, tailLength: 3.0,
    tailThickness: 0.4, tailTaper: 0.6, tailStartTaper: 0, tailCurl: 0.35, tailTip: 'point',
    frontDrape: 0, frontDrapeSide: 'both', frontDrapeLength: 2.2, frontDrapeOrigin: 'back',
    frontDrapeWaveX: 0, frontDrapeWaveZ: 0, frontDrapeStrays: 0, frontDrapeStrayX: 0.7, frontDrapeStrayZ: 0.4,
    rootColor: '#efe7d6', tipColor: '#7fb0d8', gradient: true, tipFade: 0.45,
    chunkiness: 0.3,
    hairMode: 'chunky', cardWidth: 1.1, cardsPerClump: 3, cardSegments: 10, strandDensity: 5, alphaCutoff: 0.5,
    cardifyCap: false, sheen: 0.4, cardDetail: 0.5, volume: 0.3, capLayers: 3,
    scalpLength: 0, lengthFront: 0.3, lengthSide: 0.8, lengthBack: 1, scalpBluntness: 0.5,
    curlType: 'none', curlAmount: 0.3, curlFreq: 3, curlPhaseJitter: 1, layering: 0.3, chop: 0.3,
    spikeCap: false, spikeLength: 1.0, spikeJitter: 0.4, spikePattern: 'radial',
    bunStyle: 'none', bunSize: 0.5, sideCut: 0, buzzCut: false, capSweep: 0,
    facialHair: 'none', beardLength: 0.35, beardDensity: 0.6,
};

// ── vec3 helpers ──
const sub = (a: V3, b: V3): V3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const add = (a: V3, b: V3): V3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const scl = (a: V3, s: number): V3 => [a[0]*s, a[1]*s, a[2]*s];
const cross = (a: V3, b: V3): V3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a: V3, b: V3): number => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
/** Rodrigues rotation of `vec` about unit `axis` by angle with given cos/sin. */
const rotAxis = (vec: V3, axis: V3, c: number, s: number): V3 => {
    const d = dot(axis, vec), cr = cross(axis, vec);
    return [
        vec[0]*c + cr[0]*s + axis[0]*d*(1-c),
        vec[1]*c + cr[1]*s + axis[1]*d*(1-c),
        vec[2]*c + cr[2]*s + axis[2]*d*(1-c),
    ];
};
/** Deterministic hash → [0,1) for seeded per-card jitter (stable across regenerations). */
const hash11 = (n: number): number => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };

interface Accum {
    pos: number[]; nrm: number[]; uv: number[]; idx: number[]; count: number;
    // Spring-tail tagging: `curTailId` is the tail being built right now (−1 = cap/bangs/sidelocks), stamped
    // onto each vertex in `tailId`. The caller uses tailId (+ uv.v = the tail's root→tip param) to skin a tail
    // vertex to its spring-bone chain; everything else stays 100% on the head joint.
    tailId: number[]; curTailId: number;
    // Normal-lock: verts whose CREATION normal is the volume normal (cap cards = scalp-outward) and must
    // survive recomputeNormals (which would otherwise flatten them to per-card face normals). `curLock` stamps
    // each push.
    nLock: number[]; curLock: boolean;
    // Strand tangent (the flow direction, root→tip) per vert, for the anisotropic sheen; `curTan` stamps each
    // push. Lets the highlight band run ALONG the strands (incl. the crown ring) + track the posed head.
    tanDir: number[]; curTan: V3;
}
function pushVert(ac: Accum, p: V3, n: V3, u: number, v: number): number {
    ac.pos.push(p[0], p[1], p[2]); ac.nrm.push(n[0], n[1], n[2]); ac.uv.push(u, v);
    ac.tailId.push(ac.curTailId);
    ac.nLock.push(ac.curLock ? 1 : 0);
    ac.tanDir.push(ac.curTan[0], ac.curTan[1], ac.curTan[2]);
    return ac.count++;
}
function perpFrame(axis: V3): { u: V3; v: V3 } {
    const a = norm(axis);
    const up: V3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(up, a));
    return { u, v: cross(a, u) };
}
function addRingN(ac: Accum, center: V3, u: V3, v: V3, r: number, n: number, uvV: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2;
        const dir = add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)));
        out.push(pushVert(ac, add(center, scl(dir, r)), dir, k / n, uvV));
    }
    return out;
}
function bandRings(ac: Accum, a: number[], b: number[]): void {
    for (let k = 0; k < a.length; k++) {
        const k2 = (k + 1) % a.length;
        ac.idx.push(a[k], a[k2], b[k2]);
        ac.idx.push(a[k], b[k2], b[k]);
    }
}
function capRing(ac: Accum, loop: number[], apex: V3, uvV: number): void {
    let c: V3 = [0, 0, 0];
    for (const vi of loop) c = [c[0]+ac.pos[vi*3], c[1]+ac.pos[vi*3+1], c[2]+ac.pos[vi*3+2]];
    c = scl(c, 1/loop.length);
    const ai = pushVert(ac, apex, norm(sub(apex, c)), 0.5, uvV);
    for (let k = 0; k < loop.length; k++) ac.idx.push(loop[k], loop[(k+1)%loop.length], ai);
}

// ── Cap: an ellipsoidal dome (crown → ear ring) + a back flap that hangs by backLength ──
function buildCap(ac: Accum, h: HeadFrame, p: HairParams, lat: number, ring: number, radiusMul = 1, growOverride?: number, opaqueHem = false): void {
    const grow = growOverride !== undefined ? growOverride : p.capThickness + Math.max(0, Math.min(1, p.volume ?? 0)) * 0.18;   // 15d: float off the skull (growOverride = the carded tight-scalp grow)
    const Rx = h.rx * (1 + grow) * radiusMul, Rz = h.rz * (1 + grow) * radiusMul;   // radiusMul<1 recesses it
    const Ry = (h.ry * (1 + grow) + h.ry * p.crownRound) * radiusMul;
    const thetaMax = Math.PI * 0.56;   // sides/back extent — a bit past the equator
    // The Hairline slider sets where the FRONT of the cap stops (so the chunky dome doesn't overshoot down over
    // the forehead/face). acos maps the slider (height × ry above centre) → a latitude angle; higher slider =
    // higher edge. Sides/back keep thetaMax; the front lerps to hairlineTheta. (buildCapCards uses the same → match.)
    const hairlineTheta = Math.min(thetaMax, Math.acos(Math.max(-0.2, Math.min(0.92, p.hairlineFront))));
    const sideCut = Math.max(0, Math.min(1, p.sideCut ?? 0));   // undercut / fade: raise the cap edge on the ±X sides
    const capSweep = Math.max(-1, Math.min(1, p.capSweep ?? 0)); // side part: lateral sweep of the mass (crown leans, roots stay)
    const rings: number[][] = [];
    for (let i = 0; i <= lat; i++) {
        const theta = (i / lat) * thetaMax;
        const r: number[] = [];
        for (let k = 0; k < ring; k++) {
            const phi = (k / ring) * Math.PI * 2;
            const cphi = Math.cos(phi), sphi = Math.sin(phi);
            const fr = Math.max(0, sphi);                                    // 1 at the front (+Z)
            const sideMax = thetaMax * (1 - sideCut * Math.abs(cphi) * 0.8);   // undercut: the sides stop higher (shaved)
            const effTheta = Math.min(theta, thetaMax * (1 - fr) + hairlineTheta * fr, sideMax);   // front stops at the hairline
            const st = Math.sin(effTheta), ct = Math.cos(effTheta);
            const dir: V3 = [st * cphi, ct, st * sphi];
            const pos: V3 = [h.cx + dir[0] * Rx, h.cy + dir[1] * Ry, h.cz + dir[2] * Rz];
            if (capSweep !== 0) pos[0] += capSweep * Math.max(0, ct) * Rx * 0.5;   // side part: crown leans to one side, hairline stays rooted
            ac.curTan = norm([ct * cphi, -st, ct * sphi]);   // strand flows down the meridian (crown → hairline)
            r.push(pushVert(ac, pos, norm(dir), k / ring, (effTheta / thetaMax) * 0.3));
        }
        rings.push(r);
    }
    // Back-flap hem: drop the back of the bottom ring by backLength (front barely drops).
    const bottom = rings[lat];
    const hem: number[] = [];
    for (let k = 0; k < ring; k++) {
        const phi = (k / ring) * Math.PI * 2;
        const backness = Math.max(0, -Math.sin(phi));   // 1 at back (−Z), 0 at front
        const drop = h.ry * (0.12 + p.backLength * backness) * (1 - sideCut * Math.abs(Math.cos(phi)) * 0.9);   // undercut: no side flap
        const bx = ac.pos[bottom[k]*3], by = ac.pos[bottom[k]*3+1], bz = ac.pos[bottom[k]*3+2];
        ac.curTan = [0, -1, 0];   // the hem hangs straight down
        hem.push(pushVert(ac, [bx, by - drop, bz], [Math.cos(phi), -0.2, Math.sin(phi)], k / ring, opaqueHem ? 0.3 : 0.3 + 0.5 * backness));   // opaqueHem keeps the carded scalp's back flap solid (uv.v in the opaque region) → no skin shows through the back
    }
    for (let i = 0; i < lat; i++) bandRings(ac, rings[i], rings[i + 1]);
    bandRings(ac, bottom, hem);
    capRing(ac, rings[0], [h.cx, h.cy + Ry, h.cz], 0);
}

// ── Cap CARD shells (card mode + cardifyCap): the ENTIRE cap as hair cards (NO solid dome/scalp — ER style).
//    Roots are SCATTERED in ROWS across the scalp (crown→hairline) and each card fans DOWN from its LOCAL root —
//    NOT all from the crown centre (that radial convergence was the "pinwheel"/starburst). Per-card yaw + length +
//    width jitter; tapered at BOTH ends. Crown rows use FEWER cards (circumference ∝ sinθ) so the top never piles
//    up. Layer 0 = OPAQUE coverage base; outer layers (capLayers) wispier + puffed for volume. ──
function buildCapCards(ac: Accum, h: HeadFrame, p: HairParams, lanes: number, segs: number): void {
    ac.curLock = true;   // scalp-outward normal → cap cards blend smoothly (no per-card facets)
    const detail = Math.max(0, Math.min(1, p.cardDetail ?? 0));
    const vol = Math.max(0, Math.min(1, p.volume ?? 0));
    const layers = Math.max(1, Math.round(p.capLayers ?? 3));
    const thetaMax = Math.PI * 0.6;
    const hairlineTheta = Math.min(thetaMax, Math.acos(Math.max(-0.2, Math.min(0.92, p.hairlineFront))));   // Hairline slider → front edge (matches buildCap)
    const sideCut = Math.max(0, Math.min(1, p.sideCut ?? 0));   // undercut / fade (matches buildCap)
    const capSweep = Math.max(-1, Math.min(1, p.capSweep ?? 0)); // side part (matches buildCap)
    for (let layer = 0; layer < layers; layer++) {
        const lf = layers > 1 ? layer / (layers - 1) : 0;
        const isBase = layer === 0;
        const grow = 0.02 + vol * 0.05 + lf * (0.03 + vol * 0.06);  // outer layers sit further out (depth / volume)
        const Rx = h.rx * (1 + grow), Rz = h.rz * (1 + grow);
        const Ry = h.ry * (1 + grow) + h.ry * p.crownRound;
        const off = h.ry * (0.03 + vol * 0.14) * (0.5 + 0.5 * lf);  // stand-off; outer layers puff more (Volume)
        const vmul     = isBase ? 0.3 : 1.0;                        // base = OPAQUE coverage (uv.v in the solid region); outer = wispy tips
        const taperMin = isBase ? 0.5 : 0.18;                       // base less tapered (must COVER); outer pointed at both ends
        const yawAmt   = isBase ? 0.18 : 0.5;                       // base ~aligned (coverage); outer random yaw (≈±14°)
        const baseHW   = (Math.PI * 2 * Math.max(Rx, Rz) / lanes) * 0.6;   // ~uniform card half-width (neighbours overlap)
        const NR = Math.max(3, Math.round(lanes / 6));             // rows of ROOT points, crown → hairline
        for (let r = 0; r < NR; r++) {
            const rowTheta = (r / Math.max(1, NR - 1)) * thetaMax * 0.9;     // row 0 ≈ crown → last row ≈ hairline
            const cols = Math.max(2, Math.round(lanes * Math.sin(Math.max(0.16, rowTheta)) * (isBase ? 1.25 : 1.0)));   // FEWER near the crown (∝ circumference) → no pinwheel pileup
            // brick offset + per-ROW jitter (SAME across layers) + MONOTONIC per-layer interleave. The row jitter must
            // NOT depend on `layer`: a ±0.2-col per-layer wobble swamped the 1/layers interleave step, so successive
            // layers rotated back over each other (duplicate coverage) instead of progressively filling the gaps.
            // Per-layer organic variation still comes from the per-CARD jitter on ph0 below (its seed includes layer).
            const rowPhase = (r % 2) * 0.5 + (hash11(r * 3.1) - 0.5) * 0.4 + layer / layers;
            for (let c = 0; c < cols; c++) {
                const seed = r * 131.1 + c * 17.3 + layer * 1009.7;
                const ph0 = ((c + rowPhase) / cols) * Math.PI * 2 + (hash11(seed + 2) - 0.5) * (Math.PI * 2 / cols) * 0.7;
                const frontness = Math.max(0, Math.sin(ph0));                 // +Z front
                const cardThetaMax = Math.min(thetaMax * (1 - frontness) + hairlineTheta * frontness,   // front cards stop at the Hairline (matches the chunky dome; bangs cover the forehead)
                                              thetaMax * (1 - sideCut * Math.abs(Math.cos(ph0)) * 0.8));   // undercut: sides stop higher
                const th0 = Math.min(cardThetaMax * 0.9, Math.max(0, rowTheta + (hash11(seed + 1) - 0.5) * (thetaMax / NR) * 0.8));
                const yaw = (hash11(seed + 3) - 0.5) * yawAmt;
                const lenJ = isBase ? (0.92 + hash11(seed + 4) * 0.16) : (0.5 + hash11(seed + 4) * 0.85);   // base reaches the hem; outer VARIES (clumps, not a curtain)
                const cardLen = Math.max(cardThetaMax * 0.16, (cardThetaMax - th0) * lenJ);
                const wj = 1 + (hash11(seed + 5) - 0.5) * (0.3 + detail * 0.7);
                const backness = Math.max(0, -Math.sin(ph0));
                let prevL = -1, prevR = -1;
                for (let i = 0; i <= segs; i++) {
                    const t = i / segs;
                    const theta = th0 + t * cardLen;
                    const thC = Math.min(cardThetaMax, theta);
                    const hang = (theta > cardThetaMax ? (theta - cardThetaMax) * Math.max(Rx, Rz) : 0)   // past the hem → hang straight down
                               + h.ry * p.backLength * backness * Math.max(0, t - 0.7) / 0.3;             // back cards hang lower
                    const ph = ph0 + yaw * t;
                    const cphi = Math.cos(ph), sphi = Math.sin(ph), st = Math.sin(thC), ct = Math.cos(thC);
                    const dir: V3 = [st * cphi, ct, st * sphi];
                    const cen: V3 = [h.cx + dir[0] * (Rx + off), h.cy + dir[1] * (Ry + off) - hang, h.cz + dir[2] * (Rz + off)];
                    if (capSweep !== 0) cen[0] += capSweep * Math.max(0, ct) * Math.max(Rx, Rz) * 0.5;   // side part sweep (matches buildCap)
                    const wdir = norm([-sphi, 0, cphi]);
                    const hw = baseHW * (taperMin + (1 - taperMin) * Math.sin(Math.PI * t)) * wj;   // TAPER both ends (root + tip)
                    const n = norm(dir);
                    ac.curTan = norm([ct * cphi, -st, ct * sphi]);   // strand flows down the meridian
                    const li = pushVert(ac, add(cen, scl(wdir, -hw)), n, 0, t * vmul);
                    const ri = pushVert(ac, add(cen, scl(wdir,  hw)), n, 1, t * vmul);
                    if (i > 0) { ac.idx.push(prevL, prevR, ri); ac.idx.push(prevL, ri, li); }
                    prevL = li; prevR = ri;
                }
            }
        }
    }
    ac.curLock = false;
}

// ── SPIKY HAIR (Phase D): outward pointed tufts rooted on the scalp instead of a draped cap ──
/** One SPIKE: a crossed-ribbon tuft from `root` along `dir` for `len`, tapering to a sharp POINT. Head-skinned (stiff). */
function buildSpike(ac: Accum, root: V3, dir: V3, len: number, baseW: number, segs: number): void {
    const d = norm(dir);
    const fr = perpFrame(d);
    ac.curTan = d;                                              // strand flows along the spike (sheen)
    const strip = (wdir: V3, faceN: V3): void => {
        let prevL = -1, prevR = -1;
        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            const c = add(root, scl(d, t * len));
            const w = baseW * (1 - t) * (1 - t);               // quadratic taper → sharp tip
            const li = pushVert(ac, add(c, scl(wdir, -w)), faceN, 0, t);
            const ri = pushVert(ac, add(c, scl(wdir,  w)), faceN, 1, t);
            if (i > 0) { ac.idx.push(prevL, prevR, ri); ac.idx.push(prevL, ri, li); }
            prevL = li; prevR = ri;
        }
    };
    strip(fr.u, fr.v);
    strip(fr.v, fr.u);   // crossed → volume from any angle
}

/** Spiky hair: outward pointed tufts rooted on the scalp (top/sides/back; the front stops at the hairline so the face
 *  stays clear). Head-skinned/stiff. `spikePattern`: radial = along the scalp normal (porcupine) · linear = swept up+back
 *  · grid = mostly UP (liberty). Pairs with a short base cap (built by the caller) so no scalp shows between spikes. */
function buildSpikeCap(ac: Accum, h: HeadFrame, p: HairParams, lanes: number, segs: number): void {
    ac.curLock = false;                                        // per-face normals (distinct tufts, not a smooth shell)
    ac.curTailId = -1;                                         // spikes are stiff → skinned to the head
    const len  = h.ry * (p.spikeLength ?? 1.0);
    const jit  = Math.max(0, Math.min(1, p.spikeJitter ?? 0.4));
    const pattern = String(p.spikePattern ?? 'radial').toLowerCase();
    const baseW = h.rx * p.tailThickness * 0.5;
    const thetaMax = Math.PI * 0.62;
    const hairlineTheta = Math.min(thetaMax, Math.acos(Math.max(-0.2, Math.min(0.92, p.hairlineFront))));
    const NR = Math.max(3, Math.round(lanes / 5));
    for (let r = 0; r < NR; r++) {
        const rowTheta = (r / Math.max(1, NR - 1)) * thetaMax * 0.95;
        const cols = Math.max(3, Math.round(lanes * Math.sin(Math.max(0.2, rowTheta))));
        for (let c = 0; c < cols; c++) {
            const seed = r * 131.1 + c * 17.3;
            const ph0  = ((c + (r % 2) * 0.5) / cols) * Math.PI * 2 + (hash11(seed + 2) - 0.5) * (Math.PI * 2 / cols) * 0.6;
            const frontness = Math.max(0, Math.sin(ph0));                             // +Z front
            const cutTheta  = thetaMax * (1 - frontness) + hairlineTheta * frontness; // front spikes stop at the hairline
            const th = Math.min(cutTheta * 0.95, rowTheta + (hash11(seed + 1) - 0.5) * (thetaMax / NR) * 0.6);
            const cphi = Math.cos(ph0), sphi = Math.sin(ph0), st = Math.sin(th), ct = Math.cos(th);
            const normal: V3 = [st * cphi, ct, st * sphi];                            // scalp outward normal
            const root: V3   = [h.cx + normal[0] * h.rx, h.cy + normal[1] * h.ry, h.cz + normal[2] * h.rz];
            let sdir: V3 = normal;
            if (pattern === 'linear')    sdir = norm(add(scl(normal, 0.5),  [0.15, 0.9, -0.35]));   // swept up + back
            else if (pattern === 'grid') sdir = norm(add(scl(normal, 0.35), [0, 1, 0]));            // mostly UP (liberty)
            sdir = norm([sdir[0] + (hash11(seed + 3) - 0.5) * jit,
                         sdir[1] + (hash11(seed + 4) - 0.5) * jit * 0.6,
                         sdir[2] + (hash11(seed + 5) - 0.5) * jit]);
            const l = len * (0.65 + hash11(seed + 6) * 0.7);
            buildSpike(ac, root, sdir, l, baseW * (0.8 + hash11(seed + 7) * 0.5), segs);
        }
    }
}

/** A BUN: a small squashed sphere of hair at `center` (radius r). Pass `tuft` (a direction) for a man-bun → a tapered
 *  paintbrush tuft sticks out. Head-skinned (stiff). */
function buildBun(ac: Accum, center: V3, r: number, tuft?: V3): void {
    ac.curLock = false; ac.curTailId = -1;
    const LAT = 6, LON = 8;
    const rings: number[][] = [];
    for (let i = 0; i <= LAT; i++) {
        const th = (i / LAT) * Math.PI;                        // 0 (top) → π (bottom)
        const st = Math.sin(th), ct = Math.cos(th);
        const rr: number[] = [];
        for (let j = 0; j <= LON; j++) {
            const ph = (j / LON) * Math.PI * 2;
            const nx = st * Math.cos(ph), ny = ct, nz = st * Math.sin(ph);
            const pos: V3 = [center[0] + nx * r, center[1] + ny * r * 0.8, center[2] + nz * r];   // slightly squashed
            ac.curTan = [Math.cos(ph), 0, Math.sin(ph)];       // wrap direction → coiled sheen
            rr.push(pushVert(ac, pos, norm([nx, ny * 0.8, nz]), j / LON, i / LAT));
        }
        rings.push(rr);
    }
    for (let i = 0; i < LAT; i++) for (let j = 0; j < LON; j++) {
        const a = rings[i][j], b = rings[i][j + 1], c = rings[i + 1][j], d = rings[i + 1][j + 1];
        ac.idx.push(a, c, b); ac.idx.push(b, c, d);
    }
    if (tuft) buildSpike(ac, center, tuft, r * 2.6, r * 0.55, 5);   // man-bun: tapered paintbrush tip
}

// ── FACIAL HAIR: short tufts rooted on the LOWER-FRONT head (chin/jaw/cheeks/upper-lip/sideburns), drooping down.
//    Head-skinned, uses the hair colour. Sampled on the head's front hemisphere in normalised face coords: hy = height
//    (−1 bottom → +1 top; eyes ≈ +0.1, mouth ≈ −0.25, chin ≈ −0.55), hx = side (±1), hz = frontness. Regions are
//    proportion estimates — screenshot-tune. ──
function buildFacialHair(ac: Accum, h: HeadFrame, p: HairParams): void {
    const style = String(p.facialHair ?? 'none').toLowerCase();
    if (style === 'none') return;
    ac.curLock = false; ac.curTailId = -1;                              // per-face normals, head-skinned (stiff)
    const stubble = style === 'stubble';
    const len = h.ry * (p.beardLength ?? 0.35) * (stubble ? 0.22 : 1);
    const density = Math.max(0, Math.min(1, p.beardDensity ?? 0.6));
    const baseW = h.rx * (stubble ? 0.02 : 0.032);
    // Face-height bands (hy: eyes ≈ 0, nose ≈ −0.15, mouth ≈ −0.38, chin ≈ −0.65, jaw bottom ≈ −0.85 in the head bbox).
    const inRegion = (hx: number, hy: number, hz: number): boolean => {
        const ax = Math.abs(hx);
        if (style === 'mustache')  return hy > -0.50 && hy < -0.32 && ax < 0.30 && hz > 0.5;       // tight upper-lip band
        if (style === 'sideburns') return ax > 0.55 && ax < 0.82 && hy > -0.55 && hy < -0.10;      // in front of the ears
        if (style === 'goatee')    return (ax < 0.22 && hy > -0.84 && hy < -0.50)                  // chin patch
                                        || (ax < 0.28 && hy > -0.50 && hy < -0.34 && hz > 0.5);    // + soul patch / 'stache
        // full + stubble: chin + jaw + LOWER cheeks + upper lip — kept tight (not up to the eyes / not wrapping the sides)
        const lower = hy < -0.32 && hy > -0.84 && ax < 0.55 && hz > 0.2;
        const cheek = ax > 0.40 && ax < 0.72 && hy > -0.60 && hy < -0.26;
        const mustache = hy > -0.50 && hy < -0.32 && ax < 0.30 && hz > 0.5;
        return lower || cheek || mustache;
    };
    const NR = Math.round(22 + density * 22);                           // denser grid → tufts closer together
    for (let r = 0; r < NR; r++) {
        const hy = -0.9 + (r / (NR - 1)) * 0.78;                        // chin/jaw bottom → just below the nose (tighter footprint)
        const NC = Math.round(22 + density * 28);
        for (let c = 0; c < NC; c++) {
            const hx = -1 + (c / (NC - 1)) * 2;
            const rr = hx * hx + hy * hy;
            if (rr > 0.92) continue;
            const hz = Math.sqrt(Math.max(0, 1 - rr));                  // front hemisphere of the (unit) head
            if (!inRegion(hx, hy, hz)) continue;
            const seed = r * 131.1 + c * 17.3;
            if (hash11(seed) > 0.55 + density * 0.45) continue;         // keep MOST (was `> density` → too sparse/spread)
            const normal: V3 = norm([hx, hy, hz]);
            const root: V3 = [h.cx + hx * h.rx, h.cy + hy * h.ry, h.cz + hz * h.rz];
            const droop = stubble ? 0.15 : 0.75;                        // stubble points OUT; a beard droops DOWN
            let dir: V3 = norm([normal[0] * (1 - droop), normal[1] * (1 - droop) - droop, normal[2] * (1 - droop)]);
            dir = norm([dir[0] + (hash11(seed + 1) - 0.5) * 0.16, dir[1], dir[2] + (hash11(seed + 2) - 0.5) * 0.16]);   // LESS jitter = tight clump, not spread
            buildSpike(ac, root, dir, len * (0.6 + hash11(seed + 3) * 0.45), baseW * (0.7 + hash11(seed + 4) * 0.4), stubble ? 2 : 3);
        }
    }
}

// ── A flat tapered ribbon (one bang clump or side lock), hanging from `root` along `down` ──
function buildRibbon(
    ac: Accum, root: V3, down: V3, side: V3, length: number, baseW: number, segs: number, pointiness: number,
): void {
    const d = norm(down), s = norm(side);
    const n = norm(cross(d, s));   // faces forward
    ac.curTan = d;                 // strand flows down the ribbon (root → tip)
    let prevL = -1, prevR = -1;
    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const c = add(root, scl(d, t * length));
        const w = baseW * Math.max(0.04, 1 - t * pointiness);
        const li = pushVert(ac, add(c, scl(s, -w * 0.5)), n, 0, t);
        const ri = pushVert(ac, add(c, scl(s,  w * 0.5)), n, 1, t);
        if (i > 0) { ac.idx.push(prevL, prevR, ri); ac.idx.push(prevL, ri, li); }
        prevL = li; prevR = ri;
    }
}

// ── A ribbon with VOLUME: the flat strip + a perpendicular cross-strip (a + cross-section) so it reads as 3D
//    from ANY angle (a flat ribbon is invisible edge-on — e.g. side locks from the front). Works in chunky
//    (solid volume) and card (crossed cards, like the tails) modes. ──
function buildRibbonVol(
    ac: Accum, root: V3, down: V3, side: V3, length: number, baseW: number, segs: number, pointiness: number, depth = 0.85,
): void {
    const d = norm(down), s = norm(side);
    const n = norm(cross(d, s));
    ac.curTan = d;                 // strand flows down the ribbon (root → tip)
    const strip = (wdir: V3, faceN: V3, wmul: number): void => {
        let prevL = -1, prevR = -1;
        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            const c = add(root, scl(d, t * length));
            const w = baseW * wmul * Math.max(0.04, 1 - t * pointiness);
            const li = pushVert(ac, add(c, scl(wdir, -w * 0.5)), faceN, 0, t);
            const ri = pushVert(ac, add(c, scl(wdir,  w * 0.5)), faceN, 1, t);
            if (i > 0) { ac.idx.push(prevL, prevR, ri); ac.idx.push(prevL, ri, li); }
            prevL = li; prevR = ri;
        }
    };
    strip(s, n, 1);          // main plane
    strip(n, s, depth);      // perpendicular cross-plane → visible from the front too
}

// ── Bangs across the front hairline — each clump CONFORMS to the head's front (curves down the forehead to the
//    brow, then hangs free) so the bangs hug the head instead of a flat offset curtain ──
function buildBangs(ac: Accum, h: HeadFrame, p: HairParams, segs: number): void {
    const count = Math.max(0, Math.round(p.bangCount));
    if (count <= 0) return;
    const frontW = h.rx * 0.95;                       // half the forehead span the bangs cover
    const rootY  = Math.min(h.cy + h.ry * 0.9,                              // clamp near the crown so extreme offsets can't start bangs in mid-air
        h.cy + h.ry * (p.hairlineFront + (p.bangOffset ?? 0) + (p.verticalOffset ?? 0)));   // hairline + bang offset + the (cap) V-offset
    const L = h.ry * p.bangLength;
    const off = h.rz * (0.05 + Math.max(0, p.capThickness) * 0.4);   // sit just off the forehead / in front of the cap
    // One clump at horizontal offset dx: centerline conformed to the head ellipsoid front, then a tapered sheet.
    const place = (dx: number, baseW: number): void => {
        const pts: V3[] = [];
        let frontZ = -Infinity;
        for (let i = 0; i <= segs; i++) {
            const y = rootY - (i / segs) * L;
            const nx = dx / h.rx, ny = (y - h.cy) / h.ry;
            const disc = 1 - nx * nx - ny * ny;
            let z: number;
            if (disc > 0 && y >= h.cy - h.ry * 0.05) {            // conform along the forehead down to ~the brow
                z = h.cz + h.rz * Math.sqrt(disc) + off;
                if (z > frontZ) frontZ = z;
            } else {                                               // past the brow → hang free, leaning forward (bangCurve)
                z = (frontZ > -Infinity ? frontZ : h.cz + h.rz * 0.5 + off) + Math.max(0, h.cy - y) * p.bangCurve;
            }
            pts.push([h.cx + dx, y, z]);
        }
        let prevL = -1, prevR = -1;
        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            const w = Math.max(0.01, baseW) * Math.max(0.04, 1 - t * p.bangPointiness);
            const c = pts[i];
            ac.curTan = norm(sub(pts[Math.min(i + 1, segs)], pts[Math.max(i - 1, 0)]));   // flow down the bang
            const nrm = norm(sub(c, [h.cx, h.cy, h.cz]));          // outward (recomputed in the smooth pass)
            const li = pushVert(ac, [c[0] - w * 0.5, c[1], c[2]], nrm, 0, t);
            const ri = pushVert(ac, [c[0] + w * 0.5, c[1], c[2]], nrm, 1, t);
            if (i > 0) { ac.idx.push(prevL, prevR, ri); ac.idx.push(prevL, ri, li); }
            prevL = li; prevR = ri;
        }
    };

    const fringe = p.partingStyle === 'fringe';
    const partC  = fringe ? 0 : p.partingPosition * frontW * (p.partingStyle === 'swept' ? 1 : 0.6);
    const gap    = fringe ? 0 : p.partingWidth * h.rx;

    if (count % 2 === 0) {
        // EVEN → two symmetric clumps of count/2, one on each side of the parting.
        const half = count / 2;
        const leftSpan  = Math.max(0, (partC - gap * 0.5) - (-frontW));
        const rightSpan = Math.max(0, frontW - (partC + gap * 0.5));
        for (let i = 0; i < half; i++) {
            place(-frontW + leftSpan * (i + 0.5) / half,              leftSpan  / half * 1.3);
            place(partC + gap * 0.5 + rightSpan * (i + 0.5) / half,   rightSpan / half * 1.3);
        }
    } else {
        // ODD → an even spread across the front; the parting (if any) carves the middle.
        const w = (frontW * 2) / count * 1.25;
        for (let i = 0; i < count; i++) {
            const x = -frontW + (frontW * 2) * (i + 0.5) / count;
            if (gap > 0 && Math.abs(x - partC) < gap * 0.5) continue;
            place(x, w);
        }
    }
}

// ── Side locks beside the face — 3D (crossed ribbon) so they're visible from the FRONT, not edge-on. `sideLockCount`
//    locks per side fan front↔back beside the face (DENSITY, independent of each lock's Width). ──
function buildSideLocks(ac: Accum, h: HeadFrame, p: HairParams, segs: number): void {
    if (!p.sideLock) return;
    const down: V3 = norm([0, -1, 0.15]);
    const n = Math.max(1, Math.round(p.sideLockCount ?? 1));
    for (const sx of [-1, 1]) {
        for (let k = 0; k < n; k++) {
            const f = n > 1 ? (k / (n - 1) - 0.5) : 0;   // −0.5..0.5 → spread the locks front↔back beside the face
            const root: V3 = [h.cx + sx * h.rx * 0.98, h.cy + h.ry * (0.15 - Math.abs(f) * 0.1), h.cz + h.rz * (0.2 + f * 0.5)];   // temple, fanned in z
            buildRibbonVol(ac, root, down, [0, 0, 1], h.ry * p.sideLockLength, h.rx * p.sideLockWidth, segs, 0.4, 0.85);
        }
    }
}

// ── A tapered tube swept along a quadratic bezier (one tail) ──
function buildTail(ac: Accum, A: V3, C: V3, E: V3, r0: number, p: HairParams, segs: number, ring: number, C2?: V3, waveX = 0, waveZ = 0, waveFreq = 2.5, wavePhase = 0): void {
    // C2 present → CUBIC bezier (A,C,C2,E) so the spine can S-curve (e.g. fall straight, then bend); else QUADRATIC (A,C,E).
    const bez = C2
        ? (t: number): V3 => { const it = 1 - t; return [
            it*it*it*A[0] + 3*it*it*t*C[0] + 3*it*t*t*C2[0] + t*t*t*E[0],
            it*it*it*A[1] + 3*it*it*t*C[1] + 3*it*t*t*C2[1] + t*t*t*E[1],
            it*it*it*A[2] + 3*it*it*t*C[2] + 3*it*t*t*C2[2] + t*t*t*E[2] ]; }
        : (t: number): V3 => { const it = 1 - t; return [
            it*it*A[0] + 2*it*t*C[0] + t*t*E[0],
            it*it*A[1] + 2*it*t*C[1] + t*t*E[1],
            it*it*A[2] + 2*it*t*C[2] + t*t*E[2] ]; };
    const tan = C2
        ? (t: number): V3 => { const it = 1 - t; return norm([
            3*it*it*(C[0]-A[0]) + 6*it*t*(C2[0]-C[0]) + 3*t*t*(E[0]-C2[0]),
            3*it*it*(C[1]-A[1]) + 6*it*t*(C2[1]-C[1]) + 3*t*t*(E[1]-C2[1]),
            3*it*it*(C[2]-A[2]) + 6*it*t*(C2[2]-C[2]) + 3*t*t*(E[2]-C2[2]) ]); }
        : (t: number): V3 => { const it = 1 - t; return norm([
            2*it*(C[0]-A[0]) + 2*t*(E[0]-C[0]),
            2*it*(C[1]-A[1]) + 2*t*(E[1]-C[1]),
            2*it*(C[2]-A[2]) + 2*t*(E[2]-C[2]) ]); };
    // Sweep with PARALLEL TRANSPORT: one frame at the root, rotated minimally to follow each
    // tangent. (Recomputing perpFrame() per segment spins/flips the frame — and asymmetrically
    // between the mirrored left/right tails, which kinked one tail and not the other.)
    const rings: number[][] = [];
    let f = perpFrame(tan(0));
    let u = f.u, v = f.v, prevT = tan(0);
    for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const T = tan(t);
        if (i > 0) {
            const axis = cross(prevT, T), s = len(axis), c = dot(prevT, T);
            if (s > 1e-6) { const ax: V3 = [axis[0]/s, axis[1]/s, axis[2]/s]; u = rotAxis(u, ax, c, s); v = rotAxis(v, ax, c, s); }
            prevT = T;
        }
        let r = r0 * (1 - t * p.tailTaper) * (1 - (p.tailStartTaper ?? 0) * (1 - Math.min(1, t / 0.3)));   // END taper + START taper (thin root, full by ~30%)
        if (p.tailTip === 'flare' && t > 0.8) r *= 1 + (t - 0.8) * 5 * 0.4;   // widen near the end
        ac.curTan = T;   // strand flows along the tail spine
        const ctr = add(bez(t), waveOffset(t, waveX, waveZ, waveFreq, wavePhase));   // optional waviness (world x/z)
        rings.push(addRingN(ac, ctr, u, v, Math.max(0.001, r), ring, t));
    }
    for (let i = 0; i < segs; i++) bandRings(ac, rings[i], rings[i + 1]);
    const last = rings[segs];
    const tipC = add(bez(1), waveOffset(1, waveX, waveZ, waveFreq, wavePhase));   // waved tip so the cap stays attached
    if (p.tailTip === 'point') capRing(ac, last, add(tipC, scl(tan(1), r0 * 0.4)), 1);
    else capRing(ac, last, tipC, 1);   // blunt / flare → flat cap
}

// ── Alpha-card tail: `cardsPerClump` crossed ribbons swept along the SAME bezier (card mode). Reuses the
//    parallel-transport frame (no spin/flip); uv.u runs across the width, uv.v root→tip (the strand texture). ──
function buildTailCards(ac: Accum, A: V3, C: V3, E: V3, r0: number, p: HairParams, segs: number, C2?: V3, waveX = 0, waveZ = 0, waveFreq = 2.5, wavePhase = 0): void {
    // C2 present → CUBIC bezier (A,C,C2,E) so the spine can S-curve (fall straight then bend); else QUADRATIC (A,C,E).
    const bez = C2
        ? (t: number): V3 => { const it = 1 - t; return [
            it*it*it*A[0] + 3*it*it*t*C[0] + 3*it*t*t*C2[0] + t*t*t*E[0],
            it*it*it*A[1] + 3*it*it*t*C[1] + 3*it*t*t*C2[1] + t*t*t*E[1],
            it*it*it*A[2] + 3*it*it*t*C[2] + 3*it*t*t*C2[2] + t*t*t*E[2] ]; }
        : (t: number): V3 => { const it = 1 - t; return [
            it*it*A[0] + 2*it*t*C[0] + t*t*E[0],
            it*it*A[1] + 2*it*t*C[1] + t*t*E[1],
            it*it*A[2] + 2*it*t*C[2] + t*t*E[2] ]; };
    const tan = C2
        ? (t: number): V3 => { const it = 1 - t; return norm([
            3*it*it*(C[0]-A[0]) + 6*it*t*(C2[0]-C[0]) + 3*t*t*(E[0]-C2[0]),
            3*it*it*(C[1]-A[1]) + 6*it*t*(C2[1]-C[1]) + 3*t*t*(E[1]-C2[1]),
            3*it*it*(C[2]-A[2]) + 6*it*t*(C2[2]-C[2]) + 3*t*t*(E[2]-C2[2]) ]); }
        : (t: number): V3 => { const it = 1 - t; return norm([
            2*it*(C[0]-A[0]) + 2*t*(E[0]-C[0]),
            2*it*(C[1]-A[1]) + 2*t*(E[1]-C[1]),
            2*it*(C[2]-A[2]) + 2*t*(E[2]-C[2]) ]); };
    // Parallel-transport one frame down the curve (same as buildTail) → cards can't spin/flip.
    const cs: V3[] = [], us: V3[] = [], tg: V3[] = [], rs: number[] = [];
    let u = perpFrame(tan(0)).u, prevT = tan(0);
    for (let i = 0; i <= segs; i++) {
        const t = i / segs, T = tan(t);
        if (i > 0) { const axis = cross(prevT, T), s = len(axis), c = dot(prevT, T);
            if (s > 1e-6) { const ax: V3 = [axis[0]/s, axis[1]/s, axis[2]/s]; u = rotAxis(u, ax, c, s); } prevT = T; }
        const ctr = add(bez(t), waveOffset(t, waveX, waveZ, waveFreq, wavePhase));   // optional waviness (world x/z)
        cs.push(ctr); us.push(u); tg.push(T); rs.push(r0 * (1 - t * p.tailTaper) * (1 - (p.tailStartTaper ?? 0) * (1 - Math.min(1, t / 0.3))));   // END + START taper
    }
    const detail = Math.max(0, Math.min(1, p.cardDetail ?? 0));
    const nCards = Math.max(1, Math.round(p.cardsPerClump * (1 + detail * 1.5)));   // 15b: more cards with detail
    const wMul = Math.max(0.6, p.cardWidth);
    const seed = ac.curTailId * 131 + 7;                 // stable per-tail jitter seed
    for (let card = 0; card < nCards; card++) {
        const j1 = hash11(seed + card * 17 + 1) - 0.5;   // per-card rotation / width / lateral-offset jitter
        const j2 = hash11(seed + card * 17 + 2) - 0.5;
        const j3 = hash11(seed + card * 17 + 3) - 0.5;
        const ang = (card / nCards) * Math.PI + j1 * detail * 1.3;   // jittered spread around the spine
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const wj = 1 + j2 * detail * 0.6;                // per-card width
        const offJ = j3 * detail * 0.5;                  // per-card lateral offset (× the local radius)
        let prevL = -1, prevR = -1;
        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            const wAxis = rotAxis(us[i], tg[i], ca, sa);  // width axis = the frame's u rotated about the tangent
            const ctr = add(cs[i], scl(wAxis, offJ * Math.max(0.001, rs[i])));
            const hw = Math.max(0.001, rs[i]) * wMul * wj;
            const n = norm(cross(wAxis, tg[i]));
            ac.curTan = tg[i];   // strand flows along the tail spine
            const li = pushVert(ac, add(ctr, scl(wAxis, -hw)), n, 0, t);
            const ri = pushVert(ac, add(ctr, scl(wAxis,  hw)), n, 1, t);
            if (i > 0) { ac.idx.push(prevL, prevR, ri); ac.idx.push(prevL, ri, li); }
            prevL = li; prevR = ri;
        }
    }
}

function buildTails(ac: Accum, h: HeadFrame, p: HairParams, segs: number, ring: number): void {
    if (p.tailStyle === 'none') return;
    const L = h.ry * p.tailLength, r0 = h.rx * p.tailThickness;
    const attach: { A: V3; out: V3 }[] = [];
    if (p.tailStyle === 'pony') {
        attach.push({ A: [h.cx, h.cy + h.ry * p.tailHeight, h.cz - h.rz * 0.9], out: [0, 0.1, -1] });
    } else {
        const y = h.cy + h.ry * (p.tailStyle === 'pig' ? p.tailHeight - 0.5 : p.tailHeight);
        for (const sx of [-1, 1]) {
            attach.push({ A: [h.cx + sx * h.rx * 0.92, y, h.cz - h.rz * 0.25], out: [sx, 0.05, -0.25] });
        }
    }
    let ti = 0;
    for (const { A, out } of attach) {
        ac.curTailId = ti++;             // tag this tail's verts so the caller can skin them to a spring chain
        const o = norm(out);
        const down: V3 = [0, -1, 0];
        const C = add(add(A, scl(o, L * p.tailSpread * 0.5)), scl(down, L * 0.4));
        const E = add(add(A, scl(o, L * p.tailSpread * 0.3)), scl(down, L * (1 + p.tailCurl * 0.3)));
        E[2] -= L * p.tailCurl * 0.25;   // curl back
        if (p.hairMode === 'cards') buildTailCards(ac, A, C, E, r0, p, Math.max(segs, Math.round(p.cardSegments)));
        else buildTail(ac, A, C, E, r0, p, segs, ring);
    }
    ac.curTailId = -1;
}

// Shoulder-top + chest-front anchors for the front drape, read off the body collision verts (12-float stride,
// pos 0-2). The bind pose is a T-POSE (arms straight out at shoulder height), so "widest x" would hit the HAND —
// instead we sample the UPPER-CHEST band, BELOW the horizontal arms, for the real torso half-width + chest-front Z,
// then place the shoulder a touch wider at a head-relative height. Falls back to head-relative when no body verts.
function drapeAnchors(body: Float32Array | undefined, h: HeadFrame): { shoulder: (sx: number) => V3; frontZAt: (y: number) => number } {
    let halfW = h.rx * 1.7;                     // torso/shoulder half-width
    const shoulderY = h.cy - h.ry * 1.9;        // shoulder height (stable, head-relative)
    // Default front profile (head-relative) when there are no body verts.
    let frontZAt = (_y: number): number => h.cz + h.rz * 1.2;
    if (body && body.length >= 12) {
        const n = body.length / 12;
        const yHi = h.cy - h.ry * 2.0;          // just BELOW the T-pose arms (which are horizontal at shoulder height)
        const yLo = h.cy - h.ry * 3.2;          // down to mid-chest
        let maxAbsX = 0;
        for (let i = 0; i < n; i++) {
            const y = body[i * 12 + 1];
            if (y > yHi || y < yLo) continue;
            const dx = Math.abs(body[i * 12] - h.cx);
            if (dx < h.rx * 2.4 && dx > maxAbsX) maxAbsX = dx;   // torso half-width (the cap ignores stray far verts)
        }
        if (maxAbsX > 0) halfW = maxAbsX * 1.15;                 // shoulders sit a bit wider than the ribcage
        // Body FRONT z at any height y (max z near the centre-line within a small y-band). Lets the drape FOLLOW the
        // torso's front profile DOWN — chest/bust sticks out, waist tucks back — instead of hanging at one chest-front
        // z (which left the tips out in front of the receded waist).
        const yBand = h.ry * 0.6;
        frontZAt = (y: number): number => {
            let maxZ = -Infinity;
            for (let i = 0; i < n; i++) {
                if (Math.abs(body[i * 12 + 1] - y) > yBand) continue;
                if (Math.abs(body[i * 12] - h.cx) > h.rx * 1.3) continue;
                const z = body[i * 12 + 2];
                if (z > maxZ) maxZ = z;
            }
            return maxZ > -Infinity ? maxZ : h.cz + h.rz * 1.2;
        };
    }
    return { shoulder: (sx: number): V3 => [h.cx + sx * halfW, shoulderY, h.cz], frontZAt };
}

// ── FRONT DRAPE: a hair section swept FORWARD over the shoulder onto the chest (the "hair over the shoulder"
//    look). Reuses the tail sweep; its tail ids CONTINUE after the back tails so the caller builds a spring chain
//    per drape (rigid wrap for uv.v < DRAPE_SPRING_FROM, springy tip beyond). Additive — a no-op when frontDrape ≤ 0.
//    Routed off the REAL shoulder/chest (drapeAnchors) — head-relative routing crested too NARROW (head ≈ ½ shoulder
//    width) so it fell straight down THROUGH the chest and never cleared the shoulder. ──
function buildFrontDrape(ac: Accum, h: HeadFrame, p: HairParams, segs: number, ring: number, bodyVerts?: Float32Array): void {
    const amt = p.frontDrape ?? 0;
    if (amt <= 0) return;
    const side = String(p.frontDrapeSide ?? 'both').toLowerCase();
    const sides: number[] = side === 'left' ? [-1] : side === 'right' ? [1] : [-1, 1];
    const fromBack = String(p.frontDrapeOrigin ?? 'back').toLowerCase() !== 'front';   // 'back' (default) = over the shoulder from the back hair; 'front' = down the front of the neck
    const L = h.ry * (p.frontDrapeLength ?? 2.2);
    const r0 = h.rx * p.tailThickness * (0.55 + amt * 0.55);          // drape thickness scales with the amount
    const anc = drapeAnchors(bodyVerts, h);
    // Strong START taper (drape-only) so each root is THIN where it emerges from the cap/back hair → blends in instead of
    // a chunky stub poking out. Overrides the global tailStartTaper for the drape's buildTail/buildTailCards only.
    const dp = { ...p, tailStartTaper: Math.max(p.tailStartTaper ?? 0, 0.9) };
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
    const waveX = clamp01(p.frontDrapeWaveX ?? 0) * h.rx * 0.5;   // 0..1 slider → world-unit amplitude along CHEST WIDTH (x)
    const waveZ = clamp01(p.frontDrapeWaveZ ?? 0) * h.rz * 0.5;   // 0..1 slider → world-unit amplitude along DEPTH (z)
    const waveFreq = 2.5;                                          // gentle S-waves along the length
    const nStray = Math.max(0, Math.round(p.frontDrapeStrays ?? 0));                 // flyaway wisp count (per side)
    const strayX = clamp01(p.frontDrapeStrayX ?? 0.7), strayZ = clamp01(p.frontDrapeStrayZ ?? 0.4);   // stray fan spread per axis
    let ti = ac.tailId.reduce((m, v) => Math.max(m, v + 1), 0);       // continue tail ids AFTER the back tails
    for (const sx of sides) {
        ac.curTailId = ti++;                                          // its own spring chain (via the caller)
        const s = anc.shoulder(sx);                                   // [x,y,z] shoulder-top anchor for this side
        // CUBIC A→C→C2→E: the drape FALLS STRAIGHT DOWN from the hair to the shoulder, THEN merges into the chest→waist
        // shape (a single quadratic can't — its first move heads straight at the lone control). C sits ~directly below A
        // so the initial tangent is vertical; C2/E are the chest/waist shape already dialled in.
        //   A  = UP in the cap hair, behind the ear
        //   C  = ~straight DOWN from A → the fall lands at the shoulder/nape (the merge point)
        //   C2 = chest crest, inward toward the sternum
        //   E  = tip, inward + hugging the lower-chest/waist front
        const cY = s[1] - h.ry * 0.6, eY = s[1] - L;                  // where the fall curves onto the chest + tip (waist)
        // Two ORIGINS (frontDrapeOrigin toggle). A (root) + C (the run to the merge point) differ; C2/E (chest→waist) shared.
        //   'front' = per the user's red line: STRAIGHT fall from above the ear down the FRONT of the thin neck (open air —
        //             a behind/centre line clips through the body) to the collarbone, then curve onto the chest.
        //   'back'  = roots UP in the BACK hair (behind the ear) + crests OVER the shoulder from behind → reads as
        //             back-hair pulled over the shoulder (doesn't compete with the front side-locks).
        const A: V3 = fromBack
            ? [h.cx + sx * h.rx * 0.5,  h.cy + h.ry * 0.12, h.cz - h.rz * 0.55]   // back hair, behind the ear
            : [h.cx + sx * h.rx * 0.55, h.cy + h.ry * 0.1,  h.cz + h.rz * 0.1];    // above the ear, front-side
        const C: V3 = fromBack
            ? [h.cx + sx * h.rx * 0.6,  s[1] + h.ry * 0.35, h.cz - h.rz * 0.12]   // down + forward, cresting over the shoulder-top from behind
            : [h.cx + sx * h.rx * 0.55, s[1] + h.ry * 0.15, h.cz + h.rz * 0.1];    // straight DOWN the front of the neck to the collarbone
        const C2: V3 = [s[0] * 0.4 + h.cx * 0.6, cY,                 anc.frontZAt(cY) + r0 * 0.8];  // curve IN + forward onto the chest
        const E:  V3 = [s[0] * 0.3 + h.cx * 0.7, eY,                 anc.frontZAt(eY) + r0 * 0.6];  // tip, hugging the lower-chest/waist
        if (p.hairMode === 'cards') buildTailCards(ac, A, C, E, r0, dp, Math.max(segs, Math.round(p.cardSegments)), C2, waveX, waveZ, waveFreq, 0);
        else buildTail(ac, A, C, E, r0, dp, segs, ring, C2, waveX, waveZ, waveFreq, 0);
        // Stray flyaway wisps: thin, jittered copies fanning out toward the TIP (share the root A with the main lock),
        // each its OWN spring chain (sways loose) + a touch more wave + a random phase so they don't sync.
        for (let k = 0; k < nStray; k++) {
            ac.curTailId = ti++;
            const jit = (n: number) => (hash11(sx * 131 + k * 17 + n + 5) - 0.5) * 2;   // -1..1, stable per side+stray
            const spX = h.rx * 0.22 * strayX, spZ = h.rz * 0.22 * strayZ, spY = h.ry * 0.06;   // fan spread per axis
            const jC:  V3 = [C[0]  + jit(1) * spX * 0.5, C[1]  + jit(2) * spY, C[2]  + jit(3) * spZ * 0.5];
            const jC2: V3 = [C2[0] + jit(4) * spX,       C2[1] + jit(5) * spY, C2[2] + jit(6) * spZ];
            const jE:  V3 = [E[0]  + jit(7) * spX * 1.6, E[1]  + jit(8) * spY, E[2]  + jit(9) * spZ * 1.6];   // fan out more at the tip
            const sr = r0 * 0.28;                                                  // thin wisp
            const swX = waveX * 1.4 + h.rx * 0.06, swZ = waveZ * 1.4;              // strays a touch wavier (+ a width baseline)
            const sph = jit(10) * Math.PI;                                         // random wave phase per stray
            if (p.hairMode === 'cards') buildTailCards(ac, A, jC, jE, sr, dp, Math.max(segs, Math.round(p.cardSegments)), jC2, swX, swZ, waveFreq, sph);
            else buildTail(ac, A, jC, jE, sr, dp, segs, ring, jC2, swX, swZ, waveFreq, sph);
        }
    }
    ac.curTailId = -1;
}

/** Smooth, outward-oriented per-vertex normals (area-weighted) — matches body-generator. */
function recomputeNormals(ac: Accum): void {
    const accN = new Float32Array(ac.count * 3);
    for (let i = 0; i < ac.idx.length; i += 3) {
        const a = ac.idx[i], b = ac.idx[i+1], c = ac.idx[i+2];
        const e1x = ac.pos[b*3]-ac.pos[a*3], e1y = ac.pos[b*3+1]-ac.pos[a*3+1], e1z = ac.pos[b*3+2]-ac.pos[a*3+2];
        const e2x = ac.pos[c*3]-ac.pos[a*3], e2y = ac.pos[c*3+1]-ac.pos[a*3+1], e2z = ac.pos[c*3+2]-ac.pos[a*3+2];
        let nx = e1y*e2z-e1z*e2y, ny = e1z*e2x-e1x*e2z, nz = e1x*e2y-e1y*e2x;
        const rx = ac.nrm[a*3]+ac.nrm[b*3]+ac.nrm[c*3];
        const ry = ac.nrm[a*3+1]+ac.nrm[b*3+1]+ac.nrm[c*3+1];
        const rz = ac.nrm[a*3+2]+ac.nrm[b*3+2]+ac.nrm[c*3+2];
        if (nx*rx + ny*ry + nz*rz < 0) { nx=-nx; ny=-ny; nz=-nz; }
        for (const v of [a, b, c]) { accN[v*3]+=nx; accN[v*3+1]+=ny; accN[v*3+2]+=nz; }
    }
    for (let i = 0; i < ac.count; i++) {
        if (ac.nLock[i]) continue;   // keep the locked volume-following normal (cap cards = scalp-outward)
        let x = accN[i*3], y = accN[i*3+1], z = accN[i*3+2];
        const l = Math.hypot(x, y, z);
        if (l < 1e-6) { x = ac.nrm[i*3]; y = ac.nrm[i*3+1]; z = ac.nrm[i*3+2]; }
        else { x/=l; y/=l; z/=l; }
        ac.nrm[i*3]=x; ac.nrm[i*3+1]=y; ac.nrm[i*3+2]=z;
    }
}

/** Per-vertex one-ring neighbours (from the hair triangles) — to smooth the de-collision push. */
function buildAdjacency(ac: Accum): number[][] {
    const adj: Set<number>[] = Array.from({ length: ac.count }, () => new Set<number>());
    for (let i = 0; i < ac.idx.length; i += 3) {
        const a = ac.idx[i], b = ac.idx[i+1], c = ac.idx[i+2];
        adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
    }
    return adj.map(s => [...s]);
}

// ── Shrink-wrap the hair OUT of the body (build-time / rest pose, like the clothing fit) ──
// Any hair vertex inside the body (or closer than `gap`) is pushed out to the surface + gap along the nearest
// body vertex's normal, then the push is SMOOTHED over the hair so a correction lifts its neighbours into a
// soft bump (no spikes). Push-ONLY → free-hanging hair (a tail in open air) is untouched. This (1) CONFORMS
// the cap to the REAL sculpted head — which the ellipsoid cap approximates badly, so the jaw/occiput poked
// through — and (2) DRAPES the tails over the shoulders/back instead of clipping into the torso/shirt.
// `body` = the body's 12-float rest verts (pos 0-2, normal 3-5); the body INCLUDES the head, so one pass does
// both. NOTE: this is the REST-pose fit; posed tail swing (the head turning) is the spring-bone job (separate).
function fitHairToBody(ac: Accum, body: Float32Array, gap: number, maxPush: number): void {
    const bn = body.length / 12;
    if (bn === 0 || ac.count === 0) return;
    const push = new Float32Array(ac.count);
    const pnx = new Float32Array(ac.count), pny = new Float32Array(ac.count), pnz = new Float32Array(ac.count);
    // Spatial hash over body verts so each hair vert only tests its LOCAL 3×3×3 cells (was O(hairVerts × bodyVerts)).
    // cell = the push reach, so a hair vert farther than that is free-hanging (no body nearby) → no push, as before.
    const grid = new VertGrid(body, Math.max(gap + maxPush, 0.05));
    for (let g = 0; g < ac.count; g++) {
        const gx = ac.pos[g*3], gy = ac.pos[g*3+1], gz = ac.pos[g*3+2];
        const best = grid.nearest(gx, gy, gz).best;
        if (best < 0) continue;                                                   // no body vert nearby → free-hanging hair, no push
        const o = best*12, nx = body[o+3], ny = body[o+4], nz = body[o+5];
        const signed = (gx-body[o])*nx + (gy-body[o+1])*ny + (gz-body[o+2])*nz;   // dist from the surface along its normal
        push[g] = Math.min(maxPush, Math.max(0, gap - signed));                   // only push OUT (never pull a floating hair in)
        pnx[g] = nx; pny[g] = ny; pnz[g] = nz;
    }
    const adj = buildAdjacency(ac);
    for (let iter = 0; iter < 3; iter++) {
        const next = push.slice();
        for (let g = 0; g < ac.count; g++) {
            const nb = adj[g]; if (!nb.length) continue;
            let s = 0; for (const k of nb) s += push[k];
            next[g] = Math.max(push[g], 0.6 * (s / nb.length));   // max → corrections never drop below the required clearance
        }
        push.set(next);
    }
    for (let g = 0; g < ac.count; g++) {
        if (push[g] > 0) { ac.pos[g*3] += pnx[g]*push[g]; ac.pos[g*3+1] += pny[g]*push[g]; ac.pos[g*3+2] += pnz[g]*push[g]; }
    }
}

/** Spring-tail bone count per tail — the chain length the tail mesh skins to (root→tip). */
export const TAIL_BONES = 4;

/** Front drape: verts BELOW this uv.v are the "wrap" (rigid — 100% head-skinned so the authored over-shoulder
 *  shape HOLDS, no spring collapse); verts ABOVE it are the hanging TIP — the only part on a spring chain, which
 *  is rooted at the shoulder. Shared by computeTailBones (chain sampling) + _buildHairSpringRig (vertex skinning). */
export const DRAPE_SPRING_FROM = 0.55;

/** generateHair output: the mesh + the dynamic-tail rig hints (the caller builds spring chains from these). */
export interface HairResult {
    geometry: MeshGeometry;
    /** One chain of body-local REST positions (root→tip, length TAIL_BONES) per tail — sampled from the
     *  DRAPED tail (post shrink-wrap) so the spring chain's rest pose matches the conformed hair. */
    tailBones: [number, number, number][][];
    /** Per vertex: the tail index it belongs to (−1 = cap/bangs/sidelocks → stays 100% on the head joint). */
    tailVertId: Int32Array;
    /** Tail ids >= this are FRONT DRAPES (over-the-shoulder). Their WRAP is head-skinned (rigid) and only the
     *  hanging TIP springs (see DRAPE_SPRING_FROM). Equals the tail count when there's no drape. */
    drapeFromTailId: number;
}

/** Tail bone rest positions = centroid of each tail's verts bucketed by uv.v (root→tip) into TAIL_BONES bins.
 *  Uses the post-shrink-wrap positions so the chain follows the draped tail. Empty bins carry the last. */
function computeTailBones(ac: Accum, nTails: number, drapeFromTailId: number): [number, number, number][][] {
    const out: [number, number, number][][] = [];
    for (let t = 0; t < nTails; t++) {
        const isDrape = t >= drapeFromTailId;
        const sx = new Array(TAIL_BONES).fill(0), sy = new Array(TAIL_BONES).fill(0), sz = new Array(TAIL_BONES).fill(0);
        const cnt = new Array(TAIL_BONES).fill(0);
        for (let i = 0; i < ac.count; i++) {
            if (ac.tailId[i] !== t) continue;
            let v = ac.uv[i*2+1];
            if (isDrape) {                                     // a drape's chain covers ONLY the hanging tip, rooted at the shoulder
                if (v < DRAPE_SPRING_FROM) continue;           // wrap verts don't shape the chain (they're head-skinned)
                v = (v - DRAPE_SPRING_FROM) / (1 - DRAPE_SPRING_FROM);
            }
            const b = Math.max(0, Math.min(TAIL_BONES - 1, Math.round(v * (TAIL_BONES - 1))));
            sx[b] += ac.pos[i*3]; sy[b] += ac.pos[i*3+1]; sz[b] += ac.pos[i*3+2]; cnt[b]++;
        }
        const bones: [number, number, number][] = [];
        for (let b = 0; b < TAIL_BONES; b++) {
            if (cnt[b] > 0) bones.push([sx[b]/cnt[b], sy[b]/cnt[b], sz[b]/cnt[b]]);
            else bones.push(bones.length ? [...bones[bones.length-1]] as [number, number, number] : [0, 0, 0]);
        }
        out.push(bones);
    }
    return out;
}

// ── Phase A: scalp LENGTH (hair hangs past the hairline) + CURL/WAVE + LAYERING (docs/specs/hair-styles.md) ──
// A perimeter ring of hanging strands draping from the hairline DOWN to a per-region target length → the cap
// becomes a bob / long / hime cut. Each strand is a CROSSED ribbon (3D in chunky + cards) with optional
// wave/spiral curl, length variation (layering) + choppy ends. Skinned to the head (jiggle = a later pass).

/** Perpendicular curl displacement at strand t (0 root → 1 tip), in the (u,v) plane ⊥ to the strand. */
function curlDisp(t: number, u: V3, v: V3, amt: number, freq: number, phase: number, type: 'none' | 'wave' | 'spiral'): V3 {
    if (type === 'none' || amt <= 0) return [0, 0, 0];
    const a = t * freq * Math.PI * 2 + phase;
    const grow = 0.25 + 0.75 * t;                              // straighter at the root, curlier toward the tip
    if (type === 'spiral') return add(scl(u, Math.cos(a) * amt * grow), scl(v, Math.sin(a) * amt * grow));
    return scl(u, Math.sin(a) * amt * grow);                  // wave = side-to-side in u
}

/** Wave offset in WORLD X (chest width) + Z (depth) with INDEPENDENT amplitudes — grows toward the tip. Used by the
 *  front drape so "waviness" reads as side-to-side across the chest (x), controllable separately from depth (z),
 *  instead of the arbitrary strand-frame axis (which happened to land on z). */
function waveOffset(t: number, ampX: number, ampZ: number, freq: number, phase: number): V3 {
    if (ampX === 0 && ampZ === 0) return [0, 0, 0];
    const s = Math.sin(t * freq * Math.PI * 2 + phase) * (0.25 + 0.75 * t);   // grow: straighter root → wavier tip
    return [s * ampX, 0, s * ampZ];
}

/** One hanging strand: a CROSSED ribbon (two ⊥ strips → volume from any angle) swept from `start` along `down`
 *  for `length`, with curl + a blunt/pointed tip. Skinned to the head. */
function buildHangingStrand(ac: Accum, start: V3, down: V3, length: number, baseW: number, segs: number, p: HairParams, phase: number, ry: number): void {
    const d = norm(down);
    const fr = perpFrame(d);                                   // u, v ⊥ to the hang
    const amt = Math.max(0, Math.min(1, p.curlAmount ?? 0)) * ry * 0.22;
    const freq = Math.max(0.5, p.curlFreq ?? 3);
    const type = (p.curlType ?? 'none');
    const blunt = Math.max(0, Math.min(1, p.scalpBluntness ?? 0.5));
    const strip = (wdir: V3, faceN: V3, wmul: number): void => {
        let prevL = -1, prevR = -1;
        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            const c = add(add(start, scl(d, t * length)), curlDisp(t, fr.u, fr.v, amt, freq, phase, type));
            const w = baseW * wmul * (1 - t * (1 - blunt) * 0.8);   // blunt → wide tip; pointed → taper
            ac.curTan = d;                                          // strand flows down (sheen)
            const li = pushVert(ac, add(c, scl(wdir, -w * 0.5)), faceN, 0, t);
            const ri = pushVert(ac, add(c, scl(wdir,  w * 0.5)), faceN, 1, t);
            if (i > 0) { ac.idx.push(prevL, prevR, ri); ac.idx.push(prevL, ri, li); }
            prevL = li; prevR = ri;
        }
    };
    strip(fr.u, fr.v, 1);
    strip(fr.v, fr.u, 0.85);
}

/** Hanging scalp hair around the whole perimeter → bob / long / hime. Per-region lengths (front short under the
 *  bangs · sides → cheek · back → down) + per-strand layering + chop. No-op when scalpLength is 0. */
function buildScalpLength(ac: Accum, h: HeadFrame, p: HairParams, lanes: number, segs: number): void {
    const len = p.scalpLength ?? 0;
    if (len <= 0.001) return;
    const thetaMax = Math.PI * 0.6;
    const hairlineTheta = Math.min(thetaMax, Math.acos(Math.max(-0.2, Math.min(0.92, p.hairlineFront))));
    const vol = Math.max(0, Math.min(1, p.volume ?? 0));
    const grow = 0.03, off = h.ry * (0.04 + vol * 0.1);
    const Rx = h.rx * (1 + grow), Rz = h.rz * (1 + grow), Ry = h.ry * (1 + grow) + h.ry * p.crownRound;
    const baseW = (Math.PI * 2 * Math.max(Rx, Rz) / lanes) * 0.95;
    for (let lane = 0; lane < lanes; lane++) {
        const ph = (lane / lanes) * Math.PI * 2 + (hash11(lane * 5.3) - 0.5) * (Math.PI * 2 / lanes) * 0.5;
        const cph = Math.cos(ph), sph = Math.sin(ph);
        const front = Math.max(0, sph), back = Math.max(0, -sph), side = 1 - Math.abs(sph);
        const regionLen = p.lengthFront * front + p.lengthBack * back + p.lengthSide * side;
        const seed = lane * 97.7;
        const layerCut = 1 - (p.layering ?? 0) * hash11(seed + 1) * 0.6;
        const chopJ    = 1 - (p.chop ?? 0)     * hash11(seed + 2) * 0.4;
        const L = len * regionLen * h.ry * layerCut * chopJ;
        if (L < 0.01) continue;
        const startTheta = thetaMax * (1 - front) + hairlineTheta * front;   // front strands start higher (hairline)
        const st = Math.sin(startTheta), ctn = Math.cos(startTheta);
        const dir: V3 = [st * cph, ctn, st * sph];
        const start: V3 = [h.cx + dir[0] * (Rx + off), h.cy + dir[1] * (Ry + off), h.cz + dir[2] * (Rz + off)];
        const down: V3 = norm([dir[0] * 0.15, -1, dir[2] * 0.15 + back * 0.12]);   // mostly down; follows the head out then falls
        const phase = (p.curlPhaseJitter ?? 0) * hash11(seed + 3) * Math.PI * 2;
        const w = baseW * (0.8 + hash11(seed + 4) * 0.4);
        buildHangingStrand(ac, start, down, L, w, segs, p, phase, h.ry);
    }
}

/** Generate a hairstyle mesh around `head`. `uv.v` runs 0 (root) → 1 (tip) for the gradient.
 *  `bodyVerts` (optional, the body's 12-float rest geometry) enables the shrink-wrap that conforms the cap to
 *  the head + drapes the tails over the body (no clipping). Returns the mesh + spring-tail rig hints. */
export function generateHair(headIn: HeadFrame, partial?: Partial<HairParams>, bodyVerts?: Float32Array): HairResult {
    const p = { ...DEFAULT_HAIR_PARAMS, ...partial };
    // Accept either case for the enum dropdowns ('Twin' ↔ 'twin', 'Parted' ↔ 'parted', …) so a UI
    // that binds a capitalized display label still drives the geometry.
    const lc = (s: string) => String(s ?? '').toLowerCase().trim();
    p.partingStyle = lc(p.partingStyle) as HairParams['partingStyle'];
    p.tailStyle    = lc(p.tailStyle)    as HairParams['tailStyle'];
    p.tailTip      = lc(p.tailTip)      as HairParams['tailTip'];
    p.hairMode     = lc(p.hairMode)     as HairParams['hairMode'];
    // The hair HUGS the real head. Do NOT lift the whole build by verticalOffset — that floated the cap off the
    // skull (the "hair floating above the head" bug). verticalOffset now only raises the BANG hairline (folded
    // into buildBangs' rootY), so the cap / side locks / tails always sit on the head.
    const head: HeadFrame = headIn;
    const ac: Accum = { pos: [], nrm: [], uv: [], idx: [], count: 0, tailId: [], curTailId: -1, nLock: [], curLock: false, tanDir: [], curTan: [0, 0, 0] };
    const ch = Math.max(0, Math.min(1, p.chunkiness));
    const capLat = 5 + Math.round(ch * 5);   // cap latitude rings (3–6 → 4–8 → now 5–10) → the shrink-wrap conforms tighter to the head
    const ring   = 24;                        // cap segments around = the HEAD's 24-gon (built in the same X/Z frame, fu=[1,0,0]/fv=[0,0,1]) → segments angularly ALIGN with the head columns so nothing pokes between faces. ~40 extra verts, computed at generation time → perf is a non-issue.
    const ribSeg = 3 + Math.round(ch * 2);
    const tailSeg = 4 + Math.round(ch * 4);
    const tailRing = 6;

    // "Cardify Cap" = the Elden-Ring look: NO solid cap/dome/scalp AT ALL — the cap is built ENTIRELY from layered
    // hair cards (buildCapCards: an OPAQUE base card layer that covers the head + `capLayers−1` wispy volume layers,
    // phase-shifted so the translucent strand gaps fill in → full, not sparse). VOLUME = card puff, CAP LAYERS =
    // density; Cap Thickness is inert in this mode. Plain Cards / Chunky keep the full Cap-Thickness-driven solid cap.
    const cardedCap = p.hairMode === 'cards' && p.cardifyCap;
    // BUZZ cut = a thin uniform cap hugging the scalp; it suppresses every other length component below.
    if (p.buzzCut) {
        buildCap(ac, head, { ...p, capThickness: Math.min(p.capThickness, 0.03), backLength: 0, crownRound: Math.min(p.crownRound, 0.03) }, capLat, ring);
    } else if (p.spikeCap) {
        buildCap(ac, head, p, capLat, ring);                                         // short solid base so no scalp shows between spikes
        buildSpikeCap(ac, head, p, Math.round(20 + ch * 16), 4 + Math.round(ch * 3));
    } else if (cardedCap) {
        buildCapCards(ac, head, p, Math.round(16 + (ch + p.cardDetail) * 14), 6 + Math.round(ch * 4));
    } else {
        buildCap(ac, head, p, capLat, ring);
    }
    if (!p.buzzCut) {
        buildBangs(ac, head, p, ribSeg);
        buildSideLocks(ac, head, p, ribSeg + 1);
        buildTails(ac, head, p, tailSeg, tailRing);
    }
    const drapeFromTailId = ac.tailId.reduce((m, v) => Math.max(m, v + 1), 0);   // back tails occupy [0, this); the drape's tails continue from here
    if (!p.buzzCut) {
        buildFrontDrape(ac, head, p, tailSeg, tailRing, bodyVerts);   // optional: hair swept forward over the shoulder onto the chest (default off)
        buildScalpLength(ac, head, p, Math.round(34 + ch * 22), 8 + Math.round(ch * 10));   // Phase A: scalp length (bob/long/hime) + curl/wave + layering
        // BUNS (Phase C1): round = top-centre · space = two upper-side · long = man-bun (bun at the back + tapered tuft).
        const bunStyle = String(p.bunStyle ?? 'none').toLowerCase();
        if (bunStyle !== 'none') {
            const br = head.rx * (p.bunSize ?? 0.5);
            if (bunStyle === 'space') {
                buildBun(ac, [head.cx + head.rx * 0.78, head.cy + head.ry * 0.78, head.cz - head.rz * 0.1], br * 0.8);
                buildBun(ac, [head.cx - head.rx * 0.78, head.cy + head.ry * 0.78, head.cz - head.rz * 0.1], br * 0.8);
            } else if (bunStyle === 'long') {
                buildBun(ac, [head.cx, head.cy + head.ry * 0.4, head.cz - head.rz * 1.05], br * 0.9, [0.1, -0.25, -1]);   // back + paintbrush tuft
            } else {
                buildBun(ac, [head.cx, head.cy + head.ry * 1.02, head.cz - head.rz * 0.1], br);   // round, top-centre
            }
        }
    }
    buildFacialHair(ac, head, p);   // independent of buzzCut — a buzz + beard is valid

    // Shrink-wrap out of the body: cap → conforms to the real head, tails → drape over the shoulders/back.
    // Small gap (a hair off the skin) + a generous push so a tail buried in the torso still clears. Done before
    // the normals are recomputed (it moves verts).
    if (bodyVerts && bodyVerts.length >= 12) fitHairToBody(ac, bodyVerts, 0.004, 0.1);

    recomputeNormals(ac);

    const vcount = ac.count;
    const verts = new Float32Array(vcount * 12);
    for (let i = 0; i < vcount; i++) {
        const o = i * 12;
        const nx = ac.nrm[i*3], ny = ac.nrm[i*3+1], nz = ac.nrm[i*3+2];
        // Tangent = the stored STRAND direction (for the anisotropic sheen), orthogonalized against the
        // normal; fall back to a generic tangent where no strand direction was set.
        let t: V3;
        const td0 = ac.tanDir[i*3], td1 = ac.tanDir[i*3+1], td2 = ac.tanDir[i*3+2];
        const dn = td0*nx + td1*ny + td2*nz;
        const ox = td0 - nx*dn, oy = td1 - ny*dn, oz = td2 - nz*dn;
        const ol = Math.hypot(ox, oy, oz);
        if (ol > 1e-4) { t = [ox/ol, oy/ol, oz/ol]; }
        else { const ref: V3 = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0]; t = norm(cross([nx, ny, nz], ref)); }
        verts[o]   = ac.pos[i*3]; verts[o+1] = ac.pos[i*3+1]; verts[o+2]  = ac.pos[i*3+2];
        verts[o+3] = nx;          verts[o+4] = ny;            verts[o+5]  = nz;
        verts[o+6] = ac.uv[i*2];  verts[o+7] = ac.uv[i*2+1];
        verts[o+8] = t[0];        verts[o+9] = t[1];          verts[o+10] = t[2]; verts[o+11] = 1;
    }
    const nTails = ac.tailId.reduce((m, v) => Math.max(m, v + 1), 0);
    return {
        geometry: { vertices: verts, indices: new Uint32Array(ac.idx), format: '12float' },
        tailBones: computeTailBones(ac, nTails, drapeFromTailId),
        tailVertId: Int32Array.from(ac.tailId),
        drapeFromTailId,
    };
}
