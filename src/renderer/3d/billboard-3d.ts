/**
 * billboard-3d.ts — Billboard3D primitive: PNG → extruded "paper cutout" mesh.
 *
 * Given an RGBA image, produce a 3D mesh whose silhouette is the image's alpha
 * contour, extruded along Z. Front and back faces carry the image texture;
 * the side wall ("cut edge") is a solid color. The result looks like the
 * sprite was printed on card stock and cut out with scissors — the 3DS /
 * Flipnote Studio cutout look.
 *
 * Two silhouette modes, chosen automatically:
 *   • Opaque image (little/no transparency) → a rounded-rectangle outline
 *     (so cart/project thumbnails become a clean rounded slab).
 *   • Transparent icon → the traced alpha contour (boundary-edge chaining,
 *     then Douglas–Peucker simplification).
 *
 * Pure geometry — no GPU. The consumer uploads the returned arrays and renders
 * with a shader that samples the image for faceType 0 (front/back) and uses a
 * solid color for faceType 1 (sides). See docs/specs/billboard3d.md.
 */

export interface Billboard3DConfig {
  /** White-border thickness in **image pixels** — the alpha mask is dilated by
   *  this much before tracing, so the band between the icon and the fattened
   *  silhouette renders as the border color. Default 24. (Icon mode.) */
  borderPx: number;
  /** Rounded-rect padding in model units (opaque/slab mode only). Default 0.04. */
  padding: number;
  /** Extrusion thickness along Z, in model units. Default 0.10. */
  depth: number;
  /** Corner radius for the opaque/rounded-rect mode (model units). Default 0.06. */
  cornerRadius: number;
  /** RGBA of the cut edge / sides. Default white. */
  sideColor: [number, number, number, number];
  /** Alpha (0–255) at or above which a pixel is "inside". Default 26 (~0.1). */
  alphaThreshold: number;
  /** Above this opaque-pixel fraction, use rounded-rect mode. Default 0.92. */
  opaqueRectThreshold: number;
  /** Tag the front/back faces faceType 2 ("cutout") so the renderer discards
   *  transparent texels — true see-through holes (e.g. a gear's holes) instead
   *  of the painted border band. The texture must bake in its own outline (the
   *  silhouette band is no longer painted). Default false. */
  cutoutHoles: boolean;
}

export const DEFAULT_BILLBOARD3D_CONFIG: Billboard3DConfig = {
  borderPx: 24,
  padding: 0.04,
  depth: 0.10,
  cornerRadius: 0.06,
  sideColor: [1, 1, 1, 1],
  alphaThreshold: 26,
  opaqueRectThreshold: 0.92,
  cutoutHoles: false,
};

export interface Billboard3DGeometry {
  /** Interleaved is avoided; separate arrays for clarity. xyz per vertex. */
  positions: Float32Array;
  normals: Float32Array;
  /** Front/back texture coords (xy). Side verts carry their nearest face uv. */
  uvs: Float32Array;
  /** 0 = front/back (textured, painted band), 1 = side (solid sideColor),
   *  2 = front/back cutout (textured, transparent texels discarded). */
  faceType: Float32Array;
  indices: Uint32Array;
  /** Source aspect ratio (w/h) of the trimmed silhouette, for the caller. */
  aspect: number;
}

type Pt = { x: number; y: number };

// ── Silhouette extraction ────────────────────────────────────────────

/**
 * Trace the outer contour of the alpha mask via boundary-edge chaining:
 * collect every directed edge between an inside and an outside pixel, then
 * chain them into closed loops and keep the longest (the outer silhouette).
 * Robust and winding-agnostic (earClip fixes winding later).
 */
function traceContour(alpha: Uint8Array, w: number, h: number, threshold: number): Pt[] {
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && alpha[y * w + x] >= threshold;

  // Directed edges (CW around each inside pixel in y-down space).
  const key = (x: number, y: number) => x * 100000 + y;
  const next = new Map<number, Pt>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) next.set(key(x, y), { x: x + 1, y });           // top
      if (!inside(x + 1, y)) next.set(key(x + 1, y), { x: x + 1, y: y + 1 }); // right
      if (!inside(x, y + 1)) next.set(key(x + 1, y + 1), { x, y: y + 1 });    // bottom
      if (!inside(x - 1, y)) next.set(key(x, y + 1), { x, y });               // left
    }
  }
  if (next.size === 0) return [];

  // Chain into loops; keep the longest.
  const visited = new Set<number>();
  let best: Pt[] = [];
  for (const [startK, _] of next) {
    if (visited.has(startK)) continue;
    const loop: Pt[] = [];
    let cur = startK;
    let guard = next.size + 1;
    while (guard-- > 0) {
      if (visited.has(cur)) break;
      visited.add(cur);
      const p = next.get(cur);
      if (!p) break;
      loop.push(p);
      cur = key(p.x, p.y);
      if (cur === startK) break;
    }
    if (loop.length > best.length) best = loop;
  }
  return best;
}

