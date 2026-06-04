import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

const SAMPLES = 96; // points per curve arc

function sampleGlobe(
  latLines: number,
  lonLines: number,
  rotX: number, // tilt in radians
  rotY: number, // spin in radians
  r: number,
  style: 'outline' | 'filled' | 'filled-outline',
  strokeColor: string,
  fillColor: string,
  strokeWidth: number,
  showEquator: boolean,
): { paths: string[]; filled: boolean } {
  const cx = r + strokeWidth;
  const cy = r + strokeWidth;

  const rotate = (lat: number, lon: number): [number, number, number] => {
    // Sphere coords
    const sx = Math.cos(lat) * Math.cos(lon);
    const sy = Math.sin(lat);
    const sz = Math.cos(lat) * Math.sin(lon);
    // Rotate around Y by rotY
    const x1 = sx * Math.cos(rotY) + sz * Math.sin(rotY);
    const y1 = sy;
    const z1 = -sx * Math.sin(rotY) + sz * Math.cos(rotY);
    // Rotate around X by rotX
    const x2 = x1;
    const y2 = y1 * Math.cos(rotX) - z1 * Math.sin(rotX);
    const z2 = y1 * Math.sin(rotX) + z1 * Math.cos(rotX);
    return [x2, y2, z2];
  };

  const project = (lat: number, lon: number): [number, number, number] => {
    const [x, y, z] = rotate(lat, lon);
    return [cx + x * r, cy - y * r, z]; // z > 0 = front hemisphere
  };

  const buildPath = (points: [number, number, number][], dashed: boolean): string => {
    const front: string[] = [];
    const back: string[] = [];
    let inFront = points[0][2] >= 0;
    let seg: [number, number][] = [];

    const flushSeg = (isFront: boolean) => {
      if (seg.length < 2) { seg = []; return; }
      const d = seg.map((p, i) => (i === 0 ? `M${p[0].toFixed(1)},${p[1].toFixed(1)}` : `L${p[0].toFixed(1)},${p[1].toFixed(1)}`)).join(' ');
      (isFront ? front : back).push(d);
      seg = [];
    };

    for (const [px, py, pz] of points) {
      const nowFront = pz >= 0;
      if (nowFront !== inFront) {
        seg.push([px, py]);
        flushSeg(inFront);
        inFront = nowFront;
      }
      seg.push([px, py]);
    }
    flushSeg(inFront);

    const frontPath = front.length ? `<path d="${front.join(' ')}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round"/>` : '';
    const backPath  = back.length  ? `<path d="${back.join(' ')}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth * 0.4}" stroke-dasharray="${strokeWidth * 2},${strokeWidth * 2}" opacity="0.35"/>` : '';
    return frontPath + backPath;
  };

  const paths: string[] = [];

  // Latitude lines
  const latStep = Math.PI / (latLines + 1);
  for (let li = 0; li <= latLines + 1; li++) {
    const lat = -Math.PI / 2 + li * latStep;
    const isEquator = Math.abs(lat) < 0.001;
    if (li === 0 || li === latLines + 1) continue; // skip poles
    const pts: [number, number, number][] = [];
    for (let si = 0; si <= SAMPLES; si++) {
      const lon = (si / SAMPLES) * 2 * Math.PI;
      pts.push(project(lat, lon));
    }
    const sw = isEquator && showEquator ? strokeWidth * 2 : strokeWidth;
    paths.push(buildPath(pts, false).replace(`stroke-width="${strokeWidth}"`, `stroke-width="${sw}"`));
  }

  // Longitude lines
  const lonStep = (2 * Math.PI) / lonLines;
  for (let li = 0; li < lonLines; li++) {
    const lon = li * lonStep;
    const pts: [number, number, number][] = [];
    for (let si = 0; si <= SAMPLES; si++) {
      const lat = -Math.PI / 2 + (si / SAMPLES) * Math.PI;
      pts.push(project(lat, lon));
    }
    paths.push(buildPath(pts, false));
  }

  return { paths, filled: style !== 'outline' };
}

export class GlobeOrthographicGenerator implements IEphemeraGenerator {
  readonly typeId = 'globe:orthographic';
  readonly categoryId = 'globe';
  readonly displayName = 'Globe (Orthographic)';
  readonly description = 'Latitude/longitude wireframe sphere with orthographic projection.';

