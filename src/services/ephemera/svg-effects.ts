/**
 * Post-process a generated ephemera SVG with a soft glow and/or a feather (edge fade), by
 * injecting SVG filters/masks and wrapping the content. Pure string surgery — works on any
 * generator's `<svg …>…</svg>` output. Returns the SVG unchanged if no effects are requested
 * (or if the SVG shape is unexpected). Decorated output rasterizes + caches like any other SVG.
 */

export interface EphemeraGlow {
  /** Blur radius (stdDeviation), SVG user units. 0 = off. */
  radius: number;
  /** Glow color (any CSS color). */
  color: string;
  /** 0–1. Default 1. */
  opacity?: number;
}

export interface EphemeraFeather {
  /** 'radial' fades from center outward; 'linear' fades along an axis. */
  mode: 'radial' | 'linear';
  /** 0–1: where the content is still fully opaque. */
  start: number;
  /** 0–1: where it has faded to transparent. */
  end: number;
  /** Linear-mode direction in degrees (0 = →, 90 = ↓). */
  angle?: number;
}

const SVG_RE = /^(\s*<svg\b[^>]*>)([\s\S]*)(<\/svg>\s*)$/;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function decorateEphemeraSvg(
  svg: string,
  glow?: EphemeraGlow | null,
  feather?: EphemeraFeather | null,
): string {
  const hasGlow = !!glow && glow.radius > 0;
  const hasFeather = !!feather;
  if (!hasGlow && !hasFeather) return svg;

  const m = SVG_RE.exec(svg);
  if (!m) return svg; // unexpected shape — leave untouched
  const open = m[1], inner = m[2], close = m[3];
  const w = Number(/\bwidth="([\d.]+)"/.exec(open)?.[1] ?? 0);
  const h = Number(/\bheight="([\d.]+)"/.exec(open)?.[1] ?? 0);

  const defs: string[] = [];
  let wrapOpen = '';
  let wrapClose = '';

  // ── Glow (inner-most): blurred, color-flooded copy behind the original ──
  if (hasGlow) {
    const op = clamp01(glow!.opacity ?? 1);
    defs.push(
      `<filter id="ph-glow" x="-50%" y="-50%" width="200%" height="200%">` +
        `<feGaussianBlur in="SourceAlpha" stdDeviation="${glow!.radius}" result="b"/>` +
        `<feFlood flood-color="${glow!.color}" flood-opacity="${op}" result="c"/>` +
        `<feComposite in="c" in2="b" operator="in" result="g"/>` +
        `<feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>` +
      `</filter>`,
    );
    wrapOpen = `<g filter="url(#ph-glow)">`;
    wrapClose = `</g>`;
  }

  // ── Feather (outer-most): luminance mask, white→black gradient fades the edge ──
  if (hasFeather && w > 0 && h > 0) {
    const s = clamp01(feather!.start);
    const e = clamp01(feather!.end);
    if (feather!.mode === 'linear') {
      const a = ((feather!.angle ?? 90) * Math.PI) / 180;
      const dx = Math.cos(a), dy = Math.sin(a);
      const x1 = (0.5 - dx * 0.5).toFixed(3), y1 = (0.5 - dy * 0.5).toFixed(3);
      const x2 = (0.5 + dx * 0.5).toFixed(3), y2 = (0.5 + dy * 0.5).toFixed(3);
      defs.push(`<linearGradient id="ph-fg" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="${s}" stop-color="#fff"/><stop offset="${e}" stop-color="#000"/></linearGradient>`);
    } else {
      defs.push(`<radialGradient id="ph-fg" cx="0.5" cy="0.5" r="0.7071"><stop offset="${s}" stop-color="#fff"/><stop offset="${e}" stop-color="#000"/></radialGradient>`);
    }
    defs.push(`<mask id="ph-feather"><rect x="0" y="0" width="${w}" height="${h}" fill="url(#ph-fg)"/></mask>`);
    wrapOpen = `<g mask="url(#ph-feather)">` + wrapOpen;
    wrapClose = wrapClose + `</g>`;
  }

  return `${open}<defs>${defs.join('')}</defs>${wrapOpen}${inner}${wrapClose}${close}`;
}