/**
 * Morphological dilation of the alpha mask by `r` image pixels (separable
 * square max-filter — fast, and the slight squareness is rounded away by the
 * contour trace + simplify). Returns a 0/255 mask. r ≤ 0 just binarizes.
 */
function dilateMask(alpha: Uint8Array, w: number, h: number, threshold: number, r: number): Uint8Array {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = alpha[i] >= threshold ? 1 : 0;
  if (r <= 0) { const o = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) o[i] = bin[i] ? 255 : 0; return o; }
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && bin[row + xx]) { m = 1; break; } }
      tmp[row + x] = m;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < h && tmp[yy * w + x]) { m = 1; break; } }
      out[y * w + x] = m ? 255 : 0;
    }
  }
  return out;
}

/** Douglas–Peucker polygon simplification (closed loop). */
function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 4) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = true; keep[pts.length - 1] = true;

  const dist = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  };
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = dist(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx >= 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Rounded-rectangle outline (model space, centered) for the opaque mode. */
function roundedRectOutline(halfW: number, halfH: number, r: number, segs = 6): Pt[] {
  const rr = Math.max(0, Math.min(r, Math.min(halfW, halfH)));
  const out: Pt[] = [];
  const corners: [number, number, number][] = [
    [halfW - rr, halfH - rr, 0],     // TR
    [-halfW + rr, halfH - rr, Math.PI / 2],
    [-halfW + rr, -halfH + rr, Math.PI],
    [halfW - rr, -halfH + rr, -Math.PI / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (i / segs) * (Math.PI / 2);
      out.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
  }
  return out;
}

// ── Triangulation (self-contained ear clipping) ──────────────────────

function cross2(ax: number, ay: number, bx: number, by: number): number { return ax * by - ay * bx; }
function pointInTri(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = cross2(px - ax, py - ay, bx - ax, by - ay);
  const d2 = cross2(px - bx, py - by, cx - bx, cy - by);
  const d3 = cross2(px - cx, py - cy, ax - cx, ay - cy);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
function earClip(pts: Pt[]): number[] {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  const idx = Array.from({ length: n }, (_, i) => i);
  let area = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  if (area < 0) idx.reverse();
  const tris: number[] = [];
  let remaining = idx.length;
  let failSafe = n * n;   // O(n^2) total budget — enough for any simple polygon
  let i = 0;
  while (remaining > 2 && failSafe-- > 0) {
    const a = idx[i % remaining], b = idx[(i + 1) % remaining], c = idx[(i + 2) % remaining];
    const ax = pts[a].x, ay = pts[a].y, bx = pts[b].x, by = pts[b].y, cx = pts[c].x, cy = pts[c].y;
    let ear = cross2(bx - ax, by - ay, cx - bx, cy - by) > 0;
    if (ear) {
      for (let j = 0; j < remaining; j++) {
        const vi = idx[j];
        if (vi === a || vi === b || vi === c) continue;
        if (pointInTri(pts[vi].x, pts[vi].y, ax, ay, bx, by, cx, cy)) { ear = false; break; }
      }
    }
    if (ear) { tris.push(a, b, c); idx.splice((i + 1) % remaining, 1); remaining--; }
    else { i++; }
  }
  return tris;
}

function norm(x: number, y: number): Pt { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; }

// ── Public API ───────────────────────────────────────────────────────

/**
 * Build the extruded cutout geometry for an RGBA image.
 * `rgba` is tightly packed Uint8 (w*h*4). Returns normalized model-space
 * geometry (larger axis ≈ 1.0, centered, y-up).
 */
export function generateBillboard3DGeometry(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  cfg: Partial<Billboard3DConfig> = {},
): Billboard3DGeometry {
  const c = { ...DEFAULT_BILLBOARD3D_CONFIG, ...cfg };

  // Alpha mask + opaque fraction + bounding box of inside pixels.
  const alpha = new Uint8Array(w * h);
  let opaque = 0, total = 0;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3];
    alpha[i] = a;
    total++;
    if (a >= c.alphaThreshold) {
      opaque++;
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (opaque === 0) { minX = 0; minY = 0; maxX = w - 1; maxY = h - 1; }

  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const span = Math.max(bw, bh);

  if (opaque / total >= c.opaqueRectThreshold) {
    // Opaque → rounded-rectangle slab.
    const halfW = bw / span / 2, halfH = bh / span / 2;
    const outline = roundedRectOutline(halfW + c.padding, halfH + c.padding, c.cornerRadius);
    const uvLoop = outline.map(p => ({
      x: 0.5 + (p.x / (halfW * 2 + 2 * c.padding)),
      y: 0.5 - (p.y / (halfH * 2 + 2 * c.padding)),
    }));
    return extrude(outline, uvLoop, c.depth, bw / bh);
  }

  // Transparent → dilate the mask by borderPx (the white-border band), trace
  // that fattened silhouette, and keep UVs in ORIGINAL image space so the band
  // between the icon edge and the dilated edge samples transparent texels (the
  // renderer paints those with the border color). Dilation avoids the polygon
  // self-intersection that broke triangulation on concave shapes (gear teeth).
  const dilated = dilateMask(alpha, w, h, c.alphaThreshold, c.borderPx);
  const simp = simplify(traceContour(dilated, w, h, 1), 1.5);
  if (simp.length < 3) {
    // Degenerate — fall back to a plain square slab.
    const out = roundedRectOutline(0.5, 0.5, c.cornerRadius);
    const uv = out.map(p => ({ x: 0.5 + p.x, y: 0.5 - p.y }));
    return extrude(out, uv, c.depth, 1);
  }
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
  for (const p of simp) { mnx = Math.min(mnx, p.x); mny = Math.min(mny, p.y); mxx = Math.max(mxx, p.x); mxy = Math.max(mxy, p.y); }
  const cbw = (mxx - mnx) || 1, cbh = (mxy - mny) || 1, cspan = Math.max(cbw, cbh);
  const outline = simp.map(p => ({ x: (p.x - (mnx + cbw / 2)) / cspan, y: -(p.y - (mny + cbh / 2)) / cspan }));
  const uvLoop = simp.map(p => ({ x: p.x / w, y: p.y / h }));
  return extrude(outline, uvLoop, c.depth, cbw / cbh, c.cutoutHoles ? 2 : 0);
}

function extrude(outline: Pt[], uvLoop: Pt[], depth: number, aspect: number, faceVal = 0): Billboard3DGeometry {
  const n = outline.length;
  const hz = depth / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const faceType: number[] = [];
  const indices: number[] = [];

  const pushV = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, ft: number) => {
    positions.push(x, y, z); normals.push(nx, ny, nz); uvs.push(u, v); faceType.push(ft);
    return positions.length / 3 - 1;
  };

  // Front (z = +hz), normal +Z.
  const front: number[] = [];
  for (let i = 0; i < n; i++) front.push(pushV(outline[i].x, outline[i].y, hz, 0, 0, 1, uvLoop[i].x, uvLoop[i].y, faceVal));
  const tri = earClip(outline);
  for (let i = 0; i < tri.length; i += 3) indices.push(front[tri[i]], front[tri[i + 1]], front[tri[i + 2]]);

  // Back (z = -hz), normal -Z, reversed winding.
  const back: number[] = [];
  for (let i = 0; i < n; i++) back.push(pushV(outline[i].x, outline[i].y, -hz, 0, 0, -1, uvLoop[i].x, uvLoop[i].y, faceVal));
  for (let i = 0; i < tri.length; i += 3) indices.push(back[tri[i + 2]], back[tri[i + 1]], back[tri[i]]);

  // Sides: quad per outline edge, outward normal, solid (faceType 1).
  for (let i = 0; i < n; i++) {
    const a = outline[i], b = outline[(i + 1) % n];
    const ex = b.x - a.x, ey = b.y - a.y;
    const nrm = norm(ey, -ex);
    const ua = uvLoop[i], ub = uvLoop[(i + 1) % n];
    const v0 = pushV(a.x, a.y, hz, nrm.x, nrm.y, 0, ua.x, ua.y, 1);
    const v1 = pushV(b.x, b.y, hz, nrm.x, nrm.y, 0, ub.x, ub.y, 1);
    const v2 = pushV(b.x, b.y, -hz, nrm.x, nrm.y, 0, ub.x, ub.y, 1);
    const v3 = pushV(a.x, a.y, -hz, nrm.x, nrm.y, 0, ua.x, ua.y, 1);
    indices.push(v0, v1, v2, v0, v2, v3);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    faceType: new Float32Array(faceType),
    indices: new Uint32Array(indices),
    aspect,
  };
}
