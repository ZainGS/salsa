/**
 * Scene3DManager — Delegate for 3D scene operations.
 *
 * Handles:
 *  - Camera creation and control
 *  - Orbit controller attach/detach
 *  - Mesh creation (box, sphere, plane, cylinder, torus, custom)
 *  - Mesh property manipulation (position, rotation, scale, material)
 *  - PS1 aesthetic configuration
 *  - Lighting (directional + ambient)
 *
 * Frogmarks can access this via `shapeManager.scene3d`.
 */

import type { ManagerContext } from './manager-context';
import { mat4, vec4, vec3 } from 'gl-matrix';
import { Camera3D, Camera3DConfig } from '../../renderer/3d/camera-3d';
import { OrbitController, OrbitControllerConfig } from '../../renderer/3d/orbit-controller';
import { Renderer3D, PS1Config, DEFAULT_PS1_CONFIG } from '../../renderer/3d/renderer-3d';
import { Material3D } from '../../renderer/3d/material-3d';
import { MeshGeometry, generateRibbon, FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import { Mesh3D, Mesh3DConfig, MeshPrimitive, Submesh3D } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { GizmoRenderer, GizmoMode, GizmoAxis } from '../../renderer/3d/gizmo-renderer';
import { MeshEditOverlayRenderer, type MeshEditDrawData } from '../../renderer/3d/mesh-edit-overlay-renderer';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { TransformController3D } from './transform-controller-3d';
import { TextureLibrary } from '../texture-library';
import {
  Mesh3DKeyframeTracks, TrackName, KeyframeEasing,
  Camera3DKeyframeTracks, CameraTrackName,
  sampleTrack, setKeyframe, removeKeyframe,
  interpolateVec3, interpolateVec4, interpolateScalar,
  FrameLinkAnimation3D, DEFAULT_FRAME_LINK_ANIMATION_3D, evalFrameLink3D,
} from '../../types/keyframe-3d';
import { AnimationPlayer3D, AnimationPlayer3DConfig } from '../../renderer/3d/animation-player-3d';
import { UndoManager3D } from './undo-manager-3d';
import { parseOBJ } from '../../renderer/3d/obj-importer';
import { parseGLB, parseGLTF, GltfMeshResult, parseSkinnedGLB, parseSkinnedGLTF } from '../../renderer/3d/gltf-importer';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { SkinnedMesh3D, fromBase64ToUint8, fromBase64ToFloat32 } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { Joint3D, SkeletonData, SkeletonAnimClip } from '../../types/armature-3d';
import { applySkeletonClipAtFrame } from '../../renderer/3d/skeleton-animator';
import { RenderStyle } from '../../renderer/3d/material-3d';
import { HtmlTexture3D, HtmlTexture3DOptions } from '../../renderer/3d/html-texture-3d';
import { RibbonData, RibbonControlPoint, RibbonPathMode } from '../../types/ribbon-3d';
import { ClothMesh3D, ClothGridConfig, ClothPhysicsConfig, ClothSimState, ClothLiveConfig, DEFAULT_CLOTH_PHYSICS, DEFAULT_CLOTH_LIVE, StitchConstraint, WindZone } from '../../scene-graph/shapes/cloth-mesh-3d';
import { buildClothGeometry, ClothGeometryResult, buildDefaultActiveCells } from '../../renderer/3d/cloth-geometry-builder';
import { ClothSimulator, DrapeProxy } from '../../renderer/3d/cloth-simulator';
import { solidifyCloth } from '../../renderer/3d/cloth-solidifier';
import { createLiveClothSimulation, LiveClothHandle } from '../../renderer/3d/live-cloth-simulation';
import { ClothPreviewRenderer, ClothPreviewOptions } from '../../renderer/3d/cloth-preview-renderer';
import { ParticleEmitter3D, ParticleEmitterConfig, ParticlePreset } from '../../scene-graph/shapes/particle-emitter-3d';
import { KitbashLibrary } from './kitbash-library';
import type { CharacterSlot, CharacterDefinition, CharacterData, KitbashPartMeta } from '../../types/kitbash-3d';
import { GpObject3D } from '../../scene-graph/shapes/gp-object-3d';
import type { GpPoint, GpStroke3D } from '../../types/grease-pencil-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
export type { DrapeProxy, LiveClothHandle };
export type { CharacterSlot, CharacterDefinition, CharacterData, KitbashPartMeta };
export type { GpPoint, GpStroke3D };

const _nanoid = () => Math.random().toString(36).slice(2, 10);

const nearestPow2 = (n: number): number => {
    if (!isFinite(n) || n <= 0) return 1;
    return Math.pow(2, Math.round(Math.log2(n)));
};

export interface Scene3DHierarchyNode {
    id: string;
    name: string;
    type: '3DMesh' | '3DMeshGroup';
    visible: boolean;
    locked: boolean;
    collapsed?: boolean;
    children?: Scene3DHierarchyNode[];
}

export class Scene3DManager {
    private ctx: ManagerContext;
    private _orbitController?: OrbitController;
    private _orbitUpdateCallback?: () => boolean;

    // Picking + gizmo
    private _picker = new MeshPicker();
    private _gizmoRenderer?: GizmoRenderer;
    private _meshEditOverlay?: MeshEditOverlayRenderer;
    private _transformController?: TransformController3D;
    private _isMeshEditModeFn?: () => boolean;
    private _meshEditDataFn?: () => MeshEditDrawData | null;

    // Bone overlay state (A10/A11)
    private _boneOverlaySkeletonId: string | null = null;
    private _selectedJointIndex: number | null = null;
    private _hoveredJointIndex: number | null = null;
    private _jointMouseDownCleanup?: () => void;

    // Texture library (lazy-init)
    private _textureLibrary?: TextureLibrary;

    // Keyframe animation: frame-change listener unsubscribe
    private _keyframeUnsub?: () => void;

    // Animation player (optional, frame-clock driven)
    private _animPlayer?: AnimationPlayer3D;

    // Camera keyframe tracks (position, target, fov)
    private _cameraKeyframeTracks: Camera3DKeyframeTracks = {};

    // Undo/redo for 3D scene edits
    private _undoManager = new UndoManager3D();

    // Auto-sync illustration camera to pan/zoom each frame
    private _autoSyncCallback?: () => boolean;

    // Per-mesh procedural frame-link animations (keyed by mesh ID)
    private _frameLinkAnims3D = new Map<string, FrameLinkAnimation3D>();

    // Rest-pose snapshot captured at first FLA application (oscillating types only).
    // Cleared whenever FLA is set or removed so the next frame re-captures the current pose.
    private _flaRestTransforms = new Map<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>();

    // Ribbon mesh data (keyed by mesh ID)
    private _ribbonData = new Map<string, RibbonData>();

    // Cloth geometry results (keyed by mesh ID) — preserved for re-edit
    private _clothData = new Map<string, ClothGeometryResult>();
    // Live cloth simulation handles (keyed by mesh ID)
    private _liveClothHandles = new Map<string, LiveClothHandle>();
    // Preview canvas renderers for the Cloth Builder modal (keyed by mesh ID)
    private _previewRenderers = new Map<string, ClothPreviewRenderer>();
    // Stitch tool transient state (keyed by mesh ID)
    private _stitchTool = new Map<string, {
        vertexA: number;
        restLength: number;
        previewB: number | null;
        /** Cloth positions captured at beginClothStitchTool() — used as the baseline for each preview reset so every hover starts from the same pose. */
        savedPositions: Float32Array | null;
    }>();
    // Debounce timers for setClothConfigDebounced (keyed by mesh ID)
    private _clothConfigTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; grid: Partial<ClothGridConfig>; physics: Partial<ClothPhysicsConfig> }>();

    // HTML-in-Canvas GPU textures (keyed by mesh ID)
    private _htmlTextures = new Map<string, HtmlTexture3D>();

    // Particle emitters (keyed by emitter ID)
    private _particleEmitters = new Map<string, ParticleEmitter3D>();
    private _particleTickCb: (() => boolean) | null = null;

    // Per-frame ribbon update callback (scroll animation + camera-facing geometry)
    private _scrollRealFrames = new Map<string, number>();
    private _ribbonUpdateCb: (() => boolean) | null = null;

    // Ribbon control-point drag depths: key = `${ribbonId}:${handleIndex}`
    private _ribbonHandleDragDepth = new Map<string, number>();

    // Kitbash part catalog
    private readonly _kitbashLibrary = new KitbashLibrary();
    // Assembled characters: charId → CharacterData
    private _characterMap = new Map<string, CharacterData>();

    // Grease Pencil objects
    private _gpObjects = new Map<string, GpObject3D>();
    // Active stroke being drawn: {gpId, layerId, strokeId}
    private _gpActiveStroke: { gpId: string; layerId: string; strokeId: string } | null = null;

    constructor(ctx: ManagerContext) {
        this.ctx = ctx;
    }

    private get renderer3D(): Renderer3D { return this.ctx.webgpuRenderer.getRenderer3D(); }

    // ── Undo / Redo ──────────────────────────────────────────────────

    get canUndo3D(): boolean { return this._undoManager.canUndo; }
    get canRedo3D(): boolean { return this._undoManager.canRedo; }
    get undoDescription3D(): string | null { return this._undoManager.undoDescription; }
    get redoDescription3D(): string | null { return this._undoManager.redoDescription; }

    undo3D(): boolean {
        const ok = this._undoManager.undo();
        if (ok) this.ctx.scheduleRender();
        return ok;
    }

    redo3D(): boolean {
        const ok = this._undoManager.redo();
        if (ok) this.ctx.scheduleRender();
        return ok;
    }

    clearUndo3D(): void { this._undoManager.clear(); }
    pushCommand3D(cmd: import('./undo-manager-3d').Command3D): void { this._undoManager.push(cmd); }

    // ── Shadow mapping ───────────────────────────────────────────────

    enableShadows(mapSize = 1024, halfExtent = 15, bias = 0.002): void {
        this.renderer3D.enableShadows(mapSize, halfExtent, bias);
        this.ctx.scheduleRender();
    }

    disableShadows(): void {
        this.renderer3D.disableShadows();
        this.ctx.scheduleRender();
    }

    get shadowsEnabled(): boolean { return this.renderer3D.shadowsEnabled; }

    // ── Frustum culling ──────────────────────────────────────────────

    get frustumCulling(): boolean { return this.renderer3D.frustumCulling; }
    set frustumCulling(v: boolean) { this.renderer3D.frustumCulling = v; }

    // ── Synced 3D + raster playback ──────────────────────────────────

    /**
     * Start the 3D AnimationPlayer in sync with raster playback.
     * Called automatically when `animation.play()` fires.
     */
    startSyncedPlayback(): void {
        this._animPlayer?.play();
    }

    pauseSyncedPlayback(): void {
        this._animPlayer?.pause();
    }

    stopSyncedPlayback(): void {
        this._animPlayer?.stop();
    }

    // ── Camera ───────────────────────────────────────────────────────

    getCamera(): Camera3D { return this.renderer3D.getCamera(); }

    createCamera(config?: Camera3DConfig): Camera3D {
        const cam = new Camera3D(config);
        this.renderer3D.setCamera(cam);
        this.ctx.scheduleRender();
        return cam;
    }

    /** Reset camera to default position looking at origin. */
    resetCamera(): void {
        const cam = this.renderer3D.getCamera();
        cam.lookAt(0, 2, 5, 0, 0, 0);
        this.ctx.scheduleRender();
    }

    /** Switch between perspective and orthographic projection. */
    setCameraMode(mode: 'perspective' | 'orthographic'): void {
        this.renderer3D.getCamera().mode = mode;
        this.ctx.scheduleRender();
    }

    /** Set the camera field of view (degrees). */
    setFOV(fovDeg: number): void {
        this.renderer3D.getCamera().fov = fovDeg * Math.PI / 180;
        this.ctx.scheduleRender();
    }

    // ── 3D Illustration mode ─────────────────────────────────────────

    /** Last params passed to syncIllustrationCamera — used to re-sync on projection toggle. */
    private _illustrationSync: { panX: number; panY: number; zoom: number; canvasW: number; canvasH: number } | null = null;
    /** Stored projection preference — survives repeated syncIllustrationCamera calls. */
    private _illustrationProjection: 'perspective' | 'orthographic' = 'orthographic';

    /**
     * Sync the 3D camera to the 2D viewport (pan/zoom) for 3D Illustration mode.
     * Call this whenever panOffset or zoomFactor changes. Safe to call every frame.
     *
     * Coordinate convention: 2D uses Y-down (origin top-left), 3D uses Y-up.
     * The camera is placed so that a 3D mesh at (x, -y, 0) aligns with the 2D
     * world point (x, y) — users should negate Y when positioning 3D objects to
     * match 2D canvas coordinates.
     */
    syncIllustrationCamera(panX: number, panY: number, zoom: number, canvasW: number, canvasH: number): void {
        this._illustrationSync = { panX, panY, zoom, canvasW, canvasH };
        this.renderer3D.getCamera().mode = this._illustrationProjection;
        this._applyIllustrationCamera();
    }

    /**
     * Switch the 3D Illustration camera between perspective and orthographic.
     * Stores the preference so subsequent syncIllustrationCamera calls don't override it.
     * Immediately re-syncs the camera using the last syncIllustrationCamera params.
     */
    setIllustrationProjection(mode: 'perspective' | 'orthographic'): void {
        this._illustrationProjection = mode;
        this.renderer3D.getCamera().mode = mode;
        if (this._illustrationSync) {
            this._applyIllustrationCamera();
        } else {
            this.ctx.scheduleRender();
        }
    }

    private _applyIllustrationCamera(): void {
        if (!this._illustrationSync) return;
        const { panX, panY, zoom, canvasW, canvasH } = this._illustrationSync;
        const cam = this.renderer3D.getCamera();

        cam.aspect = canvasW / canvasH;

        // The 2D world matrix is:  NDC_x = zoom * x / aspect + panX / canvasW
        //                          NDC_y = zoom * y          - panY / canvasH
        // Pan is accumulated at 2× mouse pixels (see renderer panning handler).
        // Inverting NDC = 0 gives the 2D world-space center — which the 3D camera
        // must look at so that 3D meshes pan at the same rate as 2D content.
        //
        // cx = −panX / (canvasH × zoom)   [derived from aspect/canvasW simplification]
        // cy =  panY / (canvasH × zoom)
        // orthoSize = 1 / zoom  (half the visible height in normalized world units)
        const cx = -panX / (canvasH * zoom);
        const cy =  panY / (canvasH * zoom);
        const orthoSize = 1 / zoom;

        if (cam.mode === 'orthographic') {
            cam.orthoSize = orthoSize;
            cam.near = 0.001;
            cam.far = 100;
            cam.lookAt(cx, cy, 10, cx, cy, 0);
        } else {
            const d = orthoSize / Math.tan(cam.fov / 2);
            cam.near = Math.max(0.0001, d * 0.0001);
            cam.far = Math.max(d * 2, 100);
            cam.lookAt(cx, cy, d, cx, cy, 0);
        }

        this.ctx.scheduleRender();
    }

    /**
     * Subscribe to the render loop so the illustration camera automatically tracks
     * the current pan/zoom on every frame.  Call once on document load and the
     * camera will always be in sync — no need to call syncIllustrationCamera manually.
     *
     * Safe to call multiple times (duplicate calls are no-ops).
     */
    enableAutoSyncIllustrationCamera(): void {
        if (this._autoSyncCallback) return;
        const iService = this.ctx.interactionService;
        const renderer = this.ctx.webgpuRenderer;
        this._autoSyncCallback = () => {
            const canvas = renderer.getCanvas();
            const pan = iService.getPanOffset();
            const zoom = iService.getZoomFactor();
            this.syncIllustrationCamera(pan.x, pan.y, zoom, canvas.width, canvas.height);
            return false; // keep running every frame
        };
        renderer.addPreRenderCallback(this._autoSyncCallback);
        // Fire once immediately so any render already queued before this call
        // (e.g. from document load) gets the correct camera on its first frame.
        this._autoSyncCallback();
    }

    /** Stop automatic camera sync started by enableAutoSyncIllustrationCamera. */
    disableAutoSyncIllustrationCamera(): void {
        if (!this._autoSyncCallback) return;
        this.ctx.webgpuRenderer.removePreRenderCallback(this._autoSyncCallback);
        this._autoSyncCallback = undefined;
    }

    /**
     * Returns the world-space point that the illustration camera is looking at —
     * i.e. the center of the visible canvas area in 3D world coordinates.
     * Use this to place new meshes at the center of the canvas rather than at the
     * world origin (which maps to the top-left corner in illustration mode).
     *
     * Returns null if syncIllustrationCamera has never been called.
     */
    getIllustrationCenter3D(): [number, number, number] | null {
        if (!this._illustrationSync) return null;
        const { panX, panY, zoom, canvasH } = this._illustrationSync;
        // Same formula as _applyIllustrationCamera — the 2D world-space center.
        const cx = -panX / (canvasH * zoom);
        const cy =  panY / (canvasH * zoom);
        return [cx, cy, 0];
    }

    /**
     * Returns the recommended uniform scale for a new mesh in illustration mode.
     * In illustration mode 1 world unit = 1 canvas pixel, so a 1×1×1 mesh is
     * effectively invisible. This returns a scale that makes the mesh appear
     * roughly 10% of the visible canvas height (~100 px at 1080p, zoom 1).
     *
     * Returns 1 if the illustration camera has never been synced (perspective mode default).
     */
    getIllustrationMeshDefaultScale3D(): number {
        return this.illustrationMeshDefaultScale();
    }

    private illustrationMeshDefaultScale(): number {
        if (!this._illustrationSync) return 1;
        const { zoom } = this._illustrationSync;
        // The 3D world uses the same normalized units as the 2D world:
        // visible height = 2/zoom world units (Y spans −1/zoom to +1/zoom).
        // Target: mesh ≈ 10% of visible height = 0.2/zoom world units.
        return 0.2 / zoom;
    }

    /** Frame all meshes in the current camera view. */
    frameAllMeshes(padding = 1.25): boolean {
        const meshes = this.getAllMeshes();
        if (meshes.length === 0) return false;
        return this.frameMeshes(meshes, padding);
    }

    /** Frame a single mesh by ID in the current camera view. */
    frameMesh(nodeId: string, padding = 1.25): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        return this.frameMeshes([mesh], padding);
    }

    private frameMeshes(meshes: Mesh3D[], padding: number): boolean {
        const bounds = this.computeWorldBounds(meshes);
        if (!bounds) return false;

        const cam = this.renderer3D.getCamera();
        const cx = (bounds.minX + bounds.maxX) * 0.5;
        const cy = (bounds.minY + bounds.maxY) * 0.5;
        const cz = (bounds.minZ + bounds.maxZ) * 0.5;

        const dx = bounds.maxX - bounds.minX;
        const dy = bounds.maxY - bounds.minY;
        const dz = bounds.maxZ - bounds.minZ;
        const radius = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5);

        const oldDir = vec3.fromValues(
            cam.position[0] - cam.target[0],
            cam.position[1] - cam.target[1],
            cam.position[2] - cam.target[2],
        );
        if (vec3.length(oldDir) < 0.0001) vec3.set(oldDir, 0, 0.4, 1);
        vec3.normalize(oldDir, oldDir);

        let dist = radius * padding;
        if (cam.mode === 'perspective') {
            dist = Math.max(radius * padding, (radius * padding) / Math.tan(Math.max(0.1, cam.fov) * 0.5));
        } else {
            const halfH = Math.max(dy * 0.5, (dx * 0.5) / Math.max(0.0001, cam.aspect));
            cam.orthoSize = halfH * padding;
            dist = Math.max(radius * 2, 2);
        }

        cam.lookAt(
            cx + oldDir[0] * dist,
            cy + oldDir[1] * dist,
            cz + oldDir[2] * dist,
            cx,
            cy,
            cz,
        );
        this.ctx.scheduleRender();
        return true;
    }

    private computeWorldBounds(meshes: Mesh3D[]): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const mesh of meshes) {
            const v = mesh.geometry?.vertices;
            if (!v || v.length < 3) continue;

            const m = mesh.localMatrix;
            // Stride is 12 floats: pos(3) + normal(3) + uv(2) + tangent(4)
            for (let i = 0; i < v.length; i += 12) {
                const p = vec4.fromValues(v[i], v[i + 1], v[i + 2], 1);
                const wp = vec4.transformMat4(vec4.create(), p, m as mat4);
                minX = Math.min(minX, wp[0]); minY = Math.min(minY, wp[1]); minZ = Math.min(minZ, wp[2]);
                maxX = Math.max(maxX, wp[0]); maxY = Math.max(maxY, wp[1]); maxZ = Math.max(maxZ, wp[2]);
            }
        }

        if (!isFinite(minX) || !isFinite(minY) || !isFinite(minZ)) return null;
        return { minX, minY, minZ, maxX, maxY, maxZ };
    }

    // ── Orbit Controls ───────────────────────────────────────────────

    enableOrbitControls(config?: OrbitControllerConfig): OrbitController {
        this.disableOrbitControls();
        const cam = this.renderer3D.getCamera();
        this._orbitController = new OrbitController(cam, config);
        const canvas = this.ctx.webgpuRenderer.getCanvas();
        if (canvas) this._orbitController.attach(canvas);

        // Register per-frame update for damping/momentum
        this._orbitUpdateCallback = () => {
            if (!this._orbitController) return false;
            const hadMomentum = this._orbitController.update();
            if (hadMomentum) this.ctx.scheduleRender();
            return hadMomentum;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._orbitUpdateCallback);

        return this._orbitController;
    }

    disableOrbitControls(): void {
        if (this._orbitUpdateCallback) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._orbitUpdateCallback);
            this._orbitUpdateCallback = undefined;
        }
        this._orbitController?.detach();
        this._orbitController = undefined;
    }

    /** Toggle orbit controls on/off. */
    toggleOrbitControls(enabled?: boolean): void {
        if (this._orbitController) {
            this._orbitController.enabled = enabled ?? !this._orbitController.enabled;
        }
    }

    getOrbitController(): OrbitController | undefined { return this._orbitController; }

    // ── Mesh Creation ────────────────────────────────────────────────

    createBox(x: number, y: number, z: number, width = 1, height = 1, depth = 1, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'box', width, height, depth, material });
    }

    createSphere(x: number, y: number, z: number, radius = 0.5, segments = 16, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'sphere', radius, widthSegments: segments, heightSegments: Math.max(2, segments * 0.75 | 0), material });
    }

    createPlane(x: number, y: number, z: number, width = 1, height = 1, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'plane', width, height, material });
    }

    createCylinder(x: number, y: number, z: number, radius = 0.5, height = 1, radialSegments = 16, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'cylinder', radius, height, radialSegments, material });
    }

    createTorus(x: number, y: number, z: number, radius = 0.5, tubeRadius = 0.2, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'torus', radius, tubeRadius, material });
    }

    createCustomMesh(x: number, y: number, z: number, geometry: MeshGeometry, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'custom', geometry, material });
    }

    /**
     * Create an editable polygon mesh from a 2D silhouette in the XZ plane.
     * The mesh is created with an EditMesh pre-attached — no makeEditable() needed.
     */
    createPolygonMesh(x: number, y: number, z: number, points: [number, number][], height = 1, name?: string, material?: Partial<Material3D>): Mesh3D {
        const em = EditMesh.fromPolygon(points, height);
        const geom = em.compile();
        const mesh = this.createMesh(x, y, z, { primitive: 'custom', geometry: geom, material });
        mesh.editMesh = em;
        mesh.vertexColors = geom.vertexColors ?? null;
        if (name) mesh.name = name;
        return mesh;
    }

    /**
     * Create an editable circle (regular n-gon) mesh extruded along Y.
     * Convenience wrapper around createPolygonMesh.
     */
    createCircleMesh(x: number, y: number, z: number, radius = 0.5, segments = 8, height = 1, name?: string, material?: Partial<Material3D>): Mesh3D {
        const em = EditMesh.fromCircle(radius, segments, height);
        const geom = em.compile();
        const mesh = this.createMesh(x, y, z, { primitive: 'custom', geometry: geom, material });
        mesh.editMesh = em;
        mesh.vertexColors = geom.vertexColors ?? null;
        if (name) mesh.name = name;
        return mesh;
    }

    /**
     * Parse an OBJ string and create a Mesh3D at (x, y, z).
     * Handles missing normals/UVs, quads, and N-gons automatically.
     */
    importObjMesh(x: number, y: number, z: number, objText: string, material?: Partial<Material3D>): Mesh3D {
        const geometry = parseOBJ(objText);
        return this.createMesh(x, y, z, { primitive: 'custom', geometry, material });
    }

    /**
     * Read a .obj File/Blob and create a Mesh3D at (x, y, z).
     * Suitable for drag-and-drop or file-picker input.
     */
    async importObjFile(x: number, y: number, z: number, file: File | Blob, material?: Partial<Material3D>): Promise<Mesh3D> {
        const text = await file.text();
        return this.importObjMesh(x, y, z, text, material);
    }

    /**
     * Parse a GLB ArrayBuffer and create one Mesh3D per node in the scene.
     * Node positions, rotations, and scales from the GLTF hierarchy are applied
     * relative to the given (x, y, z) origin.
     * The raw buffer is retained in the model store so the scene can be serialized.
     */
    async importGltfBuffer(
        x: number, y: number, z: number,
        buffer: ArrayBuffer,
        material?: Partial<Material3D>,
        groupName?: string,
    ): Promise<Mesh3D[]> {
        const results = await parseGLB(buffer);
        return this._createMeshesFromGltf(x, y, z, results, material, buffer, groupName);
    }

    /**
     * Read a .glb/.gltf File and create one Mesh3D per node.
     * Suitable for drag-and-drop or file-picker input.
     */
    async importGltfFile(
        x: number, y: number, z: number,
        file: File | Blob,
        material?: Partial<Material3D>,
    ): Promise<Mesh3D[]> {
        const buffer = await file.arrayBuffer();
        const name   = (file as File).name ?? '';
        const groupName = name.replace(/\.[^.]+$/, '') || '3D Group';
        if (name.endsWith('.gltf')) {
            const text    = new TextDecoder().decode(buffer);
            const results = await parseGLTF(text);
            return this._createMeshesFromGltf(x, y, z, results, material, buffer, groupName);
        }
        return this.importGltfBuffer(x, y, z, buffer, material, groupName);
    }

    /**
     * Parse a .glb ArrayBuffer that contains a skinned mesh (JOINTS_0 + skins).
     * Creates one Skeleton3D and one SkinnedMesh3D per skinned primitive.
     * Returns both so the caller can link them or add them to the scene.
     */
    async importSkinnedGltfBuffer(
        x: number, y: number, z: number,
        buffer: ArrayBuffer,
        material?: Partial<Material3D>,
    ): Promise<{ skeletons: Skeleton3D[]; meshes: SkinnedMesh3D[] }> {
        const results = await parseSkinnedGLB(buffer);
        return this._createSkinnedMeshesFromGltf(x, y, z, results, material);
    }

    /** Read a .glb File containing a skinned mesh. */
    async importSkinnedGltfFile(
        x: number, y: number, z: number,
        file: File | Blob,
        material?: Partial<Material3D>,
    ): Promise<{ skeletons: Skeleton3D[]; meshes: SkinnedMesh3D[] }> {
        const buffer = await file.arrayBuffer();
        const name   = (file as File).name ?? '';
        if (name.endsWith('.gltf')) {
            const text    = new TextDecoder().decode(buffer);
            const results = await parseSkinnedGLTF(text);
            return this._createSkinnedMeshesFromGltf(x, y, z, results, material);
        }
        return this.importSkinnedGltfBuffer(x, y, z, buffer, material);
    }

    private async _createSkinnedMeshesFromGltf(
        ox: number, oy: number, oz: number,
        results: import('../../renderer/3d/gltf-importer').GltfSkinnedResult[],
        baseMaterial: Partial<Material3D> | undefined,
    ): Promise<{ skeletons: Skeleton3D[]; meshes: SkinnedMesh3D[] }> {
        const device   = this.ctx.webgpuRenderer.getDevice();
        const skeletons: Skeleton3D[] = [];
        const meshes:    SkinnedMesh3D[] = [];

        for (const r of results) {
            const skin = r.skinning;
            const jointCount = skin.jointNames.length;

            // Build Joint3D array
            const joints: Joint3D[] = [];
            for (let ji = 0; ji < jointCount; ji++) {
                const ibm = new Float32Array(skin.inverseBindMatrices.buffer,
                    skin.inverseBindMatrices.byteOffset + ji * 64, 16);
                const t = skin.jointLocalPositions.subarray(ji * 3, ji * 3 + 3);
                const q = skin.jointLocalRotations.subarray(ji * 4, ji * 4 + 4);
                const s = skin.jointLocalScales.subarray(ji * 3, ji * 3 + 3);
                joints.push({
                    index:          ji,
                    name:           skin.jointNames[ji],
                    parentIndex:    skin.jointParents[ji],
                    children:       [],
                    localPosition:  [t[0], t[1], t[2]],
                    localRotation:  [q[0], q[1], q[2], q[3]],
                    localScale:     [s[0], s[1], s[2]],
                    worldMatrix:    new Float32Array(16),
                    inverseBindMatrix: new Float32Array(ibm),
                });
            }
            // Populate children arrays
            for (const j of joints) {
                if (j.parentIndex >= 0) joints[j.parentIndex].children.push(j.index);
            }

            const skelData: SkeletonData = { name: skin.skinName, joints };
            const skeleton = new Skeleton3D(skelData);
            skeleton.name = skin.skinName;
            this.ctx.sceneGraph.root.addChild(skeleton);
            skeletons.push(skeleton);

            // Create SkinnedMesh3D
            const mesh = new SkinnedMesh3D(
                this.ctx.interactionService,
                ox + r.position[0],
                oy + r.position[1],
                oz + r.position[2],
                { primitive: 'custom', geometry: r.geometry, material: baseMaterial },
            );
            mesh.name       = r.name;
            mesh.skeletonId = skeleton.id;
            mesh.skeleton   = skeleton;
            mesh.jointIndices = skin.jointIndices;
            mesh.jointWeights = skin.jointWeights;
            mesh.skinDirty    = true;
            mesh.setRotation3D(r.rotation[0], r.rotation[1], r.rotation[2]);
            mesh.setScale3D(r.scale[0], r.scale[1], r.scale[2]);

            if (baseMaterial?.diffuse === undefined) {
                mesh.setDiffuseColor(r.diffuseColor[0], r.diffuseColor[1], r.diffuseColor[2], r.diffuseColor[3]);
            }

            if (r.diffuseImage && device) {
                const tex = device.createTexture({
                    size:  [r.diffuseImage.width, r.diffuseImage.height, 1],
                    format: 'rgba8unorm',
                    usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
                });
                device.queue.copyExternalImageToTexture({ source: r.diffuseImage }, { texture: tex }, [r.diffuseImage.width, r.diffuseImage.height]);
                mesh.diffuseTexture      = tex;
                mesh.material.hasTexture = true;
            }

            this.ctx.sceneGraph.root.addChild(mesh);
            meshes.push(mesh);
        }

        return { skeletons, meshes };
    }

    private async _createMeshesFromGltf(
        ox: number, oy: number, oz: number,
        results: GltfMeshResult[],
        baseMaterial: Partial<Material3D> | undefined,
        rawBuffer: ArrayBuffer,
        groupName?: string,
    ): Promise<Mesh3D[]> {
        if (results.length === 0) return [];
        const device = this.ctx.webgpuRenderer.getDevice();

        // Single mesh: use the standard createMesh path (undo, selection, scene graph).
        if (results.length === 1) {
            const r = results[0];
            const mesh = this.createMesh(
                ox + r.position[0], oy + r.position[1], oz + r.position[2],
                { primitive: 'custom', geometry: r.geometry, material: baseMaterial },
            );
            mesh.name = r.name;
            mesh.setRotation3D(r.rotation[0], r.rotation[1], r.rotation[2]);
            // Clamp to avoid zero-scale degenerate matrices from GLTF exporters
            mesh.setScale3D(
                Math.max(r.scale[0], 1e-6),
                Math.max(r.scale[1], 1e-6),
                Math.max(r.scale[2], 1e-6),
            );
            if (baseMaterial?.diffuse === undefined) {
                mesh.setDiffuseColor(r.diffuseColor[0], r.diffuseColor[1], r.diffuseColor[2], r.diffuseColor[3]);
            }
            this._applyGltfTextures(mesh, r, device);
            mesh.gpuDirty = true;
            mesh.glbMeshIndex = 0;
            this._modelStore.set(mesh.id, rawBuffer);
            this.autoScaleToFit([mesh.id]);
            this.ctx.scheduleRender();
            return [mesh];
        }

        // Multiple meshes: create all under one MeshGroup3D with a single undo entry.
        const group = new MeshGroup3D(this.ctx.interactionService);
        group.name = groupName ?? '3D Group';
        const created: Mesh3D[] = [];

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const mesh = new Mesh3D(
                this.ctx.interactionService,
                ox + r.position[0], oy + r.position[1], oz + r.position[2],
                { primitive: 'custom', geometry: r.geometry, material: baseMaterial },
            );
            mesh.name = r.name;
            mesh.setRotation3D(r.rotation[0], r.rotation[1], r.rotation[2]);
            // Clamp to avoid zero-scale degenerate matrices from GLTF exporters
            mesh.setScale3D(
                Math.max(r.scale[0], 1e-6),
                Math.max(r.scale[1], 1e-6),
                Math.max(r.scale[2], 1e-6),
            );
            if (baseMaterial?.diffuse === undefined) {
                mesh.setDiffuseColor(r.diffuseColor[0], r.diffuseColor[1], r.diffuseColor[2], r.diffuseColor[3]);
            }
            this._applyGltfTextures(mesh, r, device);
            mesh.gpuDirty = true;
            mesh.glbMeshIndex = i;
            this._modelStore.set(mesh.id, rawBuffer);
            group.addChild(mesh);
            created.push(mesh);
        }

        const root = this.ctx.sceneGraph.root;
        root.addChild(group);
        // Auto-scale: GLTF uses metres; Salsa uses pixels. Scale up if tiny.
        this.autoScaleToFit(created.map(m => m.id));
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(group.id);
        this.renderer3D.setSelectedMeshIds(new Set(created.map(m => m.id)));
        if (this._illustrationSync) this._applyIllustrationCamera();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Import GLB',
            undo: () => {
                group.parent?.removeChild(group);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                root.addChild(group);
                for (const m of created) m.gpuDirty = true;
                this.ctx.emitSceneGraphChanged();
            },
        });

        return created;
    }

    private _applyGltfTextures(mesh: Mesh3D, r: GltfMeshResult, device: GPUDevice | null): void {
        if (r.diffuseImage && device) {
            const tex = device.createTexture({
                size: [r.diffuseImage.width, r.diffuseImage.height, 1],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            device.queue.copyExternalImageToTexture({ source: r.diffuseImage }, { texture: tex }, [r.diffuseImage.width, r.diffuseImage.height]);
            mesh.diffuseTexture = tex;
            mesh.material.hasTexture = true;
        }
        if (r.normalMapImage && device) {
            const tex = device.createTexture({
                size: [r.normalMapImage.width, r.normalMapImage.height, 1],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            device.queue.copyExternalImageToTexture({ source: r.normalMapImage }, { texture: tex }, [r.normalMapImage.width, r.normalMapImage.height]);
            mesh.normalMapTexture = tex;
            mesh.material.hasNormalMap = true;
            if (!mesh.diffuseTexture && device) {
                const w = device.createTexture({ size: [1,1,1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
                device.queue.writeTexture({ texture: w }, new Uint8Array([255,255,255,255]), { bytesPerRow: 4 }, [1,1,1]);
                mesh.diffuseTexture = w;
                mesh.material.hasTexture = true;
            }
        }
    }

    /**
     * Recreate a Mesh3D from serialized state (e.g. from OPFS restore).
     * For GLTF-imported meshes pass the raw GLB buffer; for primitives/custom
     * geometry it is optional (geometry is reconstructed from the saved vertices).
     */
    async restoreMeshState(state: any, glbBuffer?: ArrayBuffer): Promise<Mesh3D | null> {
        let mesh: Mesh3D | null = null;

        // ── ClothMesh3D ──────────────────────────────────────────────────────
        if (state.type === '3DClothMesh' && state.clothConfig) {
            const grid: ClothGridConfig = {
                cols:             state.clothConfig.cols             ?? 8,
                rows:             state.clothConfig.rows             ?? 10,
                cellSize:         state.clothConfig.cellSize         ?? 0.1,
                cornerRadius:     state.clothConfig.cornerRadius     ?? 0,
                subdivisions:     state.clothConfig.subdivisions     ?? 1,
                activeCells:      Array.from(state.clothConfig.activeCells    ?? []),
                pinnedVertices:   Array.from(state.clothConfig.pinnedVertices ?? []),
                stitches:         state.clothConfig.stitches         ? [...state.clothConfig.stitches]         : undefined,
                bendStiffnessMap: state.clothConfig.bendStiffnessMap ? Array.from(state.clothConfig.bendStiffnessMap) : undefined,
            };
            const physics: ClothPhysicsConfig = { ...DEFAULT_CLOTH_PHYSICS, ...state.physicsConfig };
            const liveConfig: ClothLiveConfig = {
                ...DEFAULT_CLOTH_LIVE,
                ...state.liveConfig,
                windZones: state.liveConfig?.windZones ? [...state.liveConfig.windZones] : undefined,
            };
            const simState: ClothSimState = {
                positions:      Array.from(state.simState?.positions      ?? []),
                isSimulated:    state.simState?.isSimulated    ?? false,
                simulationMode: state.simState?.simulationMode ?? 'none',
            };

            // Rebuild geometry from config (reconstructs constraint graph too)
            const result   = buildClothGeometry(grid);
            const savedPos = simState.isSimulated ? new Float32Array(simState.positions) : undefined;
            const geometry = _resolveClothGeometry(result, savedPos, physics);

            const clothMesh = new ClothMesh3D(
                this.ctx.interactionService,
                state.x ?? 0, state.y ?? 0, state.z ?? 0,
                geometry, grid, physics, simState, liveConfig,
            );
            clothMesh.name = state.name ?? 'Cloth';
            clothMesh.setRotation3D(state.rotationX ?? 0, state.rotationY ?? 0, state.rotation ?? 0);
            clothMesh.setScale3D(state.scaleX ?? 1, state.scaleY ?? 1, state.scaleZ ?? 1);
            if (state.material) { Object.assign(clothMesh.material, state.material); clothMesh.gpuDirty = true; }
            clothMesh.textureLibraryId   = state.textureLibraryId   ?? null;
            clothMesh.normalMapLibraryId = state.normalMapLibraryId ?? null;
            if (state.keyframeTracks) clothMesh.keyframeTracks = state.keyframeTracks;
            if (state.frameLinkAnimation3D) this.setFrameLinkAnimation3D(clothMesh.id, state.frameLinkAnimation3D);

            this._clothData.set(clothMesh.id, result);

            const parent = this.ctx.sceneGraph.root;
            parent.addChild(clothMesh);
            this.ctx.emitSceneGraphChanged();

            // Re-enable live physics if it was active when saved
            if (liveConfig.enabled) this.enableLiveCloth(clothMesh.id, liveConfig.stepsPerFrame);

            return clothMesh;
        }

        // ── SkinnedMesh3D ─────────────────────────────────────────────────────
        if (state.type === 'SkinnedMesh3D' && glbBuffer) {
            const results = await parseSkinnedGLB(glbBuffer);
            const r = results[0] ?? null;
            if (!r) return null;

            const skinnedMesh = new SkinnedMesh3D(
                this.ctx.interactionService,
                state.x ?? 0, state.y ?? 0, state.z ?? 0,
                { geometry: r.geometry, material: state.material },
            );

            // Restore saved ID so skeleton link (skeletonId) resolves correctly.
            if (state.id) (skinnedMesh as any).id = state.id;

            skinnedMesh.name       = state.name ?? 'Skinned Mesh';
            skinnedMesh.skeletonId = state.skeletonId ?? null;
            skinnedMesh.setRotation3D(state.rotationX ?? 0, state.rotationY ?? 0, state.rotation ?? 0);
            skinnedMesh.setScale3D(state.scaleX ?? 1, state.scaleY ?? 1, state.scaleZ ?? 1);
            if (state.material) { Object.assign(skinnedMesh.material, state.material); skinnedMesh.gpuDirty = true; }
            skinnedMesh.textureLibraryId   = state.textureLibraryId   ?? null;
            skinnedMesh.normalMapLibraryId = state.normalMapLibraryId ?? null;
            if (state.keyframeTracks) skinnedMesh.keyframeTracks = state.keyframeTracks;

            // Restore skinning arrays — prefer saved base64 (authoritative), fall back to parsed data.
            if (state.jointIndicesB64) {
                skinnedMesh.jointIndices = fromBase64ToUint8(state.jointIndicesB64);
            } else if (r.skinning?.jointIndices) {
                skinnedMesh.jointIndices = r.skinning.jointIndices;
            }
            if (state.jointWeightsB64) {
                skinnedMesh.jointWeights = fromBase64ToFloat32(state.jointWeightsB64);
            } else if (r.skinning?.jointWeights) {
                skinnedMesh.jointWeights = r.skinning.jointWeights;
            }
            skinnedMesh.skinDirty = true;

            if (state.glbMeshId) this._modelStore.set(skinnedMesh.id, glbBuffer);

            this.ctx.sceneGraph.root.addChild(skinnedMesh);
            this.ctx.emitSceneGraphChanged();
            skinnedMesh.stateDirty = false;
            return skinnedMesh;
        }

        if (glbBuffer) {
            if (state.config?.geometry?.vertices?.length) {
                // If the scene-graph restore already created this mesh (same id), update it
                // in place rather than creating a second copy outside its group.
                const existing = state.id ? this.getMesh(state.id) : null;
                if (existing) {
                    mesh = existing;
                } else {
                    // Geometry was serialized inline — restore the individual mesh directly
                    // without re-parsing the GLB (which would create a new auto-group).
                    const geom = {
                        vertices: Float32Array.from(state.config.geometry.vertices),
                        indices:  Uint32Array.from(state.config.geometry.indices ?? []),
                        format: '12float' as const,
                    };
                    mesh = this.createCustomMesh(state.x, state.y, state.z, geom, state.material);
                    // Preserve the serialized ID so group-hierarchy re-population can match
                    // this new mesh back to the MeshGroup3D that owned it before the clear.
                    if (mesh && state.id) mesh.setId(state.id);
                }
                if (mesh) {
                    this._modelStore.set(mesh.id, glbBuffer);
                    // Re-apply textures from the GLB. Use glbMeshIndex for O(1) lookup;
                    // fall back to name-based search for states saved before glbMeshIndex existed.
                    const device = this.ctx.webgpuRenderer.getDevice();
                    if (device) {
                        try {
                            const results = await parseGLB(glbBuffer);
                            const idx = state.glbMeshIndex ?? -1;
                            const r = (idx >= 0 && idx < results.length)
                                ? results[idx]
                                : (results.find(rr => rr.name === state.name) ?? results[0]);
                            if (r) this._applyGltfTextures(mesh, r, device);
                        } catch { /* broken GLB — mesh still visible via saved geometry */ }
                    }
                }
            } else {
                const meshes = await this.importGltfBuffer(state.x, state.y, state.z, glbBuffer);
                mesh = meshes[0] ?? null;
            }
        } else if (state.config?.geometry) {
            const geom = {
                vertices: Float32Array.from(state.config.geometry.vertices ?? []),
                indices:  Uint32Array.from(state.config.geometry.indices  ?? []),
                format: '12float' as const,
            };
            mesh = this.createCustomMesh(state.x, state.y, state.z, geom, state.material);
        } else if (state.primitive && state.primitive !== 'custom') {
            switch (state.primitive) {
                case 'box':      mesh = this.createBox(state.x, state.y, state.z); break;
                case 'sphere':   mesh = this.createSphere(state.x, state.y, state.z); break;
                case 'plane':    mesh = this.createPlane(state.x, state.y, state.z); break;
                case 'cylinder': mesh = this.createCylinder(state.x, state.y, state.z); break;
                case 'torus':    mesh = this.createTorus(state.x, state.y, state.z); break;
                default: break;
            }
        }

        if (!mesh) return null;

        mesh.name = state.name ?? mesh.name;
        mesh.setRotation3D(state.rotationX ?? 0, state.rotationY ?? 0, state.rotation ?? 0);
        mesh.setScale3D(state.scaleX ?? 1, state.scaleY ?? 1, state.scaleZ ?? 1);
        if (state.material) { Object.assign(mesh.material, state.material); mesh.gpuDirty = true; }
        // Object.assign may have overwritten hasTexture/hasNormalMap with stale saved values
        // (e.g. a degraded state where textures weren't applied on a previous restore cycle).
        // Re-derive the flags from the actual GPU texture references set by _applyGltfTextures.
        if (mesh.diffuseTexture)   mesh.material.hasTexture   = true;
        if (mesh.normalMapTexture) mesh.material.hasNormalMap = true;

        // Restore source-index so future saves can use index-based texture lookup.
        if (state.glbMeshIndex != null) mesh.glbMeshIndex = state.glbMeshIndex;

        // Restore texture library IDs so restoreTextureLibraryData() can bind GPU textures.
        mesh.textureLibraryId    = state.textureLibraryId    ?? null;
        mesh.normalMapLibraryId  = state.normalMapLibraryId  ?? null;
        if (state.keyframeTracks) mesh.keyframeTracks = state.keyframeTracks;
        if (state.frameLinkAnimation3D) this.setFrameLinkAnimation3D(mesh.id, state.frameLinkAnimation3D);

        // Restore ribbon metadata and regenerate geometry from control points
        if (state.ribbonData) {
            const rd: RibbonData = {
                ...state.ribbonData,
                meshId: mesh.id,
                doubleSided:  state.ribbonData.doubleSided === false ? 'front' : (state.ribbonData.doubleSided === true ? 'double' : (state.ribbonData.doubleSided ?? 'double')),
                flipRearU:    state.ribbonData.flipRearU    ?? false,
                uvTileCount:  state.ribbonData.uvTileCount  ?? 1,
            };
            this._ribbonData.set(mesh.id, rd);
            let camPos: [number, number, number] = [0, 0, 3];
            try { const c = this.renderer3D.getCamera(); camPos = [c.position[0], c.position[1], c.position[2]]; } catch {}
            mesh.setGeometry(generateRibbon({
                controlPoints: rd.controlPoints.map((p: RibbonControlPoint) => [p.x, p.y, p.z] as [number, number, number]),
                width: rd.width,
                segments: rd.segments,
                uvScrollOffset: rd.uvScrollOffset,
                uvScrollOffsetV: rd.uvScrollOffsetV,
                uvEndPadding: rd.uvEndPadding,
                uvTileCount: rd.uvTileCount,
                pathMode: rd.pathMode,
                cameraPosition: camPos,
                doubleSided: rd.doubleSided,
                flipRearU: rd.flipRearU,
            }));
            if (rd.pathMode === 'camera-facing') this._ensureRibbonUpdateCb();

            // Auto-restore HTML texture from cached content
            if (rd.htmlContent && rd.htmlTextureWidth && rd.htmlTextureHeight) {
                const opts: HtmlTexture3DOptions = {};
                if (rd.htmlTextureBgColor !== undefined) opts.backgroundColor = rd.htmlTextureBgColor;
                if (rd.htmlTextureStretchToFit !== undefined) opts.stretchToFit = rd.htmlTextureStretchToFit;
                // Fire and forget — texture restore is async but mesh is already visible with geometry
                this.setHtmlTexture3D(mesh.id, rd.htmlContent, rd.htmlTextureWidth, rd.htmlTextureHeight, opts);
            }
        }

        mesh.stateDirty = false;
        this.clearSelection();
        return mesh;
    }

    // ── Auto-scale ───────────────────────────────────────────────────

    /**
     * Scale a group of meshes so their combined local-space bounding box fits
     * within `targetSize` world units. Only scales when the span is suspiciously
     * small (< 5% of targetSize) — the typical symptom of GLTF metre-vs-pixel mismatch.
     * @param meshIds IDs of meshes to scale (e.g., all meshes returned by importGltfFile)
     * @param targetSize Desired max span in world units (default 400)
     */
    autoScaleToFit(meshIds: string[], targetSize = 400): void {
        if (meshIds.length === 0) return;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const id of meshIds) {
            const mesh = this.getMesh(id);
            const v = mesh?.geometry?.vertices;
            if (!v || v.length < 3) continue;
            for (let i = 0; i < v.length; i += 12) {
                if (v[i]   < minX) minX = v[i];   if (v[i]   > maxX) maxX = v[i];
                if (v[i+1] < minY) minY = v[i+1]; if (v[i+1] > maxY) maxY = v[i+1];
                if (v[i+2] < minZ) minZ = v[i+2]; if (v[i+2] > maxZ) maxZ = v[i+2];
            }
        }

        if (!isFinite(minX)) return;

        const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.0001);
        if (span >= targetSize * 0.05) return; // already a reasonable size

        const scale = (targetSize * 0.5) / span;
        for (const id of meshIds) {
            const mesh = this.getMesh(id);
            if (!mesh) continue;
            mesh.setScale3D(mesh.scaleX * scale, mesh.scaleY * scale, mesh.scaleZ * scale);
        }
        this.ctx.scheduleRender();
    }

    // ── Model store (raw GLB bytes, for project save/load) ───────────

    /** Raw GLB buffer keyed by mesh ID — populated when a mesh is imported from GLTF. */
    private _modelStore = new Map<string, ArrayBuffer>();

    /** Returns all stored model buffers as { meshId → ArrayBuffer }. */
    getModelStore(): Map<string, ArrayBuffer> { return this._modelStore; }

    /** Restore a raw GLB buffer into the model store (used during project load). */
    storeModelBuffer(meshId: string, buffer: ArrayBuffer): void {
        this._modelStore.set(meshId, buffer);
    }

    /**
     * If `meshId` is not in the model store but belongs to a MeshGroup3D whose
     * sibling is in the store, returns that sibling's ID.  This lets _buildMeshState
     * assign a valid glbMeshId to every mesh in a group even after a degraded save
     * cycle where some entries were lost from _modelStore.
     */
    findGroupMemberGlbId(meshId: string): string | undefined {
        const m = this.getMesh(meshId);
        if (!m || !(m.parent instanceof MeshGroup3D)) return undefined;
        for (const child of m.parent.children) {
            const id = (child as any).id as string | undefined;
            if (id && id !== meshId && this._modelStore.has(id)) return id;
        }
        return undefined;
    }

    // ── Outline pass ─────────────────────────────────────────────────

    /** Enable the screen-space ink outline effect. */
    enableOutlines(color?: [number, number, number, number], threshold?: number): void {
        this.renderer3D.enableOutlines(color, threshold);
        this.ctx.scheduleRender();
    }

    /** Disable the screen-space ink outline effect. */
    disableOutlines(): void {
        this.renderer3D.disableOutlines();
        this.ctx.scheduleRender();
    }

    /** Set the outline colour (r, g, b, a in 0–1 range). */
    setOutlineColor(r: number, g: number, b: number, a = 1): void {
        this.renderer3D.setOutlineColor(r, g, b, a);
    }

    /** Set the outline width in physical pixels (default 2). Larger = thicker silhouette. */
    setOutlineThreshold(t: number): void {
        this.renderer3D.setOutlineThreshold(t);
    }

    get outlineEnabled(): boolean { return this.renderer3D.outlineEnabled; }

    // ── Render style ─────────────────────────────────────────────────

    /** Set the render style on a mesh ('default' | 'cel' | 'sketch' | 'ink'). */
    setRenderStyle(nodeId: string, style: RenderStyle): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        mesh.material.renderStyle = style;
        mesh.gpuDirty = true;
        mesh.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    getRenderStyle(nodeId: string): RenderStyle | null {
        return this.getMesh(nodeId)?.material.renderStyle ?? null;
    }

    private createMesh(x: number, y: number, z: number, config: Mesh3DConfig): Mesh3D {
        const mesh = new Mesh3D(this.ctx.interactionService, x, y, z, config);

        // In illustration mode 1 world unit = 1 canvas pixel (at zoom=1).
        // Auto-scale primitive meshes so they appear a reasonable size (~100px) on the canvas.
        // Custom geometry (GLTF/OBJ imports) is left at its original scale.
        if (this._illustrationSync && config.primitive !== 'custom') {
            const s = this.illustrationMeshDefaultScale();
            mesh.setScale3D(s, s, s);
        }

        const parent = this.ctx.sceneGraph.root;
        parent.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(mesh.id);
        this.renderer3D.setSelectedMeshIds(new Set([mesh.id]));

        // If the illustration camera sync params are available, re-apply the camera now.
        // This handles the case where _renderer3D hasn't been initialized yet (no pan/zoom
        // has happened this session), ensuring it's created with the correct camera
        // position rather than the default (0,0,3) which would frustum-cull canvas-placed meshes.
        if (this._illustrationSync) this._applyIllustrationCamera();

        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Create mesh',
            undo: () => {
                mesh.parent?.removeChild(mesh);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                parent.addChild(mesh);
                mesh.gpuDirty = true;
                this.ctx.emitSceneGraphChanged();
            },
        });

        return mesh;
    }

    getMesh(nodeId: string): Mesh3D | null {
        const node = this.ctx.sceneGraph.findNodeById(nodeId);
        return node instanceof Mesh3D ? node : null;
    }

    getSkeleton(nodeId: string): Skeleton3D | null {
        const node = this.ctx.sceneGraph.findNodeById(nodeId);
        return node instanceof Skeleton3D ? node : null;
    }

    getSkinnedMesh(nodeId: string): SkinnedMesh3D | null {
        const node = this.ctx.sceneGraph.findNodeById(nodeId);
        return node instanceof SkinnedMesh3D ? node : null;
    }

    /** Get all Mesh3D nodes in the scene. */
    getAllMeshes(): Mesh3D[] {
        const meshes: Mesh3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep?.((n: any) => {
            if (n instanceof Mesh3D) meshes.push(n);
        });
        return meshes;
    }

    /** Get all Skeleton3D nodes in the scene. */
    getAllSkeletons(): Skeleton3D[] {
        const skeletons: Skeleton3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep?.((n: any) => {
            if (n instanceof Skeleton3D) skeletons.push(n);
        });
        return skeletons;
    }

    /**
     * Recreate a Skeleton3D from serialized state produced by Skeleton3D.toJSON().
     * Adds the skeleton to the scene graph root.
     */
    restoreSkeletonState(state: any): Skeleton3D {
        const skel = Skeleton3D.fromJSON(state);
        this.ctx.sceneGraph.root.addChild(skel);
        return skel;
    }

    /**
     * Re-link SkinnedMesh3D.skeleton references after a full restore.
     * Searches all skinned meshes for a matching Skeleton3D by skeletonId.
     */
    relinkSkinnedMeshSkeletons(): void {
        const skeletonMap = new Map<string, Skeleton3D>();
        for (const skel of this.getAllSkeletons()) skeletonMap.set(skel.id, skel);

        for (const mesh of this.getAllMeshes()) {
            if (!(mesh instanceof SkinnedMesh3D)) continue;
            if (mesh.skeletonId && skeletonMap.has(mesh.skeletonId)) {
                mesh.skeleton = skeletonMap.get(mesh.skeletonId)!;
            }
        }
    }

    // ── Kitbash library (Phase B) ────────────────────────────────────

    /**
     * Fetch and parse a kitbash part manifest from the given URL.
     * After loading, parts are available via getKitbashParts().
     */
    async loadKitbashManifest(url: string): Promise<void> {
        await this._kitbashLibrary.loadManifest(url);
    }

    /** Register parts from a pre-parsed array (e.g. from a bundled import). */
    addKitbashParts(parts: KitbashPartMeta[]): void {
        this._kitbashLibrary.addParts(parts);
    }

    /** Return all parts for a given slot, or [] if none are loaded. */
    getKitbashParts(slot: CharacterSlot): KitbashPartMeta[] {
        return this._kitbashLibrary.getPartsBySlot(slot);
    }

    /** Return all slot types that have at least one part loaded. */
    getKitbashSlots(): CharacterSlot[] {
        return this._kitbashLibrary.getAllSlots();
    }

    // ── Character assembly (Phase B) ─────────────────────────────────

    /**
     * Assemble a character from a CharacterDefinition. Fetches GLBs for each
     * occupied slot, remaps joint indices to the canonical skeleton from base_body,
     * and places Skeleton3D + SkinnedMesh3D nodes in the scene graph.
     *
     * @returns The stable character ID (same as def.id).
     */
    async createCharacter(
        def: CharacterDefinition,
        ox = 0, oy = 0, oz = 0,
    ): Promise<string> {
        const basePartId = def.slots['base_body'];
        if (!basePartId) throw new Error('CharacterDefinition must have a base_body slot');

        const basePart = this._kitbashLibrary.getPart(basePartId);
        if (!basePart) throw new Error(`Unknown kitbash part: ${basePartId}`);

        // 1. Load + parse base_body GLB to establish the canonical skeleton.
        const baseBuf     = await this._fetchGlbBuffer(basePart.glbUrl);
        const baseResults = await parseSkinnedGLB(baseBuf);
        const baseResult  = baseResults[0];
        if (!baseResult) throw new Error('base_body GLB contained no skinned mesh');

        const skeleton = await this._createSkeletonFromResult(baseResult);
        const partMeshIds = new Map<CharacterSlot, string>();

        // 2. Create SkinnedMesh3D for base_body (already uses canonical joints).
        const baseMesh = await this._createSkinnedMeshForSlot(
            baseResult, skeleton, ox, oy, oz, def, 'base_body',
        );
        this.ctx.sceneGraph.root.addChild(baseMesh);
        this._modelStore.set(baseMesh.id, baseBuf);
        partMeshIds.set('base_body', baseMesh.id);

        // 3. For each additional slot, fetch GLB, remap joints, create mesh.
        for (const [slot, partId] of Object.entries(def.slots) as [CharacterSlot, string][]) {
            if (slot === 'base_body') continue;
            const partMeta = this._kitbashLibrary.getPart(partId);
            if (!partMeta) { console.warn(`KitbashAssembler: unknown part ${partId} for slot ${slot}`); continue; }

            const partBuf     = await this._fetchGlbBuffer(partMeta.glbUrl);
            const partResults = await parseSkinnedGLB(partBuf);
            const partResult  = partResults[0];
            if (!partResult) { console.warn(`KitbashAssembler: GLB for ${partId} has no skinned mesh`); continue; }

            // Remap JOINTS_0 from part-local indices to canonical skeleton indices.
            this._remapJointIndices(partResult, skeleton);

            const mesh = await this._createSkinnedMeshForSlot(
                partResult, skeleton, ox, oy, oz, def, slot,
            );
            this.ctx.sceneGraph.root.addChild(mesh);
            this._modelStore.set(mesh.id, partBuf);
            partMeshIds.set(slot, mesh.id);
        }

        // 4. Apply color tints.
        if (def.skinTone) {
            const baseId = partMeshIds.get('base_body');
            const bm = baseId ? this.getMesh(baseId) : null;
            if (bm) bm.setDiffuseColor(def.skinTone.r / 255, def.skinTone.g / 255, def.skinTone.b / 255, 1);
        }
        if (def.hairColor) {
            const hairId = partMeshIds.get('hair');
            const hm = hairId ? this.getMesh(hairId) : null;
            if (hm) hm.setDiffuseColor(def.hairColor.r / 255, def.hairColor.g / 255, def.hairColor.b / 255, 1);
        }

        // 5. Register the character.
        const charData: CharacterData = {
            id: def.id,
            definition: { ...def, slots: { ...def.slots } },
            skeletonId: skeleton.id,
            partMeshIds,
        };
        this._characterMap.set(charData.id, charData);

        this._undoManager.push({
            description: 'Create character',
            undo: () => { this._destroyCharacterNodes(charData); this._characterMap.delete(charData.id); this.ctx.emitSceneGraphChanged(); },
            redo: () => { /* re-adding is async — not supported inline; re-create via createCharacter */ },
        });

        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return charData.id;
    }

    /**
     * Swap one slot on a live character. Removes the old mesh, loads the new
     * part GLB, remaps joints, and attaches the new mesh.
     */
    async swapCharacterSlot(charId: string, slot: CharacterSlot, partId: string): Promise<void> {
        const charData = this._characterMap.get(charId);
        if (!charData) return;

        const partMeta = this._kitbashLibrary.getPart(partId);
        if (!partMeta) throw new Error(`Unknown kitbash part: ${partId}`);

        const skeleton = this.getSkeleton(charData.skeletonId);
        if (!skeleton) throw new Error(`Skeleton ${charData.skeletonId} not found`);

        // Remove the old mesh for this slot.
        const oldMeshId = charData.partMeshIds.get(slot);
        if (oldMeshId) {
            const oldMesh = this.getMesh(oldMeshId);
            if (oldMesh) {
                oldMesh.parent?.removeChild(oldMesh);
                this._modelStore.delete(oldMeshId);
            }
            charData.partMeshIds.delete(slot);
        }

        // Load and attach the new part.
        const partBuf     = await this._fetchGlbBuffer(partMeta.glbUrl);
        const partResults = await parseSkinnedGLB(partBuf);
        const partResult  = partResults[0];
        if (!partResult) { console.warn(`KitbashAssembler: GLB for ${partId} has no skinned mesh`); return; }

        this._remapJointIndices(partResult, skeleton);
        const mesh = await this._createSkinnedMeshForSlot(
            partResult, skeleton,
            charData.definition.slots[slot] !== undefined ? 0 : 0, 0, 0,
            charData.definition, slot,
        );
        this.ctx.sceneGraph.root.addChild(mesh);
        this._modelStore.set(mesh.id, partBuf);

        charData.partMeshIds.set(slot, mesh.id);
        charData.definition.slots[slot] = partId;

        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Apply a diffuse color tint to one slot's mesh. */
    setCharacterSlotColor(charId: string, slot: CharacterSlot, r: number, g: number, b: number): void {
        const charData = this._characterMap.get(charId);
        if (!charData) return;
        const meshId = charData.partMeshIds.get(slot);
        if (!meshId) return;
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        mesh.setDiffuseColor(r / 255, g / 255, b / 255, 1);
        this.ctx.scheduleRender();
    }

    /** Remove a character and all its skeleton + part meshes from the scene. */
    removeCharacter(charId: string): void {
        const charData = this._characterMap.get(charId);
        if (!charData) return;
        this._destroyCharacterNodes(charData);
        this._characterMap.delete(charId);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Get the CharacterData for a given character ID, or null. */
    getCharacter(charId: string): CharacterData | null {
        return this._characterMap.get(charId) ?? null;
    }

    /** Get all assembled characters in the scene. */
    getAllCharacters(): CharacterData[] {
        return [...this._characterMap.values()];
    }

    // ── Character serialization ───────────────────────────────────────

    /** Serialize all assembled characters for project save. */
    getScene3DCharacterStates(): any[] {
        return [...this._characterMap.values()].map(c => ({
            id:         c.id,
            definition: c.definition,
            skeletonId: c.skeletonId,
            partMeshIds: Object.fromEntries(c.partMeshIds),
        }));
    }

    /**
     * Restore character catalog entries from serialized states.
     * Call AFTER restoring meshes and skeletons so the referenced node IDs exist.
     */
    restoreCharacterStates(states: any[]): void {
        this._characterMap.clear();
        for (const s of states) {
            const partMeshIds = new Map<CharacterSlot, string>(
                Object.entries(s.partMeshIds ?? {}) as [CharacterSlot, string][],
            );
            this._characterMap.set(s.id, {
                id:         s.id,
                definition: s.definition,
                skeletonId: s.skeletonId,
                partMeshIds,
            });
        }
    }

    // ── Private character assembly helpers ────────────────────────────

    private async _fetchGlbBuffer(url: string): Promise<ArrayBuffer> {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`KitbashAssembler: failed to fetch ${url} (${res.status})`);
        return res.arrayBuffer();
    }

    private async _createSkeletonFromResult(
        result: import('../../renderer/3d/gltf-importer').GltfSkinnedResult,
    ): Promise<Skeleton3D> {
        const skin = result.skinning;
        const jointCount = skin.jointNames.length;
        const joints: Joint3D[] = [];
        for (let ji = 0; ji < jointCount; ji++) {
            const ibm = new Float32Array(
                skin.inverseBindMatrices.buffer,
                skin.inverseBindMatrices.byteOffset + ji * 64,
                16,
            );
            const t = skin.jointLocalPositions.subarray(ji * 3, ji * 3 + 3);
            const q = skin.jointLocalRotations.subarray(ji * 4, ji * 4 + 4);
            const s = skin.jointLocalScales.subarray(ji * 3, ji * 3 + 3);
            joints.push({
                index:            ji,
                name:             skin.jointNames[ji],
                parentIndex:      skin.jointParents[ji],
                children:         [],
                localPosition:    [t[0], t[1], t[2]],
                localRotation:    [q[0], q[1], q[2], q[3]],
                localScale:       [s[0], s[1], s[2]],
                worldMatrix:      new Float32Array(16),
                inverseBindMatrix: new Float32Array(ibm),
            });
        }
        for (const j of joints) {
            if (j.parentIndex >= 0) joints[j.parentIndex].children.push(j.index);
        }
        const skelData: SkeletonData = { name: skin.skinName, joints };
        const skeleton = new Skeleton3D(skelData);
        skeleton.name  = skin.skinName;
        this.ctx.sceneGraph.root.addChild(skeleton);
        return skeleton;
    }

    private async _createSkinnedMeshForSlot(
        result: import('../../renderer/3d/gltf-importer').GltfSkinnedResult,
        skeleton: Skeleton3D,
        ox: number, oy: number, oz: number,
        def: CharacterDefinition,
        slot: CharacterSlot,
    ): Promise<SkinnedMesh3D> {
        const device = this.ctx.webgpuRenderer.getDevice();
        const mesh   = new SkinnedMesh3D(
            this.ctx.interactionService,
            ox + result.position[0],
            oy + result.position[1],
            oz + result.position[2],
            { primitive: 'custom', geometry: result.geometry },
        );
        mesh.name         = `${def.name}_${slot}`;
        mesh.skeletonId   = skeleton.id;
        mesh.skeleton     = skeleton;
        mesh.jointIndices = result.skinning.jointIndices.slice();
        mesh.jointWeights = result.skinning.jointWeights.slice();
        mesh.skinDirty    = true;
        mesh.setRotation3D(result.rotation[0], result.rotation[1], result.rotation[2]);
        mesh.setScale3D(result.scale[0], result.scale[1], result.scale[2]);
        mesh.setDiffuseColor(
            result.diffuseColor[0], result.diffuseColor[1],
            result.diffuseColor[2], result.diffuseColor[3],
        );
        if (result.diffuseImage && device) {
            const tex = device.createTexture({
                size:   [result.diffuseImage.width, result.diffuseImage.height, 1],
                format: 'rgba8unorm',
                usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            device.queue.copyExternalImageToTexture(
                { source: result.diffuseImage },
                { texture: tex },
                [result.diffuseImage.width, result.diffuseImage.height],
            );
            mesh.diffuseTexture      = tex;
            mesh.material.hasTexture = true;
        }
        return mesh;
    }

    /**
     * Remap a part mesh's JOINTS_0 indices from its local joint array to the
     * canonical skeleton's joint array, matching by joint name.
     */
    private _remapJointIndices(
        partResult: import('../../renderer/3d/gltf-importer').GltfSkinnedResult,
        canonicalSkeleton: Skeleton3D,
    ): void {
        const partNames = partResult.skinning.jointNames;
        const remap     = new Uint8Array(partNames.length);
        for (let i = 0; i < partNames.length; i++) {
            const canonIdx = canonicalSkeleton.data.joints.findIndex(j => j.name === partNames[i]);
            remap[i] = canonIdx >= 0 ? canonIdx : 0;
        }
        const indices = partResult.skinning.jointIndices;
        for (let v = 0; v < indices.length; v++) {
            indices[v] = remap[indices[v]];
        }
    }

    private _destroyCharacterNodes(charData: CharacterData): void {
        for (const meshId of charData.partMeshIds.values()) {
            const m = this.getMesh(meshId);
            if (m) { m.parent?.removeChild(m); this._modelStore.delete(meshId); }
        }
        const skel = this.getSkeleton(charData.skeletonId);
        if (skel) skel.parent?.removeChild(skel);
    }

    // ── Grease Pencil 3D (Phase C) ────────────────────────────────────

    /** Create a new GpObject3D in the scene and return its ID. */
    createGpObject(name = 'GP Object', skeletonId?: string): string {
        const gpObj = new GpObject3D(this.ctx.interactionService);
        gpObj.name       = name;
        gpObj.skeletonId = skeletonId;
        gpObj.addLayer('Layer 1');
        this.ctx.sceneGraph.root.addChild(gpObj);
        this._gpObjects.set(gpObj.id, gpObj);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return gpObj.id;
    }

    /** Remove a GpObject3D from the scene. */
    removeGpObject(gpId: string): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.parent?.removeChild(gpObj);
        this._gpObjects.delete(gpId);
        if (this._gpActiveStroke?.gpId === gpId) this._gpActiveStroke = null;
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    getGpObject(gpId: string): GpObject3D | null {
        return this._gpObjects.get(gpId) ?? null;
    }

    getAllGpObjects(): GpObject3D[] {
        return [...this._gpObjects.values()];
    }

    /** Add a layer to a GpObject3D. Returns the new layer ID. */
    addGpLayer(gpId: string, name = 'Layer'): string {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return '';
        const layerId = gpObj.addLayer(name);
        this.ctx.scheduleRender();
        return layerId;
    }

    /** Remove a layer from a GpObject3D. */
    removeGpLayer(gpId: string, layerId: string): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.removeLayer(layerId);
        this.ctx.scheduleRender();
    }

    /**
     * Begin a new stroke on a layer. Returns the strokeId.
     * Call addGpPoint() repeatedly, then endGpStroke().
     */
    beginGpStroke(
        gpId: string,
        layerId: string,
        color: { r: number; g: number; b: number; a: number },
        baseWidth: number,
        options?: { fillColor?: { r: number; g: number; b: number; a: number }; parentJoint?: string; closed?: boolean; frame?: number },
    ): string {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return '';

        // If a stroke is already open, close it first.
        if (this._gpActiveStroke) this.endGpStroke();

        const strokeId = gpObj.addStroke(layerId, {
            points:     [],
            color,
            baseWidth,
            fillColor:   options?.fillColor,
            parentJoint: options?.parentJoint,
            closed:      options?.closed ?? false,
        });

        // For keyframe strokes, add to keyframe list instead.
        if (options?.frame !== undefined) {
            gpObj.setKeyframe(layerId, options.frame);
        }

        this._gpActiveStroke = { gpId, layerId, strokeId };
        return strokeId;
    }

    /** Add a point to the currently active GP stroke. */
    addGpPoint(x: number, y: number, z: number, pressure = 1, opacity = 1): void {
        if (!this._gpActiveStroke) return;
        const { gpId, layerId, strokeId } = this._gpActiveStroke;
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        const layer = gpObj.getLayer(layerId);
        if (!layer) return;
        const stroke = layer.strokes.find(s => s.id === strokeId);
        if (!stroke) return;
        stroke.points.push({ x, y, z, pressure, opacity });
        this.ctx.scheduleRender();
    }

    /** Finalize the active GP stroke. Strokes with < 2 points are discarded. */
    endGpStroke(): void {
        if (!this._gpActiveStroke) return;
        const { gpId, layerId, strokeId } = this._gpActiveStroke;
        this._gpActiveStroke = null;
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        const layer = gpObj.getLayer(layerId);
        if (!layer) return;
        const stroke = layer.strokes.find(s => s.id === strokeId);
        if (stroke && stroke.points.length < 2) {
            gpObj.removeStroke(layerId, strokeId);
        }
        this.ctx.scheduleRender();
    }

    /**
     * Erase GP strokes within `radius` world units of `worldPos` on a layer.
     * Pass `frame` to erase from a keyframe instead of base strokes.
     */
    eraseGpStrokes(gpId: string, layerId: string, worldPos: [number, number, number], radius: number, frame?: number): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.eraseStrokes(layerId, worldPos, radius, frame);
        this.ctx.scheduleRender();
    }

    /** Snapshot the current base strokes of a layer as a keyframe. */
    setGpKeyframe(gpId: string, layerId: string, frame: number): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.setKeyframe(layerId, frame);
    }

    /** Remove the keyframe snapshot at frame N for a layer. */
    clearGpKeyframe(gpId: string, layerId: string, frame: number): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.clearKeyframe(layerId, frame);
    }

    /** Set draw order for a GP object within the GP pass. 0 = default; negative = background. */
    setGpRenderOrder(gpId: string, order: number): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.renderOrder = order;
        this.ctx.scheduleRender();
    }

    // ── GP serialization ──────────────────────────────────────────────

    getScene3DGpStates(): any[] {
        return [...this._gpObjects.values()].map(g => g.toJSON());
    }

    restoreGpStates(states: any[]): void {
        this._gpObjects.clear();
        // Remove any existing GpObject3D nodes from the scene graph.
        const existing: GpObject3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep(n => { if (n instanceof GpObject3D) existing.push(n); });
        for (const n of existing) n.parent?.removeChild(n);

        for (const s of states) {
            const gpObj = GpObject3D.fromJSON(s, this.ctx.interactionService);
            this.ctx.sceneGraph.root.addChild(gpObj);
            this._gpObjects.set(gpObj.id, gpObj);
        }
    }

    // ── Joint picking (A11) ─────────────────────────────────────────

    /** The index of the currently selected joint in the active bone overlay, or null. */
    getSelectedJointIndex(): number | null { return this._selectedJointIndex; }

    /** The ID of the skeleton whose bone overlay is currently active, or null. */
    getBoneOverlaySkeletonId(): string | null { return this._boneOverlaySkeletonId; }

    /**
     * Programmatically select a joint in the active bone overlay.
     * @param jointIndex  Joint index into skeleton.data.joints[], or null to deselect.
     */
    selectJoint(jointIndex: number | null): void {
        this._selectedJointIndex = jointIndex;
        this.renderer3D.setSelectedJoint(jointIndex);
        this.ctx.scheduleRender();
    }

    /** Clear the active joint selection without clearing the bone overlay. */
    clearJointSelection(): void { this.selectJoint(null); }

    // ── Mesh Grouping ───────────────────────────────────────────────

    createMeshGroup(name = '3D Group'): MeshGroup3D {
        const g = new MeshGroup3D(this.ctx.interactionService);
        g.name = name;
        const parent = this.ctx.sceneGraph.root;
        parent.addChild(g);
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(g.id);
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Create group',
            undo: () => {
                g.parent?.removeChild(g);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                parent.addChild(g);
                this.ctx.emitSceneGraphChanged();
            },
        });

        return g;
    }

    /** Delete a mesh group (and un-parent its children to root). Pushes an undo command. */
    deleteMeshGroup(groupId: string): boolean {
        const group = this.getMeshGroup(groupId);
        if (!group) return false;
        const savedParent = group.parent ?? this.ctx.sceneGraph.root;
        const children = [...group.children];

        // Lift children to root before removing the group
        for (const child of children) {
            group.removeChild(child);
            this.ctx.sceneGraph.root.addChild(child);
        }
        group.parent?.removeChild(group);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Delete group',
            undo: () => {
                // Re-adopt children and re-add group
                for (const child of children) {
                    child.parent?.removeChild(child);
                    group.addChild(child);
                }
                savedParent.addChild(group);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                for (const child of children) {
                    group.removeChild(child);
                    this.ctx.sceneGraph.root.addChild(child);
                }
                group.parent?.removeChild(group);
                this.ctx.emitSceneGraphChanged();
            },
        });

        return true;
    }

    getMeshGroup(groupId: string): MeshGroup3D | null {
        const n = this.ctx.sceneGraph.findNodeById(groupId);
        return n instanceof MeshGroup3D ? n : null;
    }

    getMeshGroups(): MeshGroup3D[] {
        const groups: MeshGroup3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep?.((n: any) => {
            if (n instanceof MeshGroup3D) groups.push(n);
        });
        return groups;
    }

    /**
     * When clicking a mesh inside a MeshGroup3D, bubble selection up to the group:
     * expand the provided IDs to all Mesh3D siblings in the same group and return
     * the group's ID for outliner sync. Falls through unchanged for non-group meshes.
     */
    private _expandGroupSelection(ids: Set<string>): { meshIds: Set<string>; groupId: string | null } {
        if (ids.size === 0) return { meshIds: ids, groupId: null };

        let commonGroup: MeshGroup3D | null = null;
        for (const id of ids) {
            const mesh = this.getMesh(id);
            if (!mesh) return { meshIds: ids, groupId: null };
            const parent = mesh.parent;
            if (!(parent instanceof MeshGroup3D)) return { meshIds: ids, groupId: null };
            if (commonGroup === null) commonGroup = parent;
            else if (commonGroup !== parent) return { meshIds: ids, groupId: null };
        }

        if (!commonGroup) return { meshIds: ids, groupId: null };

        const expanded = new Set<string>();
        for (const child of commonGroup.children) {
            if (child instanceof Mesh3D) expanded.add(child.id);
        }
        return { meshIds: expanded, groupId: commonGroup.id };
    }

    addMeshToGroup(meshId: string, groupId: string): boolean {
        const mesh = this.getMesh(meshId);
        const group = this.getMeshGroup(groupId);
        if (!mesh || !group) return false;

        mesh.parent?.removeChild(mesh);
        group.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return true;
    }

    removeMeshFromGroup(meshId: string): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh || !mesh.parent || mesh.parent === this.ctx.sceneGraph.root) return false;
        mesh.parent.removeChild(mesh);
        this.ctx.sceneGraph.root.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Delete a mesh by node ID. Pushes an undo command.
     *
     * Memory note: the undo closure keeps the Mesh3D object (and its GPU vertex/index
     * buffers) alive until the command is evicted from the undo stack. This is
     * intentional — it enables undo without re-uploading geometry — but bounds GPU
     * memory retention to at most UndoManager3D.maxDepth (50) deleted meshes.
     */
    deleteMesh(nodeId: string): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        const savedParent = mesh.parent ?? this.ctx.sceneGraph.root;
        mesh.parent?.removeChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Delete mesh',
            undo: () => {
                savedParent.addChild(mesh);
                mesh.gpuDirty = true;
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                mesh.parent?.removeChild(mesh);
                this.ctx.emitSceneGraphChanged();
            },
        });

        return true;
    }

    /**
     * Duplicate a mesh, placing the copy offset slightly from the original.
     * Copies geometry reference, material, transform, texture IDs, and keyframe tracks.
     * The new mesh is selected and pushed onto the undo stack.
     */
    duplicateMesh(nodeId: string): Mesh3D | null {
        const src = this.getMesh(nodeId);
        if (!src) return null;

        const copy = new Mesh3D(this.ctx.interactionService, src.x, src.y, src.z, {
            primitive: 'custom',
            geometry:  src.geometry,
            material:  { ...src.material },
        });
        copy.name = src.name + ' copy';
        // Offset so the duplicate doesn't sit exactly on top of the original
        copy.x += 0.5;
        copy.rotationX = src.rotationX;
        copy.rotationY = src.rotationY;
        copy.rotation  = src.rotation;
        copy.scaleX = src.scaleX;
        copy.scaleY = src.scaleY;
        copy.scaleZ = src.scaleZ;

        // Share texture library references (GPU textures are re-fetched by renderer)
        copy.textureLibraryId    = src.textureLibraryId;
        copy.normalMapLibraryId  = src.normalMapLibraryId;
        copy.diffuseTexture      = src.diffuseTexture;
        copy.normalMapTexture    = src.normalMapTexture;

        // Deep copy keyframe tracks and submeshes so they are independent
        copy.keyframeTracks = JSON.parse(JSON.stringify(src.keyframeTracks));
        copy.submeshes = JSON.parse(JSON.stringify(src.submeshes));

        const parent = src.parent ?? this.ctx.sceneGraph.root;
        parent.addChild(copy);
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(copy.id);
        this.renderer3D.setSelectedMeshIds(new Set([copy.id]));
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Duplicate mesh',
            undo: () => {
                copy.parent?.removeChild(copy);
                this.ctx.setSelectedNode(src.id);
                this.renderer3D.setSelectedMeshIds(new Set([src.id]));
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                parent.addChild(copy);
                copy.gpuDirty = true;
                this.ctx.setSelectedNode(copy.id);
                this.renderer3D.setSelectedMeshIds(new Set([copy.id]));
                this.ctx.emitSceneGraphChanged();
            },
        });

        return copy;
    }

    // ── Submesh (multi-material) CRUD ────────────────────────────────

    getSubmeshes(meshId: string): Submesh3D[] {
        return this.getMesh(meshId)?.submeshes ?? [];
    }

    setSubmesh(meshId: string, slotIndex: number, partial: Partial<Submesh3D>): void {
        const mesh = this.getMesh(meshId);
        if (!mesh || slotIndex < 0 || slotIndex >= mesh.submeshes.length) return;
        Object.assign(mesh.submeshes[slotIndex], partial);
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
    }

    appendSubmesh(meshId: string, submesh: Submesh3D): void {
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        mesh.submeshes.push({ ...submesh });
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
    }

    removeSubmesh(meshId: string, slotIndex: number): void {
        const mesh = this.getMesh(meshId);
        if (!mesh || slotIndex < 0 || slotIndex >= mesh.submeshes.length) return;
        mesh.submeshes.splice(slotIndex, 1);
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
    }

    clearSubmeshes(meshId: string): void {
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        mesh.submeshes = [];
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
    }

    // ── Mesh Properties ──────────────────────────────────────────────

    setPosition(nodeId: string, x: number, y: number, z: number): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setPosition3D(x, y, z); this.ctx.scheduleRender(); return; }
        const group = this.getMeshGroup(nodeId);
        if (group) {
            const dx = x - group.groupPos3D[0];
            const dy = y - group.groupPos3D[1];
            const dz = z - group.groupPos3D[2];
            for (const child of group.children) {
                if (child instanceof Mesh3D) { child.x += dx; child.y += dy; child.z += dz; }
            }
            group.groupPos3D = [x, y, z];
            this.ctx.scheduleRender();
        }
    }

    setRotation(nodeId: string, rx: number, ry: number, rz: number): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setRotation3D(rx, ry, rz); this.ctx.scheduleRender(); return; }
        const group = this.getMeshGroup(nodeId);
        if (group) {
            const drx = rx - group.groupRot3D[0];
            const dry = ry - group.groupRot3D[1];
            const drz = rz - group.groupRot3D[2];
            for (const child of group.children) {
                if (child instanceof Mesh3D) {
                    child.rotationX += drx;
                    child.rotationY += dry;
                    child.rotation  += drz;
                }
            }
            group.groupRot3D = [rx, ry, rz];
            this.ctx.scheduleRender();
        }
    }

    setScale(nodeId: string, sx: number, sy: number, sz: number): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) {
            mesh.setScale3D(Math.max(sx, 1e-6), Math.max(sy, 1e-6), Math.max(sz, 1e-6));
            this.ctx.scheduleRender();
            return;
        }
        const group = this.getMeshGroup(nodeId);
        if (group) {
            const ox = group.groupScale3D[0], oy = group.groupScale3D[1], oz = group.groupScale3D[2];
            const fx = ox !== 0 ? sx / ox : 1;
            const fy = oy !== 0 ? sy / oy : 1;
            const fz = oz !== 0 ? sz / oz : 1;
            // Compute group centroid
            let cx = 0, cy = 0, cz = 0, n = 0;
            for (const child of group.children) {
                if (child instanceof Mesh3D) { cx += child.x; cy += child.y; cz += child.z; n++; }
            }
            if (n > 0) { cx /= n; cy /= n; cz /= n; }
            // Scale each child's transform and position from centroid.
            // Clamp to 1e-6 so the 2D localMatrix stays invertible even if sx/sy/sz = 0.
            for (const child of group.children) {
                if (!(child instanceof Mesh3D)) continue;
                child.setScale3D(
                    Math.max(child.scaleX * fx, 1e-6),
                    Math.max(child.scaleY * fy, 1e-6),
                    Math.max(child.scaleZ * fz, 1e-6),
                );
                child.x = cx + (child.x - cx) * fx;
                child.y = cy + (child.y - cy) * fy;
                child.z = cz + (child.z - cz) * fz;
            }
            group.groupScale3D = [sx, sy, sz];
            this.ctx.scheduleRender();
        }
    }

    setMaterial(nodeId: string, material: Partial<Material3D>): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setMaterial(material); this.ctx.scheduleRender(); }
    }

    setDiffuseColor(nodeId: string, r: number, g: number, b: number, a = 1): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setDiffuseColor(r, g, b, a); this.ctx.scheduleRender(); }
    }

    setOpacity(nodeId: string, opacity: number): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setOpacity(opacity); this.ctx.scheduleRender(); }
    }

    setPrimitive(nodeId: string, primitive: MeshPrimitive, config?: Partial<Mesh3DConfig>): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setPrimitive(primitive, config); this.ctx.scheduleRender(); }
    }

    setGeometry(nodeId: string, geometry: MeshGeometry): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setGeometry(geometry); this.ctx.scheduleRender(); }
    }

    // ── Textures ────────────────────────────────────────────────────

    async setMeshTexture(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;

        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return false;

        const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
        const texture = device.createTexture({
            size: [bitmap.width, bitmap.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture },
            [bitmap.width, bitmap.height],
        );

        if (mesh.diffuseTexture) mesh.diffuseTexture.destroy();
        mesh.diffuseTexture = texture;
        mesh.material.hasTexture = true;
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    clearMeshTexture(nodeId: string): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        if (mesh.diffuseTexture) {
            mesh.diffuseTexture.destroy();
            mesh.diffuseTexture = null;
        }
        mesh.material.hasTexture = false;
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    // ── PS1 Config & Lighting ────────────────────────────────────────

    setPS1Config(config: Partial<PS1Config>): void { this.renderer3D.setPS1(config); this.ctx.scheduleRender(); }
    getPS1Config(): PS1Config { return { ...this.renderer3D.ps1Config }; }

    setDirectionalLight(dx: number, dy: number, dz: number, r = 1, g = 1, b = 1, intensity = 1): void {
        this.renderer3D.setDirectionalLight(dx, dy, dz, r, g, b, intensity);
        this.ctx.scheduleRender();
    }

    setAmbientLight(r: number, g: number, b: number, intensity = 1): void {
        this.renderer3D.setAmbientLight(r, g, b, intensity);
        this.ctx.scheduleRender();
    }

    static get PS1Defaults(): PS1Config { return { ...DEFAULT_PS1_CONFIG }; }

    // ── Selection ────────────────────────────────────────────────────

    getSelected3DIds(): Set<string> {
        return this.renderer3D.getSelectedMeshIds();
    }

    setSelected3DIds(ids: Set<string>): void {
        const { meshIds, groupId } = this._expandGroupSelection(ids);
        this.renderer3D.setSelectedMeshIds(meshIds);
        if (groupId) {
            this.ctx.setSelectedNode(groupId);
        } else if (meshIds.size === 1) {
            this.ctx.setSelectedNode([...meshIds][0]);
        }
        this._syncBoneOverlay(meshIds);
        this.ctx.scheduleRender();
    }

    clearSelection(): void {
        this.renderer3D.setSelectedMeshIds(new Set());
        this._syncBoneOverlay(new Set());
        this.ctx.scheduleRender();
    }

    /**
     * Called when an outliner node is clicked. Syncs the 3D renderer and gizmo
     * without calling ctx.setSelectedNode (which would cause a cycle).
     * Handles both Mesh3D and MeshGroup3D node IDs.
     */
    syncSelectionFromOutliner(nodeId: string): void {
        const node = this.ctx.sceneGraph.findNodeById(nodeId);
        let meshIds = new Set<string>();
        if (node instanceof MeshGroup3D) {
            for (const child of node.children) {
                if (child instanceof Mesh3D) meshIds.add(child.id);
            }
        } else if (node instanceof Mesh3D) {
            const { meshIds: expanded } = this._expandGroupSelection(new Set([nodeId]));
            meshIds = expanded;
        }
        this.renderer3D.setSelectedMeshIds(meshIds);
        this._syncBoneOverlay(meshIds);
        this.ctx.scheduleRender();
    }

    private _syncBoneOverlay(selectedIds: Set<string>): void {
        if (selectedIds.size === 1) {
            const mesh = this.getMesh([...selectedIds][0]);
            if (mesh instanceof SkinnedMesh3D && mesh.skeleton) {
                this._boneOverlaySkeletonId = mesh.skeleton.id;
                this.renderer3D.setBoneOverlaySkeleton(mesh.skeleton);
                return;
            }
        }
        this._boneOverlaySkeletonId = null;
        this._selectedJointIndex = null;
        this._hoveredJointIndex = null;
        this.renderer3D.setBoneOverlaySkeleton(null);
        this.renderer3D.setSelectedJoint(null);
        this.renderer3D.setHoveredJoint(null);
    }

    // ── Hover highlight ──────────────────────────────────────────────

    /**
     * Highlight the given mesh with a thin light-blue outline on hover.
     * Pass null to clear. Safe to call from Outliner list item mouseenter/mouseleave.
     */
    setHoveredMesh(id: string | null): void {
        if (!id) {
            this.renderer3D.setHoveredMeshIds(new Set());
        } else {
            // If the hovered mesh is part of a group (from canvas) or IS a group (from
            // outliner mouseenter), expand the hover to all group children.
            const group = this.getMeshGroup(id);
            const mesh  = group ? null : this.getMesh(id);
            const parent = mesh?.parent instanceof MeshGroup3D ? mesh.parent : group;
            if (parent) {
                const ids = new Set<string>();
                for (const child of parent.children) {
                    if (child instanceof Mesh3D) ids.add(child.id);
                }
                this.renderer3D.setHoveredMeshIds(ids);
            } else {
                this.renderer3D.setHoveredMeshIds(new Set([id]));
            }
        }
        this.ctx.scheduleRender();
    }

    getHoveredMeshId(): string | null {
        const ids = this.renderer3D.getHoveredMeshIds();
        return ids.size > 0 ? [...ids][0] : null;
    }

    // ── Picking ──────────────────────────────────────────────────────

    /**
     * Pick the front-most visible Mesh3D under the given canvas pixel.
     * Returns the hit mesh ID and world-space hit point, or null on miss.
     *
     * All four values must be in the SAME pixel space — physical (device) pixels.
     * Scale CSS mouse coordinates by devicePixelRatio (or canvas.width/rect.width)
     * before calling, and pass canvas.width / canvas.height (not clientWidth/Height).
     */
    pick3D(
        mouseX: number,
        mouseY: number,
        canvasWidth: number,
        canvasHeight: number,
    ): { meshId: string; hitPoint: [number, number, number]; distance: number } | null {
        const camera = this.renderer3D.getCamera();
        const meshes = this.getAllMeshes();
        const result = this._picker.pickMesh(mouseX, mouseY, canvasWidth, canvasHeight, camera, meshes);
        if (!result) return null;
        return { meshId: result.mesh.id, hitPoint: result.hitPoint, distance: result.distance };
    }

    /**
     * Convenience pick that takes raw client (CSS) coordinates and the canvas
     * bounding rect — always produces correct results regardless of devicePixelRatio.
     *
     * Usage:
     *   const rect = canvas.getBoundingClientRect();
     *   const hit  = shapeManager.scene3d.pickFromClient3D(e.clientX, e.clientY, rect);
     */
    pickFromClient3D(
        clientX: number,
        clientY: number,
        canvasRect: { left: number; top: number; width: number; height: number },
    ): { meshId: string; hitPoint: [number, number, number]; distance: number } | null {
        // CSS coordinates: DPR cancels in NDC = 2*(cssX/cssW)-1, so pass CSS consistently.
        return this.pick3D(clientX - canvasRect.left, clientY - canvasRect.top, canvasRect.width, canvasRect.height);
    }

    // ── World ↔ Screen projection utilities ─────────────────────────

    /**
     * Project a 3D world position to 2D screen pixel coordinates.
     * Use this to position HTML overlays (e.g. drag handles, labels) over 3D objects.
     *
     * @param x,y,z      World-space position to project.
     * @param canvasW,H  Canvas pixel dimensions (canvas.width / canvas.height).
     * @returns Screen pixel coordinates and a depth value (0 = near plane, 1 = far plane).
     *          Returns null if the point is behind the camera.
     */
    projectWorldToScreen3D(
        x: number, y: number, z: number,
        canvasW: number, canvasH: number,
    ): { x: number; y: number; depth: number } | null {
        const vp = this.renderer3D.getCamera().getViewProjectionMatrix();
        // Clip space: vp * [x, y, z, 1]
        const cx = vp[0]*x + vp[4]*y + vp[8]*z  + vp[12];
        const cy = vp[1]*x + vp[5]*y + vp[9]*z  + vp[13];
        const cz = vp[2]*x + vp[6]*y + vp[10]*z + vp[14];
        const cw = vp[3]*x + vp[7]*y + vp[11]*z + vp[15];
        if (cw <= 0) return null; // behind camera
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        const ndcZ = cz / cw;
        return {
            x:     (ndcX + 1) * 0.5 * canvasW,
            y:     (1 - ndcY) * 0.5 * canvasH,
            depth: ndcZ * 0.5 + 0.5,
        };
    }

    /**
     * Unproject a 2D screen pixel + depth back to a 3D world position.
     * Use this to convert mouse drag deltas into world-space movement for handles.
     *
     * @param screenX,Y  Mouse position in canvas pixels.
     * @param depth      Depth from a prior projectWorldToScreen3D call (or 0 for near-plane).
     * @param canvasW,H  Canvas pixel dimensions.
     */
    unprojectScreenToWorld3D(
        screenX: number, screenY: number, depth: number,
        canvasW: number, canvasH: number,
    ): { x: number; y: number; z: number } {
        const ndcX =  screenX / canvasW * 2 - 1;
        const ndcY =  1 - screenY / canvasH * 2;
        const ndcZ =  depth * 2 - 1;

        const vp = this.renderer3D.getCamera().getViewProjectionMatrix();
        // Invert VP matrix
        const inv = mat4.invert(mat4.create(), vp as mat4);
        if (!inv) return { x: 0, y: 0, z: 0 };

        const wx = inv[0]*ndcX + inv[4]*ndcY + inv[8]*ndcZ  + inv[12];
        const wy = inv[1]*ndcX + inv[5]*ndcY + inv[9]*ndcZ  + inv[13];
        const wz = inv[2]*ndcX + inv[6]*ndcY + inv[10]*ndcZ + inv[14];
        const ww = inv[3]*ndcX + inv[7]*ndcY + inv[11]*ndcZ + inv[15];
        const rw = ww !== 0 ? 1 / ww : 1;
        return { x: wx * rw, y: wy * rw, z: wz * rw };
    }

    // ── Transform controls (gizmo + picking) ─────────────────────────

    /**
     * Provide a predicate that returns true while a mesh is in edit mode.
     * Must be called before enableTransformControls so the gizmo's click-to-select
     * path is suppressed during edit mode (preventing race with MeshEditPointerController).
     */
    setMeshEditModeChecker(fn: () => boolean): void {
        this._isMeshEditModeFn = fn;
    }

    /**
     * Provide a data supplier for the mesh edit overlay renderer.
     * Called once per frame while transform controls are active; return null when not editing.
     * Typically supplied by ShapeManager after both meshEdit and scene3d are initialized.
     */
    setMeshEditDataProvider(fn: () => MeshEditDrawData | null): void {
        this._meshEditDataFn = fn;
        // If transform controls are already active, wire the provider now.
        if (this._meshEditOverlay) {
            this.renderer3D.setMeshEditDataProvider(fn);
        }
    }

    /**
     * Enable the transform gizmo + click-to-select for 3D meshes.
     * Attaches pointer event listeners to the canvas.
     */
    enableTransformControls(): void {
        this.disableTransformControls();

        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) { console.warn('Scene3DManager: WebGPU device not available'); return; }

        const swapChainFormat = (this.ctx.webgpuRenderer as any).swapChainFormat ?? 'bgra8unorm';
        this._gizmoRenderer = new GizmoRenderer(device, swapChainFormat);
        this.renderer3D.setGizmoRenderer(this._gizmoRenderer);

        const callbacks = {
            getMeshes:       () => this.getAllMeshes(),
            getCamera:       () => this.renderer3D.getCamera(),
            getCanvasSize:   () => {
                const canvas = this.ctx.webgpuRenderer.getCanvas();
                return canvas ? { width: canvas.width, height: canvas.height } : { width: 1, height: 1 };
            },
            getSelectedIds:  () => this.renderer3D.getSelectedMeshIds(),
            setSelectedIds:  (ids: Set<string>) => {
                const { meshIds, groupId } = this._expandGroupSelection(ids);
                this.renderer3D.setSelectedMeshIds(meshIds);
                if (groupId) {
                    this.ctx.setSelectedNode(groupId);
                } else if (meshIds.size === 1) {
                    this.ctx.setSelectedNode([...meshIds][0]);
                }
                this.ctx.scheduleRender();
            },
            scheduleRender:  () => {
                // Mark instance data dirty so mesh positions are re-uploaded every drag frame.
                this.renderer3D.markInstancesDirty();
                this.ctx.scheduleRender();
            },
            getOrbitController: () => this._orbitController,
            onTransformComplete: (before: Map<string, any>, after: Map<string, any>) => {
                const meshes = this.getAllMeshes();
                this._undoManager.push({
                    description: 'Transform mesh',
                    undo: () => {
                        for (const mesh of meshes) {
                            const s = before.get(mesh.id);
                            if (!s) continue;
                            mesh.x = s.x; mesh.y = s.y; mesh.z = s.z;
                            mesh.rotationX = s.rx; mesh.rotationY = s.ry; mesh.rotation = s.rz;
                            mesh.scaleX = s.sx; mesh.scaleY = s.sy; mesh.scaleZ = s.sz;
                        }
                    },
                    redo: () => {
                        for (const mesh of meshes) {
                            const s = after.get(mesh.id);
                            if (!s) continue;
                            mesh.x = s.x; mesh.y = s.y; mesh.z = s.z;
                            mesh.rotationX = s.rx; mesh.rotationY = s.ry; mesh.rotation = s.rz;
                            mesh.scaleX = s.sx; mesh.scaleY = s.sy; mesh.scaleZ = s.sz;
                        }
                    },
                });
                // Mark all transformed meshes as save-dirty.
                for (const id of after.keys()) {
                    const m = this.getMesh(id);
                    if (m) m.stateDirty = true;
                }
                // Instance data (model matrices) changed — tell renderer to re-upload.
                this.renderer3D.markInstancesDirty();
                // Auto-key: snapshot every moved mesh's transform at the current frame.
                if (this.autoKey3D) {
                    for (const id of after.keys()) this.recordKeyframeForMesh(id);
                }
            },
            onGizmoDragStart: (axis: GizmoAxis) => {
                this.renderer3D.setDraggingAxis(axis);
            },
            onGizmoDragEnd: () => {
                this.renderer3D.setDraggingAxis(null);
            },
            onTransformDone: (meshIds: string[]) => {
                for (const id of meshIds) this._flaRestTransforms.delete(id);
            },
            isInMeshEditMode: () => this._isMeshEditModeFn?.() ?? false,
        };

        this._transformController = new TransformController3D(callbacks, this._gizmoRenderer);

        // Mesh edit overlay — wireframe + selection highlights
        this._meshEditOverlay = new MeshEditOverlayRenderer(device, swapChainFormat);
        this.renderer3D.setMeshEditOverlayRenderer(this._meshEditOverlay);
        if (this._meshEditDataFn) {
            this.renderer3D.setMeshEditDataProvider(this._meshEditDataFn);
        }

        // Sync hover axis from controller to renderer each frame
        const syncCallback = () => {
            if (this._transformController && this._gizmoRenderer) {
                this.renderer3D.setHoveredGizmoAxis(this._transformController.hoveredAxis);
                this.renderer3D.setGizmoMode(this._transformController.mode);
                this.renderer3D.setHoveredCorner(this._transformController.hoveredCorner);
            }
            return false;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(syncCallback);

        const canvas = this.ctx.webgpuRenderer.getCanvas();
        if (canvas) {
            this._transformController.attach(canvas as HTMLCanvasElement);

            // Canvas hover: pick mesh under cursor, highlight it, and update joint hover
            const onMouseMove = (e: MouseEvent) => {
                const el = canvas as HTMLCanvasElement;
                const rect = el.getBoundingClientRect();
                const scaleX = el.width  / rect.width;
                const scaleY = el.height / rect.height;
                const px = (e.clientX - rect.left) * scaleX;
                const py = (e.clientY - rect.top)  * scaleY;
                const hit = this.pick3D(px, py, el.width, el.height);
                this.setHoveredMesh(hit?.meshId ?? null);

                // Joint hover (only when bone overlay is active)
                if (this._gizmoRenderer && this._boneOverlaySkeletonId) {
                    const skel = this.getSkeleton(this._boneOverlaySkeletonId);
                    if (skel) {
                        const camera = this.renderer3D.getCamera();
                        const { origin, dir } = this._picker.castRay(px, py, el.width, el.height, camera);
                        const jIdx = this._gizmoRenderer.hitTestJoint(origin, dir, skel, camera);
                        if (jIdx !== this._hoveredJointIndex) {
                            this._hoveredJointIndex = jIdx;
                            this.renderer3D.setHoveredJoint(jIdx);
                            this.ctx.scheduleRender();
                        }
                    }
                }
            };

            // Joint click: select the hovered joint (A11)
            const onMouseDown = () => {
                if (this._boneOverlaySkeletonId && this._hoveredJointIndex !== null) {
                    this._selectedJointIndex = this._hoveredJointIndex;
                    this.renderer3D.setSelectedJoint(this._selectedJointIndex);
                    this.ctx.scheduleRender();
                }
            };

            const onMouseLeave = () => {
                this.setHoveredMesh(null);
                if (this._hoveredJointIndex !== null) {
                    this._hoveredJointIndex = null;
                    this.renderer3D.setHoveredJoint(null);
                    this.ctx.scheduleRender();
                }
            };

            (canvas as HTMLCanvasElement).addEventListener('mousemove', onMouseMove);
            (canvas as HTMLCanvasElement).addEventListener('mouseleave', onMouseLeave);
            (canvas as HTMLCanvasElement).addEventListener('mousedown', onMouseDown);
            this._canvasHoverCleanup = () => {
                (canvas as HTMLCanvasElement).removeEventListener('mousemove', onMouseMove);
                (canvas as HTMLCanvasElement).removeEventListener('mouseleave', onMouseLeave);
                (canvas as HTMLCanvasElement).removeEventListener('mousedown', onMouseDown);
            };
        }
    }

    private _canvasHoverCleanup?: () => void;

    disableTransformControls(): void {
        this._canvasHoverCleanup?.();
        this._canvasHoverCleanup = undefined;
        this._transformController?.detach();
        this._transformController = undefined;
        if (this._gizmoRenderer) {
            this.renderer3D.setGizmoRenderer(undefined as any);
            this._gizmoRenderer.destroy();
            this._gizmoRenderer = undefined;
        }
        if (this._meshEditOverlay) {
            this.renderer3D.setMeshEditOverlayRenderer(undefined);
            this.renderer3D.setMeshEditDataProvider(undefined);
            this._meshEditOverlay.destroy();
            this._meshEditOverlay = undefined;
        }
        // Clear bone overlay
        this._boneOverlaySkeletonId = null;
        this._selectedJointIndex = null;
        this._hoveredJointIndex = null;
    }

    setGizmoMode(mode: GizmoMode): void {
        if (this._transformController) this._transformController.mode = mode;
        this.renderer3D.setGizmoMode(mode);
        this.ctx.scheduleRender();
    }

    getGizmoMode(): GizmoMode {
        return this.renderer3D.getGizmoMode();
    }

    setGizmoOrientation(mode: 'world' | 'local'): void {
        if (this._transformController) this._transformController.orientationMode = mode;
        else if (this._gizmoRenderer)  this._gizmoRenderer.orientationMode = mode;
        this.ctx.scheduleRender();
    }

    getGizmoOrientation(): 'world' | 'local' {
        return this._transformController?.orientationMode ?? this._gizmoRenderer?.orientationMode ?? 'world';
    }

    // ── Snap settings ────────────────────────────────────────────────

    /** Grid size for Ctrl+drag position snapping (world units). Default 1.0. */
    get snapGridSize(): number { return this._transformController?.snapGridSize ?? 1.0; }
    set snapGridSize(v: number) { if (this._transformController) this._transformController.snapGridSize = v; }

    /** Angle increment for Ctrl+drag rotation snapping (radians). Default 15° (π/12). */
    get snapAngle(): number { return this._transformController?.snapAngle ?? Math.PI / 12; }
    set snapAngle(v: number) { if (this._transformController) this._transformController.snapAngle = v; }

    /** Scale factor increment for Ctrl+drag scale snapping. Default 0.25. */
    get snapScaleStep(): number { return this._transformController?.snapScaleStep ?? 0.25; }
    set snapScaleStep(v: number) { if (this._transformController) this._transformController.snapScaleStep = v; }

    /** True when Ctrl is held during a drag and snapping is active. */
    get snapActive(): boolean { return this._transformController?.snapActive ?? false; }

    /**
     * Returns live drag state for Frogmarks to render a degree readout overlay.
     * `angleDeg` is non-null only during a rotation drag.
     * `gizmoCenterWorld` can be projected to canvas coords for label placement.
     */
    getDragInfo(): {
        isDragging: boolean;
        mode: GizmoMode;
        axis: GizmoAxis;
        angleDeg: number | null;
        gizmoCenterWorld: [number, number, number] | null;
    } {
        const tc = this._transformController;
        if (!tc || !tc.isDragging) {
            return { isDragging: false, mode: this.renderer3D.getGizmoMode(), axis: null, angleDeg: null, gizmoCenterWorld: null };
        }
        return {
            isDragging: true,
            mode: this.renderer3D.getGizmoMode(),
            axis: this.renderer3D.getDraggingAxis(),
            angleDeg: tc.dragAngleDeg,
            gizmoCenterWorld: tc.dragGizmoCenter,
        };
    }

    // ── Keyframe animation ───────────────────────────────────────────

    /**
     * Attach to the raster timeline so that 3D mesh keyframes are applied
     * automatically whenever the current frame changes.
     *
     * Safe to call before the raster layer manager is ready — if the timeline
     * isn't available yet, a pre-render callback retries on every frame until
     * it connects, then removes itself. Calling this multiple times tears down
     * the previous subscription first (idempotent).
     */
    attachKeyframesToTimeline(): void {
        this._keyframeUnsub?.();
        this._keyframeUnsub = undefined;
        if (!this._tryAttachKeyframesToTimeline()) {
            // Timeline not ready yet — poll via pre-render callback until it is
            const retry = () => {
                if (this._tryAttachKeyframesToTimeline()) {
                    this.ctx.webgpuRenderer.removePreRenderCallback(retry);
                }
                return false; // never requests a render itself
            };
            this.ctx.webgpuRenderer.addPreRenderCallback(retry);
        }
    }

    /** @internal — attempts to subscribe; returns true if successful. */
    private _tryAttachKeyframesToTimeline(): boolean {
        const timeline = this.ctx.rasterLayerManager?.getTimeline();
        if (!timeline) return false;
        this._keyframeUnsub = timeline.on((e: any) => {
            if (e.type === 'frame-changed') {
                this.applyAllKeyframesAtFrame(e.frame ?? timeline.getCurrentFrame());
                this.ctx.scheduleRender();
            }
        });
        return true;
    }

    detachKeyframesFromTimeline(): void {
        this._keyframeUnsub?.();
        this._keyframeUnsub = undefined;
    }

    /**
     * Interpolate and apply all keyframe tracks for every mesh at the given frame.
     */
    applyAllKeyframesAtFrame(frame: number): void {
        for (const mesh of this.getAllMeshes()) {
            this.applyMeshKeyframesAtFrame(mesh.id, frame);
        }
        this.applyCameraKeyframesAtFrame(frame);
        // Mesh transforms changed — tell the renderer to re-upload instance matrices.
        // Without this, _instancesDirty stays false and uploadMeshInstances returns early,
        // leaving the GPU with stale model/normal matrices.
        this.renderer3D.markInstancesDirty();
    }

    applyCameraKeyframesAtFrame(frame: number): void {
        const t = this._cameraKeyframeTracks;
        const cam = this.renderer3D.getCamera();
        const pos = sampleTrack(t.position ?? [], frame, interpolateVec3);
        if (pos) cam.setPosition(pos[0], pos[1], pos[2]);
        const tgt = sampleTrack(t.target ?? [], frame, interpolateVec3);
        if (tgt) cam.setTarget(tgt[0], tgt[1], tgt[2]);
        const fov = sampleTrack(t.fov ?? [], frame, interpolateScalar);
        if (fov !== null) cam.fov = fov * Math.PI / 180;
    }

    applyMeshKeyframesAtFrame(meshId: string, frame: number): void {
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        const tracks = mesh.keyframeTracks;

        const pos = sampleTrack(tracks.position ?? [], frame, interpolateVec3);
        if (pos) { mesh.x = pos[0]; mesh.y = pos[1]; mesh.z = pos[2]; }

        const rot = sampleTrack(tracks.rotation ?? [], frame, interpolateVec3);
        if (rot) { mesh.rotationX = rot[0]; mesh.rotationY = rot[1]; mesh.rotation = rot[2]; }

        const scale = sampleTrack(tracks.scale ?? [], frame, interpolateVec3);
        if (scale) { mesh.scaleX = scale[0]; mesh.scaleY = scale[1]; mesh.scaleZ = scale[2]; }

        const color = sampleTrack(tracks.diffuseColor ?? [], frame, interpolateVec4);
        if (color) mesh.setDiffuseColor(color[0], color[1], color[2], color[3]);

        const opacity = sampleTrack(tracks.opacity ?? [], frame, interpolateScalar);
        if (opacity !== null) mesh.setOpacity(opacity);

        const vis = sampleTrack(tracks.visible ?? [], frame, (a, _b, _t) => a);
        if (vis !== null) mesh.visible = vis;

        // Apply frame-link animation delta on top of keyframed values
        // (scroll type is driven by _ensureScrollCb pre-render callback instead)
        const fla = this._frameLinkAnims3D.get(meshId);
        if (fla?.enabled && fla.type !== 'scroll') {
            const { pos: dp, rot: dr, scale: ds } = evalFrameLink3D(fla, frame);
            if (fla.type === 'spin') {
                // Spin accumulates intentionally — constant angular velocity via +=
                mesh.rotationX += dr[0]; mesh.rotationY += dr[1]; mesh.rotation += dr[2];
            } else {
                // Oscillating types: anchor to a rest pose so drift is structurally impossible.
                // Capture rest on the first frame this FLA runs (post-keyframe, pre-delta).
                // If a keyframe was applied this frame, use it as the base instead of rest.
                if (!this._flaRestTransforms.has(meshId)) {
                    this._flaRestTransforms.set(meshId, {
                        x: mesh.x, y: mesh.y, z: mesh.z,
                        rx: mesh.rotationX, ry: mesh.rotationY, rz: mesh.rotation,
                        sx: mesh.scaleX, sy: mesh.scaleY, sz: mesh.scaleZ,
                    });
                }
                const rest = this._flaRestTransforms.get(meshId)!;
                mesh.x  = (pos   ? pos[0]   : rest.x)  + dp[0];
                mesh.y  = (pos   ? pos[1]   : rest.y)  + dp[1];
                mesh.z  = (pos   ? pos[2]   : rest.z)  + dp[2];
                mesh.rotationX = (rot ? rot[0] : rest.rx) + dr[0];
                mesh.rotationY = (rot ? rot[1] : rest.ry) + dr[1];
                mesh.rotation  = (rot ? rot[2] : rest.rz) + dr[2];
                mesh.scaleX = (scale ? scale[0] : rest.sx) + ds[0];
                mesh.scaleY = (scale ? scale[1] : rest.sy) + ds[1];
                mesh.scaleZ = (scale ? scale[2] : rest.sz) + ds[2];
            }
        }
    }

    // ── Frame Link Animation 3D ──────────────────────────────────────

    /** Set (or replace) the procedural frame-link animation for a mesh or MeshGroup3D.
     *  When called on a group, the same config is written to every Mesh3D child (write-time
     *  propagation). Each child stores an independent entry so the evaluation and serialization
     *  paths are unchanged. */
    setFrameLinkAnimation3D(meshId: string, anim: Partial<FrameLinkAnimation3D>): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof MeshGroup3D) {
            let any = false;
            for (const child of node.children) {
                if (child instanceof Mesh3D) {
                    this.setFrameLinkAnimation3D(child.id, anim);
                    any = true;
                }
            }
            return any;
        }
        if (!this.getMesh(meshId)) return false;
        const existing = this._frameLinkAnims3D.get(meshId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION_3D };
        const merged = { ...existing, ...anim };
        this._frameLinkAnims3D.set(meshId, merged);
        this._flaRestTransforms.delete(meshId); // re-capture rest on next frame
        if (merged.enabled && merged.type === 'scroll') {
            this._scrollRealFrames.set(meshId, 0);
            this._ensureRibbonUpdateCb();
            this.ctx.scheduleRender();
        }
        return true;
    }

    private _ensureRibbonUpdateCb(): void {
        if (this._ribbonUpdateCb) return;
        this._ribbonUpdateCb = () => {
            let hasActive = false;
            const cam = this.renderer3D.getCamera();
            const camPos: [number, number, number] = [cam.position[0], cam.position[1], cam.position[2]];

            // Rebuild camera-facing ribbons every frame
            for (const [meshId, ribbon] of this._ribbonData) {
                if (ribbon.pathMode !== 'camera-facing') continue;
                const mesh = this.getMesh(meshId);
                if (!mesh) continue;
                hasActive = true;
                mesh.setGeometry(generateRibbon({
                    controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
                    width: ribbon.width,
                    segments: ribbon.segments,
                    uvScrollOffset: ribbon.uvScrollOffset,
                    uvScrollOffsetV: ribbon.uvScrollOffsetV,
                    uvEndPadding: ribbon.uvEndPadding,
                    uvTileCount: ribbon.uvTileCount,
                    pathMode: ribbon.pathMode,
                    doubleSided: ribbon.doubleSided,
                    flipRearU: ribbon.flipRearU,
                    cameraPosition: camPos,
                }));
            }

            // Scroll UV animation
            for (const [meshId, fla] of this._frameLinkAnims3D) {
                if (!fla.enabled || fla.type !== 'scroll') continue;
                const ribbon = this._ribbonData.get(meshId);
                if (!ribbon) continue;
                const mesh = this.getMesh(meshId);
                if (!mesh) continue;
                hasActive = true;
                const frame = (this._scrollRealFrames.get(meshId) ?? 0) + 1;
                this._scrollRealFrames.set(meshId, frame);
                const { uvOffset } = evalFrameLink3D(fla, frame);
                if (fla.axis === 'y') {
                    ribbon.uvScrollOffsetV = uvOffset[1];
                } else {
                    ribbon.uvScrollOffset = uvOffset[0];
                }
                mesh.setGeometry(generateRibbon({
                    controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
                    width: ribbon.width,
                    segments: ribbon.segments,
                    uvScrollOffset: ribbon.uvScrollOffset,
                    uvScrollOffsetV: ribbon.uvScrollOffsetV,
                    uvEndPadding: ribbon.uvEndPadding,
                    uvTileCount: ribbon.uvTileCount,
                    pathMode: ribbon.pathMode,
                    doubleSided: ribbon.doubleSided,
                    flipRearU: ribbon.flipRearU,
                    cameraPosition: camPos,
                }));
            }

            if (!hasActive) {
                this.ctx.webgpuRenderer.removePreRenderCallback(this._ribbonUpdateCb!);
                this._ribbonUpdateCb = null;
            }
            return hasActive;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._ribbonUpdateCb);
    }

    /** Get the frame-link animation config for a mesh or group.
     *  For groups, returns the first child's config as a representative value. */
    getFrameLinkAnimation3D(meshId: string): FrameLinkAnimation3D | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof MeshGroup3D) {
            for (const child of node.children) {
                if (child instanceof Mesh3D) {
                    const fla = this._frameLinkAnims3D.get(child.id);
                    if (fla) return fla;
                }
            }
            return null;
        }
        return this._frameLinkAnims3D.get(meshId) ?? null;
    }

    /** Remove the frame-link animation from a mesh or all children of a MeshGroup3D. */
    removeFrameLinkAnimation3D(meshId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof MeshGroup3D) {
            let any = false;
            for (const child of node.children) {
                if (child instanceof Mesh3D) {
                    this._scrollRealFrames.delete(child.id);
                    this._flaRestTransforms.delete(child.id);
                    any = this._frameLinkAnims3D.delete(child.id) || any;
                }
            }
            return any;
        }
        this._scrollRealFrames.delete(meshId);
        this._flaRestTransforms.delete(meshId);
        return this._frameLinkAnims3D.delete(meshId);
    }

    setMeshKeyframe(
        meshId: string,
        property: TrackName,
        frame: number,
        value: any,
        easing: KeyframeEasing = 'linear',
    ): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;
        if (!mesh.keyframeTracks[property]) (mesh.keyframeTracks as any)[property] = [];
        const track: any[] = (mesh.keyframeTracks as any)[property];

        // Capture before-state for undo
        const existing = track.find((kf: any) => kf.frame === frame);
        const beforeValue = existing ? JSON.parse(JSON.stringify(existing.value)) : undefined;
        const beforeEasing: KeyframeEasing | undefined = existing?.easing;

        setKeyframe(track, frame, value, easing);
        mesh.stateDirty = true;

        this._undoManager.push({
            description: `Set keyframe: ${property} @ ${frame}`,
            undo: () => {
                const t: any[] = (mesh.keyframeTracks as any)[property];
                if (t) {
                    if (beforeValue === undefined) {
                        removeKeyframe(t, frame);
                    } else {
                        setKeyframe(t, frame, JSON.parse(JSON.stringify(beforeValue)), beforeEasing!);
                    }
                    mesh.stateDirty = true;
                }
            },
            redo: () => {
                if (!(mesh.keyframeTracks as any)[property]) (mesh.keyframeTracks as any)[property] = [];
                setKeyframe((mesh.keyframeTracks as any)[property], frame, JSON.parse(JSON.stringify(value)), easing);
                mesh.stateDirty = true;
            },
        });
        return true;
    }

    removeMeshKeyframe(meshId: string, property: TrackName, frame: number): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;
        const track = (mesh.keyframeTracks as any)[property];
        if (!track) return false;

        // Capture before removal for undo
        const existing = (track as any[]).find((kf: any) => kf.frame === frame);
        if (!existing) return false;
        const savedValue = JSON.parse(JSON.stringify(existing.value));
        const savedEasing: KeyframeEasing = existing.easing;

        const removed = removeKeyframe(track, frame);
        if (removed) {
            mesh.stateDirty = true;
            this._undoManager.push({
                description: `Remove keyframe: ${property} @ ${frame}`,
                undo: () => {
                    if (!(mesh.keyframeTracks as any)[property]) (mesh.keyframeTracks as any)[property] = [];
                    setKeyframe((mesh.keyframeTracks as any)[property], frame, JSON.parse(JSON.stringify(savedValue)), savedEasing);
                    mesh.stateDirty = true;
                },
                redo: () => {
                    const t: any[] = (mesh.keyframeTracks as any)[property];
                    if (t) { removeKeyframe(t, frame); mesh.stateDirty = true; }
                },
            });
        }
        return removed;
    }

    getMeshKeyframeTracks(meshId: string): Mesh3DKeyframeTracks | null {
        return this.getMesh(meshId)?.keyframeTracks ?? null;
    }

    clearMeshKeyframeTracks(meshId: string): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;

        // Deep-copy tracks before clearing for undo
        const savedTracks = JSON.parse(JSON.stringify(mesh.keyframeTracks));
        mesh.keyframeTracks = {};
        mesh.stateDirty = true;

        this._undoManager.push({
            description: 'Clear keyframe tracks',
            undo: () => {
                mesh.keyframeTracks = JSON.parse(JSON.stringify(savedTracks));
                mesh.stateDirty = true;
            },
            redo: () => {
                mesh.keyframeTracks = {};
                mesh.stateDirty = true;
            },
        });
        return true;
    }

    // ── Keyframe query helpers (for timeline UI) ─────────────────────

    /**
     * Returns the set of frame numbers where ANY track on this mesh has a keyframe.
     * Use this to draw per-frame markers in the animation timeline UI.
     */
    getMeshKeyframeFrames(meshId: string): number[] {
        const mesh = this.getMesh(meshId);
        if (!mesh) return [];
        const frames = new Set<number>();
        for (const track of Object.values(mesh.keyframeTracks)) {
            if (Array.isArray(track)) {
                for (const kf of track) frames.add(kf.frame);
            }
        }
        return Array.from(frames).sort((a, b) => a - b);
    }

    /** Returns true if the mesh has a keyframe on any track at exactly `frame`. */
    hasMeshKeyframeAtFrame(meshId: string, frame: number): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;
        for (const track of Object.values(mesh.keyframeTracks)) {
            if (Array.isArray(track) && track.some(kf => kf.frame === frame)) return true;
        }
        return false;
    }

    /**
     * Returns a flat list of every Mesh3D in the scene with id and name.
     * Use this to populate the animation panel's mesh rows — it includes
     * meshes nested inside groups.
     */
    getAllMeshesForAnimation(): { id: string; name: string }[] {
        return this.getAllMeshes().map(m => ({ id: m.id, name: m.name }));
    }

    /**
     * Returns keyframe track data for every mesh in the scene.
     * Use this to build per-mesh dope-sheet rows in the animation panel.
     * Each entry's `tracks` object has the same shape as getMeshKeyframeTracks().
     */
    getAllMeshKeyframeTracks(): { meshId: string; name: string; tracks: Mesh3DKeyframeTracks }[] {
        return this.getAllMeshes().map(m => ({
            meshId: m.id,
            name: m.name,
            tracks: m.keyframeTracks,
        }));
    }

    // ── Camera keyframe API ──────────────────────────────────────────

    /** Set a keyframe on a camera track ('position' | 'target' | 'fov'). */
    setCameraKeyframe(property: CameraTrackName, frame: number, value: any, easing: KeyframeEasing = 'linear'): void {
        if (!this._cameraKeyframeTracks[property]) {
            (this._cameraKeyframeTracks as any)[property] = [];
        }
        setKeyframe((this._cameraKeyframeTracks as any)[property], frame, value, easing);
    }

    /** Remove a keyframe from a camera track. */
    removeCameraKeyframe(property: CameraTrackName, frame: number): boolean {
        const track = (this._cameraKeyframeTracks as any)[property];
        if (!track) return false;
        return removeKeyframe(track, frame);
    }

    /** Get all camera keyframe tracks. */
    getCameraKeyframeTracks(): Camera3DKeyframeTracks {
        return this._cameraKeyframeTracks;
    }

    /** Clear all camera keyframe tracks. */
    clearCameraKeyframeTracks(): void {
        this._cameraKeyframeTracks = {};
    }

    /**
     * Snapshot the current camera position, target, and FOV as keyframes at `frame`.
     * If frame is omitted, reads the current raster timeline frame (defaults to 0).
     */
    recordCameraKeyframe(frame?: number): void {
        const f = frame ?? this.ctx.rasterLayerManager?.getTimeline()?.getCurrentFrame() ?? 0;
        const cam = this.renderer3D.getCamera();
        this.setCameraKeyframe('position', f, [cam.position[0], cam.position[1], cam.position[2]]);
        this.setCameraKeyframe('target',   f, [cam.target[0],   cam.target[1],   cam.target[2]]);
        this.setCameraKeyframe('fov',      f, cam.fov * 180 / Math.PI);
    }

    /** When true, every completed gizmo drag auto-records keyframes at the current timeline frame. */
    autoKey3D = false;

    /**
     * Snapshot a mesh's current position/rotation/scale as keyframes at `frame`.
     * If frame is omitted, reads the current raster timeline frame (defaults to 0).
     */
    recordKeyframeForMesh(meshId: string, frame?: number): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;
        const f = frame ?? this.ctx.rasterLayerManager?.getTimeline()?.getCurrentFrame() ?? 0;
        this.setMeshKeyframe(meshId, 'position', f, [mesh.x, mesh.y, mesh.z]);
        this.setMeshKeyframe(meshId, 'rotation', f, [mesh.rotationX, mesh.rotationY, mesh.rotation]);
        this.setMeshKeyframe(meshId, 'scale',    f, [mesh.scaleX, mesh.scaleY, mesh.scaleZ]);
        return true;
    }

    /**
     * Record keyframes for every currently selected 3D mesh at the given (or current) frame.
     * Returns the count of meshes keyed.
     */
    recordKeyframesForSelectedMeshes(frame?: number): number {
        let count = 0;
        for (const id of this.renderer3D.getSelectedMeshIds()) {
            if (this.recordKeyframeForMesh(id, frame)) count++;
        }
        return count;
    }

    // ── Texture library ──────────────────────────────────────────────

    getTextureLibrary(): TextureLibrary {
        if (!this._textureLibrary) {
            const device = this.ctx.webgpuRenderer.getDevice();
            if (!device) throw new Error('Scene3DManager: WebGPU device not available');
            this._textureLibrary = new TextureLibrary(device);
        }
        return this._textureLibrary;
    }

    /**
     * Upload a texture to the library and apply it to the given mesh.
     * Returns the library texture ID.
     */
    async uploadAndApplyTexture(
        meshId: string,
        source: File | Blob | ImageBitmap,
        name?: string,
    ): Promise<string | null> {
        const mesh = this.getMesh(meshId);
        if (!mesh) return null;

        const lib = this.getTextureLibrary();
        const id  = await lib.upload(source, name);
        const tex = lib.getTexture(id);
        if (!tex) return null;

        if (mesh.diffuseTexture) mesh.diffuseTexture.destroy();
        mesh.diffuseTexture = tex;
        mesh.material.hasTexture = true;
        mesh.textureLibraryId = id;
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
        return id;
    }

    /**
     * Apply an already-uploaded library texture to a mesh by ID.
     */
    applyLibraryTexture(meshId: string, textureId: string): boolean {
        const mesh = this.getMesh(meshId);
        const tex  = this.getTextureLibrary().getTexture(textureId);
        if (!mesh || !tex) return false;
        mesh.diffuseTexture = tex;
        mesh.material.hasTexture = true;
        mesh.textureLibraryId = textureId;
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    // ── Animation player ─────────────────────────────────────────────

    /**
     * Create (or replace) an AnimationPlayer3D that drives keyframe playback.
     * The player automatically calls applyAllKeyframesAtFrame on every frame tick.
     */
    createAnimationPlayer(config?: AnimationPlayer3DConfig): AnimationPlayer3D {
        this.destroyAnimationPlayer();
        this._animPlayer = new AnimationPlayer3D(config);
        this._animPlayer.onFrame((frame) => {
            this.applyAllKeyframesAtFrame(frame);
            this.ctx.scheduleRender();
        });
        return this._animPlayer;
    }

    getAnimationPlayer(): AnimationPlayer3D | undefined {
        return this._animPlayer;
    }

    destroyAnimationPlayer(): void {
        this._animPlayer?.destroy();
        this._animPlayer = undefined;
    }

    // ── Skeleton animation ────────────────────────────────────────────

    /**
     * Create an AnimationPlayer3D that drives a SkeletonAnimClip on a Skeleton3D node.
     * The player's onFrame handler interpolates joint poses each tick and recomputes
     * skin matrices.  The returned player starts paused — call player.play() to begin.
     * Destroy the player when done to stop the RAF loop.
     */
    playSkeletonClip(skeletonId: string, clip: SkeletonAnimClip): AnimationPlayer3D {
        const skeleton = this.getSkeleton(skeletonId);
        if (!skeleton) throw new Error(`Skeleton not found: ${skeletonId}`);

        const player = new AnimationPlayer3D({
            startFrame: clip.startFrame,
            endFrame:   clip.endFrame,
            fps:        clip.fps,
            loop:       true,
        });

        player.onFrame(frame => {
            applySkeletonClipAtFrame(clip, skeleton, frame);
            this.ctx.scheduleRender();
        });

        return player;
    }

    // ── Texture library data (for save/load) ─────────────────────────

    /**
     * Returns a full texture library snapshot including base64 data URLs.
     * Include this in document save payloads so textures survive reload.
     */
    getTextureLibraryData(): { entries: any[] } | null {
        return this._textureLibrary?.toJSONWithData() ?? null;
    }

    /**
     * Restore the texture library from a saved snapshot, then re-apply
     * GPU textures to any meshes whose textureLibraryId matches an entry.
     */
    async restoreTextureLibraryData(data: { entries: any[] }): Promise<void> {
        const lib = this.getTextureLibrary();
        await lib.restoreFromJSON(data);
        for (const mesh of this.getAllMeshes()) {
            if (mesh.textureLibraryId) {
                const tex = lib.getTexture(mesh.textureLibraryId);
                if (tex) {
                    mesh.diffuseTexture = tex;
                    mesh.material.hasTexture = true;
                    mesh.gpuDirty = true;
                }
            }
            if (mesh.normalMapLibraryId) {
                const tex = lib.getTexture(mesh.normalMapLibraryId);
                if (tex) {
                    mesh.normalMapTexture = tex;
                    mesh.gpuDirty = true;
                }
            }
        }
        this.ctx.scheduleRender();
    }

    // ── Group outliner helpers ───────────────────────────────────────

    setGroupCollapsed(groupId: string, collapsed: boolean): boolean {
        const group = this.getMeshGroup(groupId);
        if (!group) return false;
        group.collapsed = collapsed;
        this.ctx.emitSceneGraphChanged();
        return true;
    }

    isGroupCollapsed(groupId: string): boolean {
        return this.getMeshGroup(groupId)?.collapsed ?? false;
    }

    // ── Outliner helpers ─────────────────────────────────────────────

    setMeshVisible(nodeId: string, visible: boolean): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        mesh.visible = visible;
        this.ctx.scheduleRender();
        return true;
    }

    isMeshVisible(nodeId: string): boolean {
        return this.getMesh(nodeId)?.visible ?? true;
    }

    setGroupVisible(groupId: string, visible: boolean): boolean {
        const group = this.getMeshGroup(groupId);
        if (!group) return false;
        group.visible = visible;
        this.ctx.scheduleRender();
        return true;
    }

    isGroupVisible(groupId: string): boolean {
        return this.getMeshGroup(groupId)?.visible ?? true;
    }

    setMeshName(nodeId: string, name: string): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        mesh.name = name;
        this.ctx.emitSceneGraphChanged();
        return true;
    }

    getMeshName(nodeId: string): string | null {
        return this.getMesh(nodeId)?.name ?? null;
    }

    setGroupName(groupId: string, name: string): boolean {
        const group = this.getMeshGroup(groupId);
        if (!group) return false;
        group.name = name;
        this.ctx.emitSceneGraphChanged();
        return true;
    }

    getGroupName(groupId: string): string | null {
        return this.getMeshGroup(groupId)?.name ?? null;
    }

    /**
     * Returns a snapshot hierarchy of 3D nodes for outliner display.
     * Top-level entries are direct children of root that are Mesh3D or MeshGroup3D.
     * Groups include their Mesh3D children.
     *
     * This allocates a new array on every call. Cache the result and invalidate on
     * scene-graph-changed events rather than calling this every frame.
     */
    getScene3DHierarchy(): Scene3DHierarchyNode[] {
        const result: Scene3DHierarchyNode[] = [];
        for (const child of this.ctx.sceneGraph.root.children) {
            if (child instanceof Mesh3D) {
                result.push({
                    id: child.id, name: child.name,
                    type: '3DMesh', visible: child.visible, locked: child.locked,
                });
            } else if (child instanceof MeshGroup3D) {
                const groupChildren: Scene3DHierarchyNode[] = [];
                for (const gc of child.children) {
                    if (gc instanceof Mesh3D) {
                        groupChildren.push({
                            id: gc.id, name: gc.name,
                            type: '3DMesh', visible: gc.visible, locked: gc.locked,
                        });
                    }
                }
                result.push({
                    id: child.id, name: child.name,
                    type: '3DMeshGroup', visible: child.visible, locked: child.locked,
                    collapsed: child.collapsed, children: groupChildren,
                });
            }
        }
        return result;
    }

    // ── Normal maps ──────────────────────────────────────────────────

    /** Upload a normal map texture and apply it to the given mesh. */
    async setMeshNormalMap(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return false;

        const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
        const texture = device.createTexture({
            size: [bitmap.width, bitmap.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);

        if (mesh.normalMapTexture) mesh.normalMapTexture.destroy();
        mesh.normalMapTexture = texture;
        mesh.material.hasNormalMap = true;

        // Normal maps require the textured pipeline path (4-binding bind group).
        // Auto-create a white 1×1 diffuse if the mesh has no diffuse texture yet.
        if (!mesh.material.hasTexture) {
            const whiteTex = device.createTexture({
                size: [1, 1, 1], format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            device.queue.writeTexture({ texture: whiteTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
            if (mesh.diffuseTexture) mesh.diffuseTexture.destroy();
            mesh.diffuseTexture = whiteTex;
            mesh.material.hasTexture = true;
            console.warn(`[Scene3DManager] setMeshNormalMap: mesh "${nodeId}" had no diffuse texture — auto-created 1×1 white diffuse. Assign a real diffuse texture to replace it.`);
        }

        mesh.gpuDirty = true;
        mesh.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    clearMeshNormalMap(nodeId: string): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        if (mesh.normalMapTexture) {
            mesh.normalMapTexture.destroy();
            mesh.normalMapTexture = null;
        }
        mesh.normalMapLibraryId = null;
        mesh.material.hasNormalMap = false;
        mesh.gpuDirty = true;
        mesh.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    // ── Ribbon meshes ────────────────────────────────────────────────

    /**
     * Create a ribbon mesh that follows a Catmull-Rom spline path.
     *
     * The ribbon is double-sided, so textures applied to it are visible from
     * both the front and back.  UVs are arc-length parameterized along the path
     * (U = 0→1, V = 0 on one edge, 1 on the other) — ideal for HTML banners.
     *
     * @param x,y,z   World-space origin for the mesh node (control points are relative).
     * @param controlPoints  ≥2 points that define the spline path.
     * @param width   Ribbon width in world units.
     * @param segments  Curve subdivisions per segment (default 16).  Higher = smoother.
     * @param material  Optional material overrides.
     */
    addRibbon3D(
        x: number,
        y: number,
        z: number,
        controlPoints: RibbonControlPoint[],
        width: number,
        segments = 16,
        material?: Partial<Material3D>,
    ): Mesh3D {
        const geom = generateRibbon({
            controlPoints: controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width,
            segments,
        });
        const mesh = this.createMesh(x, y, z, { primitive: 'custom', geometry: geom, material });

        this._ribbonData.set(mesh.id, {
            meshId: mesh.id,
            controlPoints: [...controlPoints],
            width,
            segments,
            uvScrollOffset: 0,
            uvScrollOffsetV: 0,
            uvEndPadding: 0,
            uvTileCount: 1,
            pathMode: 'normal',
            doubleSided: 'double',
            flipRearU: false,
        });

        return mesh;
    }

    /**
     * Update the spline path of an existing ribbon mesh.
     * Rebuilds geometry immediately.
     */
    updateRibbonPath3D(meshId: string, controlPoints: RibbonControlPoint[]): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.controlPoints = [...controlPoints];
        const cam0 = this.renderer3D.getCamera();
        const geom = generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam0.position[0], cam0.position[1], cam0.position[2]],
        });
        mesh.setGeometry(geom);
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Update the width of a ribbon mesh.  Rebuilds geometry immediately.
     */
    updateRibbonWidth3D(meshId: string, width: number): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.width = width;
        const cam1 = this.renderer3D.getCamera();
        const geom = generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam1.position[0], cam1.position[1], cam1.position[2]],
        });
        mesh.setGeometry(geom);
        this.ctx.scheduleRender();
        return true;
    }

    /** Returns the stored ribbon data for a mesh, or null if it is not a ribbon. */
    getRibbonData3D(meshId: string): RibbonData | null {
        return this._ribbonData.get(meshId) ?? null;
    }

    /** Remove ribbon tracking data (does NOT delete the mesh). */
    removeRibbonData3D(meshId: string): boolean {
        return this._ribbonData.delete(meshId);
    }

    /**
     * Update a single control point on an existing ribbon by index and rebuild geometry.
     * Useful for drag handles — call this on every pointer-move event instead of
     * rebuilding the full control points array each time.
     *
     * @returns false if the mesh is not a ribbon or the index is out of range.
     */
    setRibbonControlPoint3D(meshId: string, index: number, x: number, y: number, z: number): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;
        if (index < 0 || index >= ribbon.controlPoints.length) return false;

        ribbon.controlPoints[index] = { x, y, z };
        const cam2 = this.renderer3D.getCamera();
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam2.position[0], cam2.position[1], cam2.position[2]],
        }));
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Set the UV end-padding for a ribbon — extra UV units added to the end of the
     * U range so a looping scroll has a small overlap instead of a hard seam.
     * Typical values: 0 (off) to 0.1 (10% overlap). Rebuilds geometry immediately.
     */
    setRibbonEndPadding3D(meshId: string, uvEndPadding: number): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.uvEndPadding = Math.max(0, uvEndPadding);
        const cam3 = this.renderer3D.getCamera();
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam3.position[0], cam3.position[1], cam3.position[2]],
        }));
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Set the path-orientation mode for a ribbon mesh and rebuild its geometry.
     *
     * - `'normal'`        — Rotation-Minimizing Frame. Ribbon lies in the path plane.
     * - `'world-up'`      — Width direction is always world-Y; ribbon stands upright.
     * - `'camera-facing'` — Face always rotates toward the camera (rebuilt every frame).
     */
    setRibbonPathMode3D(meshId: string, mode: RibbonPathMode): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.pathMode = mode;

        const cam = this.renderer3D.getCamera();
        const camPos: [number, number, number] = [cam.position[0], cam.position[1], cam.position[2]];
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: mode,
            cameraPosition: camPos,
        }));

        if (mode === 'camera-facing') {
            this._ensureRibbonUpdateCb();
        }

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Set which faces of a ribbon are visible and rebuild geometry immediately.
     * - `'double'` (default) — both front and back faces visible.
     * - `'front'`  — front face only; prevents mirrored text from showing inside loops/spirals.
     * - `'back'`   — back face only; useful for inside-of-loop views.
     * Legacy boolean accepted: `true` → `'double'`, `false` → `'front'`.
     */
    setRibbonDoubleSided3D(meshId: string, doubleSided: 'double' | 'front' | 'back' | boolean): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.doubleSided =
            doubleSided === true  ? 'double' :
            doubleSided === false ? 'front'  :
            doubleSided;
        const cam = this.renderer3D.getCamera();
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam.position[0], cam.position[1], cam.position[2]],
            doubleSided,
        }));
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Update the curve subdivision count of a ribbon and rebuild geometry immediately.
     * Higher values produce smoother curves but more triangles.
     * Typical values: 8 (draft) · 16 (standard) · 32 (smooth) · 64 (high quality).
     */
    updateRibbonSegments3D(meshId: string, segments: number): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.segments = Math.max(1, segments | 0);
        const cam = this.renderer3D.getCamera();
        const geom = generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam.position[0], cam.position[1], cam.position[2]],
        });
        mesh.setGeometry(geom);
        this.ctx.scheduleRender();
        return true;
    }

    // ── Ribbon handle transform helpers ─────────────────────────────────────────

    /** Convert a control point in mesh-local space to world space. */
    private _cpToWorld(mesh: Mesh3D, cp: { x: number; y: number; z: number }): [number, number, number] {
        const w = vec4.transformMat4(vec4.create(), [cp.x, cp.y, cp.z, 1] as any, mesh.localMatrix as any);
        return [w[0] / w[3], w[1] / w[3], w[2] / w[3]];
    }

    /** Convert a world-space position back to mesh-local space. */
    private _worldToCpLocal(mesh: Mesh3D, wx: number, wy: number, wz: number): [number, number, number] {
        const inv = mat4.invert(mat4.create(), mesh.localMatrix as any);
        if (!inv) return [wx, wy, wz];
        const l = vec4.transformMat4(vec4.create(), [wx, wy, wz, 1] as any, inv);
        return [l[0] / l[3], l[1] / l[3], l[2] / l[3]];
    }

    // ── Canvas-overlay ribbon control-point handle API ──────────────────────────

    /**
     * Project each ribbon control point into overlay pixel space for canvas overlay drawing.
     *
     * Pass the dimensions of whatever element you draw the overlay circles on
     * (e.g.  or ).
     * The returned { x, y } are in that same coordinate space, ready to draw with.
     *
     * Make sure the same dimensions are passed to beginRibbonHandleDrag3D and moveRibbonHandle3D.
     *
     * @returns One entry per control point —  in overlay pixels, or null if behind camera.
     */
    getRibbonHandleScreenPositions3D(
        ribbonId: string,
        overlayWidth: number,
        overlayHeight: number,
    ): Array<{ x: number; y: number; index: number } | null> {
        const ribbon = this._ribbonData.get(ribbonId);
        if (!ribbon) return [];
        const mesh = this.getMesh(ribbonId);
        return ribbon.controlPoints.map((cp, index) => {
            const [wx, wy, wz] = mesh ? this._cpToWorld(mesh, cp) : [cp.x, cp.y, cp.z];
            const proj = this.projectWorldToScreen3D(wx, wy, wz, overlayWidth, overlayHeight);
            if (!proj) return null;
            return { x: proj.x, y: proj.y, index };
        });
    }

    /**
     * Begin dragging a ribbon control point by its index.
     * Captures the depth of the control point at the current camera position.
     * Call once on pointerdown.
     *
     * @param overlayWidth   Width of your overlay element in pixels.
     * @param overlayHeight  Height of your overlay element in pixels.
     * @returns false if the ribbon or index is invalid.
     */
    beginRibbonHandleDrag3D(
        ribbonId: string,
        handleIndex: number,
        overlayWidth: number,
        overlayHeight: number,
    ): boolean {
        const ribbon = this._ribbonData.get(ribbonId);
        if (!ribbon || handleIndex < 0 || handleIndex >= ribbon.controlPoints.length) return false;
        const mesh = this.getMesh(ribbonId);
        const cp = ribbon.controlPoints[handleIndex];
        const [wx, wy, wz] = mesh ? this._cpToWorld(mesh, cp) : [cp.x, cp.y, cp.z];
        const proj = this.projectWorldToScreen3D(wx, wy, wz, overlayWidth, overlayHeight);
        if (!proj) return false;
        this._ribbonHandleDragDepth.set(`${ribbonId}:${handleIndex}`, proj.depth);
        return true;
    }

    /**
     * Move a ribbon control point to the current pointer position.
     * Call on every pointermove while dragging.
     *
     * @param offsetX       Pointer X in overlay pixels (e.g. event.offsetX, or clientX − rect.left).
     * @param offsetY       Pointer Y in overlay pixels.
     * @param overlayWidth  Width of the overlay element.
     * @param overlayHeight Height of the overlay element.
     * @returns false if the drag was not started.
     */
    moveRibbonHandle3D(
        ribbonId: string,
        handleIndex: number,
        offsetX: number, offsetY: number,
        overlayWidth: number, overlayHeight: number,
    ): boolean {
        const depth = this._ribbonHandleDragDepth.get(`${ribbonId}:${handleIndex}`);
        if (depth === undefined) return false;
        const world = this.unprojectScreenToWorld3D(offsetX, offsetY, depth, overlayWidth, overlayHeight);
        const mesh = this.getMesh(ribbonId);
        const [lx, ly, lz] = mesh
            ? this._worldToCpLocal(mesh, world.x, world.y, world.z)
            : [world.x, world.y, world.z];
        return this.setRibbonControlPoint3D(ribbonId, handleIndex, lx, ly, lz);
    }

    /** End a handle drag. Call on pointerup. */
    endRibbonHandleDrag3D(ribbonId: string, handleIndex: number): void {
        this._ribbonHandleDragDepth.delete(`${ribbonId}:${handleIndex}`);
    }

    /**
     * Toggle the "flip rear U" flag on a ribbon and rebuild geometry immediately.
     * When true, the back face gets horizontally mirrored U coordinates so text
     * reads left-to-right from both sides of the ribbon.
     * When false (default), the back face mirrors the front — text appears backwards
     * on the inside face.
     */
    setRibbonFlipRearU3D(meshId: string, flip: boolean): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.flipRearU = flip;
        const cam = this.renderer3D.getCamera();
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam.position[0], cam.position[1], cam.position[2]],
            doubleSided: ribbon.doubleSided,
            flipRearU: flip,
        }));
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Set how many times the HTML/diffuse texture tiles along the ribbon length.
     * Default: 1 (texture shown once end-to-end). Set to N to repeat N times —
     * the U coordinate runs 0→N and the sampler wraps. Use this to keep complex
     * script (Urdu, Arabic, etc.) crisp on long ribbons: put one copy of the text
     * in the HTML and let the GPU repeat it instead of stretching a long texture.
     */
    setRibbonUvTileCount3D(meshId: string, tileCount: number): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;
        ribbon.uvTileCount = Math.max(1, tileCount);
        const cam = this.renderer3D.getCamera();
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam.position[0], cam.position[1], cam.position[2]],
            doubleSided: ribbon.doubleSided,
            flipRearU: ribbon.flipRearU,
        }));
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Show or hide control-point handles for a ribbon.
     * The canvas overlay reads `getRibbonData3D(id)?.showHandles` to decide
     * whether to draw circles. Default when undefined: handles are visible.
     */
    setRibbonShowHandles3D(meshId: string, show: boolean): boolean {
        const ribbon = this._ribbonData.get(meshId);
        if (!ribbon) return false;
        ribbon.showHandles = show;
        return true;
    }

    /**
     * Compute GPU texture dimensions that match a ribbon's aspect ratio.
     *
     * Height is set to `targetHeight` (rounded to the nearest power of two).
     * Width is derived from the ribbon's arc-length-to-width ratio so the
     * texture fills the ribbon face without stretching.
     * Both dimensions are clamped and rounded to the nearest power of two.
     *
     * @param meshId       Ribbon mesh node ID.
     * @param targetHeight Desired texture height in pixels (default 128).
     *                     Use 64 for compact ribbons, 256 for large/high-quality ones.
     * @param maxWidth     Upper limit on texture width in pixels (default 2048).
     * @returns `{ width, height }` or `null` if the mesh is not a ribbon or has invalid data.
     */
    computeRibbonTextureSize3D(
        meshId: string,
        targetHeight = 128,
        maxWidth = 2048,
    ): { width: number; height: number; fontSize: number } | null {
        const ribbon = this._ribbonData.get(meshId);
        if (!ribbon) return null;
        if (!(ribbon.width > 0)) return null; // catches NaN, 0, negative

        const pts = ribbon.controlPoints;
        let arcLen = 0;
        for (let i = 1; i < pts.length; i++) {
            const dx = pts[i].x - pts[i - 1].x;
            const dy = pts[i].y - pts[i - 1].y;
            const dz = pts[i].z - pts[i - 1].z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (isFinite(d)) arcLen += d;
        }
        const height = nearestPow2(Math.max(32, targetHeight));
        const aspectRatio = arcLen / ribbon.width;
        const width = nearestPow2(Math.max(64, Math.min(maxWidth, Math.round(aspectRatio * height))));
        if (width < 1 || height < 1) return null;
        // fontSize = texture height: the texture height IS the ribbon height in render-pixels,
        // so a font-size equal to height fills the ribbon vertically before any CSS scaling.
        return { width, height, fontSize: height };
    }

    // ── HTML-in-Canvas textures ──────────────────────────────────────

    /**
     * Render an HTML string to a GPU texture and apply it to a mesh.
     *
     * Uses the native browser "HTML-in-Canvas" technique (SVG foreignObject +
     * drawImage + copyExternalImageToTexture) — no external libraries.
     *
     * Call this once to set the initial content, then call `updateHtmlTexture3D`
     * to change the HTML without recreating the texture object.
     *
     * @param meshId   Target mesh node ID.
     * @param html     HTML body content to render (will be wrapped in a full HTML document).
     * @param width    Texture width in pixels (default 512).
     * @param height   Texture height in pixels (default 128).
     * @param options  Background color, container style overrides.
     */
    async setHtmlTexture3D(
        meshId: string,
        html: string,
        width = 512,
        height = 128,
        options?: HtmlTexture3DOptions,
    ): Promise<boolean> {
        const mesh = this.getMesh(meshId);
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!mesh || !device) return false;
        if (!(width >= 1) || !(height >= 1)) {
            console.error(`setHtmlTexture3D: invalid dimensions ${width}×${height} for mesh "${meshId}" — did computeRibbonTextureSize3D return null?`);
            return false;
        }

        // Reuse existing HtmlTexture3D if dimensions match, otherwise recreate
        let ht = this._htmlTextures.get(meshId);
        if (ht && (ht.width !== width || ht.height !== height)) {
            ht.destroy();
            ht = undefined;
            this._htmlTextures.delete(meshId);
        }
        if (!ht) {
            HtmlTexture3D.setMainCanvas(this.ctx.webgpuRenderer.getCanvas());
            ht = new HtmlTexture3D(device, width, height);
            this._htmlTextures.set(meshId, ht);
        }

        // Snapshot the old HtmlTexture3D-owned texture BEFORE update() destroys it
        // internally.  We need this to avoid a double-destroy: _uploadBitmap() already
        // calls .destroy() on the previous _texture; if mesh.diffuseTexture points to
        // that same object we must NOT call .destroy() on it a second time.
        const prevHtTex = ht.texture;

        const tex = await ht.update(html, options);
        if (!tex) return false;

        // Only destroy the mesh's existing diffuse texture if it is NOT the one that
        // HtmlTexture3D just destroyed internally.
        if (mesh.diffuseTexture && mesh.diffuseTexture !== prevHtTex) {
            mesh.diffuseTexture.destroy();
        }
        mesh.diffuseTexture = tex;
        mesh.material.hasTexture = true;
        // Do NOT set gpuDirty — geometry did not change, only the texture.
        // The renderer rebuilds the texture bind group every frame anyway.

        // Cache content + options on the ribbon for auto-restore after document reload
        const ribbon = this._ribbonData.get(meshId);
        if (ribbon) {
            ribbon.htmlTextureId = meshId;
            ribbon.htmlContent = html;
            ribbon.htmlTextureWidth = width;
            ribbon.htmlTextureHeight = height;
            if (options?.backgroundColor !== undefined) ribbon.htmlTextureBgColor = options.backgroundColor;
            if (options?.stretchToFit !== undefined) ribbon.htmlTextureStretchToFit = options.stretchToFit;
        }

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Update the HTML content of an existing HTML texture without changing its size.
     * Faster than `setHtmlTexture3D` because it skips the texture recreation step.
     * Returns false if no HTML texture exists for this mesh — call setHtmlTexture3D first.
     */
    async updateHtmlTexture3D(meshId: string, html: string, options?: HtmlTexture3DOptions): Promise<boolean> {
        const mesh = this.getMesh(meshId);
        const ht   = this._htmlTextures.get(meshId);
        if (!mesh || !ht) return false;

        const tex = await ht.update(html, options);
        if (!tex) return false;

        mesh.diffuseTexture = tex;
        mesh.material.hasTexture = true;
        mesh.gpuDirty = true;

        // Keep cached state in sync so options survive live updates
        const ribbon = this._ribbonData.get(meshId);
        if (ribbon) {
            ribbon.htmlContent = html;
            if (options?.backgroundColor !== undefined) ribbon.htmlTextureBgColor = options.backgroundColor;
            if (options?.stretchToFit !== undefined) ribbon.htmlTextureStretchToFit = options.stretchToFit;
        }

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Remove the HTML texture from a mesh and destroy the GPU texture.
     * The mesh reverts to its material diffuse color.
     */
    removeHtmlTexture3D(meshId: string): boolean {
        const mesh = this.getMesh(meshId);
        const ht   = this._htmlTextures.get(meshId);
        if (!mesh || !ht) return false;

        ht.destroy();
        this._htmlTextures.delete(meshId);

        if (mesh.diffuseTexture) { mesh.diffuseTexture.destroy(); mesh.diffuseTexture = null; }
        mesh.material.hasTexture = false;
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    /** Returns true if the mesh has an active HTML texture. */
    hasHtmlTexture3D(meshId: string): boolean {
        return this._htmlTextures.has(meshId);
    }

    // ── Cloth / Banner ───────────────────────────────────────────────

    /**
     * Build and add a ClothMesh3D to the scene from a grid config.
     *
     * Phase 1: creates a flat (unsimulated) cloth at world position (x, y, z).
     * Phase 2: pass simulated positions via `simulatedPositions` to bake the
     *          post-physics pose into the node at creation time.
     *
     * @param x/y/z              World-space origin of the cloth.
     * @param gridConfig         Grid dimensions, active cells, pins, corner radius.
     * @param physicsConfig      Physics/solidification parameters (thickness etc.).
     * @param simulatedPositions Optional post-simulation vertex positions (Float32Array,
     *                           3 floats per vertex). If omitted the flat grid is used.
     * @param name               Display name for the node (default: "Cloth").
     */
    createClothMesh(
        x: number,
        y: number,
        z: number,
        gridConfig: Partial<ClothGridConfig> = {},
        physicsConfig: Partial<ClothPhysicsConfig> = {},
        simulatedPositions?: Float32Array,
        name?: string,
    ): ClothMesh3D {
        const cols = gridConfig.cols ?? 8;
        const rows = gridConfig.rows ?? 10;
        const fullGrid: ClothGridConfig = {
            cols,
            rows,
            cellSize:       gridConfig.cellSize       ?? 0.1,
            cornerRadius:   gridConfig.cornerRadius   ?? 0,
            activeCells:    gridConfig.activeCells    ?? buildDefaultActiveCells(cols, rows),
            pinnedVertices: gridConfig.pinnedVertices ?? [],
        };
        const fullPhysics: ClothPhysicsConfig = { ...DEFAULT_CLOTH_PHYSICS, ...physicsConfig };

        // Build geometry
        const result = buildClothGeometry(fullGrid);

        let geometry = _resolveClothGeometry(result, simulatedPositions, fullPhysics);

        const simState: ClothSimState = {
            positions:      simulatedPositions ? Array.from(simulatedPositions) : Array.from(result.flatPositions),
            isSimulated:    !!simulatedPositions,
            simulationMode: 'none',
        };

        const mesh = new ClothMesh3D(
            this.ctx.interactionService,
            x, y, z,
            geometry,
            fullGrid,
            fullPhysics,
            simState,
        );

        if (name) mesh.name = name;

        this._clothData.set(mesh.id, result);

        const parent = this.ctx.sceneGraph.root;
        parent.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();

        return mesh;
    }

    /**
     * Replace the geometry, config, and simulated pose of an existing ClothMesh3D
     * node in-place — preserves node ID, layer order, name, and material.
     *
     * Use this for the Cloth Builder modal's re-edit flow: load the existing config
     * via getClothConfig(), let the user edit, then call this when they hit Create.
     *
     * @param meshId   ID of the ClothMesh3D to update.
     * @param gridConfig   New (or unchanged) grid configuration.
     * @param physicsConfig New (or unchanged) physics configuration.
     * @param simulatedPositions Simulated vertex positions; pass undefined for flat.
     * @param mode     Simulation mode to record ('hang' | 'drape' | 'none').
     * @returns false if the node was not found or is not a ClothMesh3D.
     */
    replaceClothMesh(
        meshId: string,
        gridConfig: ClothGridConfig,
        physicsConfig: ClothPhysicsConfig,
        simulatedPositions?: Float32Array,
        mode: 'hang' | 'drape' | 'none' = 'none',
    ): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const result = buildClothGeometry(gridConfig);
        node.setGeometry(_resolveClothGeometry(result, simulatedPositions, physicsConfig));

        // Update readonly fields via casting — intentional internal mutation
        const m = node as any;
        m.clothConfig  = gridConfig;
        m.physicsConfig = physicsConfig;
        m.simState = {
            positions:      simulatedPositions ? Array.from(simulatedPositions) : Array.from(result.flatPositions),
            isSimulated:    !!simulatedPositions,
            simulationMode: mode,
        };

        this._clothData.set(meshId, result);
        node.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Retrieve the cloth grid and physics config for a ClothMesh3D node.
     * Returns null if the node is not a cloth mesh or does not exist.
     */
    getClothConfig(meshId: string): { grid: ClothGridConfig; physics: ClothPhysicsConfig } | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        return { grid: node.clothConfig, physics: node.physicsConfig };
    }

    /**
     * Returns the cached ClothGeometryResult for a cloth mesh (constraint graph,
     * inverse masses, slot maps). Needed by the simulator and re-edit modal.
     * May be null if the mesh was restored from serialization without a re-build;
     * call buildClothGeometry(getClothConfig(id).grid) to regenerate.
     */
    getClothGeometryResult(meshId: string): ClothGeometryResult | null {
        return this._clothData.get(meshId) ?? null;
    }

    /**
     * Convert a vertex grid position (col, row) to a stable **slot index**
     * (`col + row * (cols+1)`) for use in `ClothGridConfig.pinnedVertices`.
     *
     * Slot indices never change when activeCells changes, so they survive
     * cell-toggle operations. Returns -1 if the slot is inactive (corner-radius
     * cutout or custom activeCells hole). Returns null if the mesh is not found.
     *
     * For stitch constraints (StitchConstraint.a/b), use getClothVertexDenseIndex
     * instead — stitches use dense indices and are cleared on topology changes.
     */
    getClothVertexSlot(meshId: string, col: number, row: number): number | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        const result = this._clothData.get(meshId);
        if (!result) return null;
        const slotCols = node.clothConfig.cols + 1;
        const slot = col + row * slotCols;
        if (slot < 0 || slot >= result.vertexFromSlot.length) return null;
        // Return -1 for inactive slots so callers can skip unpinnable vertices.
        return result.vertexFromSlot[slot] >= 0 ? slot : -1;
    }

    /**
     * Convert a vertex grid position (col, row) to the **dense vertex index**
     * used by `StitchConstraint.a/b` and `bendStiffnessMap`.
     *
     * Dense indices are reassigned when activeCells changes, so do NOT store
     * them in pinnedVertices — use getClothVertexSlot for that instead.
     *
     * Returns -1 if the slot is inactive, null if the mesh is not found.
     */
    getClothVertexDenseIndex(meshId: string, col: number, row: number): number | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        const result = this._clothData.get(meshId);
        if (!result) return null;
        const slotCols = node.clothConfig.cols + 1;
        const slot = col + row * slotCols;
        if (slot < 0 || slot >= result.vertexFromSlot.length) return null;
        const vi = result.vertexFromSlot[slot];
        return vi >= 0 ? vi : -1;
    }

    /** @deprecated Use getClothVertexSlot for pins, getClothVertexDenseIndex for stitches. */
    getClothVertexIndex(meshId: string, col: number, row: number): number | null {
        return this.getClothVertexDenseIndex(meshId, col, row);
    }

    // ── Live config updates ───────────────────────────────────────────────────

    /**
     * Rebuild the cloth mesh from a new (or partially changed) grid/physics config.
     * Use this for real-time UI updates: every slider or grid-param change should
     * call this so the mesh and live simulation stay in sync instantly.
     *
     * Grid changes (cols, rows, cellSize, activeCells, cornerRadius) trigger a full
     * geometry rebuild + live sim reset from flat.
     *
     * Pass only the fields that changed; missing fields keep their current values.
     */
    setClothConfig(
        meshId: string,
        gridConfig?: Partial<ClothGridConfig>,
        physicsConfig?: Partial<ClothPhysicsConfig>,
    ): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const newGrid  = { ...node.clothConfig,  ...gridConfig  };
        const newPhys  = { ...node.physicsConfig, ...physicsConfig };

        const result = buildClothGeometry(newGrid);
        node.setGeometry(_resolveClothGeometry(result, undefined, newPhys));

        const m = node as any;
        m.clothConfig   = newGrid;
        m.physicsConfig = newPhys;
        m.simState = {
            positions:      Array.from(result.flatPositions),
            isSimulated:    false,
            simulationMode: node.simState.simulationMode,
        };

        this._clothData.set(meshId, result);
        node.gpuDirty = true;

        // Reset or start the live sim
        const handle = this._liveClothHandles.get(meshId);
        if (handle) {
            const mode = node.simState.simulationMode !== 'none'
                ? node.simState.simulationMode as 'hang' | 'drape'
                : 'hang';
            handle.reset(newGrid, newPhys, mode);
            handle.setBendStiffness(result.bendStiffness);
            const zones = node.liveConfig.windZones ?? [];
            if (zones.length) handle.setWindZones(zones);
        } else {
            this.enableLiveCloth(meshId);
        }

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Hot-update physics parameters without rebuilding geometry.
     * Safe to call on every slider tick for gravity, damping, stiffness, wind.
     * Does NOT reset vertex positions — cloth continues from current pose.
     */
    setClothPhysics(meshId: string, params: Partial<ClothPhysicsConfig>): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const newPhys = { ...node.physicsConfig, ...params };
        (node as any).physicsConfig = newPhys;

        this._liveClothHandles.get(meshId)?.setPhysics(params);
        return true;
    }

    /**
     * Hot-swap which vertices are pinned without resetting the cloth to flat.
     * The cloth continues simulating from its current pose — pinned vertices
     * lock in-place immediately and unpinned ones start falling.
     *
     * Use this instead of setClothConfig({ pinnedVertices }) so the user sees
     * pin changes without the cloth snapping back to the rest pose.
     *
     * If no live sim is running this only updates clothConfig so the new pins
     * take effect on the next enableLiveCloth() call. It does NOT auto-start
     * the sim — call enableLiveCloth() explicitly when you want simulation to
     * begin. This prevents a double-create race when the caller also calls
     * enableLiveCloth() immediately after (e.g. on a Hang button click).
     */
    setClothPinnedVertices(meshId: string, pinnedVertices: number[]): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const newGrid = { ...node.clothConfig, pinnedVertices };
        (node as any).clothConfig = newGrid;

        // Rebuild geometry to get the updated inverseMass array.
        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);

        const handle = this._liveClothHandles.get(meshId);
        if (handle) {
            // Hot-update only the inverseMass GPU buffer — no position reset.
            handle.setInverseMass(result.inverseMass);
            this.ctx.scheduleRender();
        }
        // No else branch: if there's no live sim, clothConfig is already updated.
        // The caller should call enableLiveCloth() when simulation should start.
        return true;
    }

    /**
     * Debounced variant of setClothConfig — accumulates changes from rapid UI
     * interactions (slider drags, spinner increments) and applies them after
     * `delayMs` of silence. Each call resets the timer, so only the final value
     * triggers a rebuild. Defaults to 150 ms.
     *
     * Use setClothConfig directly for one-shot changes (e.g. cell toggle).
     */
    setClothConfigDebounced(
        meshId: string,
        gridConfig?: Partial<ClothGridConfig>,
        physicsConfig?: Partial<ClothPhysicsConfig>,
        delayMs = 150,
    ): void {
        const pending = this._clothConfigTimers.get(meshId);
        if (pending) {
            clearTimeout(pending.timer);
            const mergedGrid    = { ...pending.grid,    ...gridConfig    };
            const mergedPhysics = { ...pending.physics, ...physicsConfig };
            const timer = setTimeout(() => {
                this._clothConfigTimers.delete(meshId);
                this.setClothConfig(meshId, mergedGrid, mergedPhysics);
            }, delayMs);
            this._clothConfigTimers.set(meshId, { timer, grid: mergedGrid, physics: mergedPhysics });
        } else {
            const g = gridConfig    ?? {};
            const p = physicsConfig ?? {};
            const timer = setTimeout(() => {
                this._clothConfigTimers.delete(meshId);
                this.setClothConfig(meshId, g, p);
            }, delayMs);
            this._clothConfigTimers.set(meshId, { timer, grid: g, physics: p });
        }
    }

    // ── Stitch tool ───────────────────────────────────────────────────────────

    /**
     * Begin an interactive stitch. Picks vertexA and enables live hover preview.
     * Call previewClothStitch(meshId, vertexB) on each pointer-move to show a
     * live preview of where the cloth will settle when stitched to that vertex.
     * Call commitClothStitch to save, or cancelClothStitchTool to discard.
     *
     * @param restLength  0 = full stitch (vertices touch); >0 = pleat/gather gap.
     * @returns false if the mesh or vertex index is invalid.
     */
    beginClothStitchTool(meshId: string, vertexA: number, restLength = 0): boolean {
        const vc = this._clothData.get(meshId)?.vertexCount ?? 0;
        if (vertexA < 0 || vertexA >= vc) return false;
        // Snapshot the current simulated pose so every preview hover starts from
        // the same baseline instead of building on top of previous preview states.
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        const savedPositions = (node instanceof ClothMesh3D && node.simState.isSimulated)
            ? new Float32Array(node.simState.positions)
            : null;
        this._stitchTool.set(meshId, { vertexA, restLength, previewB: null, savedPositions });
        return true;
    }

    /**
     * Update the hover-preview stitch target while the user moves the pointer
     * over candidate vertices. Resets the live simulation with a temporary stitch
     * so the cloth visually settles toward the preview each time vertexB changes.
     * No-op if `vertexB` hasn't changed since the last call.
     */
    previewClothStitch(meshId: string, vertexB: number): boolean {
        const state = this._stitchTool.get(meshId);
        if (!state) return false;
        if (vertexB === state.previewB) return true;
        state.previewB = vertexB;

        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const previewStitch = { a: state.vertexA, b: vertexB, restLength: state.restLength };
        const previewGrid   = {
            ...node.clothConfig,
            stitches: [...(node.clothConfig.stitches ?? []), previewStitch],
        };

        let handle = this._liveClothHandles.get(meshId);
        if (!handle) {
            this.enableLiveCloth(meshId);
            handle = this._liveClothHandles.get(meshId);
            if (!handle) return false;
        }

        const mode = node.simState.simulationMode !== 'none'
            ? node.simState.simulationMode as 'hang' | 'drape'
            : 'hang';
        // Each preview starts from the saved baseline (captured at beginClothStitchTool)
        // so every hover shows "cloth from rest pose + THIS stitch", not a compounding
        // chain of successive previews.
        const initPos = state.savedPositions ?? undefined;
        handle.reset(previewGrid, node.physicsConfig, mode, undefined, initPos);
        // Re-apply stiffness + wind so preview is consistent with current settings.
        const previewResult = buildClothGeometry(previewGrid);
        handle.setBendStiffness(previewResult.bendStiffness);
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);

        return true;
    }

    /**
     * Commit the previewed stitch as a permanent constraint.
     * Equivalent to calling addClothStitch(meshId, vertexA, previewB, restLength).
     * Returns the new stitch index, or null if no preview is active.
     * Clears the stitch tool state.
     */
    commitClothStitch(meshId: string): number | null {
        const state = this._stitchTool.get(meshId);
        if (!state || state.previewB === null) return null;
        this._stitchTool.delete(meshId);
        return this.addClothStitch(meshId, state.vertexA, state.previewB, state.restLength);
    }

    /**
     * Cancel the active stitch tool without committing. Restores the live
     * simulation to the node's committed stitch list (without the preview).
     */
    cancelClothStitchTool(meshId: string): void {
        const state = this._stitchTool.get(meshId);
        if (!state) return;
        this._stitchTool.delete(meshId);

        const node   = this.ctx.sceneGraph.findNodeById(meshId);
        const handle = this._liveClothHandles.get(meshId);
        if (!handle || !(node instanceof ClothMesh3D)) return;

        const mode = node.simState.simulationMode !== 'none'
            ? node.simState.simulationMode as 'hang' | 'drape'
            : 'hang';
        // Restore to the pose from before the stitch tool was opened.
        handle.reset(node.clothConfig, node.physicsConfig, mode, undefined, state.savedPositions ?? undefined);
        const result = this._clothData.get(meshId);
        if (result) handle.setBendStiffness(result.bendStiffness);
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);
    }

    // ── Stitch constraints ────────────────────────────────────────────────────

    /**
     * Add a vertex-to-vertex stitch constraint.
     * restLength = 0 pulls the two vertices flush together (full stitch).
     * restLength > 0 holds them at a fixed distance (gather / pleat).
     *
     * The constraint graph is rebuilt immediately; if a live sim is running for
     * this mesh it is restarted from the current positions so the stitch takes
     * effect right away.
     *
     * Returns the index of the new stitch in clothConfig.stitches, or null on error.
     */
    addClothStitch(meshId: string, a: number, b: number, restLength: number): number | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        const vc = this._clothData.get(meshId)?.vertexCount ?? 0;
        if (a < 0 || b < 0 || a >= vc || b >= vc) return null;

        const stitches = [...(node.clothConfig.stitches ?? []), { a, b, restLength: Math.max(0, restLength) }];
        const newGrid  = { ...node.clothConfig, stitches };
        (node as any).clothConfig = newGrid;

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);
        this._refreshLiveSimAfterConstraintChange(meshId, node, result);
        node.stateDirty = true;
        this.ctx.scheduleRender();
        return stitches.length - 1;
    }

    /**
     * Remove a stitch by its index in clothConfig.stitches.
     * Rebuilds the constraint graph and refreshes any live simulation.
     */
    removeClothStitch(meshId: string, index: number): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        const existing = node.clothConfig.stitches ?? [];
        if (index < 0 || index >= existing.length) return false;

        const stitches = existing.filter((_, i) => i !== index);
        const newGrid  = { ...node.clothConfig, stitches };
        (node as any).clothConfig = newGrid;

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);
        // Immediately show the stitch-free flat geometry so the mesh updates even
        // if the live sim hasn't fired its first callback yet.
        node.setGeometry(_resolveClothGeometry(result, undefined, node.physicsConfig));
        node.gpuDirty = true;
        this._refreshLiveSimAfterConstraintChange(meshId, node, result);
        node.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    /** Remove all stitch constraints from a cloth mesh. */
    clearClothStitches(meshId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        if (!node.clothConfig.stitches?.length) return true;

        const newGrid = { ...node.clothConfig, stitches: [] };
        (node as any).clothConfig = newGrid;

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);
        // Clear simState so the sim restarts from flat (not the stitched pose).
        (node as any).simState = {
            positions:      Array.from(result.flatPositions),
            isSimulated:    false,
            simulationMode: node.simState.simulationMode,
        };
        node.setGeometry(_resolveClothGeometry(result, undefined, node.physicsConfig));
        node.gpuDirty = true;
        this._refreshLiveSimAfterConstraintChange(meshId, node, result);
        node.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    /** Return all stitch constraints for a cloth mesh. */
    getClothStitches(meshId: string): StitchConstraint[] {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return [];
        return [...(node.clothConfig.stitches ?? [])];
    }

    // ── Bend-stiffness painting ───────────────────────────────────────────────

    /**
     * Set the per-vertex bend-stiffness map (values clamped to [0, 1]).
     * 0.0 = silk-floppy (no bend resistance), 1.0 = stiff cardboard-like.
     * The map is persisted in clothConfig.bendStiffnessMap and uploaded to
     * any running live simulation's GPU buffer immediately.
     *
     * Pass a Float32Array of length vertexCount (from getClothGeometryResult).
     */
    setClothBendStiffness(meshId: string, map: Float32Array | number[]): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const arr = map instanceof Float32Array ? map : new Float32Array(map);
        const newGrid = { ...node.clothConfig, bendStiffnessMap: Array.from(arr) };
        (node as any).clothConfig = newGrid;

        // Rebuild geometry result so bendStiffness Float32Array is in sync
        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);

        // Hot-update the live sim's GPU buffer if running
        const handle = this._liveClothHandles.get(meshId);
        if (handle) handle.setBendStiffness(result.bendStiffness);

        node.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    /** Returns the current bend-stiffness map (per-vertex Float32Array). */
    getClothBendStiffnessMap(meshId: string): Float32Array | null {
        const result = this._clothData.get(meshId);
        if (!result) return null;
        return result.bendStiffness.slice();
    }

    // ── Wind zones ────────────────────────────────────────────────────────────

    /**
     * Add a spatial wind zone to a cloth mesh's live config.
     * Wind zones only affect live simulations (enableLiveCloth / cloth builder preview).
     * Returns the new zone's ID, or null if the mesh is not found.
     */
    addWindZone(meshId: string, zone: Omit<WindZone, 'id'>): string | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;

        const id       = _nanoid();
        const newZone: WindZone = { ...zone, id };
        const zones    = [...(node.liveConfig.windZones ?? []), newZone];
        (node as any).liveConfig = { ...node.liveConfig, windZones: zones };

        this._liveClothHandles.get(meshId)?.setWindZones(zones);
        node.stateDirty = true;
        return id;
    }

    /**
     * Remove a wind zone by its ID.
     * Returns false if the mesh or zone was not found.
     */
    removeWindZone(meshId: string, zoneId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        const zones = (node.liveConfig.windZones ?? []).filter(z => z.id !== zoneId);
        if (zones.length === (node.liveConfig.windZones?.length ?? 0)) return false;
        (node as any).liveConfig = { ...node.liveConfig, windZones: zones };
        this._liveClothHandles.get(meshId)?.setWindZones(zones);
        node.stateDirty = true;
        return true;
    }

    /**
     * Patch fields of an existing wind zone.
     * Returns false if the mesh or zone was not found.
     */
    updateWindZone(meshId: string, zoneId: string, patch: Partial<Omit<WindZone, 'id'>>): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        const zones = (node.liveConfig.windZones ?? []).map(z =>
            z.id === zoneId ? { ...z, ...patch, id: z.id } : z,
        );
        if (!zones.find(z => z.id === zoneId)) return false;
        (node as any).liveConfig = { ...node.liveConfig, windZones: zones };
        this._liveClothHandles.get(meshId)?.setWindZones(zones);
        node.stateDirty = true;
        return true;
    }

    /** Return all wind zones for a cloth mesh. */
    getWindZones(meshId: string): WindZone[] {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return [];
        return [...(node.liveConfig.windZones ?? [])];
    }

    /** Remove all wind zones from a cloth mesh. */
    clearWindZones(meshId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        (node as any).liveConfig = { ...node.liveConfig, windZones: [] };
        this._liveClothHandles.get(meshId)?.setWindZones([]);
        node.stateDirty = true;
        return true;
    }

    /**
     * Rebuild the live simulation after a constraint change (add/remove stitch).
     * Auto-starts the live sim if not already running so stitches are immediately
     * visible. Resets from flat so the cloth settles into its new constrained pose.
     */
    private _refreshLiveSimAfterConstraintChange(
        meshId: string,
        node: ClothMesh3D,
        newResult: ClothGeometryResult,
    ): void {
        let handle = this._liveClothHandles.get(meshId);
        if (!handle) {
            // Auto-start: stitches need simulation to be visible.
            this.enableLiveCloth(meshId);
            return; // enableLiveCloth registers the onPositionsUpdate callback; done.
        }
        const mode = node.simState.simulationMode !== 'none'
            ? node.simState.simulationMode as 'hang' | 'drape'
            : 'hang';
        // Continue from the current simulated pose so the cloth doesn't snap to
        // flat when a stitch is added or removed mid-simulation.
        const initPositions = node.simState.isSimulated
            ? new Float32Array(node.simState.positions)
            : undefined;
        handle.reset(node.clothConfig, node.physicsConfig, mode, undefined, initPositions);
        handle.setBendStiffness(newResult.bendStiffness);
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);
    }

    /**
     * Run cloth physics simulation to steady-state and return the final vertex
     * positions. Does NOT create or modify any scene-graph node.
     *
     * Frogmarks calls this when the user clicks [Hang ▶] or [Drape ▶] in the
     * Cloth Builder modal, then feeds the result to createClothMesh() on [Create].
     *
     * @param gridConfig    Cloth grid configuration (columns, rows, active cells …).
     * @param physicsConfig Physics parameters (gravity, damping, stiffness, wind …).
     * @param mode          'hang' — pin top row if no explicit pins; 'drape' — no pins,
     *                      cloth falls onto the proxy shape.
     * @param proxy         Collision proxy shape for drape mode. Ignored for 'hang'.
     * @param maxSteps      Hard cap on simulation steps (default 3000).
     * @returns             Float32Array of [x, y, z] per vertex at steady state.
     */
    async simulateCloth(
        gridConfig:    Partial<ClothGridConfig>,
        physicsConfig: Partial<ClothPhysicsConfig>,
        mode: 'hang' | 'drape',
        proxy: DrapeProxy = { type: 'none' },
        maxSteps = 3000,
    ): Promise<Float32Array> {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) throw new Error('simulateCloth: WebGPU device not available');

        // Resolve full configs
        const cols = gridConfig.cols ?? 8;
        const rows = gridConfig.rows ?? 10;
        const fullGrid: ClothGridConfig = {
            cols,
            rows,
            cellSize:       gridConfig.cellSize       ?? 0.1,
            cornerRadius:   gridConfig.cornerRadius   ?? 0,
            activeCells:    gridConfig.activeCells    ?? buildDefaultActiveCells(cols, rows),
            pinnedVertices: gridConfig.pinnedVertices ?? [],
        };
        const fullPhysics: ClothPhysicsConfig = { ...DEFAULT_CLOTH_PHYSICS, ...physicsConfig };

        // Build geometry + constraint graph (CPU)
        const result = buildClothGeometry(fullGrid);

        // Compute initial positions for the simulator
        // For drape: lift cloth above the proxy so it can fall onto it
        let initPositions: Float32Array | undefined;
        if (mode === 'drape') {
            const liftY = _drapeStartY(proxy, result.flatPositions, fullGrid, fullPhysics.gravity);
            if (liftY !== 0) {
                initPositions = new Float32Array(result.flatPositions);
                for (let vi = 0; vi < result.vertexCount; vi++) {
                    initPositions[vi * 3 + 1] += liftY;
                }
            }
        }

        const sim = new ClothSimulator(device);
        try {
            sim.init(result, fullPhysics, initPositions);

            if (mode === 'drape') {
                sim.setCollision(proxy);
            }

            return await sim.runToConvergence(maxSteps);
        } finally {
            sim.destroy();
        }
    }

    /**
     * Apply a new set of simulated vertex positions to an existing ClothMesh3D
     * and mark it GPU-dirty. Used for live preview updates in the builder modal.
     *
     * @param meshId             ID of a ClothMesh3D node in the scene.
     * @param simulatedPositions [x, y, z] per vertex (from simulateCloth or readPositions).
     * @param mode               Simulation mode to record in the node's simState.
     */
    updateClothMeshPose(
        meshId: string,
        simulatedPositions: Float32Array,
        mode: 'hang' | 'drape' | 'none' = 'none',
    ): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const cached = this._clothData.get(meshId);
        if (!cached || simulatedPositions.length !== cached.vertexCount * 3) return false;

        node.setGeometry(_resolveClothGeometry(cached, simulatedPositions, node.physicsConfig));

        // Update simState in-place
        (node.simState as ClothSimState).positions      = Array.from(simulatedPositions);
        (node.simState as ClothSimState).isSimulated    = true;
        (node.simState as ClothSimState).simulationMode = mode;

        this._renderClothPreview(meshId);
        this.ctx.scheduleRender();
        return true;
    }

    // ── Live cloth simulation ─────────────────────────────────────────────────

    /**
     * Create a LiveClothHandle for interactive use in the Cloth Builder modal.
     * The handle owns its own ClothSimulator and runs a requestAnimationFrame loop.
     * Set handle.onPositionsUpdate to receive positions after each GPU readback,
     * then call updateClothMeshPose() with the result.
     * Always call handle.destroy() when the modal closes.
     *
     * Returns null if WebGPU is unavailable.
     */
    createLiveClothSim(
        grid:    Partial<ClothGridConfig>,
        physics: Partial<ClothPhysicsConfig>,
        mode:    'hang' | 'drape',
        proxy?:  DrapeProxy,
    ): LiveClothHandle | null {
        const device = this.ctx.webgpuRenderer.getDevice();
        const cols   = grid.cols ?? 8;
        const rows   = grid.rows ?? 10;
        const fullGrid: ClothGridConfig = {
            cols, rows,
            cellSize:       grid.cellSize       ?? 0.1,
            cornerRadius:   grid.cornerRadius   ?? 0,
            activeCells:    grid.activeCells    ?? buildDefaultActiveCells(cols, rows),
            pinnedVertices: grid.pinnedVertices ?? [],
        };
        const fullPhysics: ClothPhysicsConfig = { ...DEFAULT_CLOTH_PHYSICS, ...physics };
        return createLiveClothSimulation(device, fullGrid, fullPhysics, mode, proxy);
    }

    /**
     * Enable live physics for an existing ClothMesh3D in the scene.
     * Scene3DManager maintains a LiveClothHandle and calls tickLiveCloths() each
     * render frame (registered as a preRenderCallback on the WebGPU renderer).
     * The FrameLinkAnimation3D of type 'wind' on the node drives the wind force.
     *
     * Returns false if the node is not found, is not a ClothMesh3D, or WebGPU is unavailable.
     */
    enableLiveCloth(meshId: string, stepsPerFrame?: number): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        // Destroy any existing handle for this mesh
        this._liveClothHandles.get(meshId)?.destroy();

        const device = this.ctx.webgpuRenderer.getDevice();
        const cfg    = node.clothConfig;
        const phys   = node.physicsConfig;

        // Start from the mesh's current simulated positions
        const initPositions = node.simState.isSimulated
            ? new Float32Array(node.simState.positions)
            : undefined;

        // Determine mode from simState
        const mode: 'hang' | 'drape' = node.simState.simulationMode !== 'none'
            ? node.simState.simulationMode as 'hang' | 'drape'
            : 'hang';

        const handle = createLiveClothSimulation(device, cfg, phys, mode, undefined, initPositions);
        if (!handle) return false;

        // Wire GPU pose buffer override so the renderer reads live vertex data
        // without a CPU roundtrip. Fires on reset/destroy lifecycle events.
        handle.onPoseBufferChange = (buf) => {
            this.renderer3D.setVertexBufferOverride(meshId, buf);
        };
        if (handle.poseBuffer) {
            this.renderer3D.setVertexBufferOverride(meshId, handle.poseBuffer);
        }

        handle.onPositionsUpdate = (positions) => {
            // Pose buffer is live — both the main Renderer3D and the modal preview
            // ClothPreviewRenderer read poseVertexBuf directly (set via override in
            // tickLiveCloths / _renderClothPreview). Only persist simState here.
            if (handle.poseBuffer) {
                const cached = this._clothData.get(meshId);
                if (cached && positions.length === cached.vertexCount * 3) {
                    (node.simState as ClothSimState).positions      = Array.from(positions);
                    (node.simState as ClothSimState).isSimulated    = true;
                    (node.simState as ClothSimState).simulationMode = mode;
                }
            } else {
                this.updateClothMeshPose(meshId, positions, mode);
            }
            this.ctx.scheduleRender();
        };

        // Apply persisted wind zones and bend stiffness immediately
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);
        const cachedResult = this._clothData.get(meshId);
        if (cachedResult) handle.setBendStiffness(cachedResult.bendStiffness);

        this._liveClothHandles.set(meshId, handle);

        // Update liveConfig on node
        (node as any).liveConfig = {
            enabled: true,
            stepsPerFrame: stepsPerFrame ?? DEFAULT_CLOTH_LIVE.stepsPerFrame,
        } satisfies ClothLiveConfig;

        // Register per-frame tick if not already registered
        this._ensureLiveClothTick();

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Disable live physics for a cloth mesh.
     * @param bakeCurrentPose  If true, snapshots the current simulated positions
     *                         and updates the mesh geometry so it stays in its
     *                         current shape after the live sim stops.
     */
    async disableLiveCloth(meshId: string, bakeCurrentPose = false): Promise<boolean> {
        const handle = this._liveClothHandles.get(meshId);
        if (!handle) return false;

        if (bakeCurrentPose) {
            const positions = await handle.snapshot();
            const node = this.ctx.sceneGraph.findNodeById(meshId);
            if (node instanceof ClothMesh3D) {
                const mode = node.simState.simulationMode !== 'none'
                    ? node.simState.simulationMode as 'hang' | 'drape'
                    : 'hang';
                this.updateClothMeshPose(meshId, positions, mode);
            }
        }

        // Clear GPU pose buffer override before the handle destroys its buffer
        this.renderer3D.setVertexBufferOverride(meshId, null);
        handle.destroy();
        this._liveClothHandles.delete(meshId);

        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof ClothMesh3D) {
            (node as any).liveConfig = { ...DEFAULT_CLOTH_LIVE, enabled: false } satisfies ClothLiveConfig;
        }

        if (this._liveClothHandles.size === 0) {
            this._removeLiveClothTick();
        }

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Returns the active LiveClothHandle for a cloth mesh, or null if none is running.
     *
     * Frogmarks uses this in the Edit Cloth modal to:
     *   - handle.snapshot()    → get current positions for baking (Apply button)
     *   - handle.reset(...)    → restart sim from flat or a given pose
     *   - handle.setPhysics()  → hot-update gravity/damping (prefer setClothPhysics instead)
     *
     * Do NOT store the returned reference across async gaps or modal re-opens —
     * it can be replaced when setClothConfig() or reset() is called.
     */
    getLiveClothHandle(meshId: string): LiveClothHandle | null {
        return this._liveClothHandles.get(meshId) ?? null;
    }

    /**
     * Called once per render frame by the preRenderCallback registered in
     * _ensureLiveClothTick(). Applies wind animation from the mesh's
     * FrameLinkAnimation3D (type='wind') to each live cloth's simulator.
     * Returns true while any live cloths are active (keeps frames rendering).
     */
    tickLiveCloths(frame: number): boolean {
        if (this._liveClothHandles.size === 0) return false;

        for (const [meshId, handle] of this._liveClothHandles) {
            const node = this.ctx.sceneGraph.findNodeById(meshId);
            if (!(node instanceof ClothMesh3D)) {
                // Node was removed — clean up
                handle.destroy();
                this._liveClothHandles.delete(meshId);
                continue;
            }

            // Apply wind from FrameLinkAnimation3D (type='wind') if set on this mesh
            const anim = this._frameLinkAnims3D.get(meshId);
            if (anim?.enabled && anim.type === 'wind') {
                const { wind } = evalFrameLink3D(anim, frame);
                handle.setPhysics({ wind: { x: wind[0], y: wind[1], z: wind[2] } });
            }

            // Drive any attached modal preview canvas at 60fps using poseVertexBuf
            // directly — no CPU geometry upload, no rate-limiting.
            if (this._previewRenderers.has(meshId)) {
                this._renderClothPreview(meshId);
            }
        }

        return this._liveClothHandles.size > 0;
    }

    // Lazily register / remove the preRenderCallback for live cloth ticking
    private _liveClothTickCb: (() => boolean) | null = null;

    private _ensureLiveClothTick(): void {
        if (this._liveClothTickCb) return;
        let frame = 0;
        this._liveClothTickCb = () => {
            frame++;
            return this.tickLiveCloths(frame);
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._liveClothTickCb);
    }

    private _removeLiveClothTick(): void {
        if (!this._liveClothTickCb) return;
        this.ctx.webgpuRenderer.removePreRenderCallback(this._liveClothTickCb);
        this._liveClothTickCb = null;
    }

    // ── Cloth preview canvas ──────────────────────────────────────────────────

    /**
     * Attach a secondary <canvas> to receive a live cloth preview.
     * Renders the mesh into the canvas after every updateClothMeshPose() call.
     * The canvas gets its own GPUCanvasContext — no main-canvas interference.
     * Orbit is enabled by default; drag to rotate.
     *
     * Returns a dispose function — call it when the modal closes (or use
     * handle.destroy() which triggers this automatically if wired up).
     *
     * @param meshId  The cloth mesh to preview (must exist in the scene).
     * @param canvas  An HTMLCanvasElement inside the modal.
     * @param opts    bgColor, orbitEnabled.
     */
    attachClothPreviewCanvas(
        meshId: string,
        canvas: HTMLCanvasElement,
        opts?: ClothPreviewOptions,
    ): () => void {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return () => {};

        // Destroy any existing preview for this mesh
        this._previewRenderers.get(meshId)?.destroy();

        let preview: ClothPreviewRenderer;
        try {
            preview = new ClothPreviewRenderer(device, canvas, opts);
        } catch {
            return () => {};
        }
        this._previewRenderers.set(meshId, preview);

        // Render once immediately if the mesh already has geometry
        const mesh = this.getMesh(meshId);
        if (mesh) {
            mesh.gpuDirty = true;
            preview.render(mesh);
            mesh.gpuDirty = true;
        }

        return () => {
            preview.destroy();
            if (this._previewRenderers.get(meshId) === preview) {
                this._previewRenderers.delete(meshId);
            }
        };
    }

    private _renderClothPreview(meshId: string): void {
        const preview = this._previewRenderers.get(meshId);
        if (!preview) return;
        const mesh = this.getMesh(meshId);
        if (!mesh) return;

        const poseBuffer = this._liveClothHandles.get(meshId)?.poseBuffer ?? null;
        if (poseBuffer) {
            // Live path: poseVertexBuf is the authoritative vertex source.
            // Set the same override that the main Renderer3D uses — the preview's
            // internal Renderer3D reads from poseVertexBuf directly, zero CPU upload.
            // WebGPU queue ordering guarantees the compute write completes before
            // either render pass reads, so no double-buffering is needed.
            preview.setVertexBufferOverride(mesh.id, poseBuffer);
            // Preserve gpuDirty: tickLiveCloths runs as a preRenderCallback, BEFORE
            // the main Renderer3D's drawMeshes. If geometry just changed (e.g. new
            // subdivisions), the preview renderer will clear gpuDirty when it uploads
            // the new index buffer. Restore it so the main renderer does the same upload
            // rather than drawing the new poseVertexBuf against the stale index buffer.
            const wasDirty = mesh.gpuDirty;
            preview.render(mesh);
            if (wasDirty) mesh.gpuDirty = true;
        } else {
            // Static path: mesh.geometry was updated by setGeometry/updateClothMeshPose.
            // Clear any stale override and re-upload the CPU geometry.
            preview.setVertexBufferOverride(mesh.id, null);
            mesh.gpuDirty = true;
            preview.render(mesh);
            mesh.gpuDirty = true;
        }
    }

    /** Upload a normal map to the TextureLibrary and apply it to a mesh. Returns library ID. */
    async uploadAndApplyNormalMap(meshId: string, source: File | Blob | ImageBitmap, name?: string): Promise<string | null> {
        const mesh = this.getMesh(meshId);
        if (!mesh) return null;
        const lib = this.getTextureLibrary();
        const id  = await lib.upload(source, name ?? 'normal_map');
        const tex = lib.getTexture(id);
        if (!tex) return null;

        if (mesh.normalMapTexture && mesh.normalMapTexture !== tex) mesh.normalMapTexture.destroy();
        mesh.normalMapTexture = tex;
        mesh.normalMapLibraryId = id;
        mesh.material.hasNormalMap = true;

        if (!mesh.material.hasTexture) {
            const device = this.ctx.webgpuRenderer.getDevice()!;
            const whiteTex = device.createTexture({
                size: [1, 1, 1], format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            device.queue.writeTexture({ texture: whiteTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
            if (mesh.diffuseTexture) mesh.diffuseTexture.destroy();
            mesh.diffuseTexture = whiteTex;
            mesh.material.hasTexture = true;
            console.warn(`[Scene3DManager] uploadAndApplyNormalMap: mesh "${meshId}" had no diffuse texture — auto-created 1×1 white diffuse. Assign a real diffuse texture to replace it.`);
        }

        mesh.gpuDirty = true;
        mesh.stateDirty = true;
        this.ctx.scheduleRender();
        return id;
    }

    // ── Dirty tracking ───────────────────────────────────────────────────────

    /**
     * Returns IDs of all Mesh3D nodes whose save-relevant state has changed
     * since the last call to clearMeshDirtyState(). Use this for per-mesh
     * chunked saves so only changed meshes are re-uploaded.
     */
    getDirtyMeshIds(): string[] {
        return this.getAllMeshes().filter(m => m.stateDirty).map(m => m.id);
    }

    /**
     * Clear the stateDirty flag on the given mesh IDs (or all meshes if omitted).
     * Call this after a successful save of those meshes.
     */
    clearMeshDirtyState(ids?: string[]): void {
        if (ids) {
            for (const id of ids) {
                const m = this.getMesh(id);
                if (m) m.stateDirty = false;
            }
        } else {
            for (const m of this.getAllMeshes()) m.stateDirty = false;
        }
    }

    // ── Particle emitters ────────────────────────────────────────────────────

    /**
     * Add a CPU-simulated billboard particle emitter to the 3D scene.
     * Returns the emitter's ID. Pass `preset` to use a tuned preset config
     * ('dust' | 'sparks' | 'snow' | 'magic'); individual config fields override
     * the preset. The emitter begins ticking immediately.
     */
    addParticleEmitter(
        x: number, y: number, z: number,
        config: ParticleEmitterConfig = {},
        preset?: ParticlePreset,
    ): string {
        const emitter = new ParticleEmitter3D(
            this.ctx.interactionService, x, y, z, config, preset,
        );
        this._particleEmitters.set(emitter.id, emitter);

        // Add to scene graph so the main renderer can find it in `aboveRasterNodes`
        this.ctx.sceneGraph.root.addChild(emitter);
        this.ctx.emitSceneGraphChanged();

        this._ensureParticleTick();
        this.ctx.scheduleRender();
        return emitter.id;
    }

    removeParticleEmitter(id: string): void {
        const emitter = this._particleEmitters.get(id);
        if (!emitter) return;
        this._particleEmitters.delete(id);
        emitter.parent?.removeChild(emitter);
        this.ctx.emitSceneGraphChanged();

        if (this._particleEmitters.size === 0) {
            this._stopParticleTick();
        }
        this.ctx.scheduleRender();
    }

    getParticleEmitter(id: string): ParticleEmitter3D | null {
        return this._particleEmitters.get(id) ?? null;
    }

    setParticleEmitterConfig(id: string, config: ParticleEmitterConfig): void {
        const emitter = this._particleEmitters.get(id);
        if (emitter) emitter.setConfig(config);
    }

    getAllParticleEmitters(): ParticleEmitter3D[] {
        return [...this._particleEmitters.values()];
    }

    /** Re-register a ParticleEmitter3D node that was restored from JSON. */
    registerRestoredParticleEmitter(emitter: ParticleEmitter3D): void {
        this._particleEmitters.set(emitter.id, emitter);
        this._ensureParticleTick();
    }

    // ── Bloom pass ───────────────────────────────────────────────────

    get bloomEnabled(): boolean { return this.renderer3D.bloomEnabled; }

    enableBloom(threshold?: number, intensity?: number): void {
        this.renderer3D.enableBloom(threshold, intensity);
    }

    disableBloom(): void {
        this.renderer3D.disableBloom();
    }

    setBloomThreshold(t: number): void { this.renderer3D.setBloomThreshold(t); }
    setBloomIntensity(v: number): void { this.renderer3D.setBloomIntensity(v); }

    private _ensureParticleTick(): void {
        if (this._particleTickCb) return;
        let lastTime = performance.now();
        this._particleTickCb = () => {
            const now = performance.now();
            const dt  = Math.min((now - lastTime) / 1000, 0.1); // clamp to 100 ms
            lastTime  = now;
            for (const e of this._particleEmitters.values()) {
                e.tick(dt);
            }
            const hasActive = this._particleEmitters.size > 0;
            if (!hasActive) {
                this.ctx.webgpuRenderer.removePreRenderCallback(this._particleTickCb!);
                this._particleTickCb = null;
            }
            return hasActive;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._particleTickCb);
    }

    private _stopParticleTick(): void {
        if (!this._particleTickCb) return;
        this.ctx.webgpuRenderer.removePreRenderCallback(this._particleTickCb);
        this._particleTickCb = null;
    }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Compute how much to lift the cloth in Y before a drape simulation so it
 * starts above the proxy and can fall onto it.
 */
function _drapeStartY(
    proxy: DrapeProxy,
    flatPositions: Float32Array,
    config: ClothGridConfig,
    gravity: number,
): number {
    const clothHalfH = config.rows * config.cellSize * 0.5;
    if (proxy.type === 'sphere') {
        const cy = proxy.center?.[1] ?? 0;
        return cy + proxy.radius + clothHalfH + 0.1;
    }
    if (proxy.type === 'box') {
        return proxy.max[1] + clothHalfH + 0.1;
    }
    if (proxy.type === 'ground') {
        const groundY = proxy.y ?? 0;
        return groundY + clothHalfH + Math.sqrt(2 * gravity * 0.5);  // ~1s of fall height
    }
    return 0;
}

/**
 * Resolve the final MeshGeometry for a cloth node.
 * Uses solidifyCloth when thickness > 0, otherwise plain position+normal update.
 * Falls back to the flat geometry if positions is null/wrong length.
 */
function _resolveClothGeometry(
    result:    ClothGeometryResult,
    positions: Float32Array | null | undefined,
    physics:   ClothPhysicsConfig,
): MeshGeometry {
    const pos = (positions && positions.length === result.vertexCount * 3)
        ? positions
        : result.flatPositions;
    if (physics.thickness > 0) {
        return solidifyCloth(result, pos, physics.thickness, physics.solidifyRounded);
    }
    if (pos !== result.flatPositions) {
        return applySimulatedPositions(result, pos);
    }
    return result.geometry;
}

/**
 * Overwrite vertex positions in a cloth geometry result with post-simulation
 * values and recompute per-vertex normals from the new triangle faces.
 *
 * Returns a new MeshGeometry (does not mutate `result`).
 */
function applySimulatedPositions(
    result: ClothGeometryResult,
    positions: Float32Array,
): MeshGeometry {
    const src = result.geometry.vertices;
    const verts = new Float32Array(src.length);
    verts.set(src);

    const vc = result.vertexCount;

    // Overwrite positions
    for (let vi = 0; vi < vc; vi++) {
        verts[vi * FLOATS_PER_VERT    ] = positions[vi * 3    ];
        verts[vi * FLOATS_PER_VERT + 1] = positions[vi * 3 + 1];
        verts[vi * FLOATS_PER_VERT + 2] = positions[vi * 3 + 2];
    }

    // Recompute per-vertex normals (accumulate face normals, then normalize)
    const normals = new Float32Array(vc * 3);
    const indices = result.geometry.indices;
    for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
        const ax = positions[i0*3], ay = positions[i0*3+1], az = positions[i0*3+2];
        const bx = positions[i1*3], by = positions[i1*3+1], bz = positions[i1*3+2];
        const cx = positions[i2*3], cy = positions[i2*3+1], cz = positions[i2*3+2];
        const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
        const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
        const nx = e1y*e2z - e1z*e2y;
        const ny = e1z*e2x - e1x*e2z;
        const nz = e1x*e2y - e1y*e2x;
        for (const vi of [i0, i1, i2]) {
            normals[vi*3]   += nx;
            normals[vi*3+1] += ny;
            normals[vi*3+2] += nz;
        }
    }
    for (let vi = 0; vi < vc; vi++) {
        const nx = normals[vi*3], ny = normals[vi*3+1], nz = normals[vi*3+2];
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
        verts[vi * FLOATS_PER_VERT + 3] = nx / len;
        verts[vi * FLOATS_PER_VERT + 4] = ny / len;
        verts[vi * FLOATS_PER_VERT + 5] = nz / len;
    }

    return { vertices: verts, indices: result.geometry.indices, format: '12float' };
}
