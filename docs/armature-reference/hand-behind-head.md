# Hand Behind Head

**Kind:** hand-on-body (head — depends on `headSize` + arm reach) · **Baked into:** `default-animations.ts` → `POSES['Hand Behind Head']` · **Captured:** 2026-06-30

Right hand resting on the back of the head, elbow winged out — a casual / sheepish / "leaning back" pose. The **left arm is exactly Relaxed** (the capture's `shoulder_L`/`lowerarm_L` matched `REL_SH_L`/`REL_EL_L`), so only the right arm is baked; the left inherits the base. One-armed (asymmetric) — NOT mirrored.

## Body context
Body a18a93c8 — `{height:0.5, headSize:0.95, torsoThick:0.9, hipWidth:0.8, hipFront:0.63, waist:0.85, …}`. Single capture (works on this/similar bodies). Hand-on-HEAD so the relevant adaptation metric would be **headSize + arm reach** (not girth) — add a 2nd capture on a big-head body if it drifts.

## Baked pose (right arm; left = Relaxed)
```
shoulder_R  [-0.9160, 0.2031, 0.0907, -0.3340]   euler°(139.5, 1.8, -25.6)
lowerarm_R  [0.2948, 0.1858, 0.8522, 0.3903]     euler°(35.8, -20.9, 123.9)
hand_R      = one of the 3 wrist variants below (baked: NEUTRAL)
```

## Wrist variants (`hand_R` — same arm, three options)
| Variant | `hand_R` quat | euler° |
|---|---|---|
| **neutral** (baked) | `[0.1111, 0.1216, -0.0577, 0.9846]` | (12.2, 14.6, -5.1) |
| up | `[-0.0514, -0.0605, -0.0529, 0.9954]` | (-5.5, -7.2, -5.7) |
| down | `[0.1065, 0.1951, -0.0659, 0.9728]` | (11.4, 23.2, -5.4) |

Swap = replace `hand_R` in the pose. Awaiting user's call on which wrist reads best.

## Notes
- Held pose **and** the base of the **Scratch Head** clip ✅ — `SH_BEHIND`/`EL_BEHIND`/`HAND_BEHIND` are shared consts in `default-animations.ts`. Scratch Head raises to this pose, scratches via a small forearm (`qc(EL_BEHIND, qz(±10))`) + wrist (`qc(HAND_BEHIND, qx(±7))`) oscillation, then lowers. Replaced the old blind up-and-over guess.
