/**
 * src/packaging/cd/cd-case-geometry.ts
 *
 * The jewel-case SHELLS — a shallow open TRAY (a floor + four rim walls), not a solid slab, so each half has
 * the hollow "inset" depth a real jewel case has. Two of these facing each other form the closed case with the
 * disc + inserts inside. The LID adds 4 tiny SEMICIRCLE retainer tabs (2 top, 2 bottom) on the inner face — the
 * little clips that hold the booklet in place. 12-float format; rendered with a double-sided material so winding
 * is forgiving. Units are the caller's (mm here).
 *
 *   floorSide = -1 → floor at -depth/2, opening toward +z  (the TRAY: black back, opens toward the contents)
 *   floorSide = +1 → floor at +depth/2, opening toward -z  (the LID: clear front, opens toward the contents)
 */

import { type MeshGeometry, FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

export const CD_CASE_SHELL = { depth: 6, wall: 2, tabR: 5, tabInset: 3, hubR: 5, hubPetalR: 11, hubH: 3.5, hubTeeth: 8, discBedR: 58, discBedH: 1.4 } as const;

type V3 = [number, number, number];

function pushQuad(verts: number[], idx: number[], p0: V3, p1: V3, p2: V3, p3: V3, n: V3): void {
  const base = verts.length / FLOATS_PER_VERT;
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const ps = [p0, p1, p2, p3];
  for (let i = 0; i < 4; i++) {
    verts.push(ps[i][0], ps[i][1], ps[i][2], n[0], n[1], n[2], uv[i][0], uv[i][1], 1, 0, 0, 1);
  }
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** The centre HUB ROSETTE — the CD's iconic gripper flower: a raised centre button + N radiating petal teeth.
 *  Built rising in `dir` (±z) from `zFloor`, at the tray centre. Shares the shell's material. */
function appendHubRosette(verts: number[], idx: number[], zFloor: number, dir: 1 | -1, cx: number): void {
  const { hubR, hubPetalR, hubH, hubTeeth } = CD_CASE_SHELL;
  const TAU = Math.PI * 2, segs = hubTeeth * 3;
  const zTop = zFloor + dir * hubH;
  const n: V3 = [0, 0, dir];
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number => {
    verts.push(cx + x, y, z, nx, ny, nz, u, v, 1, 0, 0, 1); return verts.length / FLOATS_PER_VERT - 1;
  };
  // Centre cap (fan) + side wall (a short cylinder button).
  const cap = push(0, 0, zTop, n[0], n[1], n[2], 0.5, 0.5);
  const ring: number[] = [];
  for (let i = 0; i <= segs; i++) { const a = (i / segs) * TAU; ring.push(push(Math.cos(a) * hubR, Math.sin(a) * hubR, zTop, n[0], n[1], n[2], 0.5, 0.5)); }
  for (let i = 0; i < segs; i++) idx.push(cap, ring[i], ring[i + 1]);
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const w0 = push(c0 * hubR, s0 * hubR, zFloor, c0, s0, 0, 0, 0);
    const w1 = push(c1 * hubR, s1 * hubR, zFloor, c1, s1, 0, 0, 0);
    const w2 = push(c0 * hubR, s0 * hubR, zTop, c0, s0, 0, 0, 1);
    const w3 = push(c1 * hubR, s1 * hubR, zTop, c1, s1, 0, 0, 1);
    idx.push(w0, w2, w1, w1, w2, w3);
  }
  // N petal teeth radiating from the button edge, slightly below the cap, with gaps between them.
  const zp = zFloor + dir * hubH * 0.82, half = (TAU / hubTeeth) * 0.32;
  for (let t = 0; t < hubTeeth; t++) {
    const a = (t / hubTeeth) * TAU, a0 = a - half, a1 = a + half;
    const p0 = push(Math.cos(a0) * hubR, Math.sin(a0) * hubR, zp, n[0], n[1], n[2], 0, 0);
    const p1 = push(Math.cos(a1) * hubR, Math.sin(a1) * hubR, zp, n[0], n[1], n[2], 0, 0);
    const p2 = push(Math.cos(a) * hubPetalR, Math.sin(a) * hubPetalR, zp, n[0], n[1], n[2], 0, 0);
    idx.push(p0, p1, p2);
  }
}

/** The ribbed SPINE — corrugate the LEFT wall into horizontal ridges (the iconic ridged hinge strip). Replaces
 *  the flat left wall. `ribs` grooves of depth `ribD` protruding outward. */
function appendSpineWall(verts: number[], idx: number[], hw: number, hh: number, zFloor: number, zOpen: number, ribs = 24, ribD = 0.6): void {
  const push = (x: number, y: number, z: number, nx: number, ny: number): number => {
    verts.push(x, y, z, nx, ny, 0, 0.5, 0.5, 1, 0, 0, 1); return verts.length / FLOATS_PER_VERT - 1;
  };
  const dy = (2 * hh) / ribs;
  const quad = (yA: number, xA: number, yB: number, xB: number, nx: number, ny: number): void => {
    const a = push(xA, yA, zFloor, nx, ny), b = push(xB, yB, zFloor, nx, ny), c = push(xB, yB, zOpen, nx, ny), d = push(xA, yA, zOpen, nx, ny);
    idx.push(a, b, c, a, c, d);
  };
  for (let i = 0; i < ribs; i++) {
    const y0 = -hh + i * dy, ym = y0 + dy / 2, y1 = y0 + dy;
    quad(y0, -hw, ym, -hw - ribD, -1, 0.4);   // ridge rising
    quad(ym, -hw - ribD, y1, -hw, -1, -0.4);  // ridge falling
  }
}

/** The DISC BED: a shallow circular recess the CD nests into — a raised annular WALL at the disc radius (the bed
 *  edge/lip) plus a raised flat FRAME ring outside it, so the disc area inside reads as depressed. Centred at cx. */
function appendDiscBedRing(verts: number[], idx: number[], zFloor: number, dir: 1 | -1, cx: number): void {
  const { discBedR, discBedH, wall } = CD_CASE_SHELL;
  const rOut = discBedR + wall / 2, rIn = discBedR - wall / 2, zTop = zFloor + dir * discBedH;
  const TAU = Math.PI * 2, segs = 64;
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
    verts.push(cx + x, y, z, nx, ny, nz, 0.5, 0.5, 1, 0, 0, 1); return verts.length / FLOATS_PER_VERT - 1;
  };
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    // outer wall
    const o0 = push(c0 * rOut, s0 * rOut, zFloor, c0, s0, 0), o1 = push(c1 * rOut, s1 * rOut, zFloor, c1, s1, 0);
    const o2 = push(c0 * rOut, s0 * rOut, zTop, c0, s0, 0), o3 = push(c1 * rOut, s1 * rOut, zTop, c1, s1, 0);
    idx.push(o0, o2, o1, o1, o2, o3);
    // inner wall
    const n0 = push(c0 * rIn, s0 * rIn, zFloor, -c0, -s0, 0), n1 = push(c1 * rIn, s1 * rIn, zFloor, -c1, -s1, 0);
    const n2 = push(c0 * rIn, s0 * rIn, zTop, -c0, -s0, 0), n3 = push(c1 * rIn, s1 * rIn, zTop, -c1, -s1, 0);
    idx.push(n0, n1, n2, n1, n3, n2);
    // top cap (annulus)
    const t0 = push(c0 * rIn, s0 * rIn, zTop, 0, 0, dir), t1 = push(c1 * rIn, s1 * rIn, zTop, 0, 0, dir);
    const t2 = push(c0 * rOut, s0 * rOut, zTop, 0, 0, dir), t3 = push(c1 * rOut, s1 * rOut, zTop, 0, 0, dir);
    idx.push(t0, t2, t1, t1, t2, t3);
  }
}

