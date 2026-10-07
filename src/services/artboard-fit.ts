/**
 * Artboard fit math (ShapeManager.fitArtboard). Pure, so it is unit-tested without a renderer.
 *
 * The 2D illustration view maps the artboard's height (world height 2) to the canvas height at zoom 1, and the
 * InteractionService world matrix turns a pan offset into a screen shift of pan / 2 canvas (device) pixels, +x right,
 * +y down (see InteractionService.updateWorldMatrix).
 */

/** CSS pixels of the canvas covered by host UI on each side (tool rail, open panels, timeline, top bar, ...). */
export interface ArtboardFitInsets {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}

export interface ArtboardFitInput {
    /** Canvas size in CSS pixels (clientWidth / clientHeight). */
    cssWidth: number;
    cssHeight: number;
    /** Canvas backing-store size in device pixels (canvas.width / canvas.height). */
    pxWidth: number;
    pxHeight: number;
    /** Document (artboard) size in pixels; only its aspect is used. */
    docWidth: number;
    docHeight: number;
    insets?: ArtboardFitInsets | null;
}

/** Share of the visible area the artboard fills (the old fixed zoom was 0.85 of the full canvas height). */
export const ARTBOARD_FIT_FILL = 0.85;
/** Insets that would leave less than this many CSS px visible on an axis are ignored on that axis. */
const MIN_VISIBLE_PX = 64;

/**
 * Zoom + pan that centre the whole artboard in the visible part of the canvas (the canvas minus `insets`) and fill
 * ARTBOARD_FIT_FILL of it, limited by whichever of width / height runs out first (an artboard wider than the visible
 * area used to overflow sideways at the fixed zoom 0.85). Without insets the visible area is the whole canvas.
 */
export function computeArtboardFit(input: ArtboardFitInput): { zoom: number; panX: number; panY: number } {
    const { cssWidth: cw, cssHeight: ch, pxWidth, pxHeight, docWidth, docHeight } = input;
    if (!(cw > 0) || !(ch > 0) || !(docWidth > 0) || !(docHeight > 0)) return { zoom: ARTBOARD_FIT_FILL, panX: 0, panY: 0 };
    const clamp = (v: number | undefined) => Math.max(0, Number.isFinite(v as number) ? (v as number) : 0);
    let left = clamp(input.insets?.left), right = clamp(input.insets?.right);
    let top = clamp(input.insets?.top), bottom = clamp(input.insets?.bottom);
    if (cw - left - right < MIN_VISIBLE_PX) { left = 0; right = 0; }
    if (ch - top - bottom < MIN_VISIBLE_PX) { top = 0; bottom = 0; }
    const visW = cw - left - right;
    const visH = ch - top - bottom;

    const aspect = docWidth / docHeight;
    const artH = ARTBOARD_FIT_FILL * Math.min(visH, visW / aspect);   // artboard height on screen, CSS px
    const zoom = artH / ch;

    // Shift the artboard centre from the canvas centre to the visible area's centre (CSS px → device px → pan).
    const dx = left + visW / 2 - cw / 2;
    const dy = top + visH / 2 - ch / 2;
    const sx = pxWidth > 0 ? pxWidth / cw : 1;
    const sy = pxHeight > 0 ? pxHeight / ch : 1;
    return { zoom, panX: 2 * dx * sx, panY: 2 * dy * sy };
}
