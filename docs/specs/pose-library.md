# Pose Library — Implementation Spec

**Status:** Ready to implement  
**Last Updated:** 2026-06-07  
**Prerequisite:** FK Rotation (done), Skeleton3D serialization (done)

---

## What it is

A named snapshot of an entire skeleton's FK rotation state. Animators capture poses (T-pose, A-pose, idle, etc.) and recall them without manually re-entering joint rotations. Poses survive project save/load.

---

## Current state

- `Skeleton3D.data` has no `poses` field
- No pose methods exist on `ShapeManager` or `Scene3DManager`
- Everything else needed is already in place: `setJointRotation3D`, `updateWorldMatrices`, `toJSON`/`fromJSON`

---

## Data model

### `src/types/armature-3d.ts` — add to `SkeletonData`

```typescript
export interface SkeletonPose {
    id: string;                                               // nanoid
    name: string;
    rotations: { jointIndex: number; rotation: [number, number, number, number] }[];
}

export interface SkeletonData {
    // ...existing fields...
    poses?: SkeletonPose[];
}
```

---

## `Skeleton3D` changes

**File:** `src/scene-graph/shapes/skeleton-3d.ts`

### `toJSON`

Add to the returned object:

```typescript
poses: (this.data.poses ?? []).map(p => ({ ...p })),
```

### `fromJSON` / `fromData`

After loading joints/clips/ikChains, restore poses:

```typescript
if (raw.poses) {
    this.data.poses = raw.poses.map((p: any) => ({
        id: p.id,
        name: p.name,
        rotations: p.rotations,
    }));
}
```

---

## `Scene3DManager` — new methods

**File:** `src/services/managers/scene3d-manager.ts`

Add alongside the existing IK chain methods:

```typescript
capturePose(skelId: string, name: string): string {
    const skel = this.getSkeleton(skelId);
    if (!skel) throw new Error(`Skeleton not found: ${skelId}`);
    if (!skel.data.poses) skel.data.poses = [];
    const id = nanoid();
    const rotations = skel.data.joints.map((j, i) => ({
        jointIndex: i,
        rotation: [...j.localRotation] as [number, number, number, number],
    }));
    skel.data.poses.push({ id, name, rotations });
    this.ctx.scheduleRender();
    return id;
}

applyPose(skelId: string, poseId: string): void {
    const skel = this.getSkeleton(skelId);
    const pose = skel?.data.poses?.find(p => p.id === poseId);
    if (!skel || !pose) return;
    for (const entry of pose.rotations) {
        const joint = skel.data.joints[entry.jointIndex];
        if (joint) joint.localRotation = [...entry.rotation] as [number, number, number, number];
    }
    skel.updateWorldMatrices();
    skel.matricesDirty = true;
    this.ctx.sceneGraphChanged();
    this.ctx.scheduleRender();
}

getPoses(skelId: string): { id: string; name: string }[] {
    const skel = this.getSkeleton(skelId);
    return (skel?.data.poses ?? []).map(p => ({ id: p.id, name: p.name }));
}

renamePose(skelId: string, poseId: string, name: string): void {
    const pose = this.getSkeleton(skelId)?.data.poses?.find(p => p.id === poseId);
    if (pose) { pose.name = name; this.ctx.sceneGraphChanged(); }
}

deletePose(skelId: string, poseId: string): void {
    const skel = this.getSkeleton(skelId);
    if (!skel?.data.poses) return;
    skel.data.poses = skel.data.poses.filter(p => p.id !== poseId);
    this.ctx.sceneGraphChanged();
}
```

---

## `ShapeManager` surface

**File:** `src/services/shape-manager.ts`

Add to the armature section (near `setJointRotation3D`):

```typescript
/** Snapshot the skeleton's current FK rotations as a named pose. Returns the new pose ID. */
public capturePose3D(skelId: string, name: string): string {
    return this.scene3d.capturePose(skelId, name);
}

/** Apply a saved pose — sets all joint localRotations and fires sceneGraphChanged. */
public applyPose3D(skelId: string, poseId: string): void {
    this.scene3d.applyPose(skelId, poseId);
}

/** List all saved poses on the skeleton. */
public getPoses3D(skelId: string): { id: string; name: string }[] {
    return this.scene3d.getPoses(skelId);
}

public renamePose3D(skelId: string, poseId: string, name: string): void {
    this.scene3d.renamePose(skelId, poseId, name);
}

public deletePose3D(skelId: string, poseId: string): void {
    this.scene3d.deletePose(skelId, poseId);
}
```

---

## Frogmarks panel UX

Collapsible **Pose Library** section in the Armature panel, below Animation Clips:

```
── Pose Library ──────────────────────
  Name [_______________]  [+ Capture]

  T-Pose      [Apply] [Rename] [🗑]
  A-Pose      [Apply] [Rename] [🗑]
  Idle Ref    [Apply] [Rename] [🗑]
```

### API calls

```typescript
// Capture button:
const name = nameInput.value.trim() || `Pose ${getPoses3D(skelId).length + 1}`;
const poseId = sm.capturePose3D(skelId, name);

// Apply:
sm.applyPose3D(skelId, poseId);

// Rename (inline edit — confirm on Enter/blur):
sm.renamePose3D(skelId, poseId, newName);

// Delete:
sm.deletePose3D(skelId, poseId);

// Refresh list on sceneGraphChanged:
const poses = sm.getPoses3D(skelId);
```

Refresh the pose list on every `sceneGraphChanged` event (same pattern as the joint list).

---

## Implementation order

1. `src/types/armature-3d.ts` — add `SkeletonPose`, add `poses?` to `SkeletonData`
2. `src/scene-graph/shapes/skeleton-3d.ts` — serialize/deserialize `poses` in `toJSON`/`fromJSON`
3. `src/services/managers/scene3d-manager.ts` — add 5 methods
4. `src/services/shape-manager.ts` — expose 5 public methods
5. Frogmarks — add Pose Library panel section

Total estimated scope: ~80 lines of code across 4 files. No GPU changes, no new files.
