# PRISM REACTOR *(working title)* — Color-Creature Battler design

**Status:** 📝 Concept / design capture (no code). A future game built on the Salsa engine, to start once the engine
systems are polished. This doc captures the mechanics and the decisions reached so far.

## One-line hook

A creature-collector battler where **Energy (HP) is a bidirectional tug-of-war** — both **0%** (death) and **overload**
are threats — and the **color wheel turns damage into healing** as colors get closer, so **every attack is potentially
offense *or* sabotage** depending on the color and the part you aim at.

That synthesis — a two-sided Energy meter + a wheel where closeness reverses damage into healing — doesn't appear to
exist as a whole (see §11). It's easy to pitch in one sentence, which is a good sign.

## Visual direction

Reference (IG find, saved as inspiration): a **crystalline low-poly winged humanoid** — faceted body, iridescent
violet/blue/pink shards, a rainbow halo, dark starry ground, VHS/low-res grain. This *is* the target aesthetic and it
maps directly onto Salsa's strengths: low-poly parts, per-face jitter, dither/PS1 color banding, procedural characters,
and the new NPR skin shading. Creatures should read as **gem/reactor-crystal beings**, not organic monsters.

---

## 1. Creatures — collect + build from colored parts

- A creature is an **assembly of parts**: **crown, head, body, limbs, wings** (+ room for more: tail, core, etc.).
- **Every part has a color**: the six hues **R O Y G B V**, plus **black** and **white** (off-wheel — see §3).
- You **collect parts and build** creatures from them (Medabots-style kitbash, not fixed species).
- **Part color is a per-part choice** and matters for both offense targeting and defense (see §2, §4).

**Build strategy that falls out for free:** a **mono-color** creature is simple but can be **overloaded by one color
every time** (same-color heal, §5); a **multi-color** creature gives attackers fewer clean heal targets but **more weak
points** to exploit. Real player choice with no extra rules.

## 2. The color wheel — a damage *gradient* (LOCKED: 6 colors)

Order the six hues around a circle: **R · O · Y · G · B · V**. Effectiveness is a clean function of **wheel distance**
(min steps around the 6-cycle, 0–3) — *"the farther apart, the more it hurts; same color heals."*

| Distance | Result | Multiplier |
|---|---|---|
| **3 steps (opposite)** | super-effective | **2× damage** |
| **2 steps** | neutral | **1× damage** |
| **1 step (adjacent)** | resisted | **0.5× damage** |
| **0 steps (same color)** | **HEALS the target** | ~**0.5× as Energy gain** (tunable, see §5) |

- Opposites (2×): **Red↔Green, Orange↔Blue, Yellow↔Violet.**
- One sentence to learn, no lookup table — damage shrinks as colors converge and at zero flips to healing.
- **Damage uses the color of the PART being hit**, not the attacker's "type" — so aiming is a real decision (§4).

## 3. Black / white / off-wheel (LOCKED)

- **Black and white** are a 2-color mini-axis: **opposite each other (2×)**, **neutral (1×) to all six hues**,
  same-on-same **heals** (consistent with the rule). Safe generalist picks that are never super-effective vs. hues.
- **No mid-game wheel expansion.** Adding hues (lime/teal, etc.) silently changes existing matchups, which feels like a
  nerf to players who built around them. Pokémon only changed its type chart *between games*, never mid-save. **Decision:
  stay at 6.**
- **Keep the "a new color breaks the world" boss moment anyway — via an OFF-WHEEL color.** A **magenta / prismatic**
  boss with its own rule (e.g. neutral to all six hues, **shifts color each turn**, and/or the only color **immune to
  same-color healing**). Beating it unlocks **prismatic parts** as a rare category. Players get the "whoa, new color"
  beat *and* every matchup they already learned stays exactly the same. (Magenta is literally an off-spectrum color the
  brain invents from red+violet — a grounded hook.)

## 4. Part targeting + SHATTER

