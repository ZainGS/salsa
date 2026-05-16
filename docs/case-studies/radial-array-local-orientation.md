# Case Study: Radial Array — World-Only Axis to Local/World Orientation

**Date:** 2026-05-15  
**Files changed:** `src/scene-graph/shapes/array-group-3d.ts`, `src/renderer/3d/gizmo-renderer.ts`, `src/renderer/3d/renderer-3d.ts`, `src/services/managers/scene3d-manager.ts`, `src/services/managers/transform-controller-3d.ts`  
**Change size:** ~130 lines added, ~30 lines modified (net +100)  
**What changed:** Radial array instances and gizmo arc now orbit the source mesh's local axis when the transform gizmo is in local orientation mode, rather than always orbiting a fixed world axis.

---

## Background

The radial array mode places N instances evenly around a center point on a circle. The circle's plane is defined by its normal — which axis it is perpendicular to. Before this change, the normal was always a world axis:

- `axis = 'y'` → ring in world XZ plane (floor ring)
- `axis = 'x'` → ring in world YZ plane
- `axis = 'z'` → ring in world XY plane

This worked correctly when the source mesh was axis-aligned. The problem appeared when the source was rotated: the ring "detached" from the mesh's orientation and stayed in a world-aligned plane regardless of how the source was tilted. For a column mesh rotated 45° from vertical, the user expected `axis = 'y'` to orbit the column's own axis — but it orbited the world Y axis instead, scattering instances in a pattern completely unrelated to the column's geometry.

The transform gizmo already supported a world/local toggle (`getGizmoOrientation` / `setGizmoOrientation`), and users already used it to align Move/Rotate/Scale handles with the source's local frame. The natural extension was: when the gizmo is in local mode, the radial ring should follow the same convention.

---

## Old Architecture: Hardcoded World Axes

### `computeArrayOffsets` — radial branch

```typescript
// array-group-3d.ts (before):
} else if (params.mode === 'radial') {
    const { count, radius, axis, arcDeg, center } = params;
    const angleStep = count > 0 ? arcDeg / count : 0;
    for (let i = 0; i < count; i++) {
        const rad = i * angleStep * Math.PI / 180;
        let rx = 0, ry = 0, rz = 0;
        if (axis === 'y') { rx = radius * Math.sin(rad); rz = radius * Math.cos(rad); }
        else if (axis === 'x') { ry = radius * Math.sin(rad); rz = radius * Math.cos(rad); }
        else { rx = radius * Math.cos(rad); ry = radius * Math.sin(rad); }
        offsets.push([center[0] + rx - sourcePos[0], ...]);
    }
}
```

The per-axis branches hardcoded which world-space components to fill. `axis === 'y'` always used the XZ world plane, regardless of how the source was oriented. There was no parameter to change this.

### `drawArrayGizmo` — radial arc

```typescript
// gizmo-renderer.ts (before):
const radialPt = (angleDeg: number): [number, number, number] => {
    const rad = angleDeg * Math.PI / 180;
    if (radialAxis === 'y') return [
        radialCenter[0] + currentRadius * Math.sin(rad),
        radialCenter[1],
        radialCenter[2] + currentRadius * Math.cos(rad),
    ];
    // ... x and z cases
};
```

Same world-axis assumption, duplicated in the gizmo renderer. The ring drawn on screen was always in a world-aligned plane, even if the user had switched the gizmo to local mode.

### `_applyArrayRadiusDrag` — drag plane

When the user dragged the radius handle, the drag-plane normal was derived from the `radialAxis` string:

```typescript
// transform-controller-3d.ts (before):
const axisNormal =
    radialAxis === 'y' ? vec3.fromValues(0, 1, 0) :
    radialAxis === 'x' ? vec3.fromValues(1, 0, 0) :
                         vec3.fromValues(0, 0, 1);
```

This hardcoded world normal was used to project the mouse ray onto the ring plane for radius calculation. In local mode, the ring plane would have been tilted, but the drag projection would use the world plane — meaning dragging the radius handle would produce incorrect values for rotated meshes.

### What the user saw

