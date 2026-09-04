/**
 * interaction — the "use" verb for Play mode (docs/specs/play-mode.md).
 *
 * The ACTIVE counterpart to passive trigger volumes: registered interactables (doors, signs, NPCs, chests, pickups)
 * that the player can press-to-use when close enough. Each tick the Play loop asks for the nearest interactable in
 * range (→ the host shows a "Press F" prompt); on the interact key it fires an `interact` trigger for that id, which
 * dispatches into the UI state machine like enter/exit volumes. Pure + deterministic so it's unit-testable.
 */

export type Vec3 = [number, number, number];

export interface Interactable {
  id: string;
  /** World position of the interactable (usually the object's centre). */
  position: Vec3;
  /** Max distance (world units) the player can be from `position` to use it. */
  range: number;
}

/** The nearest interactable within its own range of the player, or null if none is in reach. 3D distance. */
export function nearestInteractable(playerPos: Vec3, list: readonly Interactable[]): { id: string; distance: number } | null {
  let best: { id: string; distance: number } | null = null;
  for (const it of list) {
    const dx = it.position[0] - playerPos[0], dy = it.position[1] - playerPos[1], dz = it.position[2] - playerPos[2];
    const d = Math.hypot(dx, dy, dz);
    if (d <= it.range && (!best || d < best.distance)) best = { id: it.id, distance: d };
  }
  return best;
}

export class InteractionSystem {
  private _items: Interactable[] = [];

  setInteractables(list: Interactable[]): void { this._items = list.slice(); }
  get interactables(): readonly Interactable[] { return this._items; }

  /** The nearest in-range interactable to the player, or null — for the prompt AND to resolve a use-key press. */
  nearest(playerPos: Vec3): { id: string; distance: number } | null {
    return nearestInteractable(playerPos, this._items);
  }
}