- **Attacks target a specific part**; damage uses **that part's color** (§2). Hit a weak-colored limb for 2×, or hit
  the head to break a key ability.
- Damage a part enough → **SHATTER**: abilities/moves that **rely on that part are disabled** (e.g. shatter the wings →
  no flight moves; shatter the crown → lose a passive). Medabots/Medarot is the closest ancestor.
- **Shatter and Energy are SEPARATE axes** (important): **healing restores Energy but does NOT repair shattered parts**
  (only special repair moves do). So you can win by *breaking parts* even against a creature that overheals constantly,
  and no one can "potion their way out of" a shattered wing.

## 5. Energy (HP) — the tug-of-war meter

Energy replaces HP and has **three zones**:

| Range | Zone | Notes |
|---|---|---|
| **0%** | **Death** | You lose the creature. |
| **1–100%** | Normal | Standard play. |
| **>100–<200%** | **OVERHEAL** | Glowing band. Powerful but unstable; has downsides (§6). |
| **200%** | **CRITICAL** | Flashing cap. Big power, big risk (§7). |

**Healing is a weapon.** Because the top of the bar is dangerous, **pushing an enemy's Energy UP is a valid attack** —
same-color hits (§2) do exactly this. That's what makes the meter a tug-of-war instead of a countdown to zero, and it's
the core differentiator.

