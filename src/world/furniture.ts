// ── World generation — Phase C: street furniture ────────────────────────────────────────────────
// The lived-in clutter of a Japanese street, all merged + seeded + capped: utility POLES with drooping multi-wire
// CATENARIES + service drops down arterials AND ordinary streets, parked cars ON THE ASPHALT at the kerb, VENDING
// runs against the shopfronts, slatted benches, ring-wheeled bicycles at racks, bollards at the crossings, red post
// boxes, utility cabinets, and cones only where there are roadworks.
//
// WHERE things go is decided ONCE by the shared pavement plan (street-slots.ts) — the same reservation the trees
// (biome) and the static crowd (pedestrians) read — so no family lands on another, nothing is placed inside a lot,
// and toggling one family never moves another. This file only EMITS geometry for the plan's slots (+ the region
// filter and the per-family toggles). Everything skips canal cells (no furniture floating on the water).

import type { WorldGraph, LayoutPreviewLayer, V2, InstanceXform } from './types';
import { metalScaleFor, cityMetresPerUnit } from './types';
import { newVendingAccum, emitVending, vendingLayers, VENDING_BRANDS, resolveVendingParams,
    vendingGarpPool, vendingShellGeometry, vendingShellTransform, vendingProductsGeometry, vendingFootTransform,
    vendingStockGeometry, vendingStockVariant, VENDING_STOCK_VARIANTS } from './vending';
import { METAL_PAINTED } from './palette';
import { hash2 } from './util';
import { Accum3D, catenary, partOf } from './meshbuild';
import { twinAccum, withFarTwin, PROP_TWIN_M } from './lod-accum';
import { makeVehicleAcc, emitVehicle, VEH_TAXI, VEH_GLASS, VEH_TYRE, VEH_CHROME, VEH_TAXI_SIGN, VEH_LAYER_LOOK, VEH_PAINT, type VehicleType } from './vehicle';
import { binInstanceTransform, binCanonicalGeometry, binGarpPool } from './trash-bin';
import { crateInstanceTransforms, crateCanonicalGeometry, crateGarpPool } from './crate';
import { ventInstanceTransform, ventCanonicalGeometry, ventGarpPool } from './vent';
import { emitStall, resolveStallParams, stallAwningInstanceTransform, stallAwningCanonicalGeometry, stallGarpPool, STALL_CANON_W } from './stall';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import { aboardInstanceTransform, aboardCanonicalGeometry, aboardGarpPool } from './a-board';
import { posterInstanceTransform, posterCanonicalGeometry, posterGarpPool } from './poster';
import { emitBikeRack, bikeRackLayers, resolveBikeRackParams } from './bike-rack';
import { emitBollard, bollardLayers, resolveBollardParams, BOLLARD_FINISHES } from './bollard';
import { emitBicycle } from './mannequin';
import { cellLevelAt, makeElevation } from './elevation';
import { regionAt } from './layout';
import { streetPlan, pavementLift, PARKED_TYPES, BENCH_SEAT_M, type Slot } from './street-slots';
import { buildFrontage } from './frontage';

type V3 = [number, number, number];

const POLE: [number, number, number] = [0.34, 0.31, 0.28];    // weathered concrete utility pole
const WIRE: [number, number, number] = [0.08, 0.08, 0.09];    // overhead cable
const INSULATOR: [number, number, number] = [0.72, 0.70, 0.66];// porcelain insulators + the transformer can
const MANHOLE: [number, number, number] = [0.24, 0.24, 0.27];
const CARBODY: [number, number, number][] = [[0.80, 0.80, 0.83], [0.20, 0.22, 0.26], [0.62, 0.20, 0.20], [0.20, 0.36, 0.55]];   // white/black/red/blue
const CAR_NAMES = ['white', 'black', 'red', 'blue'];
const BENCH: [number, number, number] = [0.30, 0.32, 0.33];    // bench frame (painted metal)
const BENCH_WOOD: [number, number, number] = [0.52, 0.36, 0.22];
const SHELTER: [number, number, number] = [0.26, 0.27, 0.30];  // bus-stop shelter frame + roof
const STOPSIGN: [number, number, number] = [0.20, 0.44, 0.72]; // bus-stop sign panel (blue, lit)
const BIKES: [number, number, number][] = [[0.72, 0.74, 0.76], [0.12, 0.12, 0.13], [0.56, 0.74, 0.70], [0.70, 0.22, 0.20]];   // silver / black / mint / red frames
const POSTBOX: [number, number, number] = [0.80, 0.16, 0.14];  // red JP post box
const POSTBOX_TRIM: [number, number, number] = [0.16, 0.16, 0.17];
const CABINET: [number, number, number] = [0.60, 0.61, 0.60];  // grey utility cabinet
const CABINET_TRIM: [number, number, number] = [0.32, 0.33, 0.33];
const CONE: [number, number, number] = [0.93, 0.46, 0.13];     // orange traffic cone
const CONE_BAND: [number, number, number] = [0.94, 0.94, 0.92];
const GUARDRAIL: [number, number, number] = [0.64, 0.64, 0.66];// metal guardrail