  getDefaultParams(): Record<string, unknown> {
    return {
      size: 200,
      latLines: 7,
      lonLines: 12,
      rotationX: 20,
      rotationY: 15,
      style: 'outline',
      strokeColor: '#000000',
      fillColor: '#000000',
      strokeWidth: 1.5,
      showEquator: true,
      bgColor: 'transparent',
    };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',        label: 'Size',          type: 'range',  default: 200, min: 60,  max: 400, step: 4,   group: 'Size' },
      { key: 'latLines',    label: 'Latitude lines', type: 'range',  default: 7,   min: 2,   max: 20,  step: 1,   group: 'Grid' },
      { key: 'lonLines',    label: 'Longitude lines',type: 'range',  default: 12,  min: 3,   max: 24,  step: 1,   group: 'Grid' },
      { key: 'rotationX',   label: 'Tilt (X)',       type: 'range',  default: 20,  min: -90, max: 90,  step: 1,   group: 'Rotation' },
      { key: 'rotationY',   label: 'Spin (Y)',        type: 'range',  default: 15,  min: -180,max: 180, step: 1,   group: 'Rotation' },
      { key: 'style',       label: 'Style',          type: 'select', default: 'outline',
        options: [{ value: 'outline', label: 'Outline only' }, { value: 'filled', label: 'Filled (solid)' }, { value: 'filled-outline', label: 'Filled + grid' }] },
      { key: 'strokeWidth', label: 'Line weight',    type: 'range',  default: 1.5, min: 0.5, max: 4,   step: 0.25, group: 'Appearance' },
      { key: 'strokeColor', label: 'Line color',     type: 'color',  default: '#000000', group: 'Appearance' },
      { key: 'fillColor',   label: 'Fill color',     type: 'color',  default: '#000000', group: 'Appearance' },
      { key: 'showEquator', label: 'Bold equator',   type: 'toggle', default: true, group: 'Appearance' },
      { key: 'bgColor',     label: 'Background',     type: 'color',  default: 'transparent', group: 'Appearance' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    const size       = Number(p['size']        ?? 200);
    const latLines   = Math.round(Number(p['latLines']   ?? 7));
    const lonLines   = Math.round(Number(p['lonLines']   ?? 12));
    const rotX       = (Number(p['rotationX'] ?? 20)) * Math.PI / 180;
    const rotY       = (Number(p['rotationY'] ?? 15)) * Math.PI / 180;
    const style      = String(p['style']       ?? 'outline') as 'outline' | 'filled' | 'filled-outline';
    const strokeColor = String(p['strokeColor'] ?? '#000000');
    const fillColor  = String(p['fillColor']   ?? '#000000');
    const strokeWidth = Number(p['strokeWidth'] ?? 1.5);
    const showEquator = Boolean(p['showEquator'] ?? true);
    const bgColor    = String(p['bgColor']     ?? 'transparent');

    const r = size / 2;
    const svgSize = size + strokeWidth * 2;
    const cx = svgSize / 2, cy = svgSize / 2;

    const { paths } = sampleGlobe(latLines, lonLines, rotX, rotY, r, style, strokeColor, fillColor, strokeWidth, showEquator);

    const bgRect = bgColor !== 'transparent'
      ? `<rect width="${svgSize}" height="${svgSize}" fill="${bgColor}"/>`
      : '';

    const filledCircle = (style === 'filled' || style === 'filled-outline')
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fillColor}"/>`
      : '';

    const gridPaths = (style === 'outline' || style === 'filled-outline')
      ? paths.join('')
      : '';

    // In filled mode, clip grid to circle and invert colors
    const clipId = 'globe-clip-' + Math.random().toString(36).slice(2, 6);
    const clipDef = style === 'filled-outline'
      ? `<defs><clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>`
      : '';
    const clipAttr = style === 'filled-outline' ? ` clip-path="url(#${clipId})"` : '';
    const invertedGrid = style === 'filled-outline'
      ? `<g${clipAttr}>${paths.map(s => s.replace(new RegExp(`stroke="${strokeColor}"`, 'g'), 'stroke="#ffffff"')).join('')}</g>`
      : '';

    const outerCircle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgSize}" height="${svgSize}" viewBox="0 0 ${svgSize} ${svgSize}">${clipDef}${bgRect}${filledCircle}${style === 'outline' ? gridPaths : invertedGrid}${outerCircle}</svg>`;
  }
}
