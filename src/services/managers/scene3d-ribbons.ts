/**
 * Scene3DRibbons — the ribbon-mesh subsystem, extracted from Scene3DManager (§5.1).
 *
 * Ribbons are Catmull-Rom spline meshes (banners, streamers) whose geometry is rebuilt on the CPU
 * (`generateRibbon`) whenever a control point / width / UV / path-mode changes. This subsystem owns the ribbon
 * data map, the control-point drag-depth cache, the per-frame scroll counters, and the animated update tick that
 * rebuilds camera-facing ribbons and advances scroll animations each frame.
 *
 * It takes `ctx` plus a `Scene3DRibbonHost` for the handful of cross-subsystem needs: creating the backing mesh,
 * looking up meshes + their frame-link animation (a type='scroll' anim drives UV scroll), and the world↔screen
 * projection used by the canvas-overlay handle drag. The FLA methods stay in the manager and poke this subsystem
 * via startScrollAnimation()/clearScrollFrames(); the restore path calls registerRibbon()/ensureTick().
 *
 * NOTE: geometry rebuilds are pure CPU (generateRibbon → mesh.setGeometry) but the camera-facing tick + handle
 * drag depend on the live camera — browser-verify camera-facing ribbons, UV scroll, and handle dragging.
 */

import type { ManagerContext } from './manager-context';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Material3D } from '../../renderer/3d/material-3d';
import { Renderer3D } from '../../renderer/3d/renderer-3d';
import { MeshGeometry, generateRibbon } from '../../renderer/3d/mesh-generators';
import { RibbonData, RibbonControlPoint, RibbonPathMode } from '../../types/ribbon-3d';
import { FrameLinkAnimation3D, evalFrameLink3D } from '../../types/keyframe-3d';
import { vec4, mat4 } from 'gl-matrix';

const nearestPow2 = (n: number): number => {
    if (!isFinite(n) || n <= 0) return 1;
    return Math.pow(2, Math.round(Math.log2(n)));
};

/** The cross-subsystem needs of the ribbon subsystem. */
export interface Scene3DRibbonHost {
    /** Create the backing mesh for a new ribbon (delegates to Scene3DManager.createMesh with primitive 'custom'). */
    createRibbonMesh(x: number, y: number, z: number, geometry: MeshGeometry, material?: Partial<Material3D>): Mesh3D;
    getMesh(id: string): Mesh3D | null;
    /** The mesh's frame-link animation, if any — a type='scroll' anim advances the ribbon UV each frame. */
    getFrameLinkAnim(id: string): FrameLinkAnimation3D | null;
    projectWorldToScreen3D(x: number, y: number, z: number, canvasW: number, canvasH: number): { x: number; y: number; depth: number } | null;
    unprojectScreenToWorld3D(screenX: number, screenY: number, depth: number, canvasW: number, canvasH: number): { x: number; y: number; z: number };
}

export class Scene3DRibbons {
    private _data = new Map<string, RibbonData>();
    private _scrollFrames = new Map<string, number>();
    private _dragDepth = new Map<string, number>();   // key = `${ribbonId}:${handleIndex}`
    private _updateCb: (() => boolean) | null = null;

    constructor(
        private readonly ctx: ManagerContext,
        private readonly host: Scene3DRibbonHost,
    ) {}

    private get renderer3D(): Renderer3D { return this.ctx.webgpuRenderer.getRenderer3D(); }

    // ── Create / update ──────────────────────────────────────────────────────

