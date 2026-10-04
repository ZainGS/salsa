// ── World generation — STATION ENTRANCES as walker destinations (railway-upgrade R2.2 leftover) ────────────────────
// Every way into the rail system at street level, as layout points: the elevated line's station stair feet (their
// ticket-gate halls sit under the upper flight), the metro kiosks' open ends and the local line's platform stairs.
// The footfall field (pedestrians.ts) pulls the crowd toward them, and the traffic sim's walkers visit them — walk up,
// "enter" (vanish, as if through the gates / down to the platform), and later come back out (world-traffic.ts).
// Pure (graph → points); memoised per graph.

import type { WorldGraph } from './types';
import { cityMetresPerUnit } from './types';
import { railLayout } from './rail-layout';
import { streetPlan } from './street-slots';
import { METRO_HALF_LEN_M } from './rail-layout';
import { localStationEntrances } from './local-line-build';

export interface StationEntrance {
    kind: 'rail' | 'metro' | 'local';
    /** Layout point where a walker "enters", and the unit direction OUT of the entrance (toward the street). */
    x: number; z: number; ox: number; oz: number;
}

const cache = new WeakMap<WorldGraph, StationEntrance[]>();

export function stationEntrances(graph: WorldGraph): StationEntrance[] {
    const hit = cache.get(graph);
    if (hit) return hit;
    const p = graph.params, u = 1 / cityMetresPerUnit(p.radius), out: StationEntrance[] = [];
    if ((p.railway ?? true) && (p.stations ?? true)) {
        for (const st of railLayout(graph).stairs) {
            // the foot of the flight, a step out onto the pavement (the stair runs along the cross-street pavement)
            out.push({ kind: 'rail', x: st.xTop + st.dir * (st.run + 0.6 * u), z: st.zp, ox: st.dir, oz: 0 });
        }
    }
    if (p.metroEntrances ?? true) {
        const plan = streetPlan(graph);
        for (const sl of plan.of('metro')) {
            const R = plan.roads[sl.ri]; if (!R) continue;
            const f = sl.n ? R.d : [-R.d[0], -R.d[1]];   // toward the junction = the kiosk's open end (metro.ts)
            const hl = METRO_HALF_LEN_M * u;
            out.push({ kind: 'metro', x: sl.x + f[0] * (hl + 0.4 * u), z: sl.z + f[1] * (hl + 0.4 * u), ox: f[0], oz: f[1] });
        }
    }
    for (const e of localStationEntrances(graph)) out.push({ kind: 'local', x: e.x, z: e.z, ox: e.ox, oz: e.oz });
    cache.set(graph, out);
    return out;
}
