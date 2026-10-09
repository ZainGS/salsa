/**
 * The document save's per-mesh state (scene3d.json `nodes[]`) and the document scene.json — moved VERBATIM out of
 * ShapeManager (_buildMeshState / getSceneGraphJSONForDocument) so the save can be tested without a GPU, plus the two
 * save-size / save-cost options of perf audit C4 / C5:
 *
 *  - `parts` (C4): serialize inside a JsonPartCollector, so the heavy typed-array sections reuse their cached JSON
 *    (scene-graph/core/json-parts.ts). The text is byte-identical either way.
 *  - `glbRefs` (C5): an IMPORTED mesh whose geometry is still exactly the GLB's (Mesh3D.importedGeometryUnchanged) is
 *    written as a REFERENCE — `geometryRef: 'glb'` + its existing glbMeshId / glbMeshIndex, no `config.geometry` — in
 *    scene3d.json AND scene.json; Scene3DManager.restoreMeshState rebuilds the geometry from the saved GLB. The GLB
 *    already rides in models3d/, so the vertex arrays were saved two more times (rounded, then unrounded).
 *
 * Without options both functions return exactly what the old ShapeManager methods did (Frogmarks' cloud save and the
 * per-mesh getMeshState3D still call them that way: those paths store their own copies and may not keep the GLB).
 */

import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { SceneGraph } from '../../scene-graph/core/scene-graph';
import type { Scene3DManager } from '../managers/scene3d-manager';
import { dropRuntimeNodesFromSceneJSON } from '../managers/play-auto-player';
import { serializeWithParts, type JsonPartCollector } from '../../scene-graph/core/json-parts';

/** The marker a GLB-referenced mesh state carries in place of `config.geometry` (perf audit C5). */
export const GLB_GEOMETRY_REF = 'glb';

/** Document-save options for buildDocumentMeshState. */
export interface DocumentMeshStateOptions {
    /** Write unchanged imported meshes as GLB references; their ids are added here (scene.json strips the same set). */
    glbRefs?: Set<string>;
}

/** The scene3d.json state of one mesh (Mesh3D.toJSON + glbMeshId / ribbon / frame-link; procedural bodies params-only). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildDocumentMeshState(scene3d: Scene3DManager, m: Mesh3D, doc?: DocumentMeshStateOptions): any {
    const store = scene3d.getModelStore();
    // If this mesh's own buffer is missing (e.g. degraded save cycle), fall back to a
    // sibling mesh in the same MeshGroup3D that does have a buffer stored.  The restore
    // path uses the same GLB source for all group members.
    const glbMeshId = store.has(m.id) ? m.id : scene3d.findGroupMemberGlbId(m.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s: any = {
        ...m.toJSON(),
        glbMeshId,
        ribbonData:           scene3d.getRibbonData3D(m.id) ?? undefined,
        frameLinkAnimation3D: scene3d.getFrameLinkAnimation3D(m.id) ?? undefined,
    };
    // E10 (playback perf 2026-10-09): a Frame Link mesh saved mid-animation writes its REST transform, not the
    // displaced frame pose — the reload re-captures its rest from the saved transform, so the displacement became a
    // permanent offset. (Null when there is no rest, or the mesh was moved since the link last posed it.) Old saves
    // need nothing: the field set is unchanged.
    const rest = scene3d.frameLinkRestForSave?.(m);
    if (rest) Object.assign(s, rest);
    // A PROCEDURAL BODY is fully regenerable from its bodyParams (a handful of numbers) — so DON'T persist the
    // large baked geometry + skinning (~1–2 MB of JSON float arrays per character). Store just the params and
    // rebuild on load (restoreMeshState → generateBodyResult). Shrinks each character from ~MB to ~KB.
    if (m.isProceduralBody) {
        const bp = scene3d.getBodyParams(m.id);
        if (bp) {
            s.bodyParams = bp;
            if (s.config) delete s.config.geometry;
            delete s.jointIndicesB64;
            delete s.jointWeightsB64;
        }
    }
    if (doc?.glbRefs && referenceGlbGeometry(s, m, glbMeshId ? store.get(glbMeshId) : undefined)) doc.glbRefs.add(m.id);
    return s;
}

/**
 * Perf audit C5: turn `state` (a mesh's document state) into a GLB reference when the mesh's geometry is the GLB's.
 * Needs a stored GLB (`glb`), inline geometry to drop, and — for a plain mesh — the index of its mesh in the GLB (the
 * reload picks it by index; names are often all 'defaultMaterial'). A skinned mesh restores from the GLB's first skin
 * already (its inline geometry was never read back when the GLB was there), so it needs no index. Returns whether the
 * state was changed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function referenceGlbGeometry(state: any, m: Mesh3D, glb: ArrayBuffer | undefined): boolean {
    if (!glb || glb.byteLength === 0 || !state?.config?.geometry) return false;
    const skinned = state.type === 'SkinnedMesh3D';
    if (state.type !== '3DMesh' && !skinned) return false;   // cloth etc. keep their geometry
    if (!skinned && (m.glbMeshIndex == null || m.glbMeshIndex < 0)) return false;
    if (!m.importedGeometryUnchanged) return false;
    delete state.config.geometry;
    state.geometryRef = GLB_GEOMETRY_REF;
    return true;
}

/** scene.json: drop the inline geometry of the GLB-referenced plain meshes (`ids`, from the scene3d.json pass). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stripGlbGeometryFromSceneJSON(node: any, ids: ReadonlySet<string>): void {
    if (!node || ids.size === 0) return;
    if (node.type === '3DMesh' && ids.has(node.id) && node.config?.geometry) {
        delete node.config.geometry;
        node.geometryRef = GLB_GEOMETRY_REF;
    }
    if (Array.isArray(node.children)) for (const c of node.children) stripGlbGeometryFromSceneJSON(c, ids);
}

/** Document-save options for buildDocumentSceneJSON. */
export interface DocumentSceneJSONOptions {
    /** The meshes scene3d.json wrote as GLB references (their scene.json copies drop the geometry too). */
    glbRefIds?: ReadonlySet<string>;
    /** Serialize with cached JSON parts (perf audit C4; mode 'raw'). */
    parts?: JsonPartCollector | null;
}

