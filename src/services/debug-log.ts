/**
 * Salsa debug console logging.
 *
 * Diagnostics that are useful when profiling but noisy in normal use (the load-path timing
 * breakdowns — {@link ../managers/world-manager}'s `generateWorld` per-phase split and
 * {@link ./shape-manager}'s `restoreProceduralFromSave3D` per-step split, etc.) route through
 * {@link debugLog} instead of `console.log`, so they stay silent unless debugging is enabled.
 *
 * To see them: either flip `enableConsoleDebug` to `true` here in code, or call
 * `setConsoleDebug(true)` at runtime (e.g. from the browser console if it's been exposed).
 */
export const debugFlags = { enableConsoleDebug: false };

/** Toggle the gated debug console logs at runtime (no rebuild needed). */
export function setConsoleDebug(on: boolean): void {
    debugFlags.enableConsoleDebug = on;
}

/** `console.log`, but only when {@link debugFlags.enableConsoleDebug} is on. Same args as console.log. */
export function debugLog(...args: unknown[]): void {
    if (debugFlags.enableConsoleDebug) console.log(...args);
}
