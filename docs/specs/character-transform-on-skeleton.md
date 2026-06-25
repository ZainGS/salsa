# Character Transform on the Skeleton — Working Log (Option B)

**Started:** 2026-06-22 · **Status:** 🟢 implemented, type-checks (pending live test)
**Goal:** a procedural character's **object transform** (move/rotate/scale the whole dressed character) lives on the **skeleton**, so the gizmo moves the skeleton's node transform and **both the skinned meshes AND the bones follow** — no offset, clean export semantics.

> This is the "do it properly" alternative to the earlier mesh-only move (which left the skeleton/bones behind). See [[project_character_rig_selection]] memory.

---

## Why the naive approaches fail (context for reverting)

- The 3D renderer uses each mesh's **own `localMatrix`** as its model matrix (NOT scene-graph world / parent transforms — verified in `renderer-3d.ts` `_uploadSkinnedInstances` + `drawMeshes`). So a scene-graph group transform does NOT reach the meshes.
- The selection box / gizmo are positioned from each mesh's `localMatrix` + **rest geometry** (not skinning). So:
  - Move the **meshes' localMatrix** → box follows, but skeleton/bones stay → bones offset.
  - Move the **skeleton** → meshes' visual follows, but box uses rest `localMatrix` → box snaps to origin.
- Fix = the character transform lives on the **skeleton node**, the meshes render with **identity** model matrix (skeleton provides the transform), and the gizmo's handle stays on the meshes' `localMatrix` (so the box keeps working) but is **synced onto the skeleton** each frame.

---

## Design

1. **`computeWorldMatrices` applies the skeleton NODE transform.** Root joint world = `skeletonNode.localMatrix · rootJointLocal` (instead of just `rootJointLocal`). Children inherit → all joints + skinning + bones pick up the node transform. Identity node transform (all existing skeletons) → **no change**.
2. **Character skinned meshes render with IDENTITY model matrix** (a flag `transformViaSkeleton`). The skeleton node provides the object transform, so applying the mesh `localMatrix` too would **double**. Flag set on the body + eye decal + hair + every garment.
3. **Per-frame sync: `skeleton.objectTransform` ← body mesh `localMatrix`.** The gizmo still moves the body mesh's `localMatrix` (so the **box + undo keep working unchanged**); a pre-render sync copies the body mesh's `localMatrix` **matrix directly** onto `skeleton.objectTransform` (no Euler decompose) and re-runs `computeWorldMatrices`. So the skeleton (and bones) follow the gizmo. Undo restores the mesh transform → sync reverts the skeleton. `objectTransform` is derived from the (persisted) body mesh transform, so it needs no separate persistence.

> **Refinement (Step 1):** `Skeleton3D` has no `localMatrix` (only `Mesh3D` does), so the object transform is a **dedicated `Skeleton3D.objectTransform` mat4** (identity default), applied to the root in both `computeWorldMatrices` and the constraint solver. Synced by a direct **matrix copy** from the body mesh's `localMatrix`.
4. The existing **multi-select character expansion + gizmo + box** are unchanged — they operate on the meshes' `localMatrix` (the handle).

Net: gizmo moves the meshes' `localMatrix` (handle) → box follows; sync mirrors it onto the skeleton → skinning + bones follow; meshes render identity → no double. Move + rotate + scale + undo all work, bones aligned.

---

## Steps + status

| # | Step | Files | Status | Revert note |
|---|------|-------|--------|-------------|
| 1 | Add `Skeleton3D.objectTransform` (mat4); `computeWorldMatrices` + constraint-solver `recomputeWorldMatrix` apply it to the root joint | `skeleton-3d.ts`, `constraint-solver.ts` | ✅ | Remove `objectTransform` + the `mul` on the root — reverts to `worldMatrix = local`. Safe: identity default = current behavior. |
| 2 | Add `transformViaSkeleton` flag to `Mesh3D`; renderer (`_uploadSkinnedInstances`) uses identity model+normal matrix when set | `mesh-3d.ts`, `renderer-3d.ts` | ✅ | Flag defaults false → no mesh affected unless set. |
| 3 | Per-frame sync callback (registered in the `Scene3DManager` constructor): copy each procedural body's `localMatrix` → `skeleton.objectTransform` + `computeWorldMatrices` (only when the body's `localMatrixVersion` changed) | `scene3d-manager.ts` | ✅ | Remove the constructor `addPreRenderCallback` + `_syncCharacterSkeletons`. |
| 4 | Set `transformViaSkeleton=true` on character meshes (body + decal + hair + clothing) at creation | `scene3d-manager.ts` | ✅ | Clear the 4 flag sets. |
| 5 | **Persist** `isProceduralBody` + `transformViaSkeleton` on `SkinnedMesh3D` (`toJSON`) + restore in `restoreMeshState`, so a MOVED character reloads correctly (the body is saved as a node; parts rebuild from rigs with the flags) | `skinned-mesh-3d.ts`, `scene3d-manager.ts` | ✅ | Remove from `toJSON` + the two restore lines. |

---

## Verify (live)
- Generate body → dress → **move/rotate the character** with the gizmo: meshes **and** the gizmo box follow; open the Armature panel → **bones are aligned** with the moved character (not at the origin). Undo reverts the move (skeleton + meshes). **Save → reload** a moved character → it comes back at the moved position with parts attached.
- Regression check: an **un-moved** character (objectTransform identity) renders identically to before; **non-character** skinned meshes (kitbash parts) are unaffected (flag false).

---

## Risks
- **`computeWorldMatrices` is also duplicated in the constraint solver** — both must apply the node matrix, or constraints (elbow/knee limits) would drop the character transform. Step 1 covers both.
- **Decompose-free sync** relies on the skeleton node + body mesh both being `Node`s with the same Euler transform — copy components directly, no matrix→Euler.
- **Box uses rest geometry** still (posed character → box slightly off, same as picking). Acceptable.
- **Export/GLB**: with the transform on the skeleton node, exporters must include it — verify before relying on baked exports (not in scope for this change).
