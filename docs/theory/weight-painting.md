# Weight Painting
**Last Updated:** 2026-06-06

---

## Intuition

When a skeleton deforms a mesh, every vertex must know how much each bone influences it. Weight painting is the process of assigning those per-vertex, per-bone influence values — the "votes" each bone gets when pulling a vertex toward where it would end up if attached rigidly to that bone.

The name comes from the primary editing interface: the artist paints directly on the mesh surface with a brush, setting influence values the way a painter sets color. But weights are not decorative — they are the data that drive skinning. The mesh deforms exactly as well or as poorly as its weights say it should.

---

## Mental Model

### Weights as voting power

A vertex influenced by two bones — say the upper arm and the lower arm — will follow a weighted blend of where each bone would put it:

```
finalPosition = weight_upper × (upperArm pulls vertex here)
              + weight_lower × (lowerArm pulls vertex here)
```

If `weight_upper = 0.8` and `weight_lower = 0.2`, the vertex is mostly rigid to the upper arm, but bends slightly with the lower arm. This produces the fleshy deformation at the elbow instead of a hard crease.

The invariant: **weights for any vertex must sum to 1.0.** Violating this scales the vertex away from or toward the origin as bones move — the mesh expands or collapses.

### The influence falloff picture

Good weights for a single bone look like a smooth gradient: full influence (1.0) near the bone's center, tapering to zero a comfortable distance away. The taper happens in the "blend zone" between two bones — where the vertex needs to smoothly transition responsibility from one bone to the other.

```
   bone A ─────────────────── bone B
  1.0                                1.0
   │         weight_A                │   weight_B
   │──────────────────╲   /─────────│
   │                   ╲ /          │
   │                    ╳           │
   │                   / ╲          │
   │──────────────────╯   ╲─────────│
  0.0                                0.0
```

The crossover region is the blend zone. Vertices here are partially controlled by both bones.

### The GPU constraint: 4 influences per vertex

GPU vertex shaders operate on fixed-size registers. A `vec4u`/`vec4f` holds four values efficiently. More than 4 bone influences per vertex would require larger registers or shader loops, adding GPU cost. In practice, most vertices need at most 2–3 meaningful influences; the 4th slot catches edge cases at complex joints.

Influences with weight < ~0.05 contribute so little they are visually indistinguishable from zero. When capping at 4, keep the 4 largest weights; renormalize so they sum to 1. The error is negligible.

### Heatmap visualization

Weight painting UIs overlay a false-color heatmap on the mesh:
- **Blue (0.0)** — no influence from this bone
- **Green (0.5)** — moderate influence
- **Red (1.0)** — full influence

The heatmap changes which bone is "active" — shown in the viewport — as the user switches the target bone. All the vertex influence values still exist for all bones; only the visualized layer changes.

---

## Formal Explanation

### The weight table

For a mesh with V vertices and J joints, the weight table is a V × J sparse matrix where most entries are zero. In practice it is stored as a per-vertex list of `(joint_index, weight)` pairs, capped at 4 entries:

```
vertex v:
  influences: [(j0, w0), (j1, w1), (j2, w2), (j3, w3)]
  constraint: w0 + w1 + w2 + w3 = 1.0
```

Padding entries (when fewer than 4 real influences) use `(0, 0.0)` — the zero weight zeroes out the contribution without affecting the result.

### Normalization

Normalization ensures the sum-to-1 invariant after any edit:

```
total = Σ w_i
if total > 0:
    w_i = w_i / total
else:
    // No influences — assign all weight to the nearest bone
    w_nearest = 1.0
```

Normalization must run after every brush stroke, every auto-weight pass, and every direct value edit.

### Brush blending modes

A weight-paint brush at position `P` with radius `R` and strength `S` affects all vertices within R. For each vertex, a falloff `f(v)` is computed (typically a smooth cosine or Gaussian based on distance):

```
f(v) = 1 - (dist(v, P) / R)²    // quadratic falloff, clamped to [0, 1]
```