```
Source mesh: cube rotated 45° around world Z

World mode radial (Y axis):          Local mode request (should be):
                                      
         ●───●                                ╲●─╱
        ╱     ╲                              ╲ ╱
      ●    ■    ●     (■ = source)         ●─■─●  (ring tilted with mesh)
        ╲     ╱                              ╱ ╲
         ●───●                              ╱●─╲

Ring in world XZ plane —             Ring perpendicular to source's
ignores mesh rotation.                local Y axis — tilted 45°.
```

---

## New Architecture: `LocalBasis3` Threaded Through the Pipeline

### New type: `LocalBasis3`

```typescript
// array-group-3d.ts (new):
export interface LocalBasis3 {
    x: [number, number, number]; // source local +X in world space
    y: [number, number, number]; // source local +Y in world space
    z: [number, number, number]; // source local +Z in world space
}
```

Each field is one column of the source's `localMatrix` (floats `[0..2]`, `[4..6]`, `[8..10]`), normalized to remove scale. This is the same basis the Move/Rotate/Scale gizmo already uses in local mode.

### `computeArrayOffsets` — optional `localBasis` parameter

The key insight is that world and local modes share the same math — they differ only in which two basis vectors span the ring plane. In world mode those vectors are fixed world axes; in local mode they come from `LocalBasis3`.

```typescript
// array-group-3d.ts (new radial branch):
let t: [number, number, number];   // primary (sin) basis vector
let bt: [number, number, number];  // secondary (cos) basis vector

if (localBasis) {
    if (axis === 'y')      { t = localBasis.x; bt = localBasis.z; }
    else if (axis === 'x') { t = localBasis.y; bt = localBasis.z; }
    else                   { t = localBasis.x; bt = localBasis.y; }
} else {
    if (axis === 'y')      { t = [1, 0, 0]; bt = [0, 0, 1]; }
    else if (axis === 'x') { t = [0, 1, 0]; bt = [0, 0, 1]; }
    else                   { t = [1, 0, 0]; bt = [0, 1, 0]; }
}

for (let i = 0; i < count; i++) {
    const rad = i * angleStep * Math.PI / 180;
    const s = Math.sin(rad), c = Math.cos(rad);
    // z-axis ring uses cos/sin ordering; x/y use sin/cos.
    const [pa, pb] = axis === 'z' ? [c, s] : [s, c];
    const rx = radius * (pa * t[0] + pb * bt[0]);
    const ry = radius * (pa * t[1] + pb * bt[1]);
    const rz = radius * (pa * t[2] + pb * bt[2]);
    offsets.push([center[0] + rx - sourcePos[0], ...]);
}
```

When `localBasis` is absent, `t` and `bt` reduce to the same fixed world vectors the old code had — so world mode output is identical to before. When present, the ring is spanned by the source's own axes.

The signature of the world-mode fallback can be verified mechanically:
- `axis === 'y'`, world, `t=[1,0,0]`, `bt=[0,0,1]`, `pa=sin`, `pb=cos`:
  - `rx = sin`, `ry = 0`, `rz = cos` — matches original `rx = sin(rad); rz = cos(rad)` ✓
- `axis === 'z'`, world, `t=[1,0,0]`, `bt=[0,1,0]`, `pa=cos`, `pb=sin`:
  - `rx = cos`, `ry = sin`, `rz = 0` — matches original ✓

### `ArrayGizmoData` — three new fields

```typescript
// gizmo-renderer.ts (new fields on ArrayGizmoData):
radialTangent?: [number, number, number];
radialBitangent?: [number, number, number];
radialNormal?: [number, number, number];  // ring plane normal for drag projection
```

These are set from `LocalBasis3` in the sync callback when in local mode. When absent, world-axis fallback paths in `drawArrayGizmo` and `_applyArrayRadiusDrag` are used.

### `drawArrayGizmo` — local-aware arc

