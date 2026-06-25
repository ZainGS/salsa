import type { IEphemeraGenerator, EphemeraParamSchema } from '../ephemera-types';

type V3 = [number, number, number];

const SOLIDS: Record<string, { verts: V3[]; edges: [number, number][] }> = {
  cube: {
    verts: [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],
    edges: [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]],
  },
  pyramid: {
    verts: [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1],[0,1,0]],
    edges: [[0,1],[1,2],[2,3],[3,0],[0,4],[1,4],[2,4],[3,4]],
  },
  octahedron: {
    verts: [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]],
    edges: [[0,2],[2,1],[1,3],[3,0],[0,4],[2,4],[1,4],[3,4],[0,5],[2,5],[1,5],[3,5]],
  },
};

/** Rotating-wireframe 3D primitive (the GBA wireframe-cube look). Orthographic projection. */
function buildWireframe(
  size: number,
  shape: string,
  rotX: number,
  rotY: number,
  strokeWidth: number,
  color: string,
  bgColor: string,
): string {
  const S = size;
  const solid = SOLIDS[shape] ?? SOLIDS['cube'];
  const ax = rotX * Math.PI / 180, ay = rotY * Math.PI / 180;
  const cxA = Math.cos(ax), sxA = Math.sin(ax), cyA = Math.cos(ay), syA = Math.sin(ay);
  const scale = S * 0.32, cx = S / 2, cy = S / 2;

  const project = (v: V3): [number, number] => {
    // rotate Y then X
    let x = v[0] * cyA + v[2] * syA;
    let z = -v[0] * syA + v[2] * cyA;
    let y = v[1] * cxA - z * sxA;
    z = v[1] * sxA + z * cxA;
    const persp = 1 / (1 + z * 0.18); // gentle perspective
    return [cx + x * scale * persp, cy - y * scale * persp];
  };

  const pts = solid.verts.map(project);
  const lines = solid.edges.map(([a, b]) =>
    `<line x1="${pts[a][0].toFixed(1)}" y1="${pts[a][1].toFixed(1)}" x2="${pts[b][0].toFixed(1)}" y2="${pts[b][1].toFixed(1)}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`,
  ).join('');
  const verts = pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(strokeWidth * 1.3).toFixed(1)}" fill="${color}"/>`).join('');

  const bg = bgColor !== 'transparent' ? `<rect width="${S}" height="${S}" fill="${bgColor}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${bg}${lines}${verts}</svg>`;
}

export class WireframeGenerator implements IEphemeraGenerator {
  readonly typeId = 'wireframe:solid';
  readonly categoryId = 'wireframe';
  readonly displayName = 'Wireframe Solid';
  readonly description = 'Projected 3D wireframe primitive (cube / pyramid / octahedron) — the retro GBA wireframe look.';

  getDefaultParams(): Record<string, unknown> {
    return { size: 200, shape: 'cube', rotX: 25, rotY: 35, strokeWidth: 2, color: '#01cdfe', bgColor: 'transparent' };
  }

  getParamSchema(): EphemeraParamSchema[] {
    return [
      { key: 'size',  label: 'Size',  type: 'range',  default: 200, min: 48, max: 400, step: 4, group: 'Size' },
      { key: 'shape', label: 'Solid', type: 'select', default: 'cube',
        options: [
          { value: 'cube',       label: 'Cube'       },
          { value: 'pyramid',    label: 'Pyramid'    },
          { value: 'octahedron', label: 'Octahedron' },
        ], group: 'Solid' },
      { key: 'rotX',        label: 'Rotate X',   type: 'range', default: 25, min: -90, max: 90,  step: 1, group: 'Orientation' },
      { key: 'rotY',        label: 'Rotate Y',   type: 'range', default: 35, min: -90, max: 90,  step: 1, group: 'Orientation' },
      { key: 'strokeWidth', label: 'Line weight', type: 'range', default: 2, min: 0.5, max: 6,   step: 0.5, group: 'Appearance' },
      { key: 'color',       label: 'Color',      type: 'color', default: '#01cdfe',                        group: 'Color' },
      { key: 'bgColor',     label: 'Background', type: 'color', default: 'transparent',                    group: 'Color' },
    ];
  }

  generate(p: Record<string, unknown>): string {
    return buildWireframe(
      Number(p['size'] ?? 200),
      String(p['shape'] ?? 'cube'),
      Number(p['rotX'] ?? 25),
      Number(p['rotY'] ?? 35),
      Number(p['strokeWidth'] ?? 2),
      String(p['color'] ?? '#01cdfe'),
      String(p['bgColor'] ?? 'transparent'),
    );
  }
}
