import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

const SAMPLES = 80;

// Solve 2θ + sin(2θ) = π·sin(φ) iteratively (Newton-Raphson)
function mollweideTheta(lat: number): number {
  if (Math.abs(lat) === Math.PI / 2) return lat > 0 ? Math.PI / 2 : -Math.PI / 2;
  let th = lat;
  const target = Math.PI * Math.sin(lat);
  for (let i = 0; i < 10; i++) {
    const dth = -(2 * th + Math.sin(2 * th) - target) / (2 + 2 * Math.cos(2 * th));
    th += dth;
    if (Math.abs(dth) < 1e-7) break;
  }
  return th;
}

function mollweideProject(lat: number, lon: number, rotY: number, r: number, cx: number, cy: number): [number, number] {
  const adjLon = lon - rotY;
  const normLon = ((adjLon + Math.PI) % (2 * Math.PI)) - Math.PI;
  const th = mollweideTheta(lat);
  const x = cx + r * (2 * Math.SQRT2 / Math.PI) * normLon * Math.cos(th);
  const y = cy - r * Math.SQRT2 * Math.sin(th);
  return [x, y];
}

function buildMollweide(
  latLines: number,
  lonLines: number,
  rotY: number,
  r: number,
  strokeColor: string,
  strokeWidth: number,
  showEquator: boolean,
  style: 'outline' | 'filled' | 'filled-outline',
  fillColor: string,
): string[] {
  const cx = r * 2 * Math.SQRT2;
  const cy = r * Math.SQRT2;
  const paths: string[] = [];

  const buildPath = (pts: [number, number][], sw: number): string => {
    if (pts.length < 2) return '';
    const d = pts.map((p, i) => (i === 0 ? `M${p[0].toFixed(1)},${p[1].toFixed(1)}` : `L${p[0].toFixed(1)},${p[1].toFixed(1)}`)).join(' ');
    return `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${sw}" stroke-linecap="round"/>`;
  };

  // Latitude lines
  const latStep = Math.PI / (latLines + 1);
  for (let li = 1; li <= latLines; li++) {
    const lat = -Math.PI / 2 + li * latStep;
    const isEquator = Math.abs(lat) < 0.001;
    const sw = isEquator && showEquator ? strokeWidth * 2 : strokeWidth;
    const pts: [number, number][] = [];
    for (let si = 0; si <= SAMPLES; si++) {
      const lon = -Math.PI + (si / SAMPLES) * 2 * Math.PI;
      pts.push(mollweideProject(lat, lon, rotY, r, cx, cy));
    }
    paths.push(buildPath(pts, sw));
  }

  // Longitude lines (meridians)
  const lonStep = (2 * Math.PI) / lonLines;
  for (let li = 0; li < lonLines; li++) {
    const lon = -Math.PI + li * lonStep;
    const pts: [number, number][] = [];
    for (let si = 0; si <= SAMPLES; si++) {
      const lat = -Math.PI / 2 + (si / SAMPLES) * Math.PI;
      pts.push(mollweideProject(lat, lon, rotY, r, cx, cy));
    }
    paths.push(buildPath(pts, strokeWidth));
  }

  return paths;
}

export class GlobeMollweideGenerator implements IEphemeraGenerator {
  readonly typeId = 'globe:mollweide';
  readonly categoryId = 'globe';
  readonly displayName = 'Globe (Mollweide)';
  readonly description = 'Equal-area elliptical Mollweide projection with latitude/longitude grid.';

