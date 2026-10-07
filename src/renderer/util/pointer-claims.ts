/**
 * Pointer CLAIMS — a capture-phase tool marks an event as "mine" WITHOUT stopping it (mobile-parity 7.3b P1).
 *
 * UV / surface paint must let every finger through to the OrbitController (it pinches and two-finger-orbits only if it
 * sees each finger), so it can't stopImmediatePropagation a touch pointerdown the way it does a mouse press. Tools
 * that would otherwise ALSO act on that press (a raster stroke, a mesh-edit face pick) check the claim and stand down.
 * The set is weak: an event is forgotten as soon as it is garbage.
 */

const claimed = new WeakSet<object>();

/** Mark `e` as owned by the caller: other tools should not start anything from it (camera input still may). */
export function claimPointerEvent(e: object): void { claimed.add(e); }

/** Whether a capture-phase tool claimed `e` (see {@link claimPointerEvent}). */
export function isPointerEventClaimed(e: object): boolean { return claimed.has(e); }