/**
 * scene.json for the DOCUMENT save path — the scene graph JSON with the heavy baked geometry + base64 skinning
 * STRIPPED from SkinnedMesh3D nodes. The document also writes scene3d.json (params-only, the 3D source of truth
 * on load), and scene.json's SkinnedMesh3D nodes are IGNORED by the restore anyway (they fall through
 * recreateNode's `default:` → an empty placeholder). So that geometry is pure duplication — ~MBs per character.
 * This keeps the lightweight node stub (id/type/transform/name/flags) so the tree + 2D content restore
 * identically. Plain '3DMesh' nodes are left intact — their geometry IS used by recreateNode + isn't the bloat —
 * except GLB-referenced ones (opts.glbRefIds, perf audit C5): recreateNode gives those an empty placeholder (the 3D
 * pass rebuilds them from the GLB), which keeps their group membership.
 */
export function buildDocumentSceneJSON(sceneGraph: SceneGraph, scene3d: Scene3DManager, opts: DocumentSceneJSONOptions = {}): string {
    const build = (): unknown => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const scene: any = sceneGraph.toJSON();
        // Runtime-only nodes (the Play auto default player: body, skeleton, face decal, hair, garments) never reach a
        // document, even when a save lands mid-Play (they're only in the graph while playing).
        // Grease Pencil objects too: they persist in scene3dJSON.gpObjects (every stroke point) — this copy doubled
        // the drawing's save size and only ever restored as an empty placeholder node.
        dropRuntimeNodesFromSceneJSON(scene.root, new Set([...scene3d.autoPlayer.runtimeNodeIds(), ...scene3d.getAllGpObjects().map(g => g.id)]));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const strip = (n: any): void => {
            if (n?.type === 'SkinnedMesh3D') {
                if (n.config) delete n.config.geometry;
                delete n.jointIndicesB64; delete n.jointWeightsB64;
                delete n.blendShapes; delete n.baseVerticesB64; delete n.blendWeights;
            }
            if (n?.children) for (const c of n.children) strip(c);
        };
        if (scene.root) strip(scene.root);
        if (opts.glbRefIds?.size) stripGlbGeometryFromSceneJSON(scene.root, opts.glbRefIds);
        const texLibData = scene3d.getTextureLibraryData();
        if (texLibData && texLibData.entries.length > 0) scene.textureLibrary = texLibData;
        return scene;
    };
    return serializeWithParts(opts.parts, build, (scene) => JSON.stringify(scene));
}