/** A flat half-disc (semicircle) fan in the XY plane at z, centred at (cx,cy), radius r, sweeping from a0 to a0+π. */
function pushSemicircle(verts: number[], idx: number[], cx: number, cy: number, z: number, r: number, a0: number, n: V3, segs = 8): void {
  const center = verts.length / FLOATS_PER_VERT;
  verts.push(cx, cy, z, n[0], n[1], n[2], 0.5, 0.5, 1, 0, 0, 1);
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (i / segs) * Math.PI;
    verts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z, n[0], n[1], n[2], 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, 1, 0, 0, 1);
  }
  for (let i = 0; i < segs; i++) idx.push(center, center + 1 + i, center + 2 + i);
}

/**
 * A shallow open case shell. `w`×`h` footprint, `depth` wall height, `floorSide` ±1 (see header). `withTabs`
 * adds the 4 booklet-retainer semicircles on the inner floor.
 */
export function generateCaseShell(w: number, h: number, depth = CD_CASE_SHELL.depth, floorSide: 1 | -1 = -1, withTabs = false, withHub = false, withSpine = false, hubOffsetX = 0): MeshGeometry {
  const hw = w / 2, hh = h / 2, hd = depth / 2;
  const zFloor = floorSide * hd;      // the solid face
  const zOpen = -floorSide * hd;      // the open rim
  const verts: number[] = [];
  const idx: number[] = [];

  const wall = CD_CASE_SHELL.wall, bev = 0.7;
  const iw = hw - wall, ih = hh - wall;   // inner perimeter
  const ow = hw - bev, oh = hh - bev;     // rim OUTER edge, pulled in by the bevel
  const dz: 1 | -1 = (-floorSide) as 1 | -1;   // floor → open direction
  const zBev = zOpen - dz * bev;          // where the outer wall meets the chamfer
  const rimN: V3 = [0, 0, dz];            // the top rim faces the opening

  // Floor (the visible outer face).
  pushQuad(verts, idx, [-hw, -hh, zFloor], [hw, -hh, zFloor], [hw, hh, zFloor], [-hw, hh, zFloor], [0, 0, floorSide]);
  // OUTER walls (floor → just below the rim), normals outward.
  pushQuad(verts, idx, [-hw, -hh, zFloor], [-hw, -hh, zBev], [hw, -hh, zBev], [hw, -hh, zFloor], [0, -1, 0]);
  pushQuad(verts, idx, [-hw, hh, zFloor], [hw, hh, zFloor], [hw, hh, zBev], [-hw, hh, zBev], [0, 1, 0]);
  if (withSpine) appendSpineWall(verts, idx, hw, hh, zFloor, zBev);   // ribbed hinge-side wall
  else pushQuad(verts, idx, [-hw, -hh, zFloor], [-hw, hh, zFloor], [-hw, hh, zBev], [-hw, -hh, zBev], [-1, 0, 0]);
  pushQuad(verts, idx, [hw, -hh, zFloor], [hw, -hh, zBev], [hw, hh, zBev], [hw, hh, zFloor], [1, 0, 0]);
  // BEVEL chamfer strips — a 45° softened top-outer edge (catches light like molded plastic).
  pushQuad(verts, idx, [-hw, -hh, zBev], [hw, -hh, zBev], [ow, -oh, zOpen], [-ow, -oh, zOpen], [0, -0.7, dz * 0.7]);
  pushQuad(verts, idx, [-ow, oh, zOpen], [ow, oh, zOpen], [hw, hh, zBev], [-hw, hh, zBev], [0, 0.7, dz * 0.7]);
  pushQuad(verts, idx, [-hw, -hh, zBev], [-ow, -oh, zOpen], [-ow, oh, zOpen], [-hw, hh, zBev], [-0.7, 0, dz * 0.7]);
  pushQuad(verts, idx, [hw, -hh, zBev], [hw, hh, zBev], [ow, oh, zOpen], [ow, -oh, zOpen], [0.7, 0, dz * 0.7]);
  // INNER walls (open → floor) at the inner perimeter, normals inward — gives the rim real THICKNESS.
  pushQuad(verts, idx, [-iw, -ih, zOpen], [-iw, -ih, zFloor], [iw, -ih, zFloor], [iw, -ih, zOpen], [0, 1, 0]);
  pushQuad(verts, idx, [-iw, ih, zFloor], [iw, ih, zFloor], [iw, ih, zOpen], [-iw, ih, zOpen], [0, -1, 0]);
  pushQuad(verts, idx, [-iw, -ih, zFloor], [-iw, ih, zFloor], [-iw, ih, zOpen], [-iw, -ih, zOpen], [1, 0, 0]);
  pushQuad(verts, idx, [iw, -ih, zOpen], [iw, ih, zOpen], [iw, ih, zFloor], [iw, -ih, zFloor], [-1, 0, 0]);
  // TOP RIM frame (the flat plastic edge) — 4 strips from the beveled outer edge (±ow/±oh) → inner (±iw/±ih).
  pushQuad(verts, idx, [-ow, oh, zOpen], [ow, oh, zOpen], [iw, ih, zOpen], [-iw, ih, zOpen], rimN);          // top
  pushQuad(verts, idx, [-iw, -ih, zOpen], [iw, -ih, zOpen], [ow, -oh, zOpen], [-ow, -oh, zOpen], rimN);      // bottom
  pushQuad(verts, idx, [-ow, -oh, zOpen], [-iw, -ih, zOpen], [-iw, ih, zOpen], [-ow, oh, zOpen], rimN);      // left
  pushQuad(verts, idx, [iw, -ih, zOpen], [ow, -oh, zOpen], [ow, oh, zOpen], [iw, ih, zOpen], rimN);          // right

  // 4 retainer tabs on the inner floor — 2 along the top edge, 2 along the bottom, protruding inward.
  if (withTabs) {
    const r = CD_CASE_SHELL.tabR, inset = CD_CASE_SHELL.tabInset, zTab = zFloor - floorSide * 0.2;   // just off the floor
    const n: V3 = [0, 0, -floorSide];
    // top edge (y=+hh): semicircles opening downward (a0 = π)
    pushSemicircle(verts, idx, -hw + w * 0.28, hh - inset, zTab, r, Math.PI, n);
    pushSemicircle(verts, idx, hw - w * 0.28, hh - inset, zTab, r, Math.PI, n);
    // bottom edge (y=-hh): semicircles opening upward (a0 = 0)
    pushSemicircle(verts, idx, -hw + w * 0.28, -hh + inset, zTab, r, 0, n);
    pushSemicircle(verts, idx, hw - w * 0.28, -hh + inset, zTab, r, 0, n);
  }

  // The tray's disc bed + centre gripper rosette — both rise from the floor into the case (−floorSide), offset to
  // sit under the right-aligned disc.
  if (withHub) {
    appendDiscBedRing(verts, idx, zFloor, (-floorSide) as 1 | -1, hubOffsetX);
    appendHubRosette(verts, idx, zFloor, (-floorSide) as 1 | -1, hubOffsetX);
  }

  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx), format: '12float' };
}
