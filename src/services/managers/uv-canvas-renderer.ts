/**
 * UVCanvasRenderer — 2D canvas renderer for the UV editor right-pane.
 *
 * Rendering layers (bottom → top):
 *   1. Texture background (checkerboard if no texture linked)
 *   2. UV [0,1] boundary box
 *   3. Island color fills  (optional, showIslands)
 *   4. Stretch overlay     (optional, showStretchOverlay)
 *   5. UV wireframe        (seams red, normal edges white, selected orange)
 *   6. Hover face tint
 *   7. Selection highlights (faces filled, vertices as dots, pinned as diamonds)
 *
 * UVEditorSession holds all runtime state for one mesh's UV editor.
 * It is NOT serialized — rebuilt from the EditMesh when reopened.
 */

import type { EditMesh, UVIsland } from '../../scene-graph/shapes/edit-mesh';

// ── Session ───────────────────────────────────────────────────────────────────

export type UVSelectionMode = 'vertex' | 'edge' | 'face';

export class UVEditorSession {
  constructor(public readonly meshId: string) {}

  selection = {
    vertices: new Set<number>(),
    edges:    new Set<number>(),
    faces:    new Set<number>(),
    mode: 'face' as UVSelectionMode,
  };

  /** Cached island decomposition. Invalidated when seams or topology change. */
  islands: UVIsland[] = [];
  islandsDirty = true;

  showWireframe      = true;
  showIslands        = false;
  showStretchOverlay = false;

  linkedLayerId: string | null = null;
  pinnedVertices = new Set<number>();

  /** Set by hover events to drive cross-highlighting in both panes. */
  hoveredFaceIndex: number | null = null;

  /**
   * When true, hovering highlights the entire UV island that contains the
   * hovered face rather than just the single face.
   */
  islandHoverMode = false;

  /** UV coordinate displayed at the canvas centre (the pan offset). */
  panU = 0.5;
  panV = 0.5;
  /** Scale factor — 1 = UV [0,1] square fills ~85% of the canvas shorter axis. */
  zoom = 1.0;

  /** Call after any seam or topology change to force island recompute. */
  invalidateIslands(): void { this.islandsDirty = true; }

  selectFace(fi: number, additive = false): void {
    if (!additive) this.selection.faces.clear();
    this.selection.faces.add(fi);
    this.selection.mode = 'face';
  }

  selectVertex(vi: number, additive = false): void {
    if (!additive) this.selection.vertices.clear();
    this.selection.vertices.add(vi);
    this.selection.mode = 'vertex';
  }

  selectEdge(hi: number, additive = false): void {
    if (!additive) this.selection.edges.clear();
    this.selection.edges.add(hi);
    this.selection.mode = 'edge';
  }

  clearSelection(): void {
    this.selection.vertices.clear();
    this.selection.edges.clear();
    this.selection.faces.clear();
  }

  selectAll(editMesh: EditMesh): void {
    this.clearSelection();
    if (this.selection.mode === 'face') {
      for (let i = 0; i < editMesh.faces.length; i++) this.selection.faces.add(i);
    } else if (this.selection.mode === 'vertex') {
      for (let i = 0; i < editMesh.vertices.length; i++) this.selection.vertices.add(i);
    } else {
      for (let i = 0; i < editMesh.halfEdges.length; i++) {
        const he = editMesh.halfEdges[i];
        if (he.twin < 0 || he.twin > i) this.selection.edges.add(i);
      }
    }
  }
}

// ── Island color palette ──────────────────────────────────────────────────────

const ISLAND_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [100, 150, 255],
  [255, 150, 100],
  [100, 220, 130],
  [200, 100, 220],
  [220, 210,  80],
  [100, 210, 220],
  [220, 110, 130],
  [160, 200, 120],
];

// ── Renderer ──────────────────────────────────────────────────────────────────