Different brush modes apply the falloff differently:

| Mode | Formula | Use |
|------|---------|-----|
| **Replace** | `new_w = lerp(old_w, target, f × S)` | Set weights to a target value |
| **Add** | `new_w = old_w + target × f × S` | Increase influence in a region |
| **Subtract** | `new_w = old_w - target × f × S` | Reduce influence |
| **Smooth** | `new_w = lerp(old_w, avg_neighbors, f × S)` | Even out jagged weight boundaries |

After applying any mode, normalize the vertex's full weight list.

### Auto-weighting by distance (`1/d²`)

The automatic bind assigns weights without manual painting. For each vertex:

1. Find the N nearest joints by world-space distance (N ≤ 4)
2. Compute raw weight as `1 / max(d_i, ε)²`
3. Normalize so the N weights sum to 1

```
raw_i = 1 / max(distance(vertex, joint_i), ε)²
w_i = raw_i / Σ raw_j
```

This gives intuitive falloff: a vertex sitting directly on a bone gets near-1.0 weight; a vertex halfway between two bones gets ~50/50. It is fast (one pass over vertices) and requires no artist input, making it the correct default for first-bind.

Its limit: it is purely spatial — it ignores the mesh's topology and surface. A vertex on the front of the chest may be closest to the spine joint even though it should deform with the ribcage. For production characters, artists paint over the auto-weights to fix these cases.

### Heat diffusion (theory)

The alternative auto-weight method — "heat diffusion" — treats each joint as a heat source on the mesh surface and diffuses temperature outward along edges. The equilibrium temperature at each vertex becomes that bone's weight. Diffusion naturally follows the mesh surface, so it correctly avoids assigning influence through interior geometry (unlike the straight-line `1/d²` approach).

Salsa currently uses `1/d²`; heat diffusion is more expensive (requires solving a sparse linear system per bone) and reserved for a future quality pass.

---

## Why It Matters

**The quality of deformation is entirely downstream of weights.** A technically correct skinning pipeline produces ugly results with bad weights; a simple pipeline produces natural deformation with good weights. The skeleton is just a rig — the mesh follows the rig faithfully, for better or worse.

**Iterative refinement.** Auto-weights are fast but coarse. Weight painting lets the artist correct specific regions without re-running the full bind. The pipeline is: auto-bind → inspect deformations → paint corrections → repeat.

**Blend shapes vs. skinning.** For extreme joint angles (elbow fully bent, shoulder raised overhead), linear blend skinning produces "candy wrapper twist" — volume loss at the joint. The fix is either corrective blend shapes (morph targets added on top of the skinning result) or dual quaternion skinning. Weight painting is upstream of both: better weights reduce the need for corrective shapes.

---

## Where the Mental Model Breaks

**"Weights sum to 1, so if I add weight on one bone, I'm done."**
Adding weight to one bone breaks the sum-to-1 constraint. Normalization redistributes the excess from the other bones proportionally. This means painting a region with bone A may silently reduce bone B's influence there — which is usually correct but can be surprising when two bones share a tight blend zone.

**"Auto-weights are good enough."**
For simple rigs (a rigid prop attached to one bone), yes. For organic characters with complex joint interactions (shoulder, hip, spine), no. The 1/d² approach draws straight lines through space and will assign spine influence to vertices on the skin of the chest because the spine joint is geometrically close. Heat diffusion (surface-following) produces better initial weights, but even that requires artist correction at complex joints.

**"Smooth brush always helps."**
Smooth averages weights with vertex neighbors. In a well-defined blend zone, it helps. But if neighboring vertices have incorrect weights (they're in the wrong bone's territory), smooth propagates the error outward instead of fixing it. Always paint the broad regions correct before smoothing.

**"4 influences is always enough."**
For the wrist, shoulder, and spine, vertices may legitimately need influence from 3+ bones. The 4-influence cap handles this. But at multi-joint intersections (shoulder with clavicle, upper arm, and scapula bones all nearby), the 5th influence can matter. The truncation/renormalization introduces a small positional error that compounds with extreme poses.