export function buildFurniture(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const p = graph.params, gy = p.groundY, s = p.radius / 10, half = p.streetWidth * 0.5;
    const py = gy + pavementLift(p);                       // pavement top (props stand on it; parked cars on the road)
    const metalScale = metalScaleFor(p.radius);   // cycles per WORLD UNIT (diorama)
    const u = 1 / cityMetresPerUnit(p.radius);    // metres → world units
    const H = (a: number, b: number, salt: number): number => hash2(a, b, (p.seed ^ salt) >>> 0);
    const plan = streetPlan(graph);
    const wet = (x: number, z: number): boolean => cellLevelAt(graph, x, z) < 0;
    const enabled = (x: number, z: number): boolean => !keep || keep(regionAt(graph, x, z) ?? -1);
    const use = (sl: Slot): boolean => enabled(sl.x, sl.z) && !wet(sl.x, sl.z);
    const furn = p.streetFurniture ?? true;
    // Poles/wires + instanced props BAKE the elevation (the discrete terrace step tears a thin prism apart; instanced
    // canonical geometry must lift its transform, not its vertices) — routed with no field in world-manager._add.
    const lift = makeElevation(graph);
    const road = (sl: Slot) => plan.roads[sl.ri]!;
    const faceRoad = (sl: Slot): V2 => { const R = road(sl); return [-R.pp[0] * sl.side, -R.pp[1] * sl.side]; };

    // P9: poles + insulators and the parked cars' trim + chrome also build a cheap FAR TWIN (lod-accum.ts).
    const pole = twinAccum(PROP_TWIN_M.pole, u, p.propTwins), wire = new Accum3D(), insul = twinAccum(PROP_TWIN_M.pole, u, p.propTwins), manhole = new Accum3D();
    const carBody = CARBODY.map(() => new Accum3D());
    const pv = makeVehicleAcc(), taxiBody = new Accum3D();
    pv.trim = twinAccum(PROP_TWIN_M.carTrim, u, p.propTwins); pv.chrome = twinAccum(PROP_TWIN_M.carTrim, u, p.propTwins);
    const vend = newVendingAccum();
    const bench = new Accum3D(), benchWood = new Accum3D(), shelter = new Accum3D(), shelterSign = new Accum3D();
    const bikeFrames = BIKES.map(() => new Accum3D()), bikeTyre = new Accum3D(), rack = new Accum3D(), bollard = new Accum3D();
    const postbox = new Accum3D(), postboxTrim = new Accum3D(), cabinet = new Accum3D(), cabinetTrim = new Accum3D();
    const cone = new Accum3D(), coneBand = new Accum3D(), works = new Accum3D(), guardrail = new Accum3D();
    const crateInst: InstanceXform[] = [], binInst: InstanceXform[] = [], ventInst: InstanceXform[] = [];
    const aboardInst: InstanceXform[] = [], stallAwnInst: InstanceXform[] = [], posterInst: InstanceXform[] = [];
    const stallWood = new Accum3D(), stallProd = new Accum3D();

    // ── UTILITY POLES + CATENARIES (E11) ─────────────────────────────────────────────────────────────────
    // Consecutive poles on one road are strung with 3 power wires on the cross-arm (porcelain insulators) + 2 lower
    // telecom cables, each a 10-segment catenary with its own sag; ~half the poles drop a service line to the nearest
    // facade at ~2nd-floor height (lot frontage), some across the street.
    if (p.powerLines ?? true) {
        const byRoad = new Map<number, Slot[]>();
        for (const sl of plan.of('pole')) (byRoad.get(sl.ri) ?? byRoad.set(sl.ri, []).get(sl.ri)!).push(sl);
        for (const [, poles] of byRoad) {
            poles.sort((a, b) => a.along - b.along);
            let prev: { rig: PoleRig; along: number } | null = null;
            for (const sl of poles) {
                if (!use(sl)) { prev = null; continue; }
                const R = road(sl), base: V3 = [sl.x, gy + lift(sl.x, sl.z), sl.z];
                const rig = partOf([pole, insul], base, R.d, () => addPole(pole, insul, base, R.d, [R.pp[0] * sl.side, R.pp[1] * sl.side], s, sl.h < 0.3));   // P20: one prop part
                if (prev && sl.along - prev.along < 2.2 * s) addSpan(wire, prev.rig, rig, s);
                if (sl.h < 0.42) posterInst.push(posterInstanceTransform([sl.x, base[1], sl.z], [R.pp[0] * sl.side, R.pp[1] * sl.side], u, 0.17));
                // SERVICE DROP to the facade behind the pole (and, sometimes, across the street).
                for (const [side, roll] of [[sl.side, sl.h], [-sl.side as 1 | -1, 1 - sl.h]] as [1 | -1, number][]) {
                    if (roll > (side === sl.side ? 0.55 : 0.25)) continue;
                    const al = sl.along + (H(sl.ri, sl.n * 2 + (side > 0 ? 1 : 0), 0x5d0f) - 0.5) * 0.3 * s;
                    const fr = plan.frontageAt(sl.ri, side, al);
                    if (fr == null) continue;
                    const [fx, fz] = plan.at(sl.ri, side, al, fr - 0.004 * s);
                    const top: V3 = [fx, gy + lift(fx, fz) + 0.34 * s, fz];
                    catenary(wire, rig.tele[0], top, 0.012 * s, 6, 0.0012 * s);
                }
                prev = { rig, along: sl.along };
            }
        }
    }

    // ── MANHOLE covers on some carriageway centrelines ───────────────────────────────────────────────────
    if (furn) graph.roads.forEach((r, ri) => {
        if (r.klass === 'alley' || H(ri, 0, 0x1101) >= 0.28) return;
        const x = (r.a[0] + r.b[0]) * 0.5, z = (r.a[1] + r.b[1]) * 0.5;
        if (!wet(x, z) && enabled(x, z)) manhole.prism([x, gy + 0.002 * s, z], 0.02 * s, 0.02 * s, 0.004 * s, 10);
    });

    // ── PARKED CARS on the asphalt (E2/E14): kerb-side flank ~0.2 m off the kerb, facing the traffic of their lane
    //    (left-hand traffic). Buses/trucks only on arterials — the plan picks the type.
    if (p.parkedCars ?? true) {
        for (const sl of plan.of('parked')) {
            if (!use(sl)) continue;
            // Left-hand traffic: the +pp side is the RIGHT of a→b, so a car parked there faces b→a (and vice versa).
            const R = road(sl), fwd: V2 = [-R.d[0] * sl.side, -R.d[1] * sl.side];
            // Round 4 body variety: a plan 'sedan' slot becomes a 90s sedan / hatch / kei wagon by a position hash
            // (the slot plan + its lengths stay untouched — the hatch/kei are SHORTER, so they always fit).
            let type = PARKED_TYPES[sl.n] as VehicleType;
            if (type === 'sedan') { const v = H(Math.round(sl.x * 1000), Math.round(sl.z * 1000), 0xca75); type = v < 0.22 ? 'hatch' : v < 0.40 ? 'kei' : 'sedan'; }
            const ci = (sl.h * CARBODY.length) | 0;
            pv.body = type === 'taxi' ? taxiBody : carBody[ci];
            // P20: the parked car's trim / chrome / glass / lenses / taxi belt are one prop part (the painted body stays merged).
            partOf([pv.trim, pv.chrome, pv.glass, pv.lensHead, pv.lensTail, pv.band, pv.sign], [sl.x, gy, sl.z], fwd, () =>
                emitVehicle(pv, [sl.x, gy, sl.z], [fwd[0], 0, fwd[1]], [-fwd[1], 0, fwd[0]], s, type, { lights: false }));
        }
    }

    // ── ROADWORKS: a steel plate / open patch ringed by cones + a striped barrier (the only place cones appear) ──
    if (furn) {
        for (const sl of plan.of('roadworks')) {
            if (!use(sl)) continue;
            const R = road(sl), d: V3 = [R.d[0], 0, R.d[1]], c: V3 = [R.pp[0] * sl.side, 0, R.pp[1] * sl.side], up: V3 = [0, 1, 0];
            works.obox([sl.x, gy + 0.0015 * s, sl.z], d, up, c, sl.half * 0.55, 0.0015 * s, 0.04 * s);   // the steel plate
            const n = 6;
            for (let k = 0; k < n; k++) {
                const t = (k / (n - 1) - 0.5) * 2, al = sl.along + t * sl.half * 0.85, off = sl.off + (k % 2 ? 0.03 : -0.03) * s * (Math.abs(t) < 0.9 ? 1 : 0);
                const [x, z] = plan.at(sl.ri, sl.side, al, off);
                addCone(cone, coneBand, [x, gy, z], u);
            }
            // A striped A-frame barrier on the traffic side of the patch.
            const [bx, bz] = plan.at(sl.ri, sl.side, sl.along, sl.off - 0.05 * s);
            coneBand.obox([bx, gy + 0.9 * u, bz], d, up, c, 0.6 * u, 0.1 * u, 0.02 * u);
            for (const k of [-1, 1]) cone.beam([bx + d[0] * k * 0.55 * u, gy, bz + d[2] * k * 0.55 * u], [bx + d[0] * k * 0.55 * u, gy + 1.0 * u, bz + d[2] * k * 0.55 * u], 0.03 * u, 4);
        }
    }

    // ── BENCHES (slatted, E9) + BUS STOPS (shelter + lit sign + a bench inside) ──────────────────────────────
    if (furn) {
        for (const sl of plan.of('bench')) if (use(sl)) partOf([bench, benchWood], [sl.x, py, sl.z], road(sl).d, () => addBench(bench, benchWood, [sl.x, py, sl.z], road(sl).d, faceRoad(sl), u));
        for (const sl of plan.of('busstop')) {
            if (!use(sl)) continue;
            const R = road(sl), face = faceRoad(sl);
            addBusStop(shelter, shelterSign, [sl.x, py, sl.z], R.d, face, s);
            const [bx, bz] = plan.at(sl.ri, sl.side, sl.along, sl.off - 0.004 * s);
            addBench(bench, benchWood, [bx, py, bz], R.d, face, u);
        }
    }

    // ── BIKE RACKS + BICYCLES (E9): a hoop rack on the kerb band, ring-wheeled mamachari angled shallowly across it ──
    if (p.bicycles ?? true) {
        for (const sl of plan.of('bikerow')) {
            if (!use(sl)) continue;
            const R = road(sl), n = sl.n, pitch = 0.62 * u;
            const rp = resolveBikeRackParams({ hoops: Math.max(2, Math.ceil(n / 2) + 1), lengthM: n * 0.62, widthM: 0.55, heightM: 0.75 });
            emitBikeRack(rack, [sl.x, py, sl.z], [R.pp[0], R.pp[1]], rp, u);
            const ang = 0.32 * (sl.h < 0.5 ? 1 : -1);   // ~18°: the bikes lean along the kerb, not across the footway
            for (let k = 0; k < n; k++) {
                const al = sl.along + (k - (n - 1) / 2) * pitch;
                const [x, z] = plan.at(sl.ri, sl.side, al, sl.off);
                const ca = Math.cos(ang), sa = Math.sin(ang);
                const f: V2 = [R.d[0] * ca - R.d[1] * sa, R.d[1] * ca + R.d[0] * sa];
                const col = (H(sl.ri, k + Math.round(sl.along * 100), 0xb1c0) * BIKES.length) | 0;
                emitBicycle(bikeFrames[col], bikeTyre, { o: [x, py, z], f, u }, { basket: H(sl.ri, k, 0xb1c1) < 0.6 });
            }
        }
    }

    // ── BOLLARDS (E9): a short row on the kerb at every junction corner (protecting the waiting crowd, leaving the
    //    zebra landing open), and a line across each shotengai entrance (pedestrian street — no cars). ─────────────
    const bp = resolveBollardParams({ cap: 'dome', finish: 'black', heightM: 0.8, radiusM: 0.07 });
    if (furn) {
        // One short row per CORNER of a 4-way junction (each corner is shared by two arms — only the arm with the
        // corner on its travel-left side from the node places it), on ~60% of junctions.
        plan.roads.forEach((R) => {
            if (!R || (R.klass !== 'arterial' && R.klass !== 'street')) return;
            for (const end of [0, 1] as const) {
                if ((end === 0 ? R.armsA : R.armsB) < 4) continue;
                if (H(R.ri * 2 + end, 0, 0xb011) > 0.6) continue;
                for (const side of [end === 0 ? 1 : -1] as const) {
                    const S = R.sides[side];
                    for (let k = 0; k < 2; k++) {
                        const dAl = half + 0.075 * s + k * 0.022 * s;
                        const al = end === 0 ? dAl : R.len - dAl;
                        const [x, z] = plan.at(R.ri, side, al, S.kerbIn + 0.008 * s);
                        if (wet(x, z) || !enabled(x, z) || plan.inBuilding(x, z)) continue;
                        partOf([bollard], [x, py, z], [0, 1], () => emitBollard(bollard, [x, py, z], bp, u));
                    }
                }
            }
        });
        const sg = graph.shotengai;
        if (sg && (!keep || keep(sg.region))) {
            const dx = sg.spine[1][0] - sg.spine[0][0], dz = sg.spine[1][1] - sg.spine[0][1], L = Math.hypot(dx, dz) || 1;
            const d: V2 = [dx / L, dz / L], pp: V2 = [-d[1], d[0]];
            for (const [e, inward] of [[sg.spine[0], 1], [sg.spine[1], -1]] as [V2, number][]) {
                for (let k = 0; k < 5; k++) {
                    const lat = (k / 4 - 0.5) * sg.width * 0.8;
                    const x = e[0] + d[0] * inward * 0.03 * s + pp[0] * lat, z = e[1] + d[1] * inward * 0.03 * s + pp[1] * lat;
                    if (!wet(x, z)) partOf([bollard], [x, py, z], [0, 1], () => emitBollard(bollard, [x, py, z], bp, u));
                }
            }
        }
        // GUARDRAIL on arterial kerbs along the junction approaches (the pedestrian pen by the crossing).
        plan.roads.forEach((R) => {
            if (!R || R.klass !== 'arterial' || H(R.ri, 3, 0x6611) >= 0.55) return;
            for (const end of [0, 1] as const) {
                if ((end === 0 ? R.armsA : R.armsB) < 3) continue;
                const side: 1 | -1 = H(R.ri, 4 + end, 0x2231) < 0.5 ? 1 : -1, off = half + 0.006 * s;
                const a0 = half + 0.15 * s, a1 = a0 + 0.35 * s, gn = 6;
                let prev: V3 | null = null;
                for (let i = 0; i <= gn; i++) {
                    const dAl = a0 + (a1 - a0) * i / gn, al = end === 0 ? dAl : R.len - dAl;
                    if (al < 0 || al > R.len) { prev = null; continue; }
                    const [x, z] = plan.at(R.ri, side, al, off);
                    if (wet(x, z) || !enabled(x, z)) { prev = null; continue; }
                    if (i % 2 === 0) guardrail.prism([x, py, z], 0.004 * s, 0.004 * s, 0.05 * s, 4);
                    const top: V3 = [x, py + 0.045 * s, z];
                    if (prev) guardrail.beam(prev, top, 0.0035 * s, 3);
                    prev = top;
                }
            }
        });
    }

    // ── FRONTAGE CLUTTER by lot zone (E13): A-boards / crates / stalls by shop doors, bins by homes + vending runs ──
    if (furn) {
        for (const sl of plan.of('aboard')) if (use(sl)) aboardInst.push(aboardInstanceTransform([sl.x, py + lift(sl.x, sl.z), sl.z], faceRoad(sl), 0.6));
        for (const sl of plan.of('bin')) if (use(sl)) binInst.push(binInstanceTransform([sl.x, py + lift(sl.x, sl.z), sl.z], 0.9 + sl.h * 0.2, u));
        for (const sl of plan.of('crate')) {
            if (!use(sl)) continue;
            const f = faceRoad(sl), seed = Math.floor(hash2(Math.round(sl.x * 1000), Math.round(sl.z * 1000), (p.seed ^ 0xc8a7) >>> 0) * 1e6) + 1;
            crateInstanceTransforms([sl.x, py + lift(sl.x, sl.z), sl.z], { count: Math.max(1, sl.n), sizeM: 0.45, seed }, u, Math.atan2(f[0], f[1]))
                .forEach(t => crateInst.push(t));
        }
        for (const sl of plan.of('stall')) {
            if (!use(sl)) continue;
            const R = road(sl), cW: V3 = [-R.pp[0] * sl.side, 0, -R.pp[1] * sl.side];   // customer side faces the road
            const sp = resolveStallParams({ widthM: STALL_CANON_W, awning: false });
            emitStall(stallWood, new Accum3D(), stallProd, [sl.x, py, sl.z], [R.d[0], 0, R.d[1]], cW, sp, u, { posts: true });
            stallAwnInst.push(stallAwningInstanceTransform([sl.x, py + lift(sl.x, sl.z), sl.z], [cW[0], cW[2]], STALL_CANON_W));
        }
        // Flush pavement grates now and then in the walking band (they're flat — nothing to trip over).
        plan.roads.forEach((R) => {
            if (!R || R.klass === 'ring') return;
            const n = Math.floor(R.len / (0.7 * s));
            for (let i = 0; i < n; i++) {
                if (H(R.ri, i, 0x3ca9) > 0.07) continue;
                const side: 1 | -1 = H(R.ri, i, 0x71b3) < 0.5 ? 1 : -1, al = (i + 0.5) / n * R.len;
                if (al < R.mouthA + 0.05 * s || al > R.len - R.mouthB - 0.05 * s) continue;
                const [x, z] = plan.at(R.ri, side, al, R.sides[side].walkC);
                if (wet(x, z) || !enabled(x, z)) continue;
                ventInst.push(ventInstanceTransform([x, py + lift(x, z), z], 0.7, [R.d[0], R.d[1]]));
            }
        });
    }

    // ── CORNER KIT (E9): a round red JP post box (plinth + drum + domed cap + slot) and grey utility cabinets with
    //    door seams + louvres, from the plan's corner slots.
    if (furn) {
        for (const sl of plan.of('postbox')) if (use(sl)) partOf([postbox, postboxTrim], [sl.x, py, sl.z], faceRoad(sl), () => addPostbox(postbox, postboxTrim, [sl.x, py, sl.z], faceRoad(sl), u));
        for (const sl of plan.of('cabinet')) if (use(sl)) partOf([cabinet, cabinetTrim], [sl.x, py, sl.z], road(sl).d, () => addCabinet(cabinet, cabinetTrim, [sl.x, py, sl.z], road(sl).d, faceRoad(sl), u));
    }

    // ── VENDING RUNS (E10): 2–4 machines shoulder to shoulder against the building line, facing the pavement, with a
    //    recycling bin at the end. The body/backdrop/cans instance at the machine FOOT (vendingFootTransform) so all
    //    three GARP parts pick the SAME skin for a machine.
    const shellInst: InstanceXform[] = [];
    const productsInst: InstanceXform[] = [];
    const stockInst: InstanceXform[][] = Array.from({ length: VENDING_STOCK_VARIANTS }, () => []);
    if (furn) {
        const pitchM = 0.88;
        for (const sl of plan.of('vending')) {
            if (!use(sl)) continue;
            const dir = faceRoad(sl), n = sl.n;
            const runHalf = (n * pitchM + 0.55) * 0.5 * u;
            for (let k = 0; k < n; k++) {
                const al = sl.along - runHalf + (k + 0.5) * pitchM * u;
                const [x, z] = plan.at(sl.ri, sl.side, al, sl.off);
                if (wet(x, z)) continue;
                const vi = (H(sl.ri, Math.round(al * 1000), 0x30bd) * VENDING_BRANDS.length) | 0;
                const vparams = resolveVendingParams({ brand: vi, seed: p.seed });
                // Skip the cabinet AND the product boxes in the merge — both are instanced as GARP-textured layers
                // below (shell + products panel); the rest of the window furniture (glow/glass/frame/tray) merges.
                partOf([vend.trim, vend.chrome, vend.hole, vend.glass, vend.glow, vend.strip, vend.buttons], [x, py, z], dir,
                    () => emitVending(vend, [x, py, z], dir, vparams, u, p.seed, true, true));   // P20: one prop part
                shellInst.push(vendingShellTransform([x, py, z], dir, vparams, u));
                // ★ Backdrop + cans use the FOOT transform (their offsets are baked into the geometry) — the same
                //   (x,z) as the body, so GARP picks the SAME skin for all three (a machine never mixes brands).
                productsInst.push(vendingFootTransform([x, py, z], dir));
                stockInst[vendingStockVariant(x, z, p.seed)].push(vendingFootTransform([x, py, z], dir));
            }
            // The recycling bin at the end of the run.
            const [bx, bz] = plan.at(sl.ri, sl.side, sl.along + runHalf - 0.25 * u, sl.off + 0.08 * u);
            if (!wet(bx, bz)) binInst.push(binInstanceTransform([bx, py + lift(bx, bz), bz], 0.85, u));
        }
    }

    // Persona-polish D1: eye-level frontage dressing (nobori / noren) — frontage.ts. Its bikes-against-the-wall merge
    // into the bicycle accumulators above (no extra draws), so it runs before those layers are built.
    const frontage = buildFrontage(graph, keep, { bikeFrames, bikeTyre });
    const out: LayoutPreviewLayer[] = [];
    // Spun-concrete poles read as concrete (the ground CONCRETE surface, like the kerbs); porcelain insulators +
    // transformer cans are glazed; the cables carry a dull rubber sheen (metal family, very rough, no streaks).
    if (!pole.empty) out.push(...withFarTwin({ name: 'world:util-pole', color: POLE, y: gy, geometry: pole.geometry(), ground: { surface: 'concrete', tint: POLE, tileMm: 3000, metersPerUnit: 1 / u } }, pole, 'util-pole', PROP_TWIN_M.pole, u));
    if (!insul.empty) out.push(...withFarTwin({ name: 'world:util-pole-insulator', color: INSULATOR, y: gy, geometry: insul.geometry(), metal: { tint: INSULATOR, roughness: 0.25, streakAmount: 0, grime: 0.15, scale: metalScale } }, insul, 'util-insulator', PROP_TWIN_M.pole, u));   // (own key: each pair grids like its plain layer)
    if (!wire.empty) out.push({ name: 'world:util-wire', color: WIRE, y: gy, geometry: wire.geometry(), metal: { tint: WIRE, roughness: 0.6, streakAmount: 0, grime: 0.25, scale: metalScale } });
    if (!manhole.empty) out.push({ name: 'world:manhole', color: MANHOLE, y: gy, geometry: manhole.geometry() });
    if (!works.empty) out.push({ name: 'world:manhole-works', color: [0.30, 0.30, 0.31], y: gy, geometry: works.geometry(), metal: { ...METAL_PAINTED, tint: [0.3, 0.3, 0.31], scale: metalScale } });
    carBody.forEach((acc, i) => { if (!acc.empty) out.push({ name: 'world:car-' + CAR_NAMES[i], color: CARBODY[i], y: gy, geometry: acc.geometry(), ...VEH_PAINT }); });   // car-paint sheen
    // Upgraded parked-car detail (vehicle.ts): yellow taxi bodies + shared glass / tyres / chrome / taxi belt + sign.
    if (!taxiBody.empty)  out.push({ name: 'world:car-taxi',   color: VEH_TAXI, y: gy, geometry: taxiBody.geometry(), ...VEH_PAINT });
    if (!pv.glass.empty)  out.push({ name: 'world:car-glass2', color: VEH_GLASS, y: gy, geometry: pv.glass.geometry(), glass: true });
    if (!pv.trim.empty)   out.push(...withFarTwin({ name: 'world:car-trim',   color: VEH_TYRE, y: gy, geometry: pv.trim.geometry(), ...VEH_LAYER_LOOK.trim.extra }, pv.trim, 'car-trim', PROP_TWIN_M.carTrim, u));
    if (!pv.chrome.empty) out.push(...withFarTwin({ name: 'world:car-chrome', color: VEH_CHROME, y: gy, geometry: pv.chrome.geometry(), metal: { roughness: 0.22, scale: metalScale } }, pv.chrome, 'car-chrome', PROP_TWIN_M.carTrim, u));
    if (!pv.band.empty)   out.push({ name: 'world:car-band',   color: [0.08, 0.08, 0.09], y: gy, geometry: pv.band.geometry(), pattern: { color: [0.96, 0.96, 0.96], mode: 'checker', freq: 26, scale: 1 } });
    if (!pv.sign.empty)   out.push({ name: 'world:car-sign',   color: VEH_TAXI_SIGN, y: gy, geometry: pv.sign.geometry(), emissive: 0.6 });
    // Unlit head/tail LENSES (parked = lights:false). ★ Names must NOT match the night glow-walk's /headlight|taillight/.
    if (!pv.lensHead.empty) out.push({ name: 'world:car-lens-head', color: VEH_LAYER_LOOK.lensHead.color, y: gy, geometry: pv.lensHead.geometry(), ...VEH_LAYER_LOOK.lensHead.extra });
    if (!pv.lensTail.empty) out.push({ name: 'world:car-lens-tail', color: VEH_LAYER_LOOK.lensTail.color, y: gy, geometry: pv.lensTail.geometry(), ...VEH_LAYER_LOOK.lensTail.extra });
    // ── Instanced, GARP-skinnable street clutter (one canonical geometry + a transform per copy) ─────────────
    const garpLayer = (inst: InstanceXform[], name: string, geo: MeshGeometry, poolId: string, slot: string, extra: Partial<LayoutPreviewLayer> = {}) => {
        // drape:'baked' — the instance y already bakes the terrain via lift(x,z) (like the poles); the height pass
        // must not touch it again. Prevents both the "sinks under the hills" and any double-lift.
        if (inst.length) out.push({ name, color: [1, 1, 1], y: gy, geometry: geo, instances: inst, arrayGroup: true, drape: 'baked', garp: { pool: poolId, slot, seed: p.seed }, ...extra });
    };
    garpLayer(crateInst, 'world:crate', crateCanonicalGeometry(u), crateGarpPool().id, 'label');
    garpLayer(binInst, 'world:trash-bin', binCanonicalGeometry(u), binGarpPool().id, 'body');
    garpLayer(ventInst, 'world:vent', ventCanonicalGeometry(u), ventGarpPool().id, 'face');
    garpLayer(aboardInst, 'world:aboard', aboardCanonicalGeometry(u), aboardGarpPool().id, 'face', { singleSided: false });
    garpLayer(stallAwnInst, 'world:stall-awning', stallAwningCanonicalGeometry(u), stallGarpPool().id, 'awning', { singleSided: false });
    garpLayer(posterInst, 'world:poster', posterCanonicalGeometry(u), posterGarpPool().id, 'art', { singleSided: false });
    // Stall body (wood + produce) stays baked.
    if (!stallWood.empty) out.push({ name: 'world:stall', color: [0.46, 0.32, 0.20], y: gy, geometry: stallWood.geometry() });
    if (!stallProd.empty) out.push({ name: 'world:stall-produce', color: [0.82, 0.52, 0.20], y: gy, geometry: stallProd.geometry(), pattern: { color: [0.72, 0.22, 0.18], mode: 'dots', freq: 5, scale: 1 } });
    out.push(...vendingLayers(vend, metalScale, { night: !!p.nightMode }));
    // The instanced, GARP-skinned machine BODY (one canonical shell + a transform per machine). `garp` marks it
    // for the dedicated GARP atlas; each copy's skin is chosen at scene instantiation from its (x,z)+seed.
    if (shellInst.length) {
        out.push({
            name: 'world:vending-body', color: [1, 1, 1], y: gy,
            geometry: vendingShellGeometry(resolveVendingParams({ seed: p.seed }), u),
            instances: shellInst, arrayGroup: true, garp: { pool: vendingGarpPool().id, slot: 'body', seed: p.seed },
        });
        // The instanced BACKDROP (GARP `products`: the lit back wall behind the cans) — emissive so it reads backlit.
        out.push({
            name: 'world:vending-products', color: [1, 1, 1], y: gy, emissive: p.nightMode ? 0.8 : 0.3,
            geometry: vendingProductsGeometry(resolveVendingParams({ seed: p.seed }), u),
            instances: productsInst, arrayGroup: true, garp: { pool: vendingGarpPool().id, slot: 'products', seed: p.seed },
        });
        // The instanced 3D CANS (GARP `labels`: the packed can-label sheet), one layer per arrangement variant. A
        // touch of emissive: they sit in the lit window, so they read as backlit rather than shadowed behind glass.
        stockInst.forEach((inst, v) => {
            if (!inst.length) return;
            out.push({
                name: `world:vending-stock-${v}`, color: [1, 1, 1], y: gy, emissive: p.nightMode ? 0.35 : 0.12,
                geometry: vendingStockGeometry(resolveVendingParams({ seed: p.seed }), u, v),
                instances: inst, arrayGroup: true, garp: { pool: vendingGarpPool().id, slot: 'labels', seed: p.seed },
            });
        });
    }
    if (!bench.empty) out.push({ name: 'world:bench', color: BENCH, y: gy, geometry: bench.geometry(), metal: { ...METAL_PAINTED, tint: BENCH, scale: metalScale } });
    if (!benchWood.empty) out.push({ name: 'world:bench-wood', color: BENCH_WOOD, y: gy, geometry: benchWood.geometry(), pattern: { color: [0.40, 0.27, 0.16], mode: 'stripes', freq: 3, scale: 0.12 } });
    if (!shelter.empty) out.push({ name: 'world:busstop', color: SHELTER, y: gy, geometry: shelter.geometry() });
    if (!shelterSign.empty) out.push({ name: 'world:busstop-sign', color: STOPSIGN, y: gy, geometry: shelterSign.geometry(), emissive: p.nightMode ? 1.1 : 0.6 });
    // Frame tubes — bare metal, and shiny enough to catch a highlight. Low grime: a bike in use gets rained on but
    // not left to silt up like rooftop plant. Tyres are their own matte layer (no glinting rubber).
    bikeFrames.forEach((acc, i) => {
        if (acc.empty) return;
        const c = BIKES[i];
        out.push({ name: `world:bicycle-${i}`, color: c, y: gy, geometry: acc.geometry(),
            metal: { tint: c, streak: [c[0] * 0.6, c[1] * 0.6, c[2] * 0.62], roughness: 0.30, streakAmount: 0.30, grime: 0.20, scale: metalScale * 2.0 } });
    });
    if (!bikeTyre.empty) out.push({ name: 'world:bicycle-tyre', color: [0.07, 0.07, 0.08], y: gy, geometry: bikeTyre.geometry(), metal: { tint: [0.07, 0.07, 0.08], roughness: 0.7, streakAmount: 0, grime: 0.3, scale: metalScale } });
    // Racks + bollards come from their own generators; renamed onto the furniture LOD prefixes (bicycle / guardrail).
    for (const L of bikeRackLayers(rack, metalScale)) out.push({ ...L, name: 'world:bicycle-rack', y: gy });
    for (const L of bollardLayers(bollard, BOLLARD_FINISHES[bp.finish], metalScale)) out.push({ ...L, name: 'world:guardrail-bollard', y: gy });
    if (!guardrail.empty) out.push({ name: 'world:guardrail', color: GUARDRAIL, y: gy, geometry: guardrail.geometry(), metal: { ...METAL_PAINTED, scale: metalScale } });
    if (!postbox.empty) out.push({ name: 'world:postbox', color: POSTBOX, y: gy, geometry: postbox.geometry(), metal: { ...METAL_PAINTED, tint: POSTBOX, scale: metalScale } });
    if (!postboxTrim.empty) out.push({ name: 'world:postbox-trim', color: POSTBOX_TRIM, y: gy, geometry: postboxTrim.geometry(), metal: { ...METAL_PAINTED, tint: POSTBOX_TRIM, scale: metalScale } });
    if (!cabinet.empty) out.push({ name: 'world:cabinet', color: CABINET, y: gy, geometry: cabinet.geometry(), metal: { ...METAL_PAINTED, tint: CABINET, scale: metalScale } });
    if (!cabinetTrim.empty) out.push({ name: 'world:cabinet-trim', color: CABINET_TRIM, y: gy, geometry: cabinetTrim.geometry(), metal: { ...METAL_PAINTED, tint: CABINET_TRIM, scale: metalScale } });
    if (!cone.empty) out.push({ name: 'world:cone', color: CONE, y: gy, geometry: cone.geometry() });
    if (!coneBand.empty) out.push({ name: 'world:cone-band', color: CONE_BAND, y: gy, geometry: coneBand.geometry(), emissive: 0.55 });
    out.push(...frontage);
    return out;
}

