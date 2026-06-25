/**
 * Ephemera System — core types.
 *
 * Ephemera is a procedural generator system for editorial design objects:
 * barcodes, globe wireframes, crosshairs, warning labels, serial strings,
 * motion lines, and similar graphic vocabulary.
 */

// ── Generator schema ────────────────────────────────────────────────

export type EphemeraParamType = 'text' | 'number' | 'range' | 'select' | 'toggle' | 'color' | 'seed';

export interface EphemeraSelectOption {
  value: string | number | boolean;
  label: string;
}

export interface EphemeraParamSchema {
  key: string;
  label: string;
  type: EphemeraParamType;
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: EphemeraSelectOption[];
  group?: string;
}

export interface IEphemeraGenerator {
  readonly typeId: string;
  readonly categoryId: string;
  readonly displayName: string;
  readonly description: string;
  getDefaultParams(): Record<string, unknown>;
  getParamSchema(): EphemeraParamSchema[];
  /** Returns a valid SVG string. Must be pure and synchronous. */
  generate(params: Record<string, unknown>): string;
}

// ── Data model ──────────────────────────────────────────────────────

export interface EphemeraElement {
  id: string;
  typeId: string;
  label: string;
  params: Record<string, unknown>;
  svg: string;
  createdAt: number;
}

export interface EphemeraElementSheet {
  id: string;
  name: string;
  elements: EphemeraElement[];
  createdAt: number;
  modifiedAt: number;
}

// ── Canvas placements (Phase 3) ─────────────────────────────────────

/** A single placed instance of an ephemera on a canvas layer. */
export interface EphemeraPlacement {
  id: string;
  layerId: string;                 // parent ephemera layer ID
  typeId: string;                  // generator type
  params: Record<string, unknown>; // parameter snapshot
  svg: string;                     // cached SVG at placement time
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;                // degrees
  opacity: number;                 // 0–1
  /** Canvas composite op for the draw — e.g. 'multiply' / 'overlay' / 'screen' so worn-edge
   *  and grunge ephemera sit INTO the art instead of as a flat sticker. Default 'source-over'. */
  blendMode?: GlobalCompositeOperation;
  /** Optional soft glow baked into the SVG (see decorateEphemeraSvg). */
  glow?: { radius: number; color: string; opacity?: number } | null;
  /** Optional edge feather (alpha fade) baked into the SVG (see decorateEphemeraSvg). */
  feather?: { mode: 'radial' | 'linear'; start: number; end: number; angle?: number } | null;
  visible: boolean;
}

// ── Category descriptor (for UI dropdowns) ──────────────────────────

export interface EphemeraCategory {
  id: string;
  displayName: string;
}

export const EPHEMERA_CATEGORIES: EphemeraCategory[] = [
  { id: 'barcode-1d',          displayName: 'Barcodes (1D)'              },
  { id: 'globe',               displayName: 'Globe / Wireframe'          },
  { id: 'crosshair',           displayName: 'Crosshair / Reticle'        },
  { id: 'warning-label',       displayName: 'Warning Labels'             },
  { id: 'serial-string',       displayName: 'Serial / Data Strings'      },
  { id: 'motion-lines',        displayName: 'Speed / Motion Lines'       },
  { id: 'registration-marks',  displayName: 'Registration / Print Marks' },
  { id: 'waveform',            displayName: 'Waveform / Data Bars'       },
  { id: 'geometric-frame',     displayName: 'Geometric Frame / Border'   },
  { id: 'stars-sparkles',      displayName: 'Stars / Sparkles'           },
  // ── Retro polish kit ──
  { id: 'worn-edges',          displayName: 'Worn Edges / Damage'        },
  { id: 'media-icons',         displayName: 'Media Formats'              },
  { id: 'holo-seal',           displayName: 'Holographic Seals'          },
  { id: 'badge',               displayName: 'Badges / Stamps'            },
  { id: 'memphis',             displayName: 'Memphis / Confetti'         },
  { id: 'halftone',            displayName: 'Halftone / Dots'            },
  { id: 'scanline',            displayName: 'Scanlines / CRT'            },
  { id: 'rainbow-strip',       displayName: 'Rainbow / Spectrum'         },
  { id: 'wireframe',           displayName: 'Wireframe Solids'           },
];
