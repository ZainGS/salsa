# Barycentric Coordinates
**Last Updated:** 2026-05-11

---

## Intuition

A triangle is defined by three vertices. Any point inside that triangle can be described as a weighted average of those three vertices. The weights are barycentric coordinates.

The key insight is that the weights are *determined by position* — you don't assign them, you compute them from where the point is. And because the weights are relative to the triangle's own geometry, they're invariant under any transformation that preserves the triangle's shape. A point one third of the way between vertex A and vertex B has the same barycentric coordinates whether the triangle is in object space, world space, or UV space.

---

## Mental Model

Three people stand at the corners of a triangle, each holding a rope attached to a ball in the middle. The barycentric coordinates tell you how hard each person is pulling.

- If person A pulls with full force (α = 1, β = 0, γ = 0), the ball is at A's corner.
- If all three pull equally (α = β = γ = 1/3), the ball is at the centroid.
- If the ball is on the edge between A and B (γ = 0), person C isn't pulling at all.

The constraint is that the three weights always sum to 1: α + β + γ = 1. This is why you only need two of the three to determine the point — the third is always `1 - α - β`.

---

## Formal Explanation

For a triangle with vertices **A**, **B**, **C**, any point **P** can be written as:

```
P = α·A + β·B + γ·C,   where α + β + γ = 1
```

When all three weights are in [0, 1], **P** is inside the triangle. When any weight is negative, **P** is outside the triangle on the opposite side from that vertex.

**Computing barycentric coordinates from a 2D point:**

Given triangle vertices and a query point P, you can compute the weights using areas:

```
α = area(PBC) / area(ABC)   -- fraction of total area opposite vertex A
β = area(APC) / area(ABC)   -- fraction opposite vertex B
γ = area(ABP) / area(ABC)   -- fraction opposite vertex C
```

Where signed area = `0.5 * cross2D(B-A, C-A)`. Using signed areas lets negative values flag points outside the triangle.

In practice, the cross product form is more direct and avoids the division:

```typescript
// For point P in triangle (A, B, C):
const denom = (B.y - C.y)*(A.x - C.x) + (C.x - B.x)*(A.y - C.y);
const α = ((B.y - C.y)*(P.x - C.x) + (C.x - B.x)*(P.y - C.y)) / denom;
const β = ((C.y - A.y)*(P.x - C.x) + (A.x - C.x)*(P.y - C.y)) / denom;
const γ = 1 - α - β;
```

**Point-in-triangle test:** all three weights are in [0, 1] simultaneously iff `α ≥ 0 && β ≥ 0 && γ ≥ 0`.

**Interpolating vertex attributes:** Once you have barycentric coordinates, interpolating any per-vertex attribute (UVs, colors, normals) is just the same weighted sum:

```
uvAtP = α * uv_A  +  β * uv_B  +  γ * uv_C
```

This is exactly what the GPU does when rasterizing a triangle — it computes barycentric coordinates for every pixel covered by the triangle, then uses them to interpolate all the vertex attributes.

---

## Why It Matters

**Ray-triangle intersection.** When a ray hits a triangle (in the mesh picker, or in the mesh painter when projecting a brush onto a surface), you need to know *where* on the triangle it hit. The hit point in 3D is fine, but what you usually want is the UV coordinates at that point — to look up a texture, or to paint into the texture. Barycentric coordinates are the bridge: compute them for the 3D hit point projected onto the triangle's plane, then interpolate the UVs.

**Mesh painting.** The brush painter projects a world-space pointer position onto the mesh surface, finds the hit triangle, computes barycentric coordinates of the hit point within that triangle, then uses those to interpolate the UV — which gives the texel location to paint into.

**GPU rasterization.** The GPU doesn't explicitly compute barycentric coordinates and expose them to you — it uses them internally to interpolate all `@location(N)` attributes between vertices. Understanding this explains why attribute interpolation is linear across a triangle in screen space, and why perspective-correct interpolation requires a correction (attributes should interpolate linearly in world space, not screen space — the GPU corrects for this automatically).

