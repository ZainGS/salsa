# Pose & Animation Catalog — character creator (BotW / Animal Crossing style)

The roadmap for the capture workflow. **Poses = vocabulary** (captured via `exportPoseData3D` + girth-blend); **animations = sequences of poses** (keyframed clips the engine slerps between). Build the poses; the animations are mostly free sequencing on top.

## Capture legend (how many captures a pose needs)
- 🟢 **1 capture** — *orientation* pose (arm/torso aimed in space). Works on every body; girth doesn't matter.
- 🟡 **2 captures: thin + fat** — *hand-on-body* (hand touches hip/torso/head/face). Girth-blended. Add a medium 3rd only if the mid-range drifts.
- 🔵 **2 captures: short + tall** — *leg/ground* (foot placement, sitting, kneeling). Adapts on a leg metric; some need foot-planting later.

Reuse note: most poses return to **Relaxed**, and locomotion poses are mirrored L/R — so the real capture count is well below the row count.

---

# POSES

## Tier 1 — Core "alive" (do these first — a genuinely living character)
| Pose | Capture | Feeds |
|---|---|---|
| Relaxed stand ✅ | 🟢 | everything (the return pose) |
| Hands on hips ✅ | 🟡 | idle break, attitude |
| Arms crossed / folded | 🟡 | idle break, "waiting", annoyed |
| Hand on chin (thinking) | 🟡 | idle break, "pondering" |
| Scratch head | 🟡 | idle break, confused |
| Stretch overhead ✅ | 🟢 | idle break, wake-up |
| Stretch back (hands on lower back, arch) | 🟡 | idle break |
| Yawn (hand to mouth, head back) | 🟡 | idle break, sleepy |
| Look around / over shoulder ✅ | 🟢 | idle break, alert |
| Hands clasped behind back | 🟡 | idle, "at ease" |
| Hands in pockets | 🟡 | idle, casual |
| Wave ✅ | 🟢 | greeting |
| Point (forward) | 🟢 | "look there", directions |
| Nod / shake head (head only) | 🟢 | yes/no, conversation |
| Shrug | 🟡 | "dunno" |
| Sit on ground (relaxed) | 🔵 | resting, campfire, fishing |

## Tier 2 — Expressive / social (Animal Crossing personality)
| Pose | Capture | Feeds |
|---|---|---|
| Cheer / arms-up V ✅ | 🟢 | celebrate, win |
| Big wave (both arms) | 🟢 | "over here!" |
| Clap (open + closed) | 🟢 ×2 | applause |
| Thumbs up | 🟢 | approve |
| Peace sign / V | 🟢 | photo, cute |
| Beckon (come here) | 🟢 | call over |
| Bow (respectful) | 🟢 | greeting, thanks |
| Curtsy | 🔵 | formal greeting |
| Flex (both arms) | 🟡 | show off, strong |
| Heart hands | 🟡 | love, cute |
| Facepalm | 🟡 | exasperated |
| Salute | 🟡 | respect, ready |
| Laughing (head back, hand on belly) | 🟡 | happy |
| Crying (hands to face) | 🟡 | sad |
| Embarrassed (hand behind head, look away) | 🟡 | shy |
| Dejected (slumped, head down) | 🟢 | sad idle |
| Angry (fists clenched, hunched) | 🟢 | mad idle |
| Surprised (recoil, hands up) | 🟢 | shock reaction |
| Scared (cowering, arms protective) | 🟡 | fear |
| Blow a kiss | 🟡 | flirty |
| Dance pose ×2–3 | 🟢 | dancing |
| Talk gesture ✅ | 🟢 | dialogue |

## Tier 3 — Locomotion & action (a full action game)
**Locomotion keyframes** (mirror L/R, so ~half the captures):
| Pose | Capture | Feeds |
|---|---|---|
| Walk contact (foot fwd, opp. arm fwd) | 🔵 | walk cycle |
| Walk passing (mid-stride) | 🔵 | walk cycle |
| Run contact (lean, big stride) | 🔵 | run/jog |
| Run passing | 🔵 | run/jog |
| Sneak / crouch-walk | 🔵 | stealth |
| Jump crouch (pre-launch) | 🔵 | jump |
| Jump launch (extended, arms up) | 🔵 | jump |
| Airborne (spread/tuck) | 🔵 | jump, fall |
| Land (crouch absorb) | 🔵 | jump, fall |
| Climb reach (hand up, foot up) | 🔵 | climbing |
| Swim stroke | 🟢 | swimming |
| Paraglide hold (arms up to bar) | 🟢 | gliding |

**Combat / action:**
| Pose | Capture | Feeds |
|---|---|---|
| Combat ready (weapon up, knees bent) | 🔵 | combat idle |
| Attack windup | 🟢 | swing |
| Attack swing (follow-through) | 🟢 | swing |
| Block / guard | 🟢 | defend |
| Bow aim (one arm out, one drawing) | 🟢 | archery |
| Cast / channel (arms forward) | 🟢 | magic |
| Draw / sheathe weapon | 🟡 | equip |

