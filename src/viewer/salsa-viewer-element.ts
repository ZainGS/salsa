/**
 * SalsaViewerElement — `<salsa-viewer url="...">` custom element.
 *
 * Delegates all rendering to SalsaViewerCore. Handles shadow DOM,
 * ResizeObserver, URL attribute watching, and WebGPU fallback messaging.
 */

import { SalsaViewerCore } from './salsa-viewer-core';

const TEMPLATE = `
<style>
  :host {
    display: block;
    position: relative;
    overflow: hidden;
    background: #111;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .thumbnail {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    opacity: 1;
    transition: opacity 0.3s ease;
  }
  .thumbnail.hidden { opacity: 0; pointer-events: none; }
  .spinner-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(17,17,17,0.6);
    opacity: 1;
    transition: opacity 0.3s ease;
  }
  .spinner-overlay.hidden { opacity: 0; pointer-events: none; }
  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(255,255,255,0.15);
    border-top-color: rgba(255,255,255,0.7);
    border-radius: 50%;
    animation: salsa-spin 0.8s linear infinite;
  }
  @keyframes salsa-spin { to { transform: rotate(360deg); } }
  .fallback {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: sans-serif;
    font-size: 14px;
    color: #888;
    background: #111;
  }
</style>
<canvas></canvas>
<img class="thumbnail hidden" alt="">
<div class="spinner-overlay hidden"><div class="spinner"></div></div>
`;

export class SalsaViewerElement extends HTMLElement {
  static readonly observedAttributes = ['url'];

  private _core: SalsaViewerCore | null = null;
  private _canvas!: HTMLCanvasElement;
  private _thumbnailImg!: HTMLImageElement;
  private _spinnerOverlay!: HTMLDivElement;
  private _resizeObserver!: ResizeObserver;
  private _pendingUrl: string | null = null;

  connectedCallback(): void {
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = TEMPLATE;
    this._canvas = shadow.querySelector('canvas')!;
    this._thumbnailImg = shadow.querySelector('.thumbnail') as HTMLImageElement;
    this._spinnerOverlay = shadow.querySelector('.spinner-overlay') as HTMLDivElement;

    if (!navigator.gpu) {
      // No WebGPU — try to show thumbnail from the pending URL as a static preview
      const url = this._pendingUrl ?? this.getAttribute('url');
      if (url) {
        this._peekAndShowThumbnail(url);
      } else {
        this._showFallback(shadow, 'WebGPU required (Chrome 113+ or Edge 113+)');
      }
      return;
    }

    this._core = new SalsaViewerCore(this._canvas);
    this._core.init().then(ok => {
      if (!ok) {
        this._showFallback(shadow, 'WebGPU initialization failed');
        return;
      }
      this._resizeObserver = new ResizeObserver(() => this._core!.resize());
      this._resizeObserver.observe(this);
      this._core!.resize();

      const url = this._pendingUrl ?? this.getAttribute('url');
      if (url) this._load(url);
    });
  }

  disconnectedCallback(): void {
    this._resizeObserver?.disconnect();
    this._core?.destroy();
    this._core = null;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'url' && value) {
      if (this._core) {
        this._load(value);
      } else {
        this._pendingUrl = value;
      }
    }
  }

  /** Programmatic load — alternative to the `url` attribute. */
  async load(urlOrBlob: string | Blob): Promise<void> {
    if (!this._core) throw new Error('SalsaViewer not initialized');
    if (typeof urlOrBlob === 'string') {
      await this._core.loadUrl(urlOrBlob);
    } else {
      await this._core.loadBlob(urlOrBlob);
    }
  }

  private async _load(url: string): Promise<void> {
    this._setSpinner(true);
    try {
      // Fetch the blob so we can peek the thumbnail before full parse
      const blob = await fetch(url).then(r => {
        if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
        return r.blob();
      });

      // Show thumbnail immediately as placeholder while scene loads
      const thumb = await SalsaViewerCore.peekThumbnailFromBlob(blob);
      if (thumb) {
        this._thumbnailImg.src = thumb;
        this._thumbnailImg.classList.remove('hidden');
      }

      await this._core!.loadBlob(blob);

      // Fade out thumbnail once the scene is rendering
      this._thumbnailImg.classList.add('hidden');
    } catch (e) {
      console.error('[salsa-viewer] load failed:', e);
    } finally {
      this._setSpinner(false);
    }
  }

  private async _peekAndShowThumbnail(url: string): Promise<void> {
    try {
      const blob = await fetch(url).then(r => r.ok ? r.blob() : null);
      if (!blob) return;
      const thumb = await SalsaViewerCore.peekThumbnailFromBlob(blob);
      if (thumb) {
        this._thumbnailImg.src = thumb;
        this._thumbnailImg.classList.remove('hidden');
      } else {
        this._showFallback(this.shadowRoot!, 'WebGPU required (Chrome 113+ or Edge 113+)');
      }
    } catch {
      this._showFallback(this.shadowRoot!, 'WebGPU required (Chrome 113+ or Edge 113+)');
    }
  }

  private _setSpinner(visible: boolean): void {
    if (visible) {
      this._spinnerOverlay.classList.remove('hidden');
    } else {
      this._spinnerOverlay.classList.add('hidden');
    }
  }

  private _showFallback(shadow: ShadowRoot, msg: string): void {
    const div = document.createElement('div');
    div.className = 'fallback';
    div.textContent = msg;
    shadow.appendChild(div);
  }
}

customElements.define('salsa-viewer', SalsaViewerElement);