**Ear-clipping triangulation.** The ear-clipping algorithm in Salsa's GP fill triangulator uses a point-in-triangle test based on barycentric coordinates (or the equivalent cross-product sign test) to verify that a triangle ear contains no other polygon vertices before clipping it.

---

## Where the Mental Model Breaks

**The "weights" framing breaks outside the triangle.** Outside the triangle, at least one coordinate is negative. There's nothing wrong with negative weights mathematically — you can still compute `α·A + β·B + γ·C` and get the right point — but the "people pulling ropes" image stops working. The generalization is that barycentric coordinates define an *affine coordinate system* for the whole plane, not just the triangle interior. Any point in 2D has unique barycentric coordinates relative to a non-degenerate triangle.

**Degenerate triangles break the computation.** The denominator in the formula is twice the signed area of the triangle. If the triangle has zero area (all three vertices collinear), the denominator is zero. The barycentric computation returns NaN or infinity. Mesh painters and ray-triangle intersectors need to guard against this — a zero-area triangle can appear from aggressive welding or a bad import.

**3D vs 2D barycentric coordinates.** Computing barycentric coordinates for a 3D point on a 3D triangle requires projecting to 2D first (onto the triangle's plane). You pick the two axes that maximize the projected area — if the triangle's normal is mostly pointing in Z, project onto XY. This is what the ear-clipping implementation in `gp-renderer-3d.ts` does when triangulating closed strokes: it projects each point onto the dominant plane of the stroke before running the 2D ear-clip test.

---

## Common Confusions

**"Barycentric coordinates are 2D."**
They're defined for simplices of any dimension. In 3D you have four vertices (a tetrahedron) and four barycentric coordinates summing to 1. The 2D triangle case is just the most common in graphics.

**"The GPU interpolates attributes linearly across the screen."**
It interpolates linearly in *clip space*, which after perspective division gives non-linear interpolation in screen space. The GPU applies a perspective-correct interpolation correction so that the interpolation appears linear in world space. If you disable this (in WebGPU: `@interpolate(linear, no_perspective)`) you get raw screen-space linear interpolation, which is wrong for anything except 2D overlays.

**"Point-in-triangle test: just check all three cross products."**
The cross product sign test (`cross(AB, AP) > 0 && cross(BC, BP) > 0 && cross(CA, CP) > 0`) is equivalent to the all-positive barycentric test, but only for *counter-clockwise* triangles. For a clockwise triangle, all three are negative when inside. To handle both windings, check that all three have the same sign rather than all being positive. Salsa's ear-clipping code uses this signed-area approach.

---

## How Salsa Uses It

`src/renderer/3d/gp-renderer-3d.ts` — `earClip()` uses the `cross2D` + `pointInTriangle` helpers to test whether candidate ear triangles contain other polygon vertices. The point-in-triangle test is a direct sign-based barycentric check.

`src/renderer/3d/mesh-picker.ts` — ray-triangle intersection. After finding a ray-plane hit, computes barycentric coordinates to confirm the hit is inside the triangle and to interpolate UV coordinates for surface snap (GP stroke placement on mesh surface).

`src/renderer/raster/brushes/mesh-painter.ts` — same pattern as mesh picker; barycentric interpolation of UV coordinates at the brush hit point, used to locate the texel to paint.

---

## Related Concepts

- [UV Mapping](uv-mapping.md) — barycentric interpolation is how UVs are evaluated at arbitrary surface points; the seam problem arises from per-vertex UV storage not handling barycentric-split UVs at seam edges
- [Coordinate Spaces](coordinate-spaces.md) — barycentric coordinates are space-agnostic (they work in any space), but the hit point from a ray test typically comes in world space and must be expressed in the triangle's local frame
- [Polygon Mesh Topology](polygon-mesh-topology.md) — the triangle is the unit of barycentric computation; mesh topology determines which triangles exist to test against