---

## Common Confusions

**"I painted a region red (weight=1) but it still has some wobble from another bone."**
Normalization means setting one bone to 1.0 forces all others to 0.0. If you painted with Replace mode at strength 0.5, the result is `lerp(old, 1.0, 0.5)` — not 1.0 but 0.5 + (old/2). Paint at full strength to get exactly 1.0, or use direct value entry.

**"The auto-bind puts the fingers on the wrist bone."**
`1/d²` is straight-line distance. If the knuckle joint is far from the fingertip vertices (long fingers), the wrist joint may be geometrically closer to the fingertip than any finger joint. Fix: adjust the skeleton proportions before binding, or paint the fingertip weights manually.

**"I normalized but the mesh still scales oddly."**
Check for vertices with zero total weight (no bone in range at bind time). These are uninfluenced — they stay at their bind pose position regardless of the skeleton. The normalization fallback should assign them to the nearest bone, but if that logic is missing, they remain frozen. Identify by filtering for vertices where the sum of all weights is 0.

**"Weight painting in edit mesh mode shows different deformation than in skeleton mode."**
The weight visualization is only as correct as the current pose. If the skeleton is in bind pose (T-pose), all skin matrices are identity and the mesh looks undeformed regardless of weights. Move the skeleton to a pose with actual joint angles to see weight quality.

---

## How Salsa Uses It

**`src/services/managers/scene3d-manager.ts`** — `bindMeshToSkeleton3D`: auto-assigns weights using `1/d²` from each vertex to the 4 nearest joints. Normalizes per vertex. Upgrades the `Mesh3D` to `SkinnedMesh3D` in place and calls `computeInverseBindMatrices()` immediately after.

**`src/services/managers/scene3d-manager.ts`** — `enterWeightPaintMode3D(meshId, jointIndex)`: activates weight paint UI for the given joint. Sets `activeWeightJoint` on the scene state, triggering the renderer to switch to heatmap visualization. Subsequent `paintWeightDab3D` calls affect only this joint's weights.

**`src/services/managers/scene3d-manager.ts`** — `paintWeightDab3D(meshId, worldPos, radius, strength, mode)`: iterates vertices within `radius` of `worldPos`, applies the selected brush mode (replace/add/subtract/smooth), then calls `normalizeWeights3D` on the affected vertices. Marks `weightsDirty = true` to trigger GPU buffer re-upload.

**`src/services/managers/scene3d-manager.ts`** — `normalizeWeights3D(mesh, vertexIndices)`: for each vertex in the list, sums all four weights; if > 0, divides each weight by the sum. Handles zero-weight vertices by assigning weight 1.0 to the joint with index 0 (nearest by convention).

**`src/renderer/3d/renderer-3d.ts`** — when `mesh.weightsDirty` is true, re-uploads the joint index and weight arrays to the GPU vertex buffer. The vertex buffer layout allocates 4 bytes for joint indices (`vec4u8`) and 4 floats for weights immediately after the standard vertex attributes.

**`src/renderer/3d/shaders/skinning-shaders.ts`** — weight heatmap visualization is a separate fragment shader variant. It reads the active joint's weight for the current fragment (interpolated from vertices) and outputs a blue→green→red color ramp. Active during weight paint mode; the standard fragment shader runs during normal display.

---

## Related Concepts

- [Skeletal Animation](skeletal-animation.md) — skinning is the consumer of weight data; skin matrices combine with weights in the vertex shader
- [Inverse Kinematics](inverse-kinematics.md) — IK produces joint poses; skinning with weights converts those poses to mesh deformation
- [Scene Graphs](scene-graphs.md) — joint world matrices are accumulated via the scene graph; all of that flows through skin matrices into the weighted vertex blend
- [GPU Pipelines](gpu-pipelines.md) — weight data lives in the vertex buffer; the skinned mesh pipeline uses a different vertex layout and shader from the static mesh pipeline
