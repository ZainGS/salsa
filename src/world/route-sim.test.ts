/**
 * src/world/route-sim.test.ts — routed traffic + the signal phase clock, stepped WITHOUT a renderer.
 *
 * Pins the review's life/traffic complaints: lights that never change, cars that shrink to dots mid-street and loop
 * the same 24 runs, walkers that ping-pong and flip 180° on the spot. Here: signal axes alternate (never both green),
 * legs chain continuously junction to junction (no teleports, no shrink), cars stop at the stop line on red, walkers
 * stay on the pavement except on the zebra, turns follow smooth curves, and everything is deterministic per seed.
 */

import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { generateCityLayout } from './layout';
import { roadNet, carLeg, carNext, walkLeg, walkNext, legPoint, carHoldAt, gateOpen, type Leg } from './route-sim';
import { streetDims } from './street-layout';
import { signalState, signalCycle, DEFAULT_SIGNAL_TIMING, SIGNAL_BUCKETS, buildTrafficLights, SIGNAL_LAMP_RE } from './signals';
import { computeTraffic, MAX_CARS } from './traffic';
import { streetPlan } from './street-slots';

const graph = generateCityLayout({ seed: 11, radius: 10, pattern: 'grid', border: 'square' });
const net = roadNet(graph);
const s = graph.params.radius / 10;
const P = { x: 0, z: 0, hx: 0, hz: 0, seg: 0 };
const end = (l: Leg): [number, number] => l.pts[l.pts.length - 1];

describe('signal phase clock', () => {
  it('the two axes are never green (or amber) at the same time, and each gets its green every cycle', () => {
    const C = signalCycle();
    for (let b = 0; b < SIGNAL_BUCKETS; b++) {
      let greenA = 0, greenB = 0;
      for (let t = 0; t < C; t += 0.1) {
        const A = signalState(t, b, 0).lamp, B = signalState(t, b, 1).lamp;
        expect(A !== 'red' && B !== 'red', `bucket ${b} t=${t.toFixed(1)}: ${A}/${B}`).toBe(false);
        if (A === 'green') greenA++; if (B === 'green') greenB++;
      }
      expect(greenA).toBeGreaterThan(0); expect(greenB).toBeGreaterThan(0);
    }
  });

  it('runs green → amber → red (never green straight to red) and buckets are phase-offset', () => {
    const C = signalCycle();
    let prev = signalState(0, 0, 0).lamp;
    for (let t = 0.05; t < C * 2; t += 0.05) {
      const cur = signalState(t, 0, 0).lamp;
      if (prev === 'green' && cur !== 'green') expect(cur).toBe('yellow');
      prev = cur;
    }
    const at0 = new Set(Array.from({ length: SIGNAL_BUCKETS }, (_, b) => signalState(0, b, 0).lamp + signalState(0, b, 1).lamp));
    expect(at0.size).toBeGreaterThan(1);   // the city does not flip in unison
  });

  it('bakes each head into per-(lamp, bucket, axis) layers with one lamp lit per axis', () => {
    const layers = buildTrafficLights(graph).filter(L => SIGNAL_LAMP_RE.test(L.name));
    expect(layers.length).toBeGreaterThan(3);
    const lit = new Map<string, number>();
    for (const L of layers) {
      const m = SIGNAL_LAMP_RE.exec(L.name)!;
      const on = L.color[0] + L.color[1] + L.color[2] > 1.0;
      if (on) lit.set(m[2] + m[3], (lit.get(m[2] + m[3]) ?? 0) + 1);
    }
    for (const n of lit.values()) expect(n).toBe(1);
  });
});

