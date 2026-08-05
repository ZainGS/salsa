// ── World generation — Phase C: street furniture ────────────────────────────────────────────────
// The lived-in clutter of a Japanese street, all merged + seeded + capped: utility POLES with sagging overhead
// WIRES down the arterials, low-poly PARKED CARS at the curbs, glowing VENDING MACHINES on corners, and MANHOLE
// covers on the road. Placement is POSITION-HASH deterministic (not a running rng) so toggling a district never
// shifts another's furniture. Everything skips canal cells (no furniture floating on the water).

import type { WorldGraph, LayoutPreviewLayer, V2, InstanceXform } from './types';
import { metalScaleFor, cityMetresPerUnit } from './types';
import { newVendingAccum, emitVending, vendingLayers, VENDING_BRANDS, resolveVendingParams,
    vendingGarpPool, vendingShellGeometry, vendingShellTransform, vendingProductsGeometry, vendingProductsTransform } from './vending';
import { METAL_PAINTED } from './palette';
import { hash2, pointInPolygon, bounds } from './util';
import { Accum3D } from './meshbuild';
import { makeVehicleAcc, emitVehicle, VEH_TAXI, VEH_GLASS, VEH_TYRE, VEH_CHROME, VEH_TAXI_SIGN, type VehicleType } from './vehicle';
import { binInstanceTransform, binCanonicalGeometry, binGarpPool } from './trash-bin';
import { resolveCrateParams, crateInstanceTransforms, crateCanonicalGeometry, crateGarpPool } from './crate';
import { ventInstanceTransform, ventCanonicalGeometry, ventGarpPool } from './vent';
import { emitStall, resolveStallParams, stallAwningInstanceTransform, stallAwningCanonicalGeometry, stallGarpPool, STALL_CANON_W } from './stall';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { aboardInstanceTransform, aboardCanonicalGeometry, aboardGarpPool } from './a-board';
import { posterInstanceTransform, posterCanonicalGeometry, posterGarpPool } from './poster';
import { cellLevelAt, makeElevation } from './elevation';
import { regionAt } from './layout';
import { inShotengai } from './shotengai';

type V3 = [number, number, number];

const POLE: [number, number, number] = [0.34, 0.31, 0.28];    // weathered concrete utility pole
const WIRE: [number, number, number] = [0.08, 0.08, 0.09];    // overhead cable
const MANHOLE: [number, number, number] = [0.24, 0.24, 0.27];
const CARBODY: [number, number, number][] = [[0.80, 0.80, 0.83], [0.20, 0.22, 0.26], [0.62, 0.20, 0.20], [0.20, 0.36, 0.55]];   // white/black/red/blue
const CAR_NAMES = ['white', 'black', 'red', 'blue'];
const CAR_DARK: [number, number, number] = [0.10, 0.11, 0.13];   // glass + wheels
const BENCH: [number, number, number] = [0.34, 0.40, 0.36];    // painted-metal street bench
const SHELTER: [number, number, number] = [0.26, 0.27, 0.30];  // bus-stop shelter frame + roof
const STOPSIGN: [number, number, number] = [0.20, 0.44, 0.72]; // bus-stop sign panel (blue, lit)
const BIKE: [number, number, number] = [0.28, 0.44, 0.48];     // bicycle frame (wheels reuse the dark layer)
const POSTBOX: [number, number, number] = [0.82, 0.20, 0.17];  // red JP post box
const CABINET: [number, number, number] = [0.56, 0.57, 0.59];  // grey utility cabinet
const CONE: [number, number, number] = [0.93, 0.46, 0.13];     // orange traffic cone
const GUARDRAIL: [number, number, number] = [0.64, 0.64, 0.66];// metal guardrail

const nrm2 = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