// ── Prop builders (real METRES × u) ──────────────────────────────────────────────────────────────

/** A slatted street bench (E9): 4 seat slats + 3 back slats (wood) on two cast side frames with armrests (metal).
 *  `face` = the way a sitter faces (toward the road). Seat at BENCH_SEAT_M. */
function addBench(frame: Accum3D, wood: Accum3D, base: V3, along: V2, face: V2, u: number): void {
    const aW: V3 = [along[0], 0, along[1]], up: V3 = [0, 1, 0], fW: V3 = [face[0], 0, face[1]];
    const P = (a: number, y: number, f: number): V3 => [base[0] + (aW[0] * a + fW[0] * f) * u, base[1] + y * u, base[2] + (aW[2] * a + fW[2] * f) * u];
    const L = 0.8, seatY = BENCH_SEAT_M;
    for (let k = 0; k < 4; k++) wood.obox(P(0, seatY, 0.17 - k * 0.1), aW, up, fW, L * u, 0.016 * u, 0.04 * u);          // seat slats
    for (let k = 0; k < 3; k++) {                                                                                        // back slats (leaning back)
        const y = seatY + 0.14 + k * 0.1, f = -0.2 - k * 0.025;
        wood.obox(P(0, y, f), aW, up, fW, L * u, 0.035 * u, 0.012 * u);
    }
    for (const sx of [-1, 1]) {
        const a = sx * (L - 0.08);
        frame.beam(P(a, 0, 0.18), P(a, seatY - 0.02, 0.18), 0.022 * u, 4);      // front leg
        frame.beam(P(a, 0, -0.18), P(a, seatY - 0.02, -0.19), 0.022 * u, 4);    // back leg
        frame.beam(P(a, seatY - 0.02, -0.19), P(a, seatY + 0.42, -0.26), 0.02 * u, 4);   // back upright
        frame.beam(P(a, seatY + 0.2, 0.2), P(a, seatY + 0.2, -0.2), 0.02 * u, 4);        // armrest
        frame.beam(P(a, seatY - 0.02, 0.2), P(a, seatY + 0.2, 0.2), 0.02 * u, 4);        // armrest post
    }
}

