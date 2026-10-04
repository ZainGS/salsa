// ── World generation — METRO ENTRANCES (railway-upgrade.md R2.3) ───────────────────────────────────────────────
// Street kiosks over a stair down to the (unseen) subway: low metal side walls with glass panels above, a flat metal
// canopy, the stair well read as dark treads going down (a striped floor just above the pavement — the ground is
// never cut), a lit square sign on a pillar at the open end and a vent grille at the back. Placed by the shared
// street plan (street-slots step 15 — 'metro' slots on busy-junction pavements, clear of the viaduct) so no tree,
// bench or vending run lands on one. Layout space (warped with the city like other street props); each kiosk is
// BAKED at its own centre's ground height so its walls stay vertical and its roof level. Toggle: `metroEntrances`.

import type { WorldGraph, LayoutPreviewLayer } from './types';
import { cityMetresPerUnit, metalScaleFor } from './types';
import { Accum3D } from './meshbuild';
import { makeElevation } from './elevation';
import { streetPlan } from './street-slots';
import { METAL_PAINTED } from './palette';
import { METRO_HALF_LEN_M, METRO_HALF_W_M } from './rail-layout';

type V3 = [number, number, number];
type RGB = [number, number, number];

const PANEL: RGB = [0.18, 0.30, 0.34];   // dark teal metal panels
const ROOF: RGB = [0.26, 0.28, 0.30];
const GLASS: RGB = [0.40, 0.50, 0.55];
const WELL: RGB = [0.07, 0.07, 0.08];
const SIGN: RGB = [0.10, 0.55, 0.85];    // the lit sign box (a generic subway blue, no logo)
const VENT: RGB = [0.32, 0.33, 0.33];

