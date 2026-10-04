# Character skin deformation — plan (audit 2026-09-28 C1)

**Status:** 🟢 **Phases 1–3 BUILT 2026-09-28** (1618 tests) — seam blend, garments keep 4 influences, dual-quaternion
skinning. **Phase 4 (browser verify + tune) pending — the WGSL has not been compiled yet (browser-only).**

**Phase 3 built:** `src/renderer/3d/dual-quat-skin.ts` — `packDualQuatSkin` (CPU: skin matrix → rotation quat + dual
quat + uniform scale, marker `m[3][3] = 2`; returns null → linear fallback on non-uniform scale/shear),
`skinMatrixForTS` (TS mirror of the shader, verified against the independent CPU DQS on the real posed body to 1e-4),
and `SKIN_BLEND_WGSL` — the ONE `skinMatrixFor(joints, weights)` now used by all six skinning sites (skinned mesh ×3,
highlight/outline ×2, shadow ×1; linear when the slot is a plain matrix, so non-DQS skeletons are unchanged).
`Skeleton3D.skinningMethod` ('linear' | 'dualQuat', persisted, absent = linear); `Renderer3D._skinUploadData` packs
the upload per skeleton (reused scratch, freed with the buffer); new procedural bodies are created `'dualQuat'`;
`sm.setSkinningMethod3D(id, m)` / `getSkinningMethod3D(id)` (skeleton id OR any mesh of the character). Tests:
`dual-quat-skin.test.ts` (round trip, linear path unchanged, scale refusal, 0°/90° blend keeps scale 1 vs LBS 0.707,
mirror ≡ CPU DQS on the body), `skin-blend-shaders.test.ts` (no inline blend left anywhere; every binding gets the shared
function; skinningMethod round-trips).

**Phase 4 — what to check in the browser:** (1) nothing is black/missing on ANY skinned mesh (a WGSL error would show
here first); (2) a new character: body, clothes, hair, outline and shadow all move together in Relaxed / A-pose /
walk; (3) `setSkinningMethod3D(bodyId, 'linear')` ↔ `'dualQuat'` — elbows/knees keep volume in dualQuat, slight
outward bulge on sharp bends is expected; (4) an OLD saved character looks exactly as before (linear, seamBlend 0);
(5) scaling a character still skins correctly (uniform scale is supported).

**Built:** `skin-seam-blend.ts` (`seamBlendWeights`) wired into `generateBodyResult`; `BodyParams.seamBlend` (optional,
default 0 = classic, bit-identical — pinned by a snapshot hash); `NEW_BODY_SEAM_BLEND = 0.5` applied in
`createProceduralBody3D`; clothing's body-weight transfer now keeps up to 4 influences via `rankBodyInfluences`
(classic bodies → exactly the old top-2, proven on 5,000 random verts). Tests: `skin-seam-blend.test.ts`
(classic identity, validity, only-seams-change, folds Relaxed armpit 16→≤4, A-pose armpit/elbow → 0),
`clothing-weight-transfer.test.ts`, generator-invariants cases. **Not yet browser-verified.** Written after measuring; every number below comes from the CPU deformation
metric in `src/services/managers/skin-deform-metrics.ts` (run `SKIN_BASELINE_OUT=out.txt npx vitest run
src/services/managers/skin-deform-metrics.test.ts` to reproduce the baseline table).

## 1. The problem

On a spawned procedural character, the **shoulders/armpits look crushed** in the default `Relaxed` pose (arms hanging,
shoulders rotated 77°), and elbows / hips / knees pinch when bent. Clothing copies the body's weights, so sleeves and
trouser legs inherit it.

## 2. How it was measured

`skin-deform-metrics.ts` poses the skeleton on the CPU, skins every vertex exactly like the GPU (linear blend skinning,
up to 4 influences), and compares every triangle posed vs rest:

- **collapsed** — posed area < 50% of rest (the "pinch").
- **stretched** — posed area > 200% of rest.
- **folded** — the triangle's posed normal points *against* where its bone rotated the rest normal: it turned
  inside-out. This is the "crushed" look on screen — and it's invisible to an area-only metric (a flipped triangle can
  keep its area).

Regions are classified by each vertex's dominant joint (armpit = chest/clavicle/shoulder, etc.). Poses: `Relaxed`,
`A-pose`, a 90° elbow bend, a sitting leg (hip −90°, knee +90°).