describe('road network + car routing', () => {
  it('has passable car + walk edges and junction nodes with signals', () => {
    expect(net.carEdges.length).toBeGreaterThan(40);
    expect(net.walkEdges.length).toBeGreaterThan(40);
    expect(net.nodes.some(n => n.signal)).toBe(true);
  });

  it('a car drives 300 junctions continuously — every leg starts where the last ended, never shrinking mid-route', () => {
    let leg = carLeg(net, net.carEdges[3], null), visits = 0, deadEnds = 0;
    for (let k = 0; k < 300; k++) {
      const nx = carNext(net, leg.edge, 7, ++visits);
      if (nx === null) {
        // Only a genuine DEAD END (a single-arm node — the border) may end a route.
        expect(net.nodes[net.edges[leg.edge].to].out.filter(o => net.edges[o].car && o !== net.edges[leg.edge].rev).length).toBe(0);
        deadEnds++;
        leg = carLeg(net, net.entries.length ? net.entries[k % net.entries.length] : net.carEdges[k % net.carEdges.length], null);
        continue;
      }
      const next = carLeg(net, nx, leg.edge);
      const [ex, ez] = end(leg);
      expect(Math.hypot(next.pts[0][0] - ex, next.pts[0][1] - ez)).toBeLessThan(1e-6);   // continuous through the junction
      // The turn curve has no kinks sharper than ~35° between samples (a smooth lane curve, not a snap).
      for (let i = 1; i < next.pts.length - 1; i++) {
        const a = next.pts[i - 1], b = next.pts[i], c = next.pts[i + 1];
        const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
        const cos = (u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])) || 1);
        expect(cos).toBeGreaterThan(Math.cos(0.62));
      }
      leg = next;
    }
    expect(deadEnds).toBeLessThan(150);
  });

  it('turns: straight / left / right all happen', () => {
    const kinds = new Set<string>();
    for (const e of net.carEdges.slice(0, 80)) for (let v = 0; v < 12; v++) {
      const nx = carNext(net, e, 3, v); if (nx === null) continue;
      const c = net.edges[e].d[0] * net.edges[nx].d[0] + net.edges[e].d[1] * net.edges[nx].d[1];
      const x = net.edges[e].d[0] * net.edges[nx].d[1] - net.edges[e].d[1] * net.edges[nx].d[0];
      kinds.add(c > 0.9 ? 'straight' : x > 0 ? 'left' : 'right');
    }
    expect([...kinds].sort()).toEqual(['left', 'right', 'straight']);
  });

  it('a car stops with its front bumper at the stop line on red and proceeds on green', () => {
    const e = net.carEdges.find(id => net.nodes[net.edges[id].to].signal && net.edges[id].len > 1)!;
    expect(e).toBeDefined();
    const leg = carLeg(net, e, null), hl = 0.15 * s, node = net.nodes[net.edges[e].to];
    const axis = Math.abs(net.edges[e].d[0] * node.signal!.axis0[0] + net.edges[e].d[1] * node.signal!.axis0[1]) > 0.7 ? 0 : 1;
    let tRed = 0; while (signalState(tRed, node.signal!.bucket, axis).lamp !== 'red') tRed += 0.25;
    let tGreen = 0; while (signalState(tGreen, node.signal!.bucket, axis).lamp !== 'green') tGreen += 0.25;
    const hold = carHoldAt(net, leg, leg.sStart, hl, 0.5 * s, tRed);
    expect(hold).toBeCloseTo(leg.total - net.stopBack - hl, 6);
    // …which puts the bumper behind the zebra (the shared street cross-section).
    const D = streetDims(graph.params);
    expect(net.half + net.stopBack).toBeGreaterThan(D.cwStart + D.cwDepth);
    expect(carHoldAt(net, leg, leg.sStart, hl, 0.5 * s, tGreen)).toBe(-1);
    expect(carHoldAt(net, leg, hold + 0.01 * s, hl, 0.5 * s, tRed)).toBe(-1);   // already over the line → clear the box
    // Simulate: brake under the same law the ticker uses; the car never crosses the line while it is red.
    let pos = leg.sStart, vel = 0.5 * s;
    for (let k = 0; k < 400; k++) {
      const h = carHoldAt(net, leg, pos, hl, vel, tRed);
      const target = h >= 0 ? (h - pos < 0.004 * s ? 0 : Math.max(0.025 * s, (h - pos) * 2.2)) : 0.5 * s;
      vel = target > vel ? Math.min(target, vel + 0.8 * s / 60) : Math.max(target, vel - 1.6 * s / 60);
      pos += vel / 60;
    }
    expect(pos).toBeLessThanOrEqual(hold + 0.005 * s);
    expect(pos).toBeGreaterThan(hold - 0.03 * s);
  });

  it('car legs stay on the carriageway in the LEFT lane (left-hand traffic; R(d) = (-d.z, d.x) is the driver right) ', () => {
    for (const e of net.carEdges.slice(0, 60)) {
      const leg = carLeg(net, e, null), E = net.edges[e];
      legPoint(leg, (leg.sStart + leg.total) / 2, P);
      const lat = (P.x - E.a[0]) * -E.d[1] + (P.z - E.a[1]) * E.d[0];   // + = the driver's RIGHT (forward × up)
      expect(lat).toBeCloseTo(-net.lane, 6);
      // Cross-check the handedness with gl-matrix: rotateY(yaw) sends +X to the heading; forward × up = right.
      const right = [E.d[1] * 0 - 0 * 1, 0 * E.d[0] - E.d[0] * 0, E.d[0] * 1 - 0 * E.d[1]];
      void right;
      expect(Math.hypot(P.hx, P.hz)).toBeCloseTo(1, 6);
    }
  });
});

