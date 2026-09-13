/**
 * src/ui/ui-sound.ts
 *
 * UISoundPlayer — applies the UI System's sound actions (playSound / stopSound / setVolume) with plain
 * HTMLAudioElements. The registry maps the actions' `assetId` to a playable URL (object URL, data URL, or
 * bundled path) — the HOST registers assets (`sm.registerUISound`); the state machine only ever speaks assetIds,
 * so machines stay portable while asset storage stays a host concern (bundling audio into `.frogcart` is future).
 *
 * One element per assetId: `play` restarts from 0 (retriggering a click blip feels right), `loop` for music beds,
 * `setVolume` applies live and persists for the next play. All methods no-op on unknown/unregistered ids.
 */

export class UISoundPlayer {
  private readonly _urls = new Map<string, string>();
  private readonly _els = new Map<string, HTMLAudioElement>();
  private readonly _volumes = new Map<string, number>();

  /** Register (or replace) a playable URL for an assetId. */
  register(assetId: string, url: string): void {
    if (this._urls.get(assetId) === url) return;
    this._urls.set(assetId, url);
    this._els.get(assetId)?.pause();
    this._els.delete(assetId);   // stale element pointed at the old URL
  }

  unregister(assetId: string): void {
    this.stop(assetId);
    this._urls.delete(assetId);
    this._els.delete(assetId);
  }

  listSounds(): string[] { return [...this._urls.keys()]; }

  /** Registered assetId→url pairs (the .frogcart exporter fetches these to bundle audio into the cart). */
  getRegisteredSounds(): { assetId: string; url: string }[] {
    return [...this._urls.entries()].map(([assetId, url]) => ({ assetId, url }));
  }

  play(assetId: string, volume?: number, loop?: boolean): void {
    const url = this._urls.get(assetId);
    if (!url || typeof Audio === 'undefined') return;
    let el = this._els.get(assetId);
    if (!el) { el = new Audio(url); this._els.set(assetId, el); }
    if (volume != null) this._volumes.set(assetId, volume);
    el.volume = Math.max(0, Math.min(1, this._volumes.get(assetId) ?? 1));
    el.loop = loop ?? false;
    el.currentTime = 0;
    void el.play().catch(() => { /* autoplay policy — needs a user gesture first; non-fatal */ });
  }

  stop(assetId: string): void {
    const el = this._els.get(assetId);
    if (el) { el.pause(); el.currentTime = 0; }
  }

  setVolume(assetId: string, volume: number): void {
    this._volumes.set(assetId, volume);
    const el = this._els.get(assetId);
    if (el) el.volume = Math.max(0, Math.min(1, volume));
  }

  /** Silence everything (leaving preview / Player mode). */
  stopAll(): void { for (const id of this._els.keys()) this.stop(id); }

  destroy(): void {
    this.stopAll();
    this._els.clear();
    this._urls.clear();
    this._volumes.clear();
  }
}