## 3. What the data says (default body: 2,928 verts, 20 joints)

**Today:** 2,584 of 2,928 vertices (88%) follow ONE bone; the rest follow two. The GPU vertex format and shader
already support **4** influences — the generator only ever fills 2.

| Pose / region | folded | collapsed | worst area ratio |
|---|---|---|---|
| Relaxed / armpit | **16** | 0 | 0.52 |
| Relaxed / elbow | 8 | 0 | 0.52 |
| A-pose / armpit | 12 | 4 | 0.40 |
| A-pose / elbow | 6 | 2 | 0.40 |
| sit / hip + knee | 16 each | 7 each | **0.21** |
| **All poses & regions** | **74** | **24** | **0.21** |

### Experiments (throwaway probes, results kept here)

| Approach | folded | collapsed | worst | Verdict |
|---|---|---|---|---|
| Current weights, linear blend (LBS) | 74 | 24 | 0.21 | baseline |
| **Global weight smoothing** (Laplacian, 4–16 iters) | 76–81 | 47–**106** | 0.03–0.10 | ❌ **worse** — spreads LBS volume loss; wrecks hips/knees |
| Smoothing limited to the shoulder region | 66–70 | 18–22 | 0.10–0.19 | ❌ small fold gain, collapse returns |
| **Dual-quaternion skinning (DQS)**, current weights | 72 | **9** | **0.35** | ✅ volume: collapse −60%; folds unchanged |
| Arm-drop angle sweep 30°→77° | ~6 armpit folds at **every** angle | | | → folds are NOT the pose — they're a **weight seam** |
| **Seam blend 0.5**, LBS | 38 | 25 | 0.16 | ✅ folds −49% |
| **Seam blend 0.5 + DQS** | **38** | **10** | **0.35** | ✅✅ **best** |

The key finding: the always-folding armpit triangles are the **stitch band between the torso's arm socket and the first
arm ring** — socket vertices are bound `chest 0.80 + spine 0.20`, the adjacent deltoid ring (≈1.2 cm away)
`shoulder 0.70 + clavicle 0.30`. **They share no bone**, so the band flips the instant the shoulder turns. Global
smoothing can't fix that cleanly (it smears everything else); fixing the seam itself does.

Per-region with the recommended combination (seam 0.5 + DQS):

| Pose / region | folded (was) | collapsed (was) |
|---|---|---|
| Relaxed / armpit | **4** (16) | 3 (0) |
| Relaxed / elbow | **4** (8) | 1 (0) |
| A-pose / armpit | **0** (12) | 0 (4) |
| A-pose / elbow | **0** (6) | 0 (2) |
| sit / hip + knee | 15 (16) | 3 (7) |

## 4. The plan — two independent, opt-in pieces (old and new coexist for A/B)

Following the same rule as soft lighting / skin ramp: **new systems are switchable, default-off on existing content,
so you can compare and tune each independently.**

### Piece A — Seam blend (weights)
A post-pass in `generateBodyResult`, after the sculpt: for every mesh edge whose two vertices share **no** bone, mix
each endpoint toward the average weights of its across-seam neighbours by `seamBlend` (0..1), keep the top **4**
influences, renormalize. Touches only seam vertices; topology, UVs and the ~600-line sculpt are unchanged.