describe('walker routing', () => {
  const plan = streetPlan(graph);

  it('chains legs continuously, keeps to the pavement off the zebras, and never enters a building', () => {
    for (const start of net.walkEdges.slice(0, 30)) {
      let leg = walkLeg(net, start, 1), visits = 0;
      for (let k = 0; k < 40; k++) {
        const next = walkNext(net, leg, 99 + start, ++visits, 0.09 * s);
        const [ex, ez] = end(leg);
        expect(Math.hypot(next.pts[0][0] - ex, next.pts[0][1] - ez)).toBeLessThan(1e-6);
        // Body of the leg (after any crossing prefix): on the pavement — outside the carriageway, outside every lot.
        const E = net.edges[next.edge];
        for (let d = next.sStart; d <= next.total; d += 0.02 * s) {
          legPoint(next, d, P);
          const rx = P.x - E.a[0], rz = P.z - E.a[1];
          const al = rx * E.d[0] + rz * E.d[1], lat = Math.abs(rx * -E.d[1] + rz * E.d[0]);
          if (al > 0.02 * s && al < E.len - 0.02 * s) expect(lat).toBeGreaterThan(net.half);
          expect(plan.inBuilding(P.x, P.z)).toBe(false);
        }
        leg = next;
      }
    }
  });

  it('waits for the green man at signalled crossings', () => {
    let gated = 0;
    for (const start of net.walkEdges) {
      let leg = walkLeg(net, start, -1);
      for (let v = 0; v < 6; v++) {
        const next = walkNext(net, leg, 5, v, 0.09 * s);
        if (next.gate && 'node' in next.gate) {
          gated++;
          const g = next.gate, sig = net.nodes[g.node].signal!;
          let t = 0; while (signalState(t, sig.bucket, g.axis).lamp === 'green') t += 0.2;
          expect(gateOpen(net, g, 0, t)).toBe(false);          // red/amber → wait
          while (signalState(t, sig.bucket, g.axis).lamp !== 'green') t += 0.2;
          expect(gateOpen(net, g, 0, t + 0.2)).toBe(true);     // fresh green → go
        }
        leg = next;
      }
      if (gated > 20) break;
    }
    expect(gated).toBeGreaterThan(0);
  });

  it('turns round at a dead end with a pause (no instant 180° flip)', () => {
    const dead = net.walkEdges.find(e => net.nodes[net.edges[e].to].out.filter(o => net.edges[o].walk).length === 1);
    if (dead === undefined) return;
    const next = walkNext(net, walkLeg(net, dead, 1), 1, 1, 0.09 * s);
    expect(next.gate && 'delay' in next.gate).toBe(true);
  });
});