```typescript
// gizmo-renderer.ts (new radialPt):
const radialPt = (angleDeg: number): [number, number, number] => {
    const rad = angleDeg * Math.PI / 180;
    const s = Math.sin(rad), c = Math.cos(rad);
    if (radialTangent && radialBitangent) {
        // Local mode: ring spans source's own axes.
        const [pa, pb] = radialAxis === 'z' ? [c, s] : [s, c];
        return [
            radialCenter[0] + currentRadius * (pa * radialTangent[0] + pb * radialBitangent[0]),
            radialCenter[1] + currentRadius * (pa * radialTangent[1] + pb * radialBitangent[1]),
            radialCenter[2] + currentRadius * (pa * radialTangent[2] + pb * radialBitangent[2]),
        ];
    }
    // World mode fallback (original code):
    if (radialAxis === 'y') return [radialCenter[0] + currentRadius * s, radialCenter[1], radialCenter[2] + currentRadius * c];
    ...
};
```

The arc drawn on screen now tilts with the mesh in local mode — the visual matches the GPU instances.

### `renderer-3d.ts` — `setArrayGroups(groups, localBases?)`

The renderer receives the bases map and forwards it to `computeArrayOffsets` during instance buffer upload:

```typescript
// renderer-3d.ts:
private _arrayGroupLocalBases = new Map<string, LocalBasis3>();

setArrayGroups(groups: ArrayGroup3D[], localBases?: Map<string, LocalBasis3>): void {
    this._arrayGroups = groups;
    this._arrayGroupLocalBases = localBases ?? new Map();
    this._instancesDirty = true;
}

// Inside uploadMeshInstances:
const offsets = computeArrayOffsets(
    group.arrayParams,
    [source.x, source.y, source.z],
    this._arrayGroupLocalBases.get(group.id),  // undefined → world mode
);
```

### `_ensureArrayGroupSync` — basis extraction

The sync callback that feeds `setArrayGroups` each frame now also builds the bases map when the orientation mode is local:

```typescript
// scene3d-manager.ts (inside _ensureArrayGroupSync callback):
let localBases: Map<string, LocalBasis3> | undefined;
if (this._transformController?.orientationMode === 'local') {
    for (const group of groups) {
        if (group.arrayParams.mode !== 'radial') continue;
        const source = this.getMesh(group.sourceId);
        if (!source) continue;
        const m = source.localMatrix as Float32Array;
        const c0 = Math.hypot(m[0], m[1], m[2]) || 1;
        const c1 = Math.hypot(m[4], m[5], m[6]) || 1;
        const c2 = Math.hypot(m[8], m[9], m[10]) || 1;
        if (!localBases) localBases = new Map();
        localBases.set(group.id, {
            x: [m[0]/c0, m[1]/c0, m[2]/c0],
            y: [m[4]/c1, m[5]/c1, m[6]/c1],
            z: [m[8]/c2, m[9]/c2, m[10]/c2],
        });
    }
}
this.renderer3D.setArrayGroups(groups, localBases);
```

`localMatrix` columns are normalized (divide by column magnitude) to remove scale — otherwise a scaled mesh would have a non-unit normal and the ring would orbit an off-center ellipse instead of a circle.