**Same-color heal tuning (so it doesn't break):**
- Heal **Energy only** — **no part damage, no part repair** (keeps Shatter independent, §4).
- Heal at ~**0.5×** the damage value so overloading isn't as fast as killing (tune separately from damage).
- **Ally targeting** allowed → same-color hits double as **support healing**, and in doubles let you push your **own**
  Meltdown creature into Critical **on your terms** (a nice mirror of the enemy forcing it prematurely).

**Counterplay — VENT:** a move that **dumps Overheal**, ideally converting it into **damage or a buff**. Without a way
to shed Energy, being force-overloaded feels helpless. Vent is the pressure-release valve.

## 6. OVERHEAL downsides (the reactor flavor)

Don't apply every downside globally or the rules pile up. Structure:
- **Universal baseline:** mild **Decay** each turn while overhealed (radioactive decay) — so **stalling in Overheal is
  never free**.
- **Per-creature / per-body-color flavor** on top (makes the **body color** matter beyond damage — a readable rule):
  - **Burst** (e.g. red bodies) — releases a damage pulse.
  - **Sluggish** (e.g. blue bodies) — reduced speed/priority while overhealed.
  - **Fragile Excess** — takes extra damage while overhealed.
- Tying the overheal *behavior* to body color gives the color choice a **second meaning** and teaches itself.

## 7. CRITICAL — the crux (LOCKED direction: power **on a clock**)

Critical must be a **real threat to whoever's in it** (or a mono-red creature vs. a red attacker is unkillable). Chosen
design = combine **"power at a price"** + **"a timer"** (reactor theme = critical mass):

- **Unlocks CRITICAL-only moves** + a damage boost — reaching Critical is a **gamble you choose, or one your opponent
  forces on you** (via same-color overload).
- **On a clock:** after **N turns** in Critical, the creature **detonates** — self-damage (and maybe splash to
  adjacent creatures), then **crashes to a low Energy value**.
- **Can't be healed while Critical** (or same-color heal is blocked) — a **guaranteed way out** the target doesn't
  fully control, so "I win by overloading you" is viable but not degenerate.

> ❓ **Open question (from the chat, still unanswered):** is Critical mainly a **payoff you aim for**, or mainly a
> **danger state to avoid**? This decides how generous the unlocked moves / damage boost are vs. how punishing the
> detonation is. Pick a lean before building — it colors the whole meta.

## 8. Abilities (OVERHEAL / CRITICAL triggers)

Creatures have **unique abilities** keyed to the Energy zones. The best ones are **double-edged** (a strength *and* a
vulnerability the opponent can exploit):
- **Meltdown / Runaway Reaction** — *"At 150%+ Energy, immediately boost to 200% (Critical)."* Great tug-of-war example:
  it helps the owner reach Critical fast, but if the opponent knows you have it, they can **heal you to 150% on purpose**
  to trigger it before you're ready.
- **Critical-only moves** — powerful moves usable only at 200% (paired with §7's clock).
- Room to fold in **Decay / Sluggish / Fragile Excess / Burst** as ability effects, not just passives.

## 9. Readability (the main risk)

Color matchups + part targeting + Shatter + three Energy zones is **a lot to track**. Lean on visuals:
- **Energy bar with visually distinct zones**: normal fill, a **glowing Overheal band**, a **flashing Critical cap**.
- **Per-part color indicators** on the creature and in the target UI.
- The **reactor fiction teaches the rules**: "a reactor above capacity is unstable" explains Overheal/Critical for free.
- The low-res/jitter art must keep the six hues distinguishable — a reason to **stay at 6 colors** (§3).

## 10. Decisions locked so far

1. **6-color wheel**, distance-gradient effectiveness; **same color heals** (§2).
2. **No mid-game wheel expansion**; the "new color" beat is an **off-wheel prismatic boss** instead (§3).
3. **Shatter and Energy are independent axes**; heal never repairs parts (§4/§5).
4. **Same-color heal = Energy only, ~0.5× rate, ally-targetable**; **Vent** is the counterplay (§5).
5. **Critical = power on a clock + no-heal**, detonation as the guaranteed exit (§7).
6. Overheal has a **universal Decay** baseline + **body-color-flavored** extra downside (§6).

## 11. Prior art (pieces exist; the synthesis doesn't)

- **Part-based / breakable parts:** Medabots/Medarot (head/arms/legs each with HP, break one → disable its attacks),
  Monster Hunter part-breaks, Fallout VATS limb targeting. Building/collecting: Spore, Monster Rancher.
- **Color-relationship wheels:** MTG color pie (allied/enemy on a wheel), Fire Emblem weapon triangle. Your
  distance-based rule is cleaner than most type charts.
- **Same-type heals:** exists only as an *exception* (Pokémon Water/Volt Absorb, FF elemental absorption) where healing
  an enemy is a *mistake*. Making it a **universal matchup rule** where it's a **strategy** is the novel part.
- **Over-capacity danger:** BattleTech/MechWarrior **heat** (push for power, risk shutdown / ammo cook-off) is the best
  Critical reference; TF2 overheal for the decaying buffer.
- **Chemistry/fusion:** Cassette Beasts (fuse monsters, type interactions create statuses) — worth studying for modern
  monster-collecting done with more interesting reactions than Pokémon.

**Novel contribution:** one **bidirectional Energy meter** (both ends lethal) + a **color wheel where closeness reverses
damage into healing** → every attack is offense or sabotage by choice of color + part.

## 12. Engine feasibility on Salsa (why this is buildable here)

This game is unusually well-matched to what Salsa already does — most of the *creature* side exists; the *game* side is
new systems on top.

- **Creature = assembled colored parts** → Salsa already has **procedural characters with parts + kitbash** (body,
  head, limbs, hair/clothes as separate meshes sharing a skeleton) and **per-part material color**. A "creature schema"
  is a data layer over that: `{ parts: { crown, head, body, limbs[], wings[] }, each: { meshRef, color: Hue|BW } }`.
- **Look** → low-poly + **dither/PS1 color banding** + per-face jitter + the new **toon-ramp / soft NPR shading** and
  **rim light** = the crystalline-iridescent reference aesthetic, close to out-of-the-box.
- **Battle logic** → pure, testable modules (like the UI state machine / packaging split): a **combat engine**
  (color-distance math, Energy zones, Shatter, abilities) with a thin renderer adapter. No GPU needed to unit-test the
  rules.
- **UI / menus / HUD** → the **UI System** (state machine + per-state visibility + forms) already exists for the battle
  HUD, the Energy bar zones, part-target selection, and menus (see docs/ui/ui-system.md).
- **Collection / building** → fits the planned **Shared Asset Library + Creator Suite** (author parts as assets, build
  creatures from them). See docs/specs/shared-asset-library.md, creator-suite.md.

> ❓ **"How do I make a system to easily create these creatures?"** (asked in the chat, effectively unanswered there):
> the answer is a **Creature Creator** = a kitbash mode over Salsa's procedural parts with a **fixed part-slot schema**
> (crown/head/body/limbs/wings) and a **color enum per part**, saving each creature as a Shared-Asset-Library record.
> That's a concrete future spec once the engine is polished — flag it when you want it drafted.

## 12b. Architecture & shipping — where/how this gets built

**This game is NOT Salsa engine code.** It's authored by the user in the **Frogmarks editor** and shipped as a
**cartridge**. Three layers:

- **Salsa** = the engine *library* — generic capabilities only (rendering, procedural colored creatures/parts, UI
  system, asset library, `.frogcart` export, and the **scripting runtime**). Nothing game-specific ever lives here.
- **Frogmarks** = the *editor* — where you author assets, UI flow, and **scripts**.
- **PRISM REACTOR** = a **cartridge** (`.frogcart`) = your scripts + creature assets + UI state machine. The game =
  content, not engine code.

**Custom battle logic = Script Behaviors** (spec: `docs/specs/script-behaviors.md`; being built now). Author **TypeScript,
run JavaScript** (types stripped with sucrase; IntelliSense from a shipped `.d.ts`). Scripts call a curated, stable
**`ScriptContext` API**, run **Play-only + non-destructive** (Stop reverts everything), and **coexist with the UI state
machine, sharing variables**. A turn-based battler is best a **central controller script** (battle loop → color math →
Energy/Shatter → drives the UI machine via shared vars/`emit`) plus **your own data model** for creature stats (plain JS
objects / vars) — keeping the engine generic (it renders + runs UI; *your script owns the rules*).

**Language: JS/TS — not C++.** The runtime is the browser (WebGPU); everything runs in JS/WASM there. A battler is **not
CPU-bound** (rendering is already GPU), so JS perf is a non-issue and C++ would buy nothing while hurting portability. A
**WASM module** (C++/Rust → WASM, called via `ScriptContext`) stays as an escape hatch for a *proven* future hotspot
only. Because `ScriptContext` is a "forever contract," the executor can swap (main-realm → QuickJS sandbox → Worker/WASM)
without changing any game script.

**Shipping to Steam / other devices:** wrap the web app + cartridge in **Electron / Tauri** (a packaging task, later —
not a language decision). Web is the *most* portable target (desktop via Electron/Tauri, mobile via WebView/Capacitor,
anywhere with a browser; WebGPU is expanding). **Sandboxing (QuickJS)** is required only before sharing carts publicly
(untrusted scripts) — fine to skip while self-authoring.

**Prerequisite:** Script Behaviors (S1–S4 in its spec) must exist before any of this game can be authored — **that build
is starting now.**

## 13. Open questions to resolve before building

1. **Critical: payoff vs. danger** lean (§7) — sets how strong the reward and how harsh the detonation are.
2. **Same-color heal rate** exact value (§5) and whether **Vent** converts Overheal to damage or a buff.
3. **How many parts / slots** per creature, and which abilities bind to which parts (§4/§8).
4. **Turn structure** — is this turn-based (Pokémon-like) or real-time-ish? (Affects timers, Sluggish, Critical clock.)
5. **Off-wheel prismatic** exact rule (§3) — color-shifting, heal-immune, or both.

---

*Origin: design chat braindump + discussion, captured 2026-09-27. Living doc — update as decisions land.*
</content>