/** A bus-stop shelter: two posts + a flat roof + a lit sign panel on a pole at the front. */
function addBusStop(shelter: Accum3D, sign: Accum3D, base: V3, along: V2, face: V2, s: number): void {
    const aW: V3 = [along[0], 0, along[1]], up: V3 = [0, 1, 0], fW: V3 = [face[0], 0, face[1]], w = 0.09 * s, h = 0.14 * s;
    for (const sx of [-1, 1]) shelter.prism([base[0] + aW[0] * w * sx - fW[0] * 0.012 * s, base[1], base[2] + aW[2] * w * sx - fW[2] * 0.012 * s], 0.004 * s, 0.004 * s, h, 4);   // back posts
    shelter.obox([base[0] - fW[0] * 0.004 * s, base[1] + h, base[2] - fW[2] * 0.004 * s], aW, up, fW, w * 1.15, 0.004 * s, 0.03 * s);   // roof
    shelter.obox([base[0] - fW[0] * 0.02 * s, base[1] + h * 0.55, base[2] - fW[2] * 0.02 * s], aW, up, fW, w, h * 0.42, 0.0015 * s);   // back glass/ad panel
    const sx = base[0] + aW[0] * w * 1.25, sz = base[2] + aW[2] * w * 1.25;
    shelter.prism([sx, base[1], sz], 0.003 * s, 0.003 * s, 0.17 * s, 4);                                                              // sign pole
    sign.obox([sx + fW[0] * 0.006 * s, base[1] + 0.155 * s, sz + fW[2] * 0.006 * s], aW, up, fW, 0.026 * s, 0.02 * s, 0.003 * s);      // sign panel
}