Only radial groups get a basis entry — linear and grid arrays do not use local bases (their spacing vectors are already in world space and already respect the user's intent directly).

### `_applyArrayRadiusDrag` — local drag plane

The drag state now carries `radialNormal` populated from `ArrayGizmoData.radialNormal`:

```typescript
// transform-controller-3d.ts — _arrayDrag state:
radialNormal?: [number, number, number];

// _applyArrayRadiusDrag (new):
const axisNormal: vec3 = radialNormal
    ? vec3.fromValues(...radialNormal)
    : (radialAxis === 'y' ? vec3.fromValues(0, 1, 0) :
       radialAxis === 'x' ? vec3.fromValues(1, 0, 0) :
                            vec3.fromValues(0, 0, 1));
```

`radialNormal` comes directly from the `LocalBasis3` column that corresponds to the chosen axis (e.g. for `axis === 'y'` in local mode, `radialNormal = localBasis.y`). The drag projection now intersects the mouse ray against the tilted ring plane, so the radius value computed during drag matches the distance between the actual ring center and the dragged handle.

### `pickAdditional` — consistent picking in local mode

The ray–AABB instance picker also uses local bases when in local mode so that the clickable volumes match the rendered instance positions:

```typescript
// scene3d-manager.ts pickAdditional:
const basis = (() => {
    if (node.arrayParams.mode !== 'radial' || this._transformController?.orientationMode !== 'local') return undefined;
    // extract normalized LocalBasis3 from source.localMatrix
})();
const offsets = computeArrayOffsets(node.arrayParams, [source.x, source.y, source.z], basis);
```

---

## Data Flow Before and After

```
BEFORE (world only):

  Frame start
    _ensureArrayGroupSync callback:
      setArrayGroups(groups)                [no basis map]

  uploadMeshInstances:
    computeArrayOffsets(params, srcPos)     [world-axis hardcoded]

  drawArrayGizmo:
    radialPt(angleDeg) → world-axis formula [ring always world-aligned]

  _applyArrayRadiusDrag:
    axisNormal derived from radialAxis str   [world normal always]

AFTER (world + local):

  Frame start
    _ensureArrayGroupSync callback:
      if orientationMode === 'local':
        extract LocalBasis3 from source.localMatrix  [3 hypot + 9 divides per radial group]
      setArrayGroups(groups, localBases?)    [map passed; undefined in world mode]

  uploadMeshInstances:
    computeArrayOffsets(params, srcPos, basis?)  [basis rotates t/bt when present]

  drawArrayGizmo:
    radialPt: checks radialTangent/radialBitangent   [tilted arc when present]
    fallback: same world-axis formula                 [unchanged world path]

  _applyArrayRadiusDrag:
    axisNormal = radialNormal ?? world-from-string   [local normal when present]
```

---

## Correctness Notes

### Normal matrix unaffected

Instance normal matrices are copied verbatim from the source (translation doesn't affect the inverse-transpose of R×S). Local orientation changes where instances are positioned, not their orientation. All instances face the same direction as the source — correct for an array of columns around a center point.

### `arrayParams.axis` unchanged

`axis` still stores `'x' | 'y' | 'z'` — there is no new field on `ArrayParams`. Which axis it refers to (world or local) is determined at runtime by the gizmo orientation mode. This keeps serialization stable: the same `.frogmarks` file loads correctly in both modes and the meaning follows whichever mode the user has active when they open it.

### Linear and grid arrays

`localBasis` is only computed and passed for groups whose `arrayParams.mode === 'radial'`. Linear and grid spacing vectors are already expressed in world space as explicit `[x, y, z]` tuples — the user already chose their direction via the axis buttons or gizmo drag. There is no ambiguity to resolve.

### No-rotation case

When the source mesh is unrotated, `localMatrix` columns are the identity columns — `localBasis.x = [1,0,0]`, etc. `computeArrayOffsets` with this basis produces the same output as without it. World and local modes are exactly identical for unrotated sources.

---

## Files Changed

| File | Change |
|---|---|
| [src/scene-graph/shapes/array-group-3d.ts](../../src/scene-graph/shapes/array-group-3d.ts) | Added `LocalBasis3` type; added optional `localBasis?` param to `computeArrayOffsets`; replaced per-axis if/else branches with `t`/`bt` basis vector decomposition |
| [src/renderer/3d/gizmo-renderer.ts](../../src/renderer/3d/gizmo-renderer.ts) | Added `radialTangent?`, `radialBitangent?`, `radialNormal?` to `ArrayGizmoData`; updated `drawArrayGizmo` radial arc to use tangent/bitangent when present |
| [src/renderer/3d/renderer-3d.ts](../../src/renderer/3d/renderer-3d.ts) | Added `_arrayGroupLocalBases: Map<string, LocalBasis3>`; updated `setArrayGroups` signature; forwarded basis per group to `computeArrayOffsets` |
| [src/services/managers/scene3d-manager.ts](../../src/services/managers/scene3d-manager.ts) | `_ensureArrayGroupSync`: builds and passes `localBases` map when `orientationMode === 'local'`; radial gizmo data section computes `radialTangent/Bitangent/Normal`; `pickAdditional` uses local basis for instance AABB offsets |
| [src/services/managers/transform-controller-3d.ts](../../src/services/managers/transform-controller-3d.ts) | Added `radialNormal?` to `_arrayDrag` state; `_applyArrayRadiusDrag` uses `radialNormal` over world-axis fallback |
