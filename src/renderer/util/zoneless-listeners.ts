/**
 * Zone-agnostic DOM event listeners.
 *
 * When Salsa runs inside an Angular app, Zone.js monkey-patches `EventTarget.prototype.addEventListener`
 * so that EVERY event a listener receives schedules a Zone "task" → which triggers a full Angular change
 * detection cycle when the task completes. For Salsa's high-frequency CANVAS INPUT listeners (pointermove,
 * pointerover, wheel, …) that means every mouse movement over the canvas runs Angular CD over the host's
 * entire component tree — even though Salsa's own handler is cheap and Salsa drives its own render loop.
 *
 * The fix: register those listeners with Zone.js's ORIGINAL (un-patched) `addEventListener`, which Zone
 * stashes on the prototype under `Zone.__symbol__('addEventListener')` (default `__zone_symbol__addEventListener`).
 * A listener added that way is a plain native listener — Zone never sees its events, so it never wakes Angular.
 *
 * This is fully feature-detected: if Zone.js isn't present (a non-Angular host, tests, etc.) it falls back to
 * the normal `addEventListener`, so Salsa stays framework-agnostic. IMPORTANT: a listener added with
 * {@link addZonelessListener} must be removed with {@link removeZonelessListener} using the SAME handler
 * reference, so keep handlers as stable bound fields.
 *
 * Trade-off to be aware of on the host side: because these handlers run OUTSIDE Angular's zone, any callback
 * Salsa makes back into the host from them (e.g. selection / scene-graph-changed) also runs outside the zone.
 * If the host needs Angular to update in response, it should re-enter the zone in that callback
 * (`ngZone.run(...)`) or use OnPush + `markForCheck()`. Forcing CD on every raw pointer event — which is what
 * we're removing — is exactly the bug.
 */

/** Resolve Zone's un-patched original for `patchedName` on `el`, or null when Zone isn't patching it. */
function unpatched(el: EventTarget, patchedName: 'addEventListener' | 'removeEventListener'): ((...a: unknown[]) => void) | null {
  const Zone = (globalThis as unknown as { Zone?: { __symbol__?: (n: string) => string } }).Zone;
  const sym = (Zone && typeof Zone.__symbol__ === 'function') ? Zone.__symbol__(patchedName) : '__zone_symbol__' + patchedName;
  const fn = (el as unknown as Record<string, unknown>)[sym];
  return typeof fn === 'function' ? (fn as (...a: unknown[]) => void) : null;
}

/** Like `el.addEventListener`, but bypasses Zone.js so the listener's events never trigger Angular CD. */
export function addZonelessListener(
  el: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject | ((event: any) => void),
  options?: boolean | AddEventListenerOptions,
): void {
  const raw = unpatched(el, 'addEventListener');
  if (raw) raw.call(el, type, handler, options);
  else el.addEventListener(type, handler as EventListenerOrEventListenerObject, options);
}

/** Remove a listener added via {@link addZonelessListener} (same handler + options). */
export function removeZonelessListener(
  el: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject | ((event: any) => void),
  options?: boolean | EventListenerOptions,
): void {
  const raw = unpatched(el, 'removeEventListener');
  if (raw) raw.call(el, type, handler, options);
  else el.removeEventListener(type, handler as EventListenerOrEventListenerObject, options);
}
