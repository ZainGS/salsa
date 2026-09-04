/**
 * Procedural CREATURE generator — parametric quadruped / biped composed as an SDF metaball blob list.
 *
 * The answer to "make me a dog": don't box-model, COMPOSE. A creature = a body capsule + 4 leg capsules + a neck +
 * a head sphere + a snout + ears + a tail, all smooth-fused (each blob carries a `blend` radius). Pure: params →
 * `SdfBlob[]`; the mesh comes from `generateSdfMesh`. Parallels the humanoid `body-generator.ts`. The capsule
 * skeleton also doubles as a bone rig (Phase 3, not yet built).
 *
 * Convention: feet at y≈0, body horizontal, +Z = forward (head), +Y = up, +X = right.
 */

import type { SdfBlob, V3 } from '../../scene-graph/shapes/sdf-mesh';

export type CreatureSpecies = 'dog' | 'cat' | 'horse' | 'lizard' | 'generic';

export interface CreatureParams {
  species?: CreatureSpecies;
  bodyLength?: number;   // nose-to-tail body capsule length
  bodyRadius?: number;   // torso thickness
  legCount?: 4 | 2;      // quadruped or biped
  legLength?: number;
  legRadius?: number;
  legSplay?: number;     // how far legs sit out from the body centre-line (0..1)
  neckLength?: number;
  neckRadius?: number;
  headSize?: number;
  snoutLength?: number;
  snoutRadius?: number;
  earSize?: number;      // 0 = no ears
  tailLength?: number;
  tailRadius?: number;
  tailCurl?: number;     // upward curl of the tail (0..1)
  blend?: number;        // global smooth-fuse radius
  rigged?: boolean;      // also emit a matching bone skeleton + bind (createCreature3D handles this)
  seed?: number;         // deterministic proportion variety — same species, different individual
  roughness?: number;    // 0 = smooth; >0 applies a displace modifier for skin/scale/fur relief (createCreature3D)
  eyes?: boolean;        // add eye spheres (default on) — createCreature3D handles this
  decimate?: number;     // keep this fraction of triangles (QEM); default 0.4. 0 or ≥1 = no decimation (dense)

}

/** One bone in the auto-rig: an ABSOLUTE joint position (creature local coords, feet at y≈0) + parent index into
 *  this same list (−1 = root). createCreature3D converts these to parent-relative bones and binds the mesh. */
export interface CreatureJoint { name: string; parent: number; pos: V3; }

/** Curated per-species proportion sets (merged over the generic defaults). */
const PRESETS: Record<CreatureSpecies, Partial<CreatureParams>> = {
  generic: {},
  dog:    { bodyLength: 1.2, bodyRadius: 0.28, legLength: 0.55, legRadius: 0.1, neckLength: 0.45, headSize: 0.3, snoutLength: 0.28, earSize: 0.12, tailLength: 0.6, tailCurl: 0.5 },
  cat:    { bodyLength: 1.0, bodyRadius: 0.22, legLength: 0.5, legRadius: 0.08, neckLength: 0.32, headSize: 0.26, snoutLength: 0.16, earSize: 0.14, tailLength: 0.9, tailRadius: 0.06, tailCurl: 0.7 },
  horse:  { bodyLength: 1.6, bodyRadius: 0.4, legLength: 1.0, legRadius: 0.12, neckLength: 0.8, headSize: 0.34, snoutLength: 0.4, earSize: 0.1, tailLength: 0.9, tailRadius: 0.1, tailCurl: 0.2 },
  lizard: { bodyLength: 1.4, bodyRadius: 0.24, legLength: 0.22, legRadius: 0.07, legSplay: 1.0, neckLength: 0.2, headSize: 0.24, snoutLength: 0.34, snoutRadius: 0.1, earSize: 0, tailLength: 1.6, tailRadius: 0.14, tailCurl: 0.0 },
};

const DEFAULTS: Required<Omit<CreatureParams, 'species' | 'rigged' | 'seed' | 'roughness' | 'eyes' | 'decimate'>> = {
  bodyLength: 1.2, bodyRadius: 0.3, legCount: 4, legLength: 0.55, legRadius: 0.1, legSplay: 0.6,
  neckLength: 0.45, neckRadius: 0.18, headSize: 0.3, snoutLength: 0.25, snoutRadius: 0.14, earSize: 0.12,
  tailLength: 0.6, tailRadius: 0.08, tailCurl: 0.5, blend: 0.18,
};

export const CREATURE_SPECIES: CreatureSpecies[] = ['dog', 'cat', 'horse', 'lizard', 'generic'];