- New `BodyParams.seamBlend` (0 = today's weights exactly). **New bodies default to 0.5; saved characters have no
  field → 0 → unchanged** until you raise it. It's a body param, so it persists and regenerates deterministically.
- A slider ("Joint smoothness") for tuning.

### Piece B — Dual-quaternion skinning (shader)
A per-**skeleton** skinning method `'linear' | 'dualQuat'` (per skeleton, not per mesh — body, clothes, hair and
charms share one skeleton and **must** deform identically or clothes separate from skin).

- CPU: convert each joint's skin matrix to a dual quaternion (+ a separately-blended scale, see risks) when the
  skeleton uploads its matrices.
- WGSL: ONE shared skinning function (`skinVertex`, LBS or DQS by a uniform flag) replacing the **six** hand-copied
  skinning blocks (skinning ×3, highlight/outline ×2, shadow ×1) — so the body, its outline and its shadow can never
  disagree.
- `Skeleton3D.skinningMethod` persists. **New procedural bodies default to `dualQuat`; existing skeletons stay
  `linear`.** Toggle to compare.

### Piece C — Clothing inherits 4 influences
`clothing-generator` copies the nearest body vertex's weights but keeps only the top **2**
(`clothing-generator.ts:1035-1054`). Keep 4, so garments get the seam blend too. (Hair is 100% head / spring chains —
unaffected.)

## 5. Phases (each gated — stop if the numbers or the look regress)

| Phase | Work | Gate |
|---|---|---|
| **0** | ✅ Done — metric, baseline, experiments (this doc). | — |
| **1** ✅ | Seam blend post-pass + `seamBlend` param + 4 influences out of the generator. Pure TS. | Test: seam 0.5 reproduces the table above (armpit/elbow folds ↓), classic (0) is **bit-identical** to today, `validateSkinnedResult` invariants hold (weights sum to 1, ≤4). |
| **2** ✅ | Clothing keeps 4 influences. | Test: garment weights sum to 1; a dressed body's sleeve folds ↓ like the body's. |
| **3** ✅ | DQS: CPU dual-quat upload + one shared WGSL `skinVertex` + `Skeleton3D.skinningMethod`. | CPU metric matches the table; **browser**: linear mode pixel-identical to today; DQS character's outline + shadow track the body. |
| **4** | Browser tune: Relaxed / A-pose / wave / walk; adjust the `seamBlend` default. | Your eye. |

Phases 1–2 are pure TypeScript and fully unit-testable. Phase 3 is the only one with WGSL (runtime-compiled →
browser-verify).

## 6. What you should see

- **Shoulders/armpits in the default pose stop folding in on themselves** — the underside of the arm meets the torso
  as a smooth crease instead of a crushed notch. A-pose armpits and bent elbows become clean.
- **Joints keep their volume when bent** (DQS) — elbows and knees stop thinning like a wrung towel.
- **Sleeves and trouser legs follow** (Phase 2).
- Nothing changes on characters you've already saved until you opt them in.

## 7. Risks & known side-effects

1. **DQS bulge.** Dual quaternions preserve volume by pushing it *outward* on the bend side — a slight bulge at a
   sharply bent elbow/knee instead of a pinch. Standard trade; usually preferred for stylized characters. It's a
   toggle, so compare.
2. **Scale.** Joints can be scaled (`localScale`, constraint scale, and the character's own scale on the root). Pure
   DQS only blends rotation + translation → scale must be factored out per joint, blended linearly, and re-applied
   (the standard "DQS + scale" split). Non-uniform scale on a single joint would fall back to linear for that vertex.
3. **Six shader copies.** Consolidating them is required for correctness (not optional polish) — otherwise the
   outline/shadow of a DQS body would drift from the body itself.
4. **Seam blend changes clothing fit slightly** (garments are fit in the T-pose and copy weights) — re-check the fit in
   Phase 2.
5. **Blend shapes / saves:** unaffected — topology is unchanged, and weights regenerate from params on load.

## 8. What this does NOT fix (separate items)

- **Sitting / crotch folds** (hip+knee: 15 folds, unchanged by the seam blend) — the thigh-top rings are already
  blended with `hips`; the folds come from the pelvis↔thigh **geometry** (the crotch loop). Needs a topology look
  (audit **C4**) or a hip helper joint.
- **Low resolution where it matters** (8-sided arms, 9-ring head, 76% of vertices on unarticulated fingers/toes) —
  audit **C4**. Better weights make the *existing* mesh bend well; they don't add detail.
- **The face** — audit **C5**.

## 9. Tests to add

- `skin-deform-metrics.test.ts` (exists): LBS + DQS rest-pose identity; the report table.
- Phase 1: classic (`seamBlend: 0`) is byte-identical to today's `generateBodyResult`; seam 0.5 → Relaxed + A-pose
  armpit/elbow folds ≤ the table; weights sum to 1, ≤ 4 influences, no NaN.
- Phase 2: garment weights valid; garment fold count tracks the body.
- Phase 3: CPU dual-quat conversion round-trips a rigid matrix; the shared WGSL snippet is used by all six skinning
  sites (a source-scan test like the MeshInstance layout test).