  getDefaultParams(): Record<string, unknown> {
    return {
      size: 200, latLines: 6, lonLines: 12, rotationY: 0,
      style: 'outline', strokeColor: '#000000', fillColor: '#000000',
      strokeWidth: 1, showEquator: true, bgColor: 'transparent',
    };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',        label: 'Size',           type: 'range',  default: 200, min: 60,  max: 400, step: 4,   group: 'Size' },
      { key: 'latLines',    label: 'Latitude lines', type: 'range',  default: 6,   min: 2,   max: 18,  step: 1,   group: 'Grid' },
      { key: 'lonLines',    label: 'Longitude lines',type: 'range',  default: 12,  min: 3,   max: 24,  step: 1,   group: 'Grid' },
      { key: 'rotationY',   label: 'Spin (Y)',        type: 'range',  default: 0,   min: -180,max: 180, step: 1,   group: 'Rotation' },
      { key: 'style',       label: 'Style',          type: 'select', default: 'outline',
        options: [{ value: 'outline', label: 'Outline only' }, { value: 'filled', label: 'Filled' }, { value: 'filled-outline', label: 'Filled + grid' }] },
      { key: 'strokeWidth', label: 'Line weight',    type: 'range',  default: 1,   min: 0.5, max: 3,   step: 0.25, group: 'Appearance' },
      { key: 'strokeColor', label: 'Line color',     type: 'color',  default: '#000000', group: 'Appearance' },
      { key: 'fillColor',   label: 'Fill color',     type: 'color',  default: '#000000', group: 'Appearance' },
      { key: 'showEquator', label: 'Bold equator',   type: 'toggle', default: true, group: 'Appearance' },
      { key: 'bgColor',     label: 'Background',     type: 'color',  default: 'transparent', group: 'Appearance' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    const size        = Number(p['size']        ?? 200);
    const latLines    = Math.round(Number(p['latLines']   ?? 6));
    const lonLines    = Math.round(Number(p['lonLines']   ?? 12));
    const rotY        = Number(p['rotationY']  ?? 0) * Math.PI / 180;
    const style       = String(p['style']       ?? 'outline') as 'outline' | 'filled' | 'filled-outline';
    const strokeColor = String(p['strokeColor'] ?? '#000000');
    const fillColor   = String(p['fillColor']   ?? '#000000');
    const strokeWidth = Number(p['strokeWidth'] ?? 1);
    const showEquator = Boolean(p['showEquator'] ?? true);
    const bgColor     = String(p['bgColor']     ?? 'transparent');

    // Mollweide ellipse: width = 2√2·r, height = √2·r
    const r    = size / (2 * Math.SQRT2); // so ellipse width = size
    const svgW = size + strokeWidth * 2;
    const svgH = size / 2 + strokeWidth * 2;
    const cx   = svgW / 2;
    const cy   = svgH / 2;
    const rx   = size / 2;
    const ry   = size / 4;

    const paths = buildMollweide(latLines, lonLines, rotY, r, strokeColor, strokeWidth, showEquator, style, fillColor);

    const bg = bgColor !== 'transparent'
      ? `<rect width="${svgW}" height="${svgH}" fill="${bgColor}"/>`
      : '';

    const filled = (style === 'filled' || style === 'filled-outline')
      ? `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fillColor}"/>`
      : '';

    const clipId = 'mw-clip-' + Math.random().toString(36).slice(2, 6);
    const clipDef = style === 'filled-outline'
      ? `<defs><clipPath id="${clipId}"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/></clipPath></defs>`
      : '';

    // Shift grid paths to match svgW/svgH centering
    const gridShiftX = cx - r * 2 * Math.SQRT2;
    const gridShiftY = cy - r * Math.SQRT2;
    const gridTransform = `translate(${gridShiftX.toFixed(2)},${gridShiftY.toFixed(2)})`;

    const gridPaths = style === 'outline'
      ? `<g transform="${gridTransform}">${paths.join('')}</g>`
      : style === 'filled-outline'
        ? `<g clip-path="url(#${clipId})" transform="${gridTransform}">${paths.map(s => s.replace(new RegExp(`stroke="${strokeColor}"`, 'g'), 'stroke="#ffffff"')).join('')}</g>`
        : '';

    const outline = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">${clipDef}${bg}${filled}${gridPaths}${outline}</svg>`;
  }
}