    addRibbon(
        x: number, y: number, z: number,
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
        const mesh = this.host.createRibbonMesh(x, y, z, geom, material);

        this._data.set(mesh.id, {
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

    updatePath(meshId: string, controlPoints: RibbonControlPoint[]): boolean {
        const mesh = this.host.getMesh(meshId);
        const ribbon = this._data.get(meshId);
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

    updateWidth(meshId: string, width: number): boolean {
        const mesh = this.host.getMesh(meshId);
        const ribbon = this._data.get(meshId);
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

    getData(meshId: string): RibbonData | null {
        return this._data.get(meshId) ?? null;
    }

    removeData(meshId: string): boolean {
        return this._data.delete(meshId);
    }

    setControlPoint(meshId: string, index: number, x: number, y: number, z: number): boolean {
        const mesh = this.host.getMesh(meshId);
        const ribbon = this._data.get(meshId);
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

    setEndPadding(meshId: string, uvEndPadding: number): boolean {
        const mesh = this.host.getMesh(meshId);
        const ribbon = this._data.get(meshId);
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

    setPathMode(meshId: string, mode: RibbonPathMode): boolean {
        const mesh = this.host.getMesh(meshId);
        const ribbon = this._data.get(meshId);
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

        if (mode === 'camera-facing') this._ensureTick();

        this.ctx.scheduleRender();
        return true;
    }

    setDoubleSided(meshId: string, doubleSided: 'double' | 'front' | 'back' | boolean): boolean {
        const mesh = this.host.getMesh(meshId);
        const ribbon = this._data.get(meshId);
        if (!mesh || !ribbon) return false;

        const ds = doubleSided === true ? 'double' : doubleSided === false ? 'front' : doubleSided;
        ribbon.doubleSided = ds;
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
            doubleSided: ds,
        }));
        this.ctx.scheduleRender();
        return true;
    }

    updateSegments(meshId: string, segments: number): boolean {
        const mesh = this.host.getMesh(meshId);
        const ribbon = this._data.get(meshId);
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

    setFlipRearU(meshId: string, flip: boolean): boolean {
        const mesh = this.host.getMesh(meshId);
        const ribbon = this._data.get(meshId);
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

    setUvTileCount(meshId: string, tileCount: number): boolean {
        const mesh = this.host.getMesh(meshId);
        const ribbon = this._data.get(meshId);
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

    setShowHandles(meshId: string, show: boolean): boolean {
        const ribbon = this._data.get(meshId);
        if (!ribbon) return false;
        ribbon.showHandles = show;
        return true;
    }

    computeTextureSize(meshId: string, targetHeight = 128, maxWidth = 2048): { width: number; height: number; fontSize: number } | null {
        const ribbon = this._data.get(meshId);
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
        return { width, height, fontSize: height };
    }

    // ── Canvas-overlay handle drag ───────────────────────────────────────────

    /** Convert a control point in mesh-local space to world space. */
    private _cpToWorld(mesh: Mesh3D, cp: { x: number; y: number; z: number }): [number, number, number] {
        const w = vec4.transformMat4(vec4.create(), [cp.x, cp.y, cp.z, 1] as vec4, mesh.localMatrix as mat4);
        return [w[0] / w[3], w[1] / w[3], w[2] / w[3]];
    }

    /** Convert a world-space position back to mesh-local space. */
    private _worldToCpLocal(mesh: Mesh3D, wx: number, wy: number, wz: number): [number, number, number] {
        const inv = mat4.invert(mat4.create(), mesh.localMatrix as mat4);
        if (!inv) return [wx, wy, wz];
        const l = vec4.transformMat4(vec4.create(), [wx, wy, wz, 1] as vec4, inv);
        return [l[0] / l[3], l[1] / l[3], l[2] / l[3]];
    }

    getHandleScreenPositions(
        ribbonId: string,
        overlayWidth: number,
        overlayHeight: number,
    ): Array<{ x: number; y: number; index: number } | null> {
        const ribbon = this._data.get(ribbonId);
        if (!ribbon) return [];
        const mesh = this.host.getMesh(ribbonId);
        return ribbon.controlPoints.map((cp, index) => {
            const [wx, wy, wz] = mesh ? this._cpToWorld(mesh, cp) : [cp.x, cp.y, cp.z];
            const proj = this.host.projectWorldToScreen3D(wx, wy, wz, overlayWidth, overlayHeight);
            if (!proj) return null;
            return { x: proj.x, y: proj.y, index };
        });
    }

    beginHandleDrag(
        ribbonId: string,
        handleIndex: number,
        overlayWidth: number,
        overlayHeight: number,
    ): boolean {
        const ribbon = this._data.get(ribbonId);
        if (!ribbon || handleIndex < 0 || handleIndex >= ribbon.controlPoints.length) return false;
        const mesh = this.host.getMesh(ribbonId);
        const cp = ribbon.controlPoints[handleIndex];
        const [wx, wy, wz] = mesh ? this._cpToWorld(mesh, cp) : [cp.x, cp.y, cp.z];
        const proj = this.host.projectWorldToScreen3D(wx, wy, wz, overlayWidth, overlayHeight);
        if (!proj) return false;
        this._dragDepth.set(`${ribbonId}:${handleIndex}`, proj.depth);
        return true;
    }

    moveHandle(
        ribbonId: string,
        handleIndex: number,
        offsetX: number, offsetY: number,
        overlayWidth: number, overlayHeight: number,
    ): boolean {
        const depth = this._dragDepth.get(`${ribbonId}:${handleIndex}`);
        if (depth === undefined) return false;
        const world = this.host.unprojectScreenToWorld3D(offsetX, offsetY, depth, overlayWidth, overlayHeight);
        const mesh = this.host.getMesh(ribbonId);
        const [lx, ly, lz] = mesh
            ? this._worldToCpLocal(mesh, world.x, world.y, world.z)
            : [world.x, world.y, world.z];
        return this.setControlPoint(ribbonId, handleIndex, lx, ly, lz);
    }

    endHandleDrag(ribbonId: string, handleIndex: number): void {
        this._dragDepth.delete(`${ribbonId}:${handleIndex}`);
    }

    // ── Restore + FLA-scroll bridge ──────────────────────────────────────────

    /** Restore path: re-register ribbon data reconstructed from JSON. */
    registerRibbon(rd: RibbonData): void {
        this._data.set(rd.meshId, rd);
    }

    /** Restore path: start the animated tick (for camera-facing ribbons after a reload). */
    ensureTick(): void {
        this._ensureTick();
    }

    /** FLA bridge: a type='scroll' anim was (re)set on a mesh — reset its scroll counter and start ticking. */
    startScrollAnimation(meshId: string): void {
        this._scrollFrames.set(meshId, 0);
        this._ensureTick();
        this.ctx.scheduleRender();
    }

    /** FLA bridge: an anim was removed — drop its scroll counter. */
    clearScrollFrames(meshId: string): void {
        this._scrollFrames.delete(meshId);
    }

    // ── Per-frame update tick ────────────────────────────────────────────────

    private _ensureTick(): void {
        if (this._updateCb) return;
        this._updateCb = () => {
            let hasActive = false;
            const cam = this.renderer3D.getCamera();
            const camPos: [number, number, number] = [cam.position[0], cam.position[1], cam.position[2]];

            // One pass over ribbons: rebuild camera-facing ones every frame, and advance UV scroll for any
            // ribbon whose mesh carries a type='scroll' frame-link animation. (A ribbon that is BOTH just gets a
            // single rebuild with the advanced scroll offset — identical final geometry to the old two-loop form.)
            for (const [meshId, ribbon] of this._data) {
                const mesh = this.host.getMesh(meshId);
                if (!mesh) continue;
                const fla = this.host.getFrameLinkAnim(meshId);
                const isScroll = !!fla && fla.enabled && fla.type === 'scroll';
                if (ribbon.pathMode !== 'camera-facing' && !isScroll) continue;
                hasActive = true;

                if (isScroll) {
                    const frame = (this._scrollFrames.get(meshId) ?? 0) + 1;
                    this._scrollFrames.set(meshId, frame);
                    const { uvOffset } = evalFrameLink3D(fla!, frame);
                    if (fla!.axis === 'y') ribbon.uvScrollOffsetV = uvOffset[1];
                    else ribbon.uvScrollOffset = uvOffset[0];
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
                this.ctx.webgpuRenderer.removePreRenderCallback(this._updateCb!);
                this._updateCb = null;
            }
            return hasActive;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._updateCb);
    }

    /** Tear down the tick and drop all references (used on manager teardown). Safe to call more than once. */
    dispose(): void {
        this._data.clear();
        this._scrollFrames.clear();
        this._dragDepth.clear();
        if (this._updateCb) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._updateCb);
            this._updateCb = null;
        }
    }
}
