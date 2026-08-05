// ── World generation — POSTER (flyer) GARP asset ────────────────────────────────────────────────────
// A flat printed poster stuck on a utility pole / pillar / wall. Instanced + GARP-skinnable so real poster ART
// (the user's "posters on pillars" ask) can theme it per pool. Not a Creator object — a scatter surface. Mirrors
// the crate GARP recipe (canonical geo + per-instance transforms + a pool).

import type { InstanceXform, V2 } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { GarpPool } from './garp';
import { Accum3D } from './meshbuild';

type V3 = [number, number, number];

export const POSTER_CANON_W = 0.5, POSTER_CANON_H = 0.7;   // canonical poster size (m)
export const POSTER_SKIN_NAMES = ['gig', 'notice', 'ad'];
export function posterSkinKey(name: string): string { return `poster/${name}/art`; }
export function posterGarpPool(): GarpPool {
    return {
        id: 'salsa/poster', name: 'Posters', version: 1, size: [512, 512], slots: ['art'],
        defaults: { art: posterSkinKey('gig') },
        skins: POSTER_SKIN_NAMES.map((n) => ({ name: n, slots: { art: posterSkinKey(n) } })),
    };
}

/** ONE canonical poster quad centred at the origin, facing +Z, UV 0..1 (the printed art). */
export function posterCanonicalGeometry(worldPerMetre: number): MeshGeometry {
    const a = new Accum3D();
    const hw = POSTER_CANON_W * 0.5 * worldPerMetre, hh = POSTER_CANON_H * 0.5 * worldPerMetre;
    a.quadUV4([-hw, hh, 0], [hw, hh, 0], [hw, -hh, 0], [-hw, -hh, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    return a.geometry();
}

/** One poster instance on a post at `base` (foot), at eye-level, facing `face` (V2), just proud of radius `rM`. */
export function posterInstanceTransform(base: V3, face: V2, worldPerMetre: number, rM = 0.06, eyeM = 1.2): InstanceXform {
    const l = Math.hypot(face[0], face[1]) || 1;
    const f: V2 = [face[0] / l, face[1] / l];
    const off = (rM + 0.01) * worldPerMetre;
    return { x: base[0] + f[0] * off, y: base[1] + eyeM * worldPerMetre, z: base[2] + f[1] * off, ry: Math.atan2(f[0], f[1]), s: 1 };
}