export function buildMetro(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params;
    if (!(p.metroEntrances ?? true)) return [];
    const slots = streetPlan(graph).of('metro');
    if (!slots.length) return [];
    const u = 1 / cityMetresPerUnit(p.radius), M = (m: number): number => m * u, gy = p.groundY;
    const elev = makeElevation(graph), plan = streetPlan(graph);
    const panel = new Accum3D(), roof = new Accum3D(), glass = new Accum3D(), well = new Accum3D(), sign = new Accum3D(), vent = new Accum3D(), letter = new Accum3D();
    const Y: V3 = [0, 1, 0];
    for (const sl of slots) {
        const R = plan.roads[sl.ri]; if (!R) continue;
        const f: V3 = sl.n ? [R.d[0], 0, R.d[1]] : [-R.d[0], 0, -R.d[1]];   // toward the junction = the open end
        const l: V3 = [R.pp[0] * sl.side, 0, R.pp[1] * sl.side];           // toward the building line
        const y0 = gy + elev(sl.x, sl.z);
        const hl = M(METRO_HALF_LEN_M), hw = M(METRO_HALF_W_M);
        const P = (a: number, b: number, h: number): V3 => [sl.x + f[0] * a + l[0] * b, y0 + h, sl.z + f[2] * a + l[2] * b];
        const wallH = M(1.05), topH = M(2.3), t = M(0.06);
        const back = -hl + M(0.9);   // the vent box sits behind the kiosk's closed end
        // Side walls (low solid panels) + glass above, and the closed back end.
        for (const e of [-1, 1]) {
            panel.obox(P((back + hl) / 2, e * (hw - t), wallH / 2), f, Y, l, (hl - back) / 2, wallH / 2, t);
            glass.obox(P((back + hl) / 2 - M(0.1), e * (hw - t), (wallH + topH) / 2), f, Y, l, (hl - back) / 2 - M(0.12), (topH - wallH) / 2, t * 0.4);
            panel.obox(P(hl - M(0.04), e * (hw - t), topH / 2), f, Y, l, M(0.04), topH / 2, t * 1.2);   // door-side posts
        }
        panel.obox(P(back + t, 0, topH / 2), f, Y, l, t, topH / 2, hw);
        // Canopy (overhangs the open end a little).
        roof.obox(P((back + hl) / 2 + M(0.15), 0, topH + M(0.07)), f, Y, l, (hl - back) / 2 + M(0.3), M(0.07), hw + M(0.12));
        // The stair well: dark treads "going down" — a striped floor quad just above the pavement.
        const a = P(hl - M(0.05), -hw + t * 2, M(0.02)), b = P(back + t * 2, -hw + t * 2, M(0.02));
        const c = P(back + t * 2, hw - t * 2, M(0.02)), d = P(hl - M(0.05), hw - t * 2, M(0.02));
        well.quad4(a, b, c, d);
        // Sign pillar at the open end on the kerb side + the lit square sign box on top.
        const sx = hl - M(0.2), sz = -(hw + M(0.25));
        panel.obox(P(sx, sz, M(1.35)), f, Y, l, M(0.06), M(1.35), M(0.06));
        sign.obox(P(sx, sz, M(2.95)), f, Y, l, M(0.3), M(0.3), M(0.12));
        // The white "M" on both faces of the sign box (R2.3 leftover): 4 strokes, 0.42 m tall, 0.07 m wide.
        for (const e of [-1, 1]) {
            const n: V3 = [l[0] * e, 0, l[2] * e], r: V3 = [n[2], 0, -n[0]];   // face normal + the viewer's right
            const c = P(sx, sz + e * M(0.125), M(2.95));
            const Q = (x: number, y: number): V3 => [c[0] + r[0] * M(x), c[1] + M(y), c[2] + r[2] * M(x)];
            const bar = (x0: number, y0: number, x1: number, y1: number): void => {
                const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, w = 0.035, nx = -dy / L * w, ny = dx / L * w;
                const a = Q(x0 - nx, y0 - ny), b = Q(x1 - nx, y1 - ny), cc = Q(x1 + nx, y1 + ny), d = Q(x0 + nx, y0 + ny);
                const fn = [(b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]), 0, (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])];
                if (fn[0] * n[0] + fn[2] * n[2] >= 0) letter.quad4(a, b, cc, d); else letter.quad4(a, d, cc, b);
            };
            bar(-0.17, -0.21, -0.17, 0.21); bar(0.17, -0.21, 0.17, 0.21);
            bar(-0.17, 0.21, 0, -0.02); bar(0, -0.02, 0.17, 0.21);
        }
        // Vent grille block behind the kiosk.
        vent.obox(P(-hl + M(0.42), 0, M(0.45)), f, Y, l, M(0.38), M(0.45), hw - M(0.1));
    }
    const metalScale = metalScaleFor(p.radius);
    const out: LayoutPreviewLayer[] = [];
    const add = (name: string, color: RGB, acc: Accum3D, extra: Partial<LayoutPreviewLayer> = {}): void => {
        if (!acc.empty) out.push({ name, color, y: gy, geometry: acc.geometry(), drape: 'baked', ...extra });
    };
    add('world:metro-kiosk', PANEL, panel, { metal: { ...METAL_PAINTED, tint: PANEL, scale: metalScale } });
    add('world:metro-roof', ROOF, roof, { metal: { ...METAL_PAINTED, tint: ROOF, scale: metalScale } });
    add('world:metro-glass', GLASS, glass, { glass: true });
    add('world:metro-stairs', WELL, well, { pattern: { color: [0.22, 0.22, 0.23], freq: 1 / (0.3 * u), scale: 0.18, mode: 'stripes' } });
    add('world:metro-vent', VENT, vent, { pattern: { color: [0.12, 0.12, 0.12], freq: 1 / (0.06 * u), scale: 0.4, mode: 'stripes' } });
    add('world:metro-sign-lit', SIGN, sign, { emissive: p.nightMode ? 1.1 : 0.6 });
    add('world:metro-sign-letter', [0.97, 0.97, 0.95], letter, { emissive: 1.4 });   // lit white "M" (glow row 'sign-'; untiered like the box)
    return out;
}
