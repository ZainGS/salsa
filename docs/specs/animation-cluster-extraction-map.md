# Scene3D Animation Cluster — Extraction Map (audit C4)
**Date:** 2026-09-12 · **Status:** Slice A ✅ (scene3d-animation.ts, 3 tests, BOTH latent NLA bugs fixed w/ round-trip coverage; manager keeps delegators; sweep reads _animation.nlaBindPoses) · D ✅ (same subsystem: getSkeletonIdForMesh + installDefaultAnimations + serializeSkeletonForSave/_eqNoId + pose export/body export + full pose library incl. adaptive-pose blend; 6 host hooks; +3 tests) · B ✅ (FLA CRUD + both maps moved w/ public map getters; cloth/ribbons/armature/keyframe-apply readers rewired; ribbon-scroll via 2 host hooks; harness-smoked spin+bob+remove) · C ✅ (idle/breaks/squash/leg engine moved; cohort live-loop sync STAYS on the manager via the setIdleLiveHold hook; ghost preview reuses public applyIdle + exported IDLE_JOINTS; harness-verified: chest breathes, squash writes scale, off restores base EXACTLY) — **C4 COMPLETE 2026-09-12**
**Precedent:** `armature-tangle-extraction-map.md` (recon-then-slices worked; do not move code without this map).

The audit's C4 ("largest remaining non-facade block") is NOT one cohesive region — it is four sub-clusters
with very different coupling profiles. Line refs are post-C8/kitbash (manager ≈ 8.4k lines).

## Slice A — NLA + animation players + skeleton-clip playback  ✅ safest, first
`scene3d-manager.ts` ~7002–7204 (~200 ln). State: `_animPlayer`, `_nlaTracks`, `_nlaPlayers`,
`_nlaBindPoses`. → `scene3d-animation.ts` (`Scene3DAnimation`).
- Host needs: `getSkeleton`, `keepSpringsAlive(skelId)` (private `_keepSpringsAlive`), and
  `applyAllKeyframesAtFrame(frame)` (stays on manager — keyframe cluster + camera seam).
- Outside touches: `play3D/pause3D/stop3D` (~1237) use `_animPlayer` → delegators; the
  deleteFullCharacter per-body state sweep caps `_nlaBindPoses` (~5522) → expose a getter (the
  `Scene3DKitbash.spawnSpins` pattern).
- 🐛 **Latent bugs found during recon (fix WITH this slice — the code is in hand):**
  1. `restoreSkeletonState` = `Skeleton3D.fromJSON` + addChild — never re-seeds `_nlaTracks`, so
     after a reload the NLA UI sees zero tracks even when data existed.
  2. Worse: `Skeleton3D.toJSON` serializes `skeletonData` field-by-field and **drops `nlaTracks`
     entirely** — the "persist the track on the skeleton data so it survives save/load" comment in
     `createNLATrack3D` has never been true.
  Fix: serialize `nlaTracks` + `nlaBindPose` in `Skeleton3D.toJSON`/`fromJSON`; the subsystem
  lazily seeds its maps from `skeleton.data` on first NLA access per skeleton (lazy = no
  restore-ordering coupling).

## Slice B — Frame Link Animation (FLA) CRUD  ⚠ shared-state heavy
CRUD ~6815–6878 (~65 ln). State `_frameLinkAnims3D` + `_flaRestTransforms` is read by FOUR parties:
- the per-mesh keyframe application (~6783–6810, `evalFrameLink3D` delta on top of keyframes — this
  STAYS with the keyframe cluster),
- the cloth + ribbons constructor host closures (`getFrameLinkAnim`),
- the armature host (`flaRestTransforms` — clears rest entries when a gizmo moves a mesh).
Moving the maps means updating 3 constructor closures + the armature host field + a read accessor for
the keyframe site. Verdict: extract CRUD only if Slice A goes clean; the maps can live in the
subsystem with getters. Modest cohesion win — do not force it.

## Slice C — Procedural idle / idle-breaks / squash-stretch / leg-idle  ✅ DONE 2026-09-12 (tick-order preserved: idle→squash→foot-IK×2→springs keep-alive all inside the moved callback; live-verified in the harness — user in-app pass still recommended)
~717–1097 (~380 ln) + `_idleRigs/_idleBreaks/_squashStretch/_legIdleModes`.
- The `_idleSolveCallback` pre-render tick composes idle solve → (IK/constraints/springs happen in
  the armature/character sync) — ORDER IS LOAD-BEARING (memory: idle runs BEFORE spring solve; the
  disableOrbitControls-stripped-the-callback bug lives here).
- All four maps are captured by the deleteFullCharacter state sweep (~5517).
- `_syncCharacterSkeletons` (~662) is character/armature territory, NOT this slice.
Verdict: own dedicated pass with in-app verification of idle/breaks/squash on a live character.

## Slice D — Default animations + Pose Library  ✅ DONE 2026-09-12 (was clean as predicted)
~7581–7826 (~245 ln); pure content lives in `default-animations.ts` already; manager holds
`installDefaultAnimations` + pose CRUD. Couplings: skeleton clips + `_character`? (verify at
execution). Good second slice.

## Explicitly NOT in C4
Camera keyframes (~6922) — armature/camera seam. Keyframe track CRUD — already `Scene3DKeyframes`.
`_syncCharacterSkeletons` — character subsystem. Ghost idle (~4127) — preview machinery.