export class UVCanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('UVCanvasRenderer: failed to obtain 2D context');
    this.ctx = ctx;
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────

  /** UV [0,1] → canvas pixel, honouring the session's pan/zoom. */
  uvToCanvas(u: number, v: number, session: UVEditorSession): [number, number] {
    const { width: w, height: h } = this.canvas;
    const size = Math.min(w, h) * 0.85;
    return [
      (u - session.panU) * session.zoom * size + w * 0.5,
      (v - session.panV) * session.zoom * size + h * 0.5,
    ];
  }

  /** Canvas pixel → UV [0,1] (inverse of uvToCanvas). */
  canvasToUV(cx: number, cy: number, session: UVEditorSession): [number, number] {
    const { width: w, height: h } = this.canvas;
    const size = Math.min(w, h) * 0.85;
    return [
      (cx - w * 0.5) / (session.zoom * size) + session.panU,
      (cy - h * 0.5) / (session.zoom * size) + session.panV,
    ];
  }

  // ── Main draw call ────────────────────────────────────────────────────────

  draw(
    session:  UVEditorSession,
    editMesh: EditMesh | null | undefined,
    texture?: HTMLImageElement | ImageBitmap | HTMLCanvasElement | null,
  ): void {
    if (!editMesh) return;
    const { ctx, canvas } = this;
    const { width: w, height: h } = canvas;

    // Refresh island cache if dirty
    if (session.islandsDirty) {
      session.islands = editMesh.computeUVIslands();
      session.islandsDirty = false;
    }

    const uv = (u: number, v: number): [number, number] =>
      this.uvToCanvas(u, v, session);

    const [ox, oy] = uv(0, 0);
    const [ex, ey] = uv(1, 1);
    const uvW = ex - ox;
    const uvH = ey - oy;

    ctx.clearRect(0, 0, w, h);

    // ── 1. Background ──────────────────────────────────────────────────────
    if (texture) {
      ctx.drawImage(texture, ox, oy, uvW, uvH);
    } else {
      this._drawCheckerboard(ox, oy, uvW, uvH);
    }

    // UV [0,1] boundary box
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(ox, oy, uvW, uvH);
    ctx.restore();

    // ── 2. Island fills ────────────────────────────────────────────────────
    if (session.showIslands) {
      this._drawIslandFills(session, editMesh, uv);
    }

    // ── 3. Stretch overlay ─────────────────────────────────────────────────
    if (session.showStretchOverlay) {
      this._drawStretchOverlay(editMesh, uv);
    }

    // ── 4. UV wireframe ────────────────────────────────────────────────────
    if (session.showWireframe) {
      this._drawWireframe(session, editMesh, uv);
    }

    // ── 5. Hover highlight ─────────────────────────────────────────────────
    if (session.hoveredFaceIndex !== null) {
      if (session.islandHoverMode && !session.islandsDirty) {
        const island = session.islands.find(isl => isl.faceIndices.includes(session.hoveredFaceIndex!));
        if (island) {
          for (const fi of island.faceIndices) {
            this._drawFaceFill(fi, editMesh, uv, 'rgba(255,200,100,0.18)');
          }
        } else {
          this._drawFaceFill(session.hoveredFaceIndex, editMesh, uv, 'rgba(255,200,100,0.22)');
        }
      } else {
        this._drawFaceFill(session.hoveredFaceIndex, editMesh, uv, 'rgba(255,200,100,0.22)');
      }
    }

    // ── 6. Selection ───────────────────────────────────────────────────────
    this._drawSelection(session, editMesh, uv);
  }

  // ── Hit test ──────────────────────────────────────────────────────────────

  /**
   * Find the EditMesh face index whose UV projection contains (cx, cy).
   * Uses point-in-triangle for fan-triangulated faces.
   * Returns null when no face matches.
   */
  hitTestFace(
    cx: number, cy: number,
    session:  UVEditorSession,
    editMesh: EditMesh,
  ): number | null {
    const [u, v] = this.canvasToUV(cx, cy, session);
    let result: number | null = null;
    for (let fi = 0; fi < editMesh.faces.length; fi++) {
      const verts = this._getFaceUVVerts(fi, editMesh);
      if (verts.length < 3) continue;
      for (let k = 1; k < verts.length - 1; k++) {
        if (_ptInTri(u, v, verts[0], verts[k], verts[k + 1])) {
          result = fi;
          break;
        }
      }
    }
    return result;
  }

  // ── Private: drawing layers ───────────────────────────────────────────────

  private _drawCheckerboard(ox: number, oy: number, uvW: number, uvH: number): void {
    const { ctx } = this;
    const cell  = Math.max(8, uvW / 16);
    const cols  = Math.ceil(uvW / cell);
    const rows  = Math.ceil(uvH / cell);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, uvW, uvH);
    ctx.clip();
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#555' : '#333';
        ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
      }
    }
    ctx.restore();
  }

  private _drawIslandFills(
    session:  UVEditorSession,
    editMesh: EditMesh,
    uv:       (u: number, v: number) => [number, number],
  ): void {
    const { ctx } = this;
    for (const island of session.islands) {
      const [r, g, b] = ISLAND_PALETTE[island.id % ISLAND_PALETTE.length];
      ctx.fillStyle = `rgba(${r},${g},${b},0.18)`;
      for (const fi of island.faceIndices) {
        this._traceFacePath(fi, editMesh, uv);
        ctx.fill();
      }
    }
  }

  private _drawStretchOverlay(
    editMesh: EditMesh,
    uv: (u: number, v: number) => [number, number],
  ): void {
    const { ctx } = this;
    const { faces } = editMesh;

    // Compute per-face areas for normalization
    let totalWorld = 0, totalUV = 0;
    const areas: Array<{ w: number; u: number }> = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const uvVerts    = this._getFaceUVVerts(fi, editMesh);
      const worldVerts = this._getFaceWorldVerts(fi, editMesh);
      let wA = 0, uA = 0;
      for (let k = 1; k < worldVerts.length - 1; k++) {
        wA += _triArea3D(worldVerts[0], worldVerts[k], worldVerts[k + 1]);
        if (uvVerts.length > k + 1)
          uA += _triArea2D(uvVerts[0], uvVerts[k], uvVerts[k + 1]);
      }
      areas.push({ w: wA, u: uA });
      totalWorld += wA;
      totalUV    += uA;
    }
    const norm = totalUV > 0 && totalWorld > 0 ? totalWorld / totalUV : 1;

    for (let fi = 0; fi < faces.length; fi++) {
      const { w, u } = areas[fi];
      if (u <= 0) continue;
      // log2 stretch: 0 = ideal, positive = stretched, negative = compressed
      const stretch = Math.log2((w / u) * norm + 1e-9);
      const t = Math.max(0, Math.min(1, (stretch + 1) / 2));
      const red = Math.round(255 * t);
      const blu = Math.round(255 * (1 - t));
      ctx.fillStyle = `rgba(${red},50,${blu},0.55)`;
      this._traceFacePath(fi, editMesh, uv);
      ctx.fill();
    }
  }

  private _drawWireframe(
    session:  UVEditorSession,
    editMesh: EditMesh,
    uv:       (u: number, v: number) => [number, number],
  ): void {
    const { ctx } = this;
    const { halfEdges, vertices } = editMesh;

    for (let hi = 0; hi < halfEdges.length; hi++) {
      const he = halfEdges[hi];
      // Only draw the canonical half of each edge (skip the twin)
      if (he.twin >= 0 && he.twin < hi) continue;

      const uvTo   = vertices[he.vertex].uv;
      const uvFrom = vertices[halfEdges[he.prev].vertex].uv;
      if (!uvTo || !uvFrom) continue;

      const [x0, y0] = uv(uvFrom[0], uvFrom[1]);
      const [x1, y1] = uv(uvTo[0],   uvTo[1]);

      const isSel = session.selection.mode === 'edge' && session.selection.edges.has(hi);

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);

      if (isSel) {
        ctx.strokeStyle = 'rgba(255,160,30,1.0)';
        ctx.lineWidth   = 2.5;
      } else if (he.isSeam) {
        ctx.strokeStyle = 'rgba(230,38,38,0.9)';
        ctx.lineWidth   = 1.8;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth   = 1.0;
      }
      ctx.stroke();
    }
  }

  private _drawSelection(
    session:  UVEditorSession,
    editMesh: EditMesh,
    uv:       (u: number, v: number) => [number, number],
  ): void {
    const { ctx, canvas } = this;
    const { selection } = session;

    // Selected faces — orange tint
    if (selection.mode === 'face') {
      for (const fi of selection.faces) {
        this._drawFaceFill(fi, editMesh, uv, 'rgba(255,160,30,0.35)');
      }
    }

    // Vertex dots — all shown in vertex mode, selected are larger/brighter
    if (selection.mode === 'vertex') {
      for (let vi = 0; vi < editMesh.vertices.length; vi++) {
        const uvCoord = editMesh.vertices[vi].uv;
        if (!uvCoord) continue;
        const [cx, cy] = uv(uvCoord[0], uvCoord[1]);
        const isSel = selection.vertices.has(vi);
        ctx.beginPath();
        ctx.arc(cx, cy, isSel ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = isSel ? 'rgba(255,160,30,1.0)' : 'rgba(255,180,80,0.7)';
        ctx.fill();
      }
    }

    // Pinned vertices — blue diamond
    for (const vi of session.pinnedVertices) {
      const uvCoord = editMesh.vertices[vi]?.uv;
      if (!uvCoord) continue;
      const [cx, cy] = uv(uvCoord[0], uvCoord[1]);
      const s = 4;
      ctx.beginPath();
      ctx.moveTo(cx,     cy - s);
      ctx.lineTo(cx + s, cy    );
      ctx.lineTo(cx,     cy + s);
      ctx.lineTo(cx - s, cy    );
      ctx.closePath();
      ctx.fillStyle = 'rgba(80,180,255,1.0)';
      ctx.fill();
    }
  }

  private _drawFaceFill(
    fi:      number,
    editMesh: EditMesh,
    uv:      (u: number, v: number) => [number, number],
    color:   string,
  ): void {
    this.ctx.fillStyle = color;
    this._traceFacePath(fi, editMesh, uv);
    this.ctx.fill();
  }

  /** Trace a canvas path for the UV polygon of face `fi` (does not stroke or fill). */
  private _traceFacePath(
    fi:      number,
    editMesh: EditMesh,
    uv:      (u: number, v: number) => [number, number],
  ): void {
    const verts = this._getFaceUVVerts(fi, editMesh);
    if (verts.length < 3) return;
    const [x0, y0] = uv(verts[0][0], verts[0][1]);
    this.ctx.beginPath();
    this.ctx.moveTo(x0, y0);
    for (let k = 1; k < verts.length; k++) {
      const [xk, yk] = uv(verts[k][0], verts[k][1]);
      this.ctx.lineTo(xk, yk);
    }
    this.ctx.closePath();
  }

  // ── Private: data extraction ──────────────────────────────────────────────

  /** UV coordinates of each vertex of face `fi`, in face-winding order. */
  private _getFaceUVVerts(fi: number, editMesh: EditMesh): [number, number][] {
    const { faces, halfEdges, vertices } = editMesh;
    const face = faces[fi];
    if (!face) return [];
    const result: [number, number][] = [];
    let hi = face.halfEdge;
    const start = hi;
    let guard = 0;
    do {
      const uvCoord = vertices[halfEdges[hi].vertex].uv;
      result.push(uvCoord ?? [0, 0]);
      hi = halfEdges[hi].next;
      if (++guard > 64) break;
    } while (hi !== start);
    return result;
  }

  /** Object-space (x,y,z) for each vertex of face `fi`. */
  private _getFaceWorldVerts(fi: number, editMesh: EditMesh): [number, number, number][] {
    const { faces, halfEdges, vertices } = editMesh;
    const face = faces[fi];
    if (!face) return [];
    const result: [number, number, number][] = [];
    let hi = face.halfEdge;
    const start = hi;
    let guard = 0;
    do {
      const v = vertices[halfEdges[hi].vertex];
      result.push([v.x, v.y, v.z]);
      hi = halfEdges[hi].next;
      if (++guard > 64) break;
    } while (hi !== start);
    return result;
  }
}

// ── Module-private math ───────────────────────────────────────────────────────

function _ptInTri(
  px: number, py: number,
  a: [number, number],
  b: [number, number],
  c: [number, number],
): boolean {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

function _triArea2D(
  a: [number, number],
  b: [number, number],
  c: [number, number],
): number {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) * 0.5;
}

function _triArea3D(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): number {
  const ax = b[0]-a[0], ay = b[1]-a[1], az = b[2]-a[2];
  const bx = c[0]-a[0], by = c[1]-a[1], bz = c[2]-a[2];
  const cx = ay*bz - az*by;
  const cy = az*bx - ax*bz;
  const cz = ax*by - ay*bx;
  return 0.5 * Math.sqrt(cx*cx + cy*cy + cz*cz);
}
