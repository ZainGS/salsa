/**
 * Run a document-capturing task only while the editor is IDLE (not in Play / UI preview / Player mode).
 *
 * Why (bug-hunt 2026-10-01, the G2 follow-up): while Play runs, the scene holds the IN-GAME frame — walked-to player
 * and script transforms, the first-person-hidden player, script hides, mid-stride loco poses, the Play camera, UI vars.
 * A gather made then captures that frame. `DocumentPersistence.saveNow` already DEFERS until Stop for this reason; this
 * helper gives the same rule to the other gather paths (`packProject` = the .frogmarks export, `exportFrogcart`).
 *
 * Deferring (instead of serializing a reconstructed pre-Play state while playing) reuses the one tested restore path:
 * Stop puts every in-game change back, so a gather right after Stop is the editor state by construction. Rebuilding the
 * editor view of transforms + visibility + poses + camera + UI vars at gather time would duplicate each Stop restore
 * path, and any one missed would silently export corruption.
 *
 * Semantics:
 *  - busy at call time → wait (poll) until idle, then run;
 *  - the editor became busy again while the task ran (Play started mid-gather) → discard that result, wait, run again;
 *    the same when the task THREW and the editor is busy afterwards (the GPU device was lost mid-read-back);
 *  - `isStale()` true while waiting (e.g. another document was loaded) → reject with `IdleGateStaleError`, so an export
 *    asked for document A never silently packs document B.
 */
export class IdleGateStaleError extends Error {
  constructor(message = 'The document changed while the export was waiting for Play to stop') {
    super(message);
    this.name = 'IdleGateStaleError';
  }
}

export interface IdleGateOptions {
  /** Poll interval while busy (ms). Default 250 (the saveNow deferral's interval). */
  pollMs?: number;
  /** Checked each poll and after the task: true = the request no longer applies (reject). */
  isStale?: () => boolean;
  /** Called once if the task had to wait (for a host notice: "export will finish when you stop Play"). */
  onDeferred?: () => void;
  /** A counter that moves whenever a busy period starts (e.g. the GPU device-loss count). A task that spanned a whole
   *  busy period (lost AND recovered while it ran) is run again, like one that ended busy. */
  busyEpoch?: () => number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runWhenIdle<T>(isBusy: () => boolean, task: () => Promise<T>, opts: IdleGateOptions = {}): Promise<T> {
  const pollMs = opts.pollMs ?? 250;
  const sleep = opts.sleep ?? defaultSleep;
  let notified = false;
  for (;;) {
    while (isBusy()) {
      if (!notified) { notified = true; try { opts.onDeferred?.(); } catch { /* host callback */ } }
      if (opts.isStale?.()) throw new IdleGateStaleError();
      await sleep(pollMs);
    }
    if (opts.isStale?.()) throw new IdleGateStaleError();
    let result: T;
    const epoch0 = opts.busyEpoch?.();
    try { result = await task(); }
    catch (e) {
      // The editor went busy while the task ran and the task failed (a GPU device lost mid-read-back rejects): that
      // failure belongs to the busy period, not to the request. Wait and run again; a failure while idle is real.
      if (!isBusy() && opts.busyEpoch?.() === epoch0) throw e;
      continue;
    }
    if (!isBusy() && opts.busyEpoch?.() === epoch0) {
      if (opts.isStale?.()) throw new IdleGateStaleError();
      return result;
    }
    // Play started while the (async) task ran: the result may hold in-game state. Drop it and go round again.
  }
}