export function buildFurniture(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const p = graph.params, gy = p.groundY, s = p.radius / 10, half = p.streetWidth * 0.5;
    const metalScale = metalScaleFor(p.radius);   // cycles per WORLD UNIT (diorama)
    const H = (a: number, b: number, salt: number): number => hash2(a, b, (p.seed ^ salt) >>> 0);
    // Placement guard: canals + the pedestrian street + anywhere outside the city border stay clear.
    const wet = (x: number, z: number): boolean => cellLevelAt(graph, x, z) < 0 || inShotengai(graph, x, z) || !pointInPolygon([x, z], graph.border);
    const enabled = (x: number, z: number): boolean => !keep || keep(regionAt(graph, x, z) ?? -1);
    // Is a point inside a BUILT lot footprint (so a deep prop like a stall doesn't back into a wall)?
    const builtLots = graph.lots.filter(l => l.zone !== 'park' && l.zone !== 'water' && l.poly.length >= 3).map(l => ({ poly: l.poly, b: bounds(l.poly) }));
    const inBuilding = (x: number, z: number): boolean => {
        for (const { poly, b } of builtLots) {
            if (x < b.min[0] || x > b.max[0] || z < b.min[1] || z > b.max[1]) continue;
            if (pointInPolygon([x, z], poly)) return true;
        }
        return false;
    };
    // Poles sit exactly ON grid-cell corners (road crossings), where the discrete terrace step in the height
    // post-transform TEARS a thin prism/ring apart (half the ring lifts a full step → giant black sails on the
    // wires). So the pole/wire layers BAKE the elevation here (sampled once per pole → rigid, seamless) and are
    // routed with NO field in world-manager._add.
    const lift = makeElevation(graph);

    // Shared per-(road, side) longitudinal reservation so the INDEPENDENT curb families (poles, cars, benches,
    // clutter, stalls, bus stops, bikes) stop landing on top of one another — each ran its own RNG before and had
    // no idea what the others had already put on the kerb. First family to claim a stretch wins; later ones skip
    // it. Keyed by road index + side; intervals are distance ALONG the road (world units). No RNG consumed → the
    // existing hash-driven placement is unchanged except that colliding props now drop out.
    const claimed = new Map<string, Array<[number, number]>>();
    const tryClaim = (ri: number, side: number, along: number, halfLen: number): boolean => {
        const key = ri + ':' + side, lo = along - halfLen, hi = along + halfLen;
        const arr = claimed.get(key);
        if (!arr) { claimed.set(key, [[lo, hi]]); return true; }
        for (const iv of arr) if (lo < iv[1] && hi > iv[0]) return false;   // overlaps a claimed stretch
        arr.push([lo, hi]); return true;
    };

    const pole = new Accum3D(), wire = new Accum3D(), manhole = new Accum3D();
    const carBody = CARBODY.map(() => new Accum3D()), carDark = new Accum3D();
    // Upgraded parked cars (vehicle.ts): shared detail (glass/trim/chrome/taxi belt+sign) + a yellow taxi body.
    const pv = makeVehicleAcc(), taxiBody = new Accum3D();
    const vend = newVendingAccum();   // proper sub-layered machines (vending.ts), not one flat box each
    const bench = new Accum3D(), shelter = new Accum3D(), shelterSign = new Accum3D(), bike = new Accum3D();
    const postbox = new Accum3D(), cabinet = new Accum3D(), cone = new Accum3D(), guardrail = new Accum3D();
    // Street clutter — all GARP-skinnable, so each is INSTANCED (one canonical geo + a transform per copy).
    const crateInst: InstanceXform[] = [], binInst: InstanceXform[] = [], ventInst: InstanceXform[] = [];
    const aboardInst: InstanceXform[] = [], stallAwnInst: InstanceXform[] = [], posterInst: InstanceXform[] = [];
    const stallWood = new Accum3D(), stallProd = new Accum3D();   // stall body stays baked; only the awning is instanced
    const clutterWpm = 1 / cityMetresPerUnit(p.radius);   // metres → diorama units, for the Creator-authored clutter

    graph.roads.forEach((road, ri) => {
        if (road.klass === 'alley') return;
        const a = road.a, b = road.b, dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        if (len < 1e-3) return;
        const d = nrm2([dx, dz]), pp: V2 = [-d[1], d[0]];       // along-road + cross-road unit
        const curb = half + 0.03 * s;

        // Utility POLES + overhead WIRES along the arterials (one curb side), consecutive poles strung together.
        if ((p.powerLines ?? true) && road.klass === 'arterial') {
            const sp = 1.15 * s, n = Math.max(2, Math.round(len / sp));
            let prevTop: V3 | null = null;
            for (let i = 0; i <= n; i++) {
                const t = i / n, x = a[0] + dx * t + pp[0] * curb, z = a[1] + dz * t + pp[1] * curb;
                if (t * len < half + 0.05 * s || (1 - t) * len < half + 0.05 * s) { prevTop = null; continue; }   // loop is inclusive → keep poles out of the junction mouth
                if (wet(x, z) || !enabled(x, z)) { prevTop = null; continue; }
                if (!tryClaim(ri, 1, t * len, 0.05 * s)) { prevTop = null; continue; }   // poles run first → they seed the +curb side
                const top = addPole(pole, [x, gy + lift(x, z), z], d, s);   // elevation baked (layer routed flat)
                if (prevTop) addWire(wire, prevTop, top, s);   // sagging span from the previous pole
                if (H(ri, 100 + i, 0x0c0f) < 0.42) posterInst.push(posterInstanceTransform([x, gy + lift(x, z), z], pp, clutterWpm, 0.17));   // flyers, clear of the ~0.15 m pole
                prevTop = top;
            }
        }

        // MANHOLE on the road centreline (some segments).
        if ((p.streetFurniture ?? true) && H(ri, 0, 0x1101) < 0.28) {
            const x = (a[0] + b[0]) * 0.5, z = (a[1] + b[1]) * 0.5;
            if (!wet(x, z) && enabled(x, z)) manhole.prism([x, gy + 0.002 * s, z], 0.02 * s, 0.02 * s, 0.004 * s, 10);
        }

        // PARKED CARS at the curb (arterials + streets), skipping the intersection mouths and canals.
        if ((p.parkedCars ?? true) && road.klass !== 'ring') {
            const cl = 0.14 * s, sp = 0.42 * s, n = Math.floor(len / sp);
            for (let i = 0; i < n; i++) {
                const t = (i + 0.5) / n;
                if (t * len < half + cl || (1 - t) * len < half + cl) continue;   // clear of the junction
                if (H(ri, i, 0x2c07) > 0.5) continue;                              // ~half the slots
                const side = H(ri, i, 0x51a9) < 0.5 ? 1 : -1;
                const x = a[0] + dx * t + pp[0] * (half + 0.04 * s) * side, z = a[1] + dz * t + pp[1] * (half + 0.04 * s) * side;
                if (wet(x, z) || !enabled(x, z)) continue;
                if (!tryClaim(ri, side, t * len, 0.16 * s)) continue;   // a parked car is long → reserve a wide stretch
                const ci = (H(ri, i, 0x77f3) * CARBODY.length) | 0, vt = H(ri, i, 0x9911);
                // Upgraded vehicle mix (vehicle.ts): buses / trucks / checker taxis / old-school classics / sedans.
                const type: VehicleType = vt < 0.08 ? 'bus' : vt < 0.17 ? 'truck'
                    : (() => { const vt2 = H(ri, i, 0x5a7c); return vt2 < 0.08 ? 'taxi' : vt2 < 0.26 ? 'classic' : 'sedan'; })();
                pv.body = type === 'taxi' ? taxiBody : carBody[ci];
                emitVehicle(pv, [x, gy, z], [d[0], 0, d[1]], [pp[0], 0, pp[1]], s, type, { lights: false });
            }
        }

        // BENCHES on the sidewalk (a few slots), facing the road.
        if ((p.streetFurniture ?? true) && road.klass !== 'ring') {
            const sp = 0.9 * s, n = Math.floor(len / sp);
            for (let i = 0; i < n; i++) {
                if (H(ri, i, 0x4b1d) > 0.16) continue;
                const t = (i + 0.5) / n; if (t * len < half + 0.12 * s || (1 - t) * len < half + 0.12 * s) continue;
                const side = H(ri, i, 0x6f2a) < 0.5 ? 1 : -1;
                const x = a[0] + dx * t + pp[0] * (half + 0.07 * s) * side, z = a[1] + dz * t + pp[1] * (half + 0.07 * s) * side;
                if (wet(x, z) || !enabled(x, z)) continue;
                if (!tryClaim(ri, side, t * len, 0.12 * s)) continue;
                addBench(bench, [x, gy, z], d, [pp[0] * side, pp[1] * side], s);
            }
        }

        // STREET CLUTTER — bins / crates / pavement grates on the sidewalk (trash-bin.ts / crate.ts / vent.ts).
        if ((p.streetFurniture ?? true) && road.klass !== 'ring') {
            const sp = 0.7 * s, n = Math.floor(len / sp);
            for (let i = 0; i < n; i++) {
                const roll = H(ri, i, 0x3ca9);
                if (roll > 0.34) continue;                                     // ~34% of slots get clutter
                const t = (i + 0.5) / n; if (t * len < half + 0.10 * s || (1 - t) * len < half + 0.10 * s) continue;
                const side = H(ri, i, 0x71b3) < 0.5 ? 1 : -1;
                const x = a[0] + dx * t + pp[0] * (half + 0.05 * s) * side, z = a[1] + dz * t + pp[1] * (half + 0.05 * s) * side;
                if (wet(x, z) || !enabled(x, z)) continue;
                if (!tryClaim(ri, side, t * len, 0.10 * s)) continue;
                // INSTANCED props aren't draped by the height pass (only baked geometry is) — bake the elevation
                // here with `lift(x,z)` like the poles do, or they sink under the terrain.
                const cy = gy + lift(x, z);
                if (roll < 0.14) {                                             // bins (instanced barrel → skinnable)
                    binInst.push(binInstanceTransform([x, cy, z], 0.9 + H(ri, i, 0x4e21) * 0.2, clutterWpm));
                } else if (roll < 0.24) {                                      // crate stacks
                    const cp = resolveCrateParams({ count: 1 + ((H(ri, i, 0x6d13) * 3) | 0), sizeM: 0.45 });
                    crateInst.push(...crateInstanceTransforms([x, cy, z], cp, clutterWpm));
                } else if (roll < 0.30) {                                      // flush pavement grate
                    ventInst.push(ventInstanceTransform([x, cy, z], 0.7, [d[0], d[1]]));
                } else {                                                       // A-board outside a shop, facing the road
                    aboardInst.push(aboardInstanceTransform([x, cy, z], [-pp[0] * side, -pp[1] * side], 0.6));
                }
            }
        }

        // PRODUCE STALLS — occasional market stall at a shopfront, facing the road. Wood + produce baked;
        // the AWNING is instanced + GARP-skinnable (stall.ts), so build the stall body with awning:false.
        if ((p.streetFurniture ?? true) && road.klass !== 'ring' && len > 1.4 * s && H(ri, 5, 0x9d3b) < 0.22) {
            const t = 0.35 + H(ri, 6, 0x4417) * 0.3, side = H(ri, 7, 0x2c81) < 0.5 ? 1 : -1;
            const x = a[0] + dx * t + pp[0] * (half + 0.10 * s) * side, z = a[1] + dz * t + pp[1] * (half + 0.10 * s) * side;
            // The stall body reaches ~0.6 m toward the shopfront — skip if that back edge lands in a building.
            const bx = x + pp[0] * side * 0.06 * s, bz = z + pp[1] * side * 0.06 * s;
            if (!wet(x, z) && enabled(x, z) && !inBuilding(bx, bz) && tryClaim(ri, side, t * len, 0.16 * s)) {
                // Fixed width == the canonical awning width, so the instanced canopy scales 1:1 (its height stays put
                // and matches the baked posts, instead of floating with a width-driven uniform scale).
                const sp = resolveStallParams({ widthM: STALL_CANON_W, awning: false });
                const cW: [number, number, number] = [-pp[0] * side, 0, -pp[1] * side];   // customer side faces the road
                emitStall(stallWood, new Accum3D(), stallProd, [x, gy, z], [d[0], 0, d[1]], cW, sp, clutterWpm, { posts: true });   // body + posts baked → draped
                stallAwnInst.push(stallAwningInstanceTransform([x, gy + lift(x, z), z], [cW[0], cW[2]], STALL_CANON_W));   // canopy instanced (s=1)
            }
        }

        // BUS STOP on some arterials — a small shelter + a lit sign.
        if ((p.streetFurniture ?? true) && road.klass === 'arterial' && len > 1.2 * s && H(ri, 0, 0x88c1) < 0.5) {
            const t = 0.4, side = H(ri, 1, 0x2d5e) < 0.5 ? 1 : -1;
            const x = a[0] + dx * t + pp[0] * (half + 0.08 * s) * side, z = a[1] + dz * t + pp[1] * (half + 0.08 * s) * side;
            if (!wet(x, z) && enabled(x, z) && tryClaim(ri, side, t * len, 0.20 * s)) addBusStop(shelter, shelterSign, [x, gy, z], d, [pp[0] * side, pp[1] * side], s);
        }

        // A ROW OF PARKED BICYCLES on the sidewalk (nose-in, perpendicular to the road) — very JP.
        if ((p.bicycles ?? true) && road.klass !== 'ring' && H(ri, 0, 0x1b1c) < 0.32) {
            const t0 = 0.28 + H(ri, 1, 0x2a2a) * 0.44, side = H(ri, 2, 0x3c11) < 0.5 ? 1 : -1;
            if (tryClaim(ri, side, t0 * len, 0.14 * s)) {   // the whole 4-bike row reserves one stretch
                const cx = a[0] + dx * t0, cz = a[1] + dz * t0;
                for (let k = 0; k < 4; k++) {
                    const off = (k - 1.5) * 0.032 * s;
                    const x = cx + d[0] * off + pp[0] * (half + 0.06 * s) * side, z = cz + d[1] * off + pp[1] * (half + 0.06 * s) * side;
                    if (wet(x, z) || !enabled(x, z)) continue;
                    addBike(bike, carDark, [x, gy, z], [pp[0] * side, pp[1] * side], s);
                }
            }
        }

        // GUARDRAIL along some arterial curbs (posts + a continuous top rail).
        if ((p.streetFurniture ?? true) && road.klass === 'arterial' && H(ri, 3, 0x6611) < 0.4) {
            const side = H(ri, 4, 0x2231) < 0.5 ? 1 : -1, off = half + 0.015 * s, gn = Math.max(2, Math.round(len / (0.11 * s)));
            let prev: V3 | null = null;
            for (let i = 0; i <= gn; i++) {
                const t = i / gn; if (t * len < half + 0.05 * s || (1 - t) * len < half + 0.05 * s) { prev = null; continue; }
                const x = a[0] + dx * t + pp[0] * off * side, z = a[1] + dz * t + pp[1] * off * side;
                if (wet(x, z) || !enabled(x, z)) { prev = null; continue; }
                if (i % 3 === 0) guardrail.prism([x, gy, z], 0.004 * s, 0.004 * s, 0.05 * s, 4);
                const top: V3 = [x, gy + 0.045 * s, z];
                if (prev) guardrail.beam(prev, top, 0.0035 * s, 3);
                prev = top;
            }
        }
    });

    // CORNER PROPS: red post boxes, grey utility cabinets, orange cone clusters (the OTHER corner from vending).
    if (p.streetFurniture ?? true) {
        graph.intersections.forEach((it, ii) => {
            if (wet(it.pos[0], it.pos[1]) || !enabled(it.pos[0], it.pos[1])) return;
            const d0 = nrm2(it.arms[0]), pd: V2 = [-d0[1], d0[0]];
            const cx = it.pos[0] + (d0[0] - pd[0]) * (half + 0.05 * s), cz = it.pos[1] + (d0[1] - pd[1]) * (half + 0.05 * s);
            if (wet(cx, cz)) return;
            const g = H(ii, 5, 0x1234), aW: V3 = [d0[0], 0, d0[1]], up: V3 = [0, 1, 0], pW: V3 = [pd[0], 0, pd[1]];
            if (g < 0.12) postbox.obox([cx, gy + 0.05 * s, cz], aW, up, pW, 0.014 * s, 0.05 * s, 0.011 * s);
            else if (g < 0.26) cabinet.obox([cx, gy + 0.04 * s, cz], aW, up, pW, 0.028 * s, 0.04 * s, 0.016 * s);
            else if (g < 0.33) for (let k = 0; k < 3; k++) cone.cone([cx + pW[0] * (k - 1) * 0.018 * s, gy, cz + pW[2] * (k - 1) * 0.018 * s], 0.009 * s, 0.028 * s, 5, 0);
        });
    }

    // VENDING MACHINES on some junction corners (glow). The generator authors in real METRES, so the city
    // scales by world-units-per-metre — physically-correct size, and (with the default dims) identical to
    // the machine's prior hardcoded size to the millimetre.
    // GARP fascia (docs/specs/city-props-garp.md §2): the cabinet/glow/glass stay MERGE-EMITTED (one draw per
    // brand), but the brand HEADER is INSTANCED so each machine can wear a different skin — a merged mesh has one
    // textureIndex and can't. World-gen supplies only the transforms + seed; SKIN SELECTION happens at scene
    // instantiation via pickSkin over the RUNTIME pool, so user-added variants are eligible (a static world-gen
    // pick could only ever choose the built-in brands).
    const shellInst: InstanceXform[] = [];
    const productsInst: InstanceXform[] = [];
    if (p.streetFurniture ?? true) {
        const worldPerMetre = 1 / cityMetresPerUnit(p.radius);
        graph.intersections.forEach((it, ii) => {
            if (H(ii, 0, 0x9e11) > 0.22) return;
            if (wet(it.pos[0], it.pos[1]) || !enabled(it.pos[0], it.pos[1])) return;
            const d0 = nrm2(it.arms[0]), pd: V2 = [-d0[1], d0[0]];
            const corner: V2 = [it.pos[0] + (d0[0] + pd[0]) * (half + 0.04 * s), it.pos[1] + (d0[1] + pd[1]) * (half + 0.04 * s)];
            if (wet(corner[0], corner[1])) return;
            for (let k = 0; k < 2; k++) {
                const off = (k - 0.5) * 0.06 * s, x = corner[0] + d0[0] * off, z = corner[1] + d0[1] * off;
                if (wet(x, z)) continue;   // re-check AFTER the along-road shift — the corner test isn't enough near canals
                const vi = (H(ii, k, 0x30bd) * VENDING_BRANDS.length) | 0;
                const vparams = resolveVendingParams({ brand: vi, seed: p.seed });
                const dir: V2 = [-pd[0], -pd[1]];   // machines face the street (away from the corner)
                // Skip the cabinet AND the product boxes in the merge — both are instanced as GARP-textured layers
                // below (shell + products panel); the rest of the window furniture (glow/glass/frame/tray) merges.
                emitVending(vend, [x, gy, z], dir, vparams, worldPerMetre, p.seed, true, true);
                // Instanced body SHELL + products PANEL per machine; skins chosen at instantiation from (x,z)+seed.
                shellInst.push(vendingShellTransform([x, gy, z], dir, vparams, worldPerMetre));
                productsInst.push(vendingProductsTransform([x, gy, z], dir, vparams, worldPerMetre));
            }
        });
    }

    const out: LayoutPreviewLayer[] = [];
    if (!pole.empty) out.push({ name: 'world:util-pole', color: POLE, y: gy, geometry: pole.geometry() });
    if (!wire.empty) out.push({ name: 'world:util-wire', color: WIRE, y: gy, geometry: wire.geometry() });
    if (!manhole.empty) out.push({ name: 'world:manhole', color: MANHOLE, y: gy, geometry: manhole.geometry() });
    carBody.forEach((acc, i) => { if (!acc.empty) out.push({ name: 'world:car-' + CAR_NAMES[i], color: CARBODY[i], y: gy, geometry: acc.geometry(), reflect: { strength: 0.4, roughness: 0.3 } }); });   // car-paint sheen
    // This layer is windscreens AND wheels — glass on a tyre is wrong, but the tyre is a dark blob under
    // the body where the fresnel term barely fires, and a car whose windows do not catch the sky reads as
    // a painted brick. The trade is worth it; split the layer if the wheels ever start glinting.
    if (!carDark.empty) out.push({ name: 'world:car-glass', color: CAR_DARK, y: gy, geometry: carDark.geometry(), glass: true });
    // Upgraded parked-car detail (vehicle.ts): yellow taxi bodies + shared glass / tyres / chrome / taxi belt + sign.
    if (!taxiBody.empty)  out.push({ name: 'world:car-taxi',   color: VEH_TAXI, y: gy, geometry: taxiBody.geometry(), reflect: { strength: 0.4, roughness: 0.3 } });
    if (!pv.glass.empty)  out.push({ name: 'world:car-glass2', color: VEH_GLASS, y: gy, geometry: pv.glass.geometry(), glass: true });
    if (!pv.trim.empty)   out.push({ name: 'world:car-trim',   color: VEH_TYRE, y: gy, geometry: pv.trim.geometry() });
    if (!pv.chrome.empty) out.push({ name: 'world:car-chrome', color: VEH_CHROME, y: gy, geometry: pv.chrome.geometry(), metal: { roughness: 0.28, scale: metalScale } });
    if (!pv.band.empty)   out.push({ name: 'world:car-band',   color: [0.08, 0.08, 0.09], y: gy, geometry: pv.band.geometry(), pattern: { color: [0.96, 0.96, 0.96], mode: 'checker', freq: 26, scale: 1 } });
    if (!pv.sign.empty)   out.push({ name: 'world:car-sign',   color: VEH_TAXI_SIGN, y: gy, geometry: pv.sign.geometry(), emissive: 0.6 });
    // ── Instanced, GARP-skinnable street clutter (one canonical geometry + a transform per copy) ─────────────
    const wpm2 = 1 / cityMetresPerUnit(p.radius);
    const garpLayer = (inst: InstanceXform[], name: string, geo: MeshGeometry, poolId: string, slot: string, extra: Partial<LayoutPreviewLayer> = {}) => {
        // drape:'baked' — the instance y already bakes the terrain via lift(x,z) (like the poles); the height pass
        // must not touch it again. Prevents both the "sinks under the hills" and any double-lift.
        if (inst.length) out.push({ name, color: [1, 1, 1], y: gy, geometry: geo, instances: inst, arrayGroup: true, drape: 'baked', garp: { pool: poolId, slot, seed: p.seed }, ...extra });
    };
    garpLayer(crateInst, 'world:crate', crateCanonicalGeometry(wpm2), crateGarpPool().id, 'label');
    garpLayer(binInst, 'world:trash-bin', binCanonicalGeometry(wpm2), binGarpPool().id, 'body');
    garpLayer(ventInst, 'world:vent', ventCanonicalGeometry(wpm2), ventGarpPool().id, 'face');
    garpLayer(aboardInst, 'world:aboard', aboardCanonicalGeometry(wpm2), aboardGarpPool().id, 'face', { singleSided: false });
    garpLayer(stallAwnInst, 'world:stall-awning', stallAwningCanonicalGeometry(wpm2), stallGarpPool().id, 'awning', { singleSided: false });
    garpLayer(posterInst, 'world:poster', posterCanonicalGeometry(wpm2), posterGarpPool().id, 'art', { singleSided: false });
    // Stall body (wood + produce) stays baked.
    if (!stallWood.empty) out.push({ name: 'world:stall', color: [0.46, 0.32, 0.20], y: gy, geometry: stallWood.geometry() });
    if (!stallProd.empty) out.push({ name: 'world:stall-produce', color: [0.82, 0.52, 0.20], y: gy, geometry: stallProd.geometry(), pattern: { color: [0.72, 0.22, 0.18], mode: 'dots', freq: 5, scale: 1 } });
    out.push(...vendingLayers(vend, metalScaleFor(p.radius), { night: !!p.nightMode }));
    // The instanced, GARP-skinned machine BODY (one canonical shell + a transform per machine). `garp` marks it
    // for the dedicated GARP atlas; each copy's skin is chosen at scene instantiation from its (x,z)+seed.
    if (shellInst.length) {
        const wpm = 1 / cityMetresPerUnit(p.radius);
        out.push({
            name: 'world:vending-body', color: [1, 1, 1], y: gy,
            geometry: vendingShellGeometry(resolveVendingParams({ seed: p.seed }), wpm),
            instances: shellInst, arrayGroup: true, garp: { pool: vendingGarpPool().id, slot: 'body', seed: p.seed },
        });
        // The instanced products PANEL (a flat GARP-skinned drink display behind the glass) — modest emissive so it
        // reads as a backlit display; the merged glow backing behind it lights the scene + shows a thin lit border.
        out.push({
            name: 'world:vending-products', color: [1, 1, 1], y: gy, emissive: p.nightMode ? 0.8 : 0.3,
            geometry: vendingProductsGeometry(resolveVendingParams({ seed: p.seed }), wpm),
            instances: productsInst, arrayGroup: true, garp: { pool: vendingGarpPool().id, slot: 'products', seed: p.seed },
        });
    }
    if (!bench.empty) out.push({ name: 'world:bench', color: BENCH, y: gy, geometry: bench.geometry() });
    if (!shelter.empty) out.push({ name: 'world:busstop', color: SHELTER, y: gy, geometry: shelter.geometry() });
    if (!shelterSign.empty) out.push({ name: 'world:busstop-sign', color: STOPSIGN, y: gy, geometry: shelterSign.geometry(), emissive: p.nightMode ? 1.1 : 0.6 });
    // Frame tubes and wheels — bare metal, and shiny enough to catch a highlight. Low grime: a bike in
    // use gets rained on but not left to silt up like rooftop plant.
    if (!bike.empty) out.push({ name: 'world:bicycle', color: BIKE, y: gy, geometry: bike.geometry(),
        metal: { tint: BIKE, streak: [BIKE[0] * 0.6, BIKE[1] * 0.6, BIKE[2] * 0.62], roughness: 0.30,
            streakAmount: 0.30, grime: 0.20, scale: metalScale * 2.0 } });
    if (!guardrail.empty) out.push({ name: 'world:guardrail', color: GUARDRAIL, y: gy, geometry: guardrail.geometry(), metal: { ...METAL_PAINTED, scale: metalScale } });
    if (!postbox.empty) out.push({ name: 'world:postbox', color: POSTBOX, y: gy, geometry: postbox.geometry() });
    if (!cabinet.empty) out.push({ name: 'world:cabinet', color: CABINET, y: gy, geometry: cabinet.geometry() });
    if (!cone.empty) out.push({ name: 'world:cone', color: CONE, y: gy, geometry: cone.geometry() });
    return out;
}