**Object interaction:**
| Pose | Capture | Feeds |
|---|---|---|
| Reach / grab (arm extended) | 🟢 | pick up, open |
| Pick up from ground (bend, grab) | 🔵 | loot |
| Hold item (two hands front) | 🟡 | carry small |
| Carry overhead (both arms up) | 🟢 | carry big |
| Throw windup → release | 🟢 ×2 | throw |
| Push (lean in, arms low fwd) | 🔵 | push block |
| Pull (lean back) | 🔵 | pull |
| Eat / drink (hand/cup to mouth) | 🟡 | consume |
| Present item (hold out) | 🟢 | give, show |
| Fishing (hold rod) | 🟢 | fishing |
| Cook / stir | 🟢 | cooking |
| Dig / shovel | 🔵 | digging |

**Sitting / resting / ground:**
| Pose | Capture | Feeds |
|---|---|---|
| Sit cross-legged | 🔵 | campfire, rest |
| Sit knees-up | 🔵 | rest, lookout |
| Sit on chair/bench (knees 90°) | 🔵 | benches |
| Kneel (one/both knees) | 🔵 | pray, examine |
| Crouch / squat | 🔵 | hide, inspect |
| Lie down (back) | 🔵 | sleep |
| Sleep (curled) | 🔵 | sleeping |
| Lean against wall | 🔵 | idle, waiting |

---

# ANIMATIONS (sequences of the poses above)

Each is a clip = pose keyframes + timing. **One-shot** plays once and returns to Relaxed; **loop** cycles. Repetitive motion (wave, clap, walk) only needs the KEY poses — I synthesize the oscillation/in-betweens.

## Idle system (the "alive" core)
- **Base idle** (loop): Breathe ⊕ Shift-weight ⊕ Look-around — already running, always on.
- **Idle breaks** (one-shot, fire a random one every ~8–20s, return to Relaxed): Stretch · Scratch head · Hands on hips · Arms crossed · Yawn · Stretch back · Check surroundings · Dust off · Hand on chin. *(This randomized-break system is what makes BotW NPCs feel alive.)*

## Emotes (one-shot, triggered)
| Animation | Pose keyframes |
|---|---|
| Wave | Relaxed → Wave (+hand oscillation) → Relaxed |
| Big wave | Relaxed → Big-wave (sway) → Relaxed |
| Cheer | Relaxed → (small crouch) → Cheer (hop) → Relaxed |
| Clap | Clap-open ↔ Clap-closed ×N |
| Thumbs up / Point / Peace | Relaxed → pose (hold) → Relaxed |
| Bow / Curtsy | Relaxed → Bow (hold) → Relaxed |
| Laugh | Relaxed → Laugh (head bob ×N) → Relaxed |
| Cry | Relaxed → Crying (shoulder shake ×N) → Relaxed |
| Shrug | Relaxed → Shrug (hold) → Relaxed |
| Dance | Dance-A ↔ Dance-B ↔ Dance-C (loop) |
| Facepalm / Salute / Flex / Heart | Relaxed → pose → Relaxed |

## Reactions (one-shot, event-driven)
| Animation | Pose keyframes |
|---|---|
| Surprised | Relaxed → Surprised (recoil snap) → settle |
| Scared | Relaxed → Scared (cower, hold/tremble) |
| Hit / flinch | current → Flinch → recover |
| Angry burst | Relaxed → Angry (hold, fume) |
| Wake up | Sleep → Sit → Stretch → Stand |

## Locomotion (loop)
| Animation | Pose keyframes |
|---|---|
| Walk | Contact-L → Passing → Contact-R → Passing → (loop) |
| Run / Jog | Run-contact-L → Run-passing → Run-contact-R → Run-passing |
| Sneak | Sneak-contact/passing (crouched) |
| Jump | Jump-crouch → Launch → Airborne → Land (one-shot) |
| Climb | Climb-reach-L ↔ Climb-reach-R (loop) |
| Swim | Swim-stroke-L ↔ Swim-stroke-R |
| Glide | Paraglide-hold (loop, slight sway) |

## Actions (one-shot)
| Animation | Pose keyframes |
|---|---|
| Pick up | Relaxed → Reach/bend → Grab → Stand (w/ item) |
| Throw | Relaxed → Throw-windup → Throw-release → Relaxed |
| Attack | Ready → Windup → Swing → Ready |
| Sit down | Stand → Crouch → Sit (then Sit-idle loop) |
| Get up | Sit → Crouch → Stand |
| Open chest | Reach → lift (Open) → step back |
| Eat / Drink | Relaxed → hand-to-mouth (chew/sip ×N) → Relaxed |

---

## Suggested order
1. **Tier 1 poses** → instant living character (idle + greet + sit). ~16 poses, ~half need a thin+fat pair.
2. Wire the **idle-break** system (random one-shots) — biggest "alive" payoff for the least work.
3. **Tier 2** for personality/social, **Tier 3** as the game needs locomotion/combat/interaction.
4. Capture hand-on-body poses on a **thin + fat** body; orientation poses once; leg/ground poses on **short + tall**.
