# Coordinate Spaces
**Last Updated:** 2026-05-11

---

## Intuition

A coordinate is meaningless without a frame of reference. (3, 0, 0) doesn't mean anything until you say "3 units to the right of what?" Coordinate spaces are just explicit agreements about what "to the right of" means.

The reason there are several of them — object, world, view, clip, NDC, screen — is not bureaucracy. Each space makes a different operation trivial. You pick the space that makes your current problem easy, do the work, then move on.

---

## Mental Model

Think of it as a relay. A vertex starts in object space (defined relative to the object's own center) and gets handed off through a chain of spaces, each one changing what the coordinates are *relative to*:

```
Object space  →[model matrix]→  World space
World space   →[view matrix]→   View (camera) space
View space    →[projection]→    Clip space
Clip space    →[÷ w]→           NDC
NDC           →[viewport]→      Screen space (pixels)
```

At each step, a matrix multiplication transforms the coordinates. The matrix doesn't distort the geometry — it re-expresses the same point in a different reference frame.

The combined MVP matrix (`model × view × projection`, or `projection × view × model` depending on convention) collapses the whole chain into one multiply. That's what you put in the vertex shader.

---

## Formal Explanation

**Object space (local space):** Positions defined relative to the object's own origin. A box defined as ±0.5 in each axis lives entirely in object space. Most mesh geometry is authored in object space.

**World space:** The common coordinate system where all objects live together. The model matrix transforms from object → world. It encodes the object's position, rotation, and scale in the world. `mesh.localMatrix` in Salsa is this matrix.

**View space (camera space):** World coordinates re-expressed relative to the camera — camera sits at origin, looking down −Z. The view matrix is the inverse of the camera's world transform. If the camera moves right, the view matrix translates everything left (so the camera stays at origin in view space).

**Clip space:** Projection matrix applied. Perspective is encoded here by making the w component carry depth information. A point's actual clip-space position is only meaningful after perspective division. The frustum is now the box −w ≤ x,y,z ≤ w. Points outside are clipped.

**NDC (Normalized Device Coordinates):** After perspective division (divide x,y,z by w). Now the visible frustum maps to the cube [−1,1]³. Z=−1 is near plane, Z=1 is far plane (WebGPU convention: Z in [0,1] after projection). Simple box test determines visibility.

**Screen space:** The viewport transform maps NDC to pixel coordinates. In WebGPU:
```
screenX = (ndcX + 1) * 0.5 * canvasWidth
screenY = (1 - ndcY) * 0.5 * canvasHeight   // Y is flipped: NDC +Y is up, screen +Y is down
```

---

## Why It Matters

**Rendering:** The vertex shader runs in clip space. Every vertex goes through MVP before the GPU does anything with it. Understanding this chain is the prerequisite for writing any non-trivial shader.

**Picking and raycasting:** Going the other direction — from screen pixels back into world space — requires inverting the chain. Click (400px, 300px) → NDC → unproject through inverse VP → world-space ray. Almost every selection tool does this.

**Screen-space effects:** Some effects are only practical in a specific space. Screen-space ambient occlusion runs in view space (depth buffer gives you view-space distances). The Grease Pencil stroke width is screen-space (strokes should be 3px wide regardless of camera distance). The knife tool runs in screen space (the user draws a line in pixels, you project mesh vertices into pixels to find intersections).

---

## Where the Mental Model Breaks

**The w component.** The relay metaphor implies clean separate steps, but clip space is genuinely different from the others — it's in *homogeneous* coordinates, where w ≠ 1. You cannot visualize or compare clip-space positions as if they were 3D points until you divide by w. This catches people when they try to reason about "is this point inside the frustum" in clip space before perspective division.

The practical consequence: when projecting vertices for the knife cut, you check `w <= 0` and bail out before dividing. Points behind the camera have w < 0. Dividing by negative w flips the sign of x and y, which means a vertex behind the camera would project to a seemingly valid screen position — but mirrored and wrong.

**The view matrix is the camera's inverse, not its transform.** If your camera node has a world matrix M (position + rotation), the view matrix is M⁻¹. This is counterintuitive because you think "apply the camera transform" — but the camera transform moves the camera; the view matrix moves the world so the camera is at the origin. They're inverses.

**Column-major vs row-major storage.** gl-matrix (which Salsa uses) stores matrices in column-major order in memory but uses the convention that vectors are column vectors multiplied on the right: `M * v`. This means `mat4.multiply(out, A, B)` computes `A × B`, so for MVP you write `mat4.multiply(out, projView, model)` — projection-view on the left, model on the right. Getting this backwards produces a valid-looking matrix that transforms everything incorrectly.

---

## Common Confusions

**"The model matrix and the object's position are the same thing."**
Not quite. The model matrix encodes position, rotation, AND scale. A uniform scale of 2 makes the mesh twice as large in world space. A non-uniform scale (2, 1, 1) stretches it. If the mesh has a parent node, the effective model matrix is the product of all ancestor transforms down to the mesh — the full scene graph chain.

**"NDC is clip space."**
Clip space is before perspective division (w ≠ 1 in general). NDC is after (w = 1 by definition since you divided by itself). The GPU does the perspective division automatically between the vertex shader output and the rasterizer, so in the shader you output clip space; the GPU converts to NDC before clipping.

**"View space Z points toward the camera."**
In OpenGL convention, view space Z points *out of the screen toward the viewer*, so the camera looks down −Z. WebGPU follows a similar convention. This is why projection matrices negate the Z axis — the depth buffer runs [0, 1] with 0 at the near plane, and the projection matrix maps −nearZ → 0 and −farZ → 1.

---

## How Salsa Uses It

`src/renderer/3d/camera-3d.ts` — `getViewProjectionMatrix()` returns the combined VP matrix. This gets passed as a uniform to every 3D shader.

`src/services/shape-manager.ts` — `knifeCut3D()` builds the full MVP:
```typescript
const vp  = this.getCamera3D().getViewProjectionMatrix();
const mvp = mat4.multiply(mat4.create(), vp, mesh.localMatrix as mat4);

// Then for each vertex:
vec4.set(clip, v.x, v.y, v.z, 1);
vec4.transformMat4(clip, clip, mvp);
const w = clip[3];
if (w <= 0) return { ok: false };           // behind camera — skip
const screenX = (clip[0] / w + 1) * 0.5 * canvasWidth;
const screenY = (1 - clip[1] / w) * 0.5 * canvasHeight;
```

`src/renderer/3d/gp-renderer-3d.ts` — GP strokes pass `viewProj` as a uniform; stroke width is a world-space value that the vertex shader expands into screen-space pixels by dividing by the projected w.

`src/renderer/3d/mesh-picker.ts` — ray unprojection: screen pixel → NDC → world-space ray via inverse VP.

---

## Related Concepts

- [Barycentric Coordinates](barycentric-coordinates.md) *(future)* — once a ray hits a triangle in world space, barycentric coords describe *where* on that triangle
- [UV Mapping](uv-mapping.md) — UV space is yet another 2D coordinate system, this one defined per-mesh surface rather than globally
- [Half-Edge Meshes](half-edge-meshes.md) — the topology structure that holds the vertices whose positions live in object space