/** A very low-poly bicycle: two wheels + a frame triangle + a handlebar, seen side-on along `along`. */
function addBike(frame: Accum3D, dark: Accum3D, base: V3, along: V2, s: number): void {
    const aW: V3 = [along[0], 0, along[1]], wr = 0.016 * s, wb = 0.042 * s;
    const fh: V3 = [base[0] + aW[0] * wb, base[1] + wr, base[2] + aW[2] * wb];   // front hub
    const bh: V3 = [base[0] - aW[0] * wb, base[1] + wr, base[2] - aW[2] * wb];   // rear hub
    dark.blob([fh[0], fh[1], fh[2]], wr, wr, 0.005 * s, 0, 0);
    dark.blob([bh[0], bh[1], bh[2]], wr, wr, 0.005 * s, 0, 0);
    const seat: V3 = [base[0] - aW[0] * 0.008 * s, base[1] + 0.05 * s, base[2] - aW[2] * 0.008 * s];
    const bars: V3 = [base[0] + aW[0] * 0.03 * s, base[1] + 0.052 * s, base[2] + aW[2] * 0.03 * s];
    frame.beam(bh, seat, 0.003 * s, 3); frame.beam(fh, seat, 0.003 * s, 3); frame.beam(fh, bars, 0.003 * s, 3);
    frame.beam(bars, [bars[0], bars[1] + 0.012 * s, bars[2]], 0.004 * s, 3);   // handlebar stem
}