interface PoleRig { power: V3[]; tele: V3[]; }
/** A concrete utility pole (~8 m) with its cross-arm PERPENDICULAR to the road (the wires run along it), three
 *  porcelain insulators, two telecom clamps lower down and (sometimes) a pole-top transformer can. Returns the wire
 *  attach points. `out` = the unit from the road toward the pole's pavement. */
function addPole(pole: Accum3D, insul: Accum3D, base: V3, along: V2, out: V2, s: number, transformer: boolean): PoleRig {
    const h = 0.55 * s, r = 0.011 * s;
    // T3.3: a spun-concrete pole with a chamfered foot, a taper and a bevelled cap (one 8-sided lathe).
    pole.lathe(base, [0, 1, 0], [[r * 1.08, 0], [r * 1.08, 0.004 * s], [r, 0.007 * s], [r * 0.8, h], [r * 0.7, h + 0.004 * s], [0, h + 0.0065 * s]], 8, { caps: [false, false] });
    const top: V3 = [base[0], base[1] + h, base[2]];
    const aW: V3 = [along[0], 0, along[1]], oW: V3 = [out[0], 0, out[1]], up: V3 = [0, 1, 0];
    // STEP BOLTS: short rungs from ~3 m up, alternating either side along the road.
    for (let i = 0; i < 6; i++) {
        const y = base[1] + (0.2 + i * 0.05) * s, sd = i % 2 ? 1 : -1;
        const rr = r * (1 - 0.2 * ((0.2 + i * 0.05) * s) / h);
        pole.beam([base[0] + aW[0] * sd * rr * 0.6, y, base[2] + aW[2] * sd * rr * 0.6], [base[0] + aW[0] * sd * (rr + 0.012 * s), y + 0.001 * s, base[2] + aW[2] * sd * (rr + 0.012 * s)], 0.0012 * s, 3);
    }
    const armY = top[1] - 0.02 * s, arm = 0.05 * s;
    // The CROSS-ARM spans ACROSS the road direction (toward the carriageway and away from it): a bevelled timber-
    // section beam on the pole, propped by two diagonal braces.
    const armMid = arm * (0.6 - 1) * 0.5;   // centre of [−arm, +0.6·arm] along `out`
    pole.bevelBox([top[0] + oW[0] * armMid, armY, top[2] + oW[2] * armMid], oW, up, aW, arm * 0.8, 0.0045 * s, 0.004 * s, 0.0012 * s);
    for (const k of [-0.7, 0.45]) {
        pole.beam([top[0] + oW[0] * Math.sign(k) * r * 0.7, armY - 0.035 * s, top[2] + oW[2] * Math.sign(k) * r * 0.7],
            [top[0] + oW[0] * arm * k, armY - 0.004 * s, top[2] + oW[2] * arm * k], 0.0014 * s, 3);
    }
    const power: V3[] = [];
    for (const k of [-0.9, -0.35, 0.4]) {
        const x = top[0] + out[0] * arm * k, z = top[2] + out[1] * arm * k;
        // A porcelain pin INSULATOR: a flared bell with a drip skirt, tapering to the wire groove.
        insul.lathe([x, armY + 0.0045 * s, z], up, [[0.0045 * s, 0], [0.0028 * s, 0.005 * s], [0.0012 * s, 0.0095 * s]], 6, { smooth: true, caps: [true, true] });
        power.push([x, armY + 0.0135 * s, z]);
    }
    const tele: V3[] = [];
    for (const [dy, k] of [[0.15, -0.012], [0.19, 0.012]] as [number, number][]) {
        const y = top[1] - dy * s, x = top[0] + out[0] * k * s, z = top[2] + out[1] * k * s;
        pole.obox([x, y, z], [along[0], 0, along[1]], [0, 1, 0], [out[0], 0, out[1]], 0.006 * s, 0.003 * s, 0.006 * s);   // clamp
        tele.push([x, y, z]);
    }
    if (transformer) {
        const tx = top[0] - out[0] * 0.022 * s, tz = top[2] - out[1] * 0.022 * s;   // clear of the pole shaft
        // Pole-top transformer can: a drum with a bevelled lid + a mounting band round the pole.
        insul.lathe([tx, base[1] + h * 0.66, tz], up, [[0.012 * s, 0], [0.012 * s, 0.035 * s], [0.0095 * s, 0.039 * s], [0, 0.04 * s]], 8, { caps: [true, false] });
        pole.obox([base[0], base[1] + h * 0.66 + 0.022 * s, base[2]], aW, up, oW, r * 0.95, 0.0025 * s, r * 0.95);
    }
    return { power, tele };
}