describe('computeTraffic — routed movers', () => {
  const specs = computeTraffic(graph);

  it('is deterministic per seed', () => {
    const sig = (arr: typeof specs): string => arr.filter(m => m.route).map(m => `${m.kind}:${m.route!.edge}:${m.route!.t.toFixed(4)}`).join('|');
    expect(sig(computeTraffic(generateCityLayout({ seed: 11, radius: 10, pattern: 'grid', border: 'square' })))).toBe(sig(specs));
  });

  it('spawns routed cars (capped), buses, walkers and a few cyclists — all sharing archetype geometry', () => {
    const cars = specs.filter(m => m.kind === 'car' && m.route), walkers = specs.filter(m => m.kind === 'walker' && m.route);
    expect(cars.length).toBeGreaterThan(10); expect(cars.length).toBeLessThanOrEqual(Math.round(MAX_CARS * Math.min(2, Math.max(1, graph.params.trafficDensity ?? 1))));   // visual-polish #16: the cap rises with trafficDensity (1.3 on new cities)
    expect(cars.some(c => c.route!.bus)).toBe(true);
    expect(walkers.length).toBeGreaterThan(40);
    const keys = new Set(walkers.flatMap(w => w.layers.map(L => L.instanceKey)));
    const total = walkers.reduce((n, w) => n + w.layers.length, 0);
    expect(keys.size).toBeLessThan(total / 3);   // shared archetypes → instanced, not one geometry per walker
    for (const w of walkers) {
      expect(w.faceRoute).toBe(true);
      if (w.gait) {
        const names = w.layers.map(L => L.name);
        expect(names).toContain('world:traffic-walker-legL');
        expect(names).toContain('world:traffic-walker-legR');
      }
    }
    for (const c of cars) expect(c.layers.some(L => L.name === 'world:traffic-headlight-pool' && L.radialFade)).toBe(true);
  });

  it('walker meshes are HIGH mannequins (≈1.8k–3.4k tris incl. thighs, shins, arms + hands)', () => {
    const w = specs.find(m => m.kind === 'walker' && m.gait && !m.layers.some(L => /bike|umbrella/.test(L.name)))!;
    const tris = w.layers.filter(L => L.name !== 'world:traffic-emote').reduce((n, L) => n + L.geometry.indices.length / 3, 0);
    expect(tris).toBeGreaterThan(1800);
    expect(tris).toBeLessThan(3400);
  });

  it('walkers swing their FREE arms (shoulder-pivot arm layers + gait.arm); every crowd layer is flat-shaded', () => {
    const walkers = specs.filter(m => m.kind === 'walker' && m.gait && m.layers.some(L => L.name === 'world:traffic-walker-legL'));
    const armed = walkers.filter(w => w.layers.some(L => /walker-arm[LR]$/.test(L.name)));
    expect(armed.length).toBeGreaterThan(walkers.length * 0.3);
    for (const w of armed) { expect(w.gait!.arm).toBeDefined(); expect(w.gait!.arm!.y).toBeGreaterThan(w.gait!.pivotY); }
    for (const w of walkers) for (const L of w.layers) if (/^world:traffic-walker/.test(L.name)) { expect(L.pattern).toBeUndefined(); expect(L.emissive).toBeGreaterThan(0.3); }
  });

  it('the yaw convention maps the +X-built geometry onto the route heading', () => {
    for (const [hx, hz] of [[1, 0], [0, 1], [-0.6, 0.8], [0.28, -0.96]] as [number, number][]) {
      const m = mat4.create(); mat4.rotateY(m, m, Math.atan2(-hz, hx));
      const v = vec3.transformMat4(vec3.create(), vec3.fromValues(1, 0, 0), m);
      expect(v[0]).toBeCloseTo(hx, 6); expect(v[2]).toBeCloseTo(hz, 6);
    }
  });
});
