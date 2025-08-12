import { Vec2 } from "../../types/interaction";

/**
 * Checks if two convex polygons (given as arrays of [x, y] pairs) intersect.
 * Uses the Separating Axis Theorem (SAT): if any separating axis exists
 * where projections don't overlap, then the polygons do not intersect.
 */
export function polygonsIntersect(a: Vec2[], b: Vec2[]): boolean {
    // Run SAT for both polygons
  const polys = [a, b];
  for (let i = 0; i < polys.length; i++) {
    const p = polys[i];
    // Loop over each edge of the polygon
    for (let j = 0; j < p.length; j++) {
      const k = (j + 1) % p.length;
      const edgeX = p[k][0] - p[j][0];
      const edgeY = p[k][1] - p[j][1];
      // Compute the perpendicular axis (normal) to the current edge
      const nx = -edgeY, ny = edgeX;
      // Project polygon A onto the axis
      let minA = Infinity, maxA = -Infinity;
      for (const [x, y] of a) { const d = x * nx + y * ny; if (d < minA) minA = d; if (d > maxA) maxA = d; }
      // Project polygon B onto the same axis
      let minB = Infinity, maxB = -Infinity;
      for (const [x, y] of b) { const d = x * nx + y * ny; if (d < minB) minB = d; if (d > maxB) maxB = d; }
      // If projections do not overlap, there's a separating axis — shapes do NOT intersect
      if (maxA < minB || maxB < minA) return false;
    }
  }
  // All projections overlapped, then shapes intersect
  return true;
}

export function pointInPolygon([px, py]: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    const hit = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) + 1e-5) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}