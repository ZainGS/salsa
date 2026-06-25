/**
 * eye-generator.ts — procedural anime eyes, composited with Canvas2D.
 *
 * The "no-drawing" path for the face/eye system: a parameter set → two mirror-symmetric eyes
 * painted into a canvas, which is uploaded into a face expression's texture (same texture the
 * brush would paint). Everything downstream — the face decal, blink, persistence — is unchanged;
 * this just fills the texture from sliders instead of from strokes. See docs/ui/character-creator.md.
 *
 * Coordinates: the canvas maps 1:1 to the flat face-front (UV (0,0) = top-left). Placement params
 * are UV fractions [0,1]; the two eyes sit at u = 0.5 ± spacing/2 on the eye line (verticalPos),
 * outer corners pointing away from centre.
 *
 * Aspect: the face decal is wider than it is tall, but the texture is square — so a circle in the
 * texture would render stretched (almond) on the face. `renderEyes(..., aspect)` pre-squishes each
 * eye horizontally by 1/aspect so circles stay round and `width`/`height` map to the VISUAL shape.
 */

export interface EyeHighlight {
    /** Position within the iris, −1..1 (0 = centre; x>0 = outer side, y<0 = up). */
    x: number;
    y: number;
    /** Radius as a fraction of the iris radius. */
    radius: number;
    color: string;
}

export interface EyeParams {
    // ── Placement (UV fractions of the face canvas) ──
    /** Gap between the two eye centres. */
    spacing: number;
    /** Eye-line height (0 = top of canvas, 1 = bottom). */
    verticalPos: number;

    // ── Eye shape (UV fractions; with aspect compensation these are the VISUAL proportions) ──
    width: number;
    height: number;
    /** Outer-corner lift, fraction of half-height (0 = level, + = cat-eye). */
    tilt: number;
    /** 0 = almond, 1 = big round. Controls lid bulge. */
    roundness: number;

    // ── Sclera (white of the eye) ──
    scleraColor: string;

    // ── Iris ──
    irisColor: string;
    /** Iris radius as a fraction of the eye half-height. ~1.0 = fills the lids. */
    irisRadius: number;
    irisGradient: boolean;
    irisColorTop: string;
    irisColorBottom: string;
    limbalRing: boolean;
    limbalColor: string;
    /** Limbal-ring thickness as a fraction of the iris radius. */
    limbalThickness: number;

    // ── Pupil ──
    pupilColor: string;
    /** Pupil radius as a fraction of the iris radius. */
    pupilRadius: number;

    // ── Gaze (iris look direction; the lid clips the iris as it moves toward an edge) ──
    /** Horizontal look, −1..1 (+ = screen-right). Both eyes look the same screen direction. */
    gazeX: number;
    /** Vertical look, −1..1 (+ = down). */
    gazeY: number;

    // ── Highlights ──
    highlights: EyeHighlight[];

    // ── Lashes / lids ──
    /** Upper-lash line thickness, fraction of eye height. */
    upperLashThickness: number;
    upperLashColor: string;
    /** Outer-corner lash flick length, 0..1. */
    outerLashLength: number;
    lowerLash: boolean;
    doubleEyelid: boolean;

    // ── Render ──
    /** Internal render resolution (px) for a chunky low-res (PS1/dollcore) look. 0 = crisp/full-res. */
    pixelResolution: number;

    // ── Blink ──
    /** Render a closed eye (a downward lash arc) — used by the blink state. */
    closed: boolean;

    // ── Under-eye decoration (e.g. the reference girl's dots) ──
    underDeco: boolean;
    underDecoColor: string;
    underDecoCount: number;
}

/** The default "anime girl" preset — round, cat-eyed lavender eyes, low-res (dollcore) by default. */
export function defaultEyeParams(): EyeParams {
    return {
        spacing: 0.44, verticalPos: 0.52,
        width: 0.32, height: 0.30, tilt: 0.22, roundness: 0.85,
        scleraColor: '#ffffff',
        irisColor: '#9b6fb0',
        irisRadius: 1.02, irisGradient: true,
        irisColorTop: '#4a3168', irisColorBottom: '#c9a8e0',
        limbalRing: true, limbalColor: '#3a2750', limbalThickness: 0.12,
        pupilColor: '#241636', pupilRadius: 0.5,
        gazeX: 0, gazeY: 0,
        highlights: [
            { x: -0.30, y: -0.38, radius: 0.34, color: '#ffffff' },
            { x:  0.30, y:  0.28, radius: 0.18, color: '#ffffff' },
        ],
        upperLashThickness: 0.18, upperLashColor: '#241a2e',
        outerLashLength: 0.7, lowerLash: false, doubleEyelid: true,
        pixelResolution: 200,
        closed: false,
        underDeco: true, underDecoColor: '#9ad0e8', underDecoCount: 3,
    };
}

type Ctx2D = CanvasRenderingContext2D;

/**
 * Render both eyes into `ctx` (sized w×h). Clears to transparent first.
 * `aspect` = the face decal's width/height; each eye is squished by 1/aspect so circles stay round.
 */
export function renderEyes(ctx: Ctx2D, p: EyeParams, w: number, h: number, aspect = 1): void {
    ctx.clearRect(0, 0, w, h);

    const cyPx = p.verticalPos * h;
    const halfGap = (p.spacing * w) * 0.5;
    const ewPx = p.width  * w;
    const ehPx = p.height * h;

    // Left eye: outer corner toward u=0 (outerSign −1). Right eye: outer toward u=1 (+1).
    drawEye(ctx, (w * 0.5) - halfGap, cyPx, ewPx, ehPx, -1, p, aspect);
    drawEye(ctx, (w * 0.5) + halfGap, cyPx, ewPx, ehPx, +1, p, aspect);
}

/** One eye centred at (cx, cy). `outerSign` = +1 puts the outer corner on the +x side. */
function drawEye(
    ctx: Ctx2D, cx: number, cy: number, ew: number, eh: number, outerSign: number, p: EyeParams, aspect: number,
): void {
    ctx.save();
    // Aspect compensation: squish the whole eye horizontally so a round iris renders round on the
    // wide-but-short decal. Centred on (cx, cy) so placement/spacing are unaffected.
    if (aspect && Math.abs(aspect - 1) > 1e-3) {
        ctx.translate(cx, cy);
        ctx.scale(1 / aspect, 1);
        ctx.translate(-cx, -cy);
    }

    const hw = ew * 0.5, hh = eh * 0.5;
    const innerX = cx - outerSign * hw, innerY = cy + hh * 0.12;
    const outerX = cx + outerSign * hw, outerY = cy - hh * p.tilt;
    const round  = p.roundness;

    // Upper- and lower-lid bezier control points (peak/trough scale with roundness).
    const upCp1x = cx - outerSign * hw * 0.55, upCp1y = cy - hh * (0.80 + 0.55 * round);
    const upCp2x = cx + outerSign * hw * 0.60, upCp2y = cy - hh * (0.80 + 0.55 * round);
    const loCp1x = cx + outerSign * hw * 0.45, loCp1y = cy + hh * (0.35 + 0.70 * round);
    const loCp2x = cx - outerSign * hw * 0.45, loCp2y = cy + hh * (0.35 + 0.70 * round);

    const traceUpperLid = () => {
        ctx.moveTo(innerX, innerY);
        ctx.bezierCurveTo(upCp1x, upCp1y, upCp2x, upCp2y, outerX, outerY);
    };

    if (p.closed) {
        // ── Closed (blink): just a downward lash arc, no eyeball ──
        ctx.strokeStyle = p.upperLashColor;
        ctx.lineWidth   = Math.max(2, eh * p.upperLashThickness);
        ctx.lineCap     = 'round';
        ctx.beginPath();
        ctx.moveTo(innerX, cy);
        ctx.quadraticCurveTo(cx, cy + hh * 0.55, outerX, outerY);
        ctx.stroke();
    } else {
        // ── Eyeball, clipped to the lid outline ──
        ctx.save();
        ctx.beginPath();
        traceUpperLid();
        ctx.bezierCurveTo(loCp1x, loCp1y, loCp2x, loCp2y, innerX, innerY);   // lower lid
        ctx.closePath();
        ctx.clip();

        ctx.fillStyle = p.scleraColor;
        ctx.fillRect(cx - hw - 2, cy - hh * 2 - 2, ew + 4, eh * 3 + 4);

        // Iris — sits a touch high so the upper lid covers its top (the classic anime peek), and
        // shifts with gaze. The clip path (lid outline) is fixed, so it trims the iris at the edge
        // as it looks around. Offsets are in visual proportion (the per-eye squish handles aspect).
        const gx = Math.max(-1, Math.min(1, p.gazeX ?? 0));
        const gy = Math.max(-1, Math.min(1, p.gazeY ?? 0));
        const irisCx = cx + gx * hw * 0.6;
        const irisCy = cy - hh * 0.05 + gy * hh * 0.55;
        const irisR  = hh * p.irisRadius;
        ctx.beginPath();
        ctx.ellipse(irisCx, irisCy, irisR, irisR, 0, 0, Math.PI * 2);
        if (p.irisGradient) {
            const g = ctx.createLinearGradient(0, irisCy - irisR, 0, irisCy + irisR);
            g.addColorStop(0, p.irisColorTop);
            g.addColorStop(1, p.irisColorBottom);
            ctx.fillStyle = g;
        } else {
            ctx.fillStyle = p.irisColor;
        }
        ctx.fill();

        if (p.limbalRing) {
            const lr = irisR - (irisR * p.limbalThickness) * 0.5;
            ctx.beginPath();
            ctx.ellipse(irisCx, irisCy, lr, lr, 0, 0, Math.PI * 2);
            ctx.strokeStyle = p.limbalColor;
            ctx.lineWidth   = Math.max(1, irisR * p.limbalThickness);
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.ellipse(irisCx, irisCy, irisR * p.pupilRadius, irisR * p.pupilRadius, 0, 0, Math.PI * 2);
        ctx.fillStyle = p.pupilColor;
        ctx.fill();

        for (const hgl of p.highlights) {
            const r = Math.max(1, hgl.radius * irisR);
            ctx.beginPath();
            ctx.ellipse(irisCx + outerSign * hgl.x * irisR, irisCy + hgl.y * irisR, r, r, 0, 0, Math.PI * 2);
            ctx.fillStyle = hgl.color;
            ctx.fill();
        }
        ctx.restore();   // un-clip

        // ── Lids / lashes on top of the eyeball ──
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        traceUpperLid();
        ctx.strokeStyle = p.upperLashColor;
        ctx.lineWidth   = Math.max(2, eh * p.upperLashThickness);
        ctx.stroke();

        if (p.lowerLash) {
            ctx.beginPath();
            ctx.moveTo(outerX, outerY);
            ctx.bezierCurveTo(loCp1x, loCp1y, loCp2x, loCp2y, innerX, innerY);
            ctx.strokeStyle = p.upperLashColor;
            ctx.lineWidth   = Math.max(1, eh * p.upperLashThickness * 0.35);
            ctx.stroke();
        }

        if (p.doubleEyelid) {
            ctx.beginPath();
            ctx.moveTo(innerX, innerY - hh * 0.20);
            ctx.bezierCurveTo(upCp1x, upCp1y - hh * 0.22, upCp2x, upCp2y - hh * 0.22, outerX, outerY - hh * 0.12);
            ctx.strokeStyle = p.upperLashColor;
            ctx.globalAlpha = 0.45;
            ctx.lineWidth   = Math.max(1, eh * p.upperLashThickness * 0.25);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
    }

    drawOuterLashes(ctx, outerX, outerY, outerSign, eh, p);
    if (p.underDeco) drawUnderDeco(ctx, cx, cy + hh, eh, p);
    ctx.restore();
}

/** Short lash flicks fanning up-and-out from the outer corner (the cat-eye). */
function drawOuterLashes(
    ctx: Ctx2D, outerX: number, outerY: number, outerSign: number, eh: number, p: EyeParams,
): void {
    if (p.outerLashLength <= 0) return;
    const len = eh * 0.6 * p.outerLashLength;
    ctx.save();
    ctx.strokeStyle = p.upperLashColor;
    ctx.lineWidth   = Math.max(1.5, eh * p.upperLashThickness * 0.7);
    ctx.lineCap     = 'round';
    for (const [dx, dy] of [[1.15, -0.7], [1.25, -0.25], [1.0, 0.2]]) {
        ctx.beginPath();
        ctx.moveTo(outerX, outerY);
        ctx.lineTo(outerX + outerSign * dx * len, outerY + dy * len);
        ctx.stroke();
    }
    ctx.restore();
}

/** A small row of dots under the eye (the reference girl's deco). */
function drawUnderDeco(ctx: Ctx2D, cx: number, eyeBottomY: number, eh: number, p: EyeParams): void {
    const n = Math.max(0, Math.floor(p.underDecoCount));
    if (n === 0) return;
    const r = eh * 0.06;
    const gap = r * 3.2;
    const y = eyeBottomY + eh * 0.45;
    const x0 = cx - (gap * (n - 1)) * 0.5;
    ctx.save();
    ctx.fillStyle = p.underDecoColor;
    for (let i = 0; i < n; i++) {
        ctx.beginPath();
        ctx.ellipse(x0 + i * gap, y, r, r, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}