/** Seeded jitter in [-1, 1], stable per (seed, key) — so a `seed` gives the SAME individual every time. */
function jitter(seed: number, key: string): number {
  let h = seed * 127.1;
  for (let i = 0; i < key.length; i++) h += key.charCodeAt(i) * 311.7;
  const s = Math.sin(h) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Shared anatomy — the key world points BOTH the blob mesh and the bone skeleton derive from (so they can't
 *  drift). Feet at y≈0, torso horizontal, +Z forward. */
function anatomy(params: CreatureParams) {
  const p = { ...DEFAULTS, ...PRESETS[params.species ?? 'generic'], ...params };
  // Seeded proportion variety: same species, distinct individual. ±~13% on the visible proportions.
  if (params.seed != null) {
    const j = (v: number, key: string): number => v * (1 + 0.13 * jitter(params.seed!, key));
    p.bodyLength = j(p.bodyLength, 'bodyLength'); p.bodyRadius = j(p.bodyRadius, 'bodyRadius');
    p.legLength = j(p.legLength, 'legLength'); p.neckLength = j(p.neckLength, 'neckLength');
    p.headSize = j(p.headSize, 'headSize'); p.tailLength = j(p.tailLength, 'tailLength');
    p.tailCurl = Math.max(0, Math.min(1, j(p.tailCurl, 'tailCurl'))); p.earSize = j(p.earSize, 'earSize');
  }
  const bodyY = p.legLength + p.bodyRadius;
  const halfL = p.bodyLength / 2;
  const legX = p.bodyRadius * (0.4 + p.legSplay);
  const attachY = bodyY - p.bodyRadius * 0.5;
  const legZ = halfL * 0.62;
  const foot = p.legRadius;
  const zPairs = p.legCount === 2 ? [legZ] : [legZ, -legZ];
  const legs = zPairs.flatMap(z => [1, -1].map(sx => {
    const footX = sx * legX * (p.legLength > 0.4 ? 1 : 1.6);
    return { sx, z, front: z > 0, attach: [sx * legX, attachY, z] as V3, paw: [footX, foot, z] as V3 };
  }));
  const shoulder: V3 = [0, bodyY, halfL];
  const hip: V3 = [0, bodyY, -halfL];
  const headBase: V3 = [0, bodyY + p.neckLength * 0.55, halfL + p.neckLength * 0.75];
  const headC: V3 = [headBase[0], headBase[1] + p.headSize * 0.2, headBase[2] + p.headSize * 0.3];
  const tailMid: V3 = [0, bodyY + p.tailLength * p.tailCurl * 0.4, -halfL - p.tailLength * 0.5];
  const tailEnd: V3 = [0, bodyY + p.tailLength * p.tailCurl, -halfL - p.tailLength * (1 - p.tailCurl * 0.4)];
  return { p, bodyY, halfL, legs, shoulder, hip, headBase, headC, tailMid, tailEnd };
}

/** Compose a creature into an SDF blob list. Feet rest at y≈0; the whole thing is centred on the XZ origin. */
export function buildCreatureBlobs(params: CreatureParams = {}): SdfBlob[] {
  const { p, headC, shoulder, hip, headBase, tailMid, tailEnd, legs } = anatomy(params);
  const blend = p.blend;
  const cap = (a: V3, b: V3, radius: number): SdfBlob => ({ shape: 'capsule', a, b, radius, blend });
  const ball = (a: V3, radius: number): SdfBlob => ({ shape: 'sphere', a, radius, blend });
  const blobs: SdfBlob[] = [];

  blobs.push(cap(hip, shoulder, p.bodyRadius));                          // torso
  for (const leg of legs) { blobs.push(cap(leg.attach, leg.paw, p.legRadius)); blobs.push(ball(leg.paw, p.legRadius * 1.1)); }
  blobs.push(cap(shoulder, headBase, p.neckRadius));                     // neck
  blobs.push({ shape: 'ellipsoid', a: headC, radii: [p.headSize * 0.85, p.headSize, p.headSize * 1.05], blend });   // head
  blobs.push(cap([headC[0], headC[1] - p.headSize * 0.25, headC[2] + p.headSize * 0.5], [headC[0], headC[1] - p.headSize * 0.3, headC[2] + p.headSize * 0.5 + p.snoutLength], p.snoutRadius));   // snout
  if (p.earSize > 0.001) for (const sx of [1, -1]) {
    blobs.push({ shape: 'ellipsoid', a: [headC[0] + sx * p.headSize * 0.55, headC[1] + p.headSize * 0.7, headC[2] - p.headSize * 0.1], radii: [p.earSize * 0.5, p.earSize, p.earSize * 0.4], blend: blend * 0.6 });
  }
  blobs.push(cap(hip, tailMid, p.tailRadius));                           // tail
  blobs.push(cap(tailMid, tailEnd, p.tailRadius * 0.7));
  return blobs;
}

/** The matching bone rig: pelvis→spine→chest→neck→head, a 2-bone chain per leg (child of chest for front legs /
 *  pelvis for back), and a 2-bone tail. Positions are ABSOLUTE (same coords as the blobs) so proximity-binding
 *  lines up. Parent indices reference earlier entries. */
export function buildCreatureSkeleton(params: CreatureParams = {}): CreatureJoint[] {
  const { bodyY, hip, shoulder, headBase, headC, tailMid, tailEnd, legs } = anatomy(params);
  const joints: CreatureJoint[] = [];
  const add = (name: string, parent: number, pos: V3): number => (joints.push({ name, parent, pos }), joints.length - 1);

  const pelvis = add('pelvis', -1, hip);
  const spine = add('spine', pelvis, [0, bodyY, 0]);
  const chest = add('chest', spine, shoulder);
  const neck = add('neck', chest, headBase);
  add('head', neck, headC);
  legs.forEach((leg, i) => {
    const upper = add(`leg${i}_upper`, leg.front ? chest : pelvis, leg.attach);
    add(`leg${i}_lower`, upper, leg.paw);
  });
  const tail1 = add('tail1', pelvis, tailMid);
  add('tail2', tail1, tailEnd);
  return joints;
}

/** Eye positions (+ radius) on the head — two small spheres createCreature3D places as separate dark meshes so the
 *  creature reads as alive (the single fused metaball body can't carry a second material). */
export function creatureEyes(params: CreatureParams = {}): { pos: V3; radius: number }[] {
  const { p, headC } = anatomy(params);
  const r = p.headSize * 0.18;
  const fwd = p.headSize * 0.7, up = p.headSize * 0.28, side = p.headSize * 0.42;
  return [1, -1].map(sx => ({ pos: [headC[0] + sx * side, headC[1] + up, headC[2] + fwd] as V3, radius: r }));
}
