/**
 * The BLANK document: what a brand-new document is, expressed as a document payload so that starting one goes through
 * the same full-replacement restore as opening a saved one (DocumentStateCoordinator.restore). That restore is the one
 * place that forgets the previous document (registries, 3D, world, characters, GARP, UI, scripts, undo, …), and every
 * field this payload leaves out is reset to its default there. See ShapeManager.startBlankDocument.
 */

import { DOCUMENT_SCHEMA_VERSION } from './schema-version';
import type { DocumentSavePayload } from './document-persistence';

/** The 2D canvas grid a document has when its save carries none (WebGPURenderer's initial values: off). */
export const DEFAULT_CANVAS_GRID: { visible: boolean; color: [number, number, number]; opacity: number; cells: number } = {
    visible: false, color: [0.5, 0.5, 0.55], opacity: 0.35, cells: 16,
};

/** No ephemera placements and no sheets (EphemeraService.deserialize re-adds the empty default sheet). */
export const EMPTY_EPHEMERA_JSON = JSON.stringify({ version: 2, sheets: [], placements: {} });

/** An empty scene-graph root (the shape SceneGraph.toJSON writes). Restoring it removes every root child: 2D shapes,
 *  3D meshes / groups, cameras, lights, emitters, procedural markers. */
export const EMPTY_SCENE_GRAPH_JSON = JSON.stringify({
    root: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, zIndex: 0, visible: true, locked: false, children: [] },
});

export interface BlankDocumentOptions {
    /** Bounded artboard size in pixels; null / absent = infinite canvas. */
    documentSize?: { w: number; h: number } | null;
    /** Raster layer pixel size; defaults to documentSize, else 1024×768 (the layer manager's initial size). */
    canvasSize?: { w: number; h: number };
}

/**
 * The payload of a new, empty document: no layers (→ the default 'Background' + 'Vector' stack), no animation, no 3D
 * (→ an empty 3D scene), default dither / canvas grid, no ephemera / GARP / UI layers / textures.
 */
export function createBlankDocumentPayload(docId: string, name: string, opts: BlankDocumentOptions = {}): DocumentSavePayload {
    const now = new Date().toISOString();
    const documentSize = opts.documentSize && opts.documentSize.w > 0 && opts.documentSize.h > 0 ? { ...opts.documentSize } : null;
    const canvas = opts.canvasSize ?? documentSize ?? { w: 1024, h: 768 };
    return {
        manifest: {
            version: 3,
            schemaVersion: DOCUMENT_SCHEMA_VERSION,
            docId,
            name,
            createdAt: now,
            savedAt: now,
            canvasWidth: canvas.w,
            canvasHeight: canvas.h,
            documentSize,
            layers: [],
            animation: null,
            canvasGrid: { ...DEFAULT_CANVAS_GRID, color: [...DEFAULT_CANVAS_GRID.color] as [number, number, number] },
            pixelFormat: 'png',
        },
        sceneGraphJSON: EMPTY_SCENE_GRAPH_JSON,
        brushPresetsJSON: null,
        layers: [],
        cels: [],
        scene3dJSON: null,
        models3d: {},
        meshTextures: {},
        bakedParts: {},
        textureLibrary: null,
        ephemeraJSON: null,
        garpJSON: null,
        uiLayersJSON: null,
    };
}