/** A small street bench: seat slab + backrest + two legs. `face` points toward the road (backrest sits away from it). */
function addBench(bench: Accum3D, base: V3, along: V2, face: V2, s: number): void {
    const aW: V3 = [along[0], 0, along[1]], up: V3 = [0, 1, 0], fW: V3 = [face[0], 0, face[1]], len = 0.055 * s;
    const seatY = base[1] + 0.022 * s;
    bench.obox([base[0], seatY, base[2]], aW, up, fW, len, 0.004 * s, 0.018 * s);                                                    // seat
    bench.obox([base[0] - fW[0] * 0.016 * s, seatY + 0.02 * s, base[2] - fW[2] * 0.016 * s], aW, up, fW, len, 0.018 * s, 0.004 * s); // backrest
    for (const sx of [-1, 1]) bench.prism([base[0] + aW[0] * len * 0.8 * sx, base[1], base[2] + aW[2] * len * 0.8 * sx], 0.004 * s, 0.004 * s, 0.022 * s, 4);
}

/** A bus-stop shelter: two posts + a flat roof + a lit sign panel on a pole at the front. */
function addBusStop(shelter: Accum3D, sign: Accum3D, base: V3, along: V2, face: V2, s: number): void {
    const aW: V3 = [along[0], 0, along[1]], up: V3 = [0, 1, 0], fW: V3 = [face[0], 0, face[1]], w = 0.09 * s, h = 0.14 * s;
    for (const sx of [-1, 1]) shelter.prism([base[0] + aW[0] * w * sx - fW[0] * 0.03 * s, base[1], base[2] + aW[2] * w * sx - fW[2] * 0.03 * s], 0.005 * s, 0.005 * s, h, 4);   // back posts
    shelter.obox([base[0] - fW[0] * 0.03 * s, base[1] + h, base[2] - fW[2] * 0.03 * s], aW, up, fW, w * 1.15, 0.006 * s, 0.05 * s);   // roof
    const sx = base[0] + aW[0] * w * 1.25, sz = base[2] + aW[2] * w * 1.25;
    shelter.prism([sx, base[1], sz], 0.004 * s, 0.004 * s, 0.17 * s, 4);                                                              // sign pole
    sign.obox([sx + fW[0] * 0.01 * s, base[1] + 0.155 * s, sz + fW[2] * 0.01 * s], aW, up, fW, 0.026 * s, 0.02 * s, 0.003 * s);        // sign panel
}

