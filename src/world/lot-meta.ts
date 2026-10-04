// ── Per-lot building metadata (city-quality B3) ─────────────────────────────────────────────────────
// buildStreets' detailed path builds each lot's full procedural building, which knows its own entrance, front edge,
// sign slots and wire anchors. Later composers (awnings / signage / pedestrian dressing / overhead wires) used to
// RE-DERIVE a frontage from the raw lot polygon with a different rule — so they dressed the shopfront a second
// time, floated signs off the real facade and put a dark glass strip over the building's own door. This carries
// the building's meta (in CITY units) to them instead.
// ★ Stored as a plain extra PROPERTY on the Lot object (not a WeakMap): the centre city is built in a WORKER and
// the mutated graph comes back through structured clone, which keeps own data properties but not side tables.
// Untyped on Lot on purpose (types.ts is shared) — always go through lotMeta() / setLotMeta().

import type { Lot, V2 } from './types';

type V3 = [number, number, number];

export interface CityLotMeta {
    /** The building dressed the lot itself (a detailed building) — city awnings / signage skip its shopfront. */
    detailed: boolean;
    /** The building has its own shopfront (awning / fascia / tenant signs). */
    shopfront: boolean;
    /** Entrance anchor + outward direction (city units), or null. */
    door: V2 | null;
    doorOut: V2;
    /** The front (entrance) edge: endpoints + outward normal (city units). */
    front: { a: V2; b: V2; out: V2 };
    /** Facade points (city units, absolute Y) where overhead service wires from the street poles attach. */
    wireAnchors: V3[];
    /** Sign slots (city units, absolute Y). `k` = the sign colour slot into `signColors` (when known). */
    signSlots: { pos: V3; out: V2; width: number; k?: number }[];
    /** visual-polish #5: the building's three sign colours (signColor / signColor2 / signColor3), for the night light
     *  spill under its signs. Optional: older graphs carry none (the spill then uses a warm white). */
    signColors?: [V3, V3, V3];
    /** Real facade height (city units). */
    height: number;
    /** (D1 frontage dressing) the building archetype, the entrance opening (city units) and whether the building
     *  already hangs its own noren / awning — so the frontage pass never doubles one up. Optional: older graphs
     *  (and the basic-box path) carry none, and the pass then skips the door dressing. */
    archetype?: string;
    doorW?: number;
    doorH?: number;
    /** Ground-floor Y of the building (city units, absolute) — the door sill. */
    doorY?: number;
    ownNoren?: boolean;
    ownAwning?: boolean;
}

type LotWithMeta = Lot & { buildingMeta?: CityLotMeta };

export function setLotMeta(lot: Lot, m: CityLotMeta): void { (lot as LotWithMeta).buildingMeta = m; }
export function lotMeta(lot: Lot): CityLotMeta | undefined { return (lot as LotWithMeta).buildingMeta; }
export function clearLotMeta(lot: Lot): void { delete (lot as LotWithMeta).buildingMeta; }