/** String a span between two pole rigs: each power wire and telecom cable as its own sagging catenary. */
function addSpan(wire: Accum3D, a: PoleRig, b: PoleRig, s: number): void {
    const n = Math.min(a.power.length, b.power.length);
    for (let i = 0; i < n; i++) catenary(wire, a.power[i], b.power[i], (0.016 + i * 0.004) * s, 10, 0.0014 * s);
    for (let i = 0; i < Math.min(a.tele.length, b.tele.length); i++) catenary(wire, a.tele[i], b.tele[i], (0.028 + i * 0.008) * s, 10, (i ? 0.0028 : 0.002) * s);
}

/** A traffic cone (~0.7 m) with a white reflective band. */
function addCone(cone: Accum3D, band: Accum3D, base: V3, u: number): void {
    cone.obox([base[0], base[1] + 0.015 * u, base[2]], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.19 * u, 0.015 * u, 0.19 * u);   // square foot
    cone.cone([base[0], base[1] + 0.03 * u, base[2]], 0.14 * u, 0.68 * u, 8, 0);
    band.prism([base[0], base[1] + 0.34 * u, base[2]], 0.078 * u, 0.078 * u, 0.1 * u, 8);
}

/** The classic round red JP post box: dark plinth, red drum, domed cap, a dark mail slot and a white plate. */
function addPostbox(body: Accum3D, trim: Accum3D, base: V3, face: V2, u: number): void {
    const f: V3 = [face[0], 0, face[1]];
    trim.prism(base, 0.16 * u, 0.16 * u, 0.12 * u, 10);                                                    // plinth
    body.prism([base[0], base[1] + 0.12 * u, base[2]], 0.22 * u, 0.22 * u, 0.95 * u, 12);                  // drum
    body.cone([base[0], base[1] + 1.07 * u, base[2]], 0.235 * u, 0.13 * u, 12, 0);                          // domed cap
    body.prism([base[0], base[1] + 1.05 * u, base[2]], 0.235 * u, 0.235 * u, 0.03 * u, 12);                // cap rim
    const r: V3 = [-face[1], 0, face[0]];
    trim.obox([base[0] + f[0] * 0.215 * u, base[1] + 0.9 * u, base[2] + f[2] * 0.215 * u], r, [0, 1, 0], f, 0.1 * u, 0.018 * u, 0.012 * u);   // slot
    trim.obox([base[0] + f[0] * 0.218 * u, base[1] + 0.62 * u, base[2] + f[2] * 0.218 * u], r, [0, 1, 0], f, 0.08 * u, 0.06 * u, 0.006 * u);  // plate
}