/** A utility pole: tall post + a short cross-arm near the top + a small transformer can. Returns the wire-attach top. */
function addPole(pole: Accum3D, base: V3, along: V2, s: number): V3 {
    const h = 0.55 * s, r = 0.011 * s;   // ~8.25 m — real utility poles tower over the low buildings (was a 4.5 m stub)
    pole.prism(base, r, r * 0.8, h, 6);
    const top: V3 = [base[0], base[1] + h, base[2]];
    pole.beam([top[0] - along[0] * 0.05 * s, top[1] - 0.02 * s, top[2] - along[1] * 0.05 * s], [top[0] + along[0] * 0.05 * s, top[1] - 0.02 * s, top[2] + along[1] * 0.05 * s], r * 0.5, 4);   // cross-arm
    pole.obox([base[0], base[1] + h * 0.72, base[2]], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.012 * s, 0.02 * s, 0.012 * s);   // transformer
    return [top[0], top[1] - 0.02 * s, top[2]];
}


/** A sagging overhead wire between two pole tops (two beams via a lowered midpoint = a cheap catenary). */
function addWire(wire: Accum3D, a: V3, b: V3, s: number): void {
    const mid: V3 = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5 - 0.035 * s, (a[2] + b[2]) * 0.5];
    wire.beam(a, mid, 0.0025 * s, 3);
    wire.beam(mid, b, 0.0025 * s, 3);
}