/** A grey roadside utility cabinet: body on a plinth, a proud door frame + centre seam on the front and louvre slats
 *  on both sides (darker trim layer). `face` = its door side (toward the pavement / road). */
function addCabinet(body: Accum3D, trim: Accum3D, base: V3, along: V2, face: V2, u: number): void {
    const a: V3 = [along[0], 0, along[1]], up: V3 = [0, 1, 0], f: V3 = [face[0], 0, face[1]];
    const P = (x: number, y: number, z: number): V3 => [base[0] + (a[0] * x + f[0] * z) * u, base[1] + y * u, base[2] + (a[2] * x + f[2] * z) * u];
    // visual-polish #14: the half-extents are METRES x u like the positions. They were raw metres, so in a ~15 m/unit
    // city every cabinet was a ~10 m wide, 17 m tall grey block whose painted-metal grime read as a "crumpled paper" wall.
    const b = (acc: Accum3D, c: V3, hx: number, hy: number, hz: number): void => acc.obox(c, a, up, f, hx * u, hy * u, hz * u);
    b(trim, P(0, 0.04, 0), 0.37, 0.04, 0.19);                        // plinth
    b(body, P(0, 0.62, 0), 0.35, 0.54, 0.17);                        // cabinet
    b(body, P(0, 1.18, 0), 0.37, 0.025, 0.19);                       // drip cap
    b(trim, P(0, 0.62, 0.172), 0.006, 0.5, 0.004);                   // centre door seam
    for (const y of [0.13, 1.11]) b(trim, P(0, y, 0.172), 0.33, 0.006, 0.004);   // door frame top/bottom
    for (const x of [-0.33, 0.33]) b(trim, P(x, 0.62, 0.172), 0.006, 0.49, 0.004);
    for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) b(trim, P(sx * 0.352, 0.8 + k * 0.06, 0), 0.004, 0.01, 0.12);   // louvres
}
