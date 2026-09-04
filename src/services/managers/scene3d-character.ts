/**
 * Scene3DCharacter — the character OVERLAY-CONTENT subsystem, extracted from Scene3DManager (§5.1, the big one).
 * See docs/specs/character-manager-extraction.md → "REFINED BOUNDARY".
 *
 * Boundary: this owns the character CONTENT that sits on a body — face rig, hair, clothing, attachments/charms,
 * spring colliders, body-fit + the body-surface/param caches, garment colour, skin tone, and the overlay refit.
 * These are mutually cyclic (a body edit refits clothing then hair; glasses sit at the face eye-line;
 * reapplyPartColor walks every rig; colliders read both hair + clothing), so they live in ONE class and cross-
 * reference internally. The SKELETON/ORCHESTRATION side (body generation, kitbash assembly, ghost preview, IK,
 * animation) stays in Scene3DManager and drives this via `refitOverlays()` / `registerBody()`.
 *
 * Depends on `ManagerContext` + a narrow `Scene3DCharacterHost`. NOTE: entirely device + character-visual with no
 * automated coverage — browser-verify after this move.
 */

import type { ManagerContext } from './manager-context';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import type { OrbitController } from '../../renderer/3d/orbit-controller';
import type { Camera3D } from '../../renderer/3d/camera-3d';
import type { SpringCollider } from '../../types/armature-3d';
import type { RenderStyle } from '../../renderer/3d/material-3d';
import { RasterTextureManager } from '../../renderer/raster/raster-texture-manager';
import { EyeParams, renderEyes, defaultEyeParams } from './eye-generator';
import type { FaceExpression, FaceBlinkConfig, FaceRigState } from './scene3d-manager';
import { HairParams, generateHair, DEFAULT_HAIR_PARAMS, HeadFrame, TAIL_BONES, DRAPE_SPRING_FROM } from './hair-generator';
import {
    ClothingParams, TopParams, ShoeParams, BodyFit, JointFit, ArmFit,
    generateTop, generateBottom, generateShoe, generateSock, generateUndershirt, generateUnderpants,
    defaultTopParams, defaultBottomParams, defaultShoeParams, defaultSockParams, defaultUndershirtParams, defaultUnderpantsParams,
    clothingPresetNames, clothingPreset, normSleeveLength, RING as GARMENT_RING,
} from './clothing-generator';
import { generateBodyResult, type ArmSurface, type ArmRing } from './body-generator';
import {
    AttachmentType, AttachmentParams, AttachmentPlacement, generateAttachment,
    defaultAttachmentParams, defaultAttachmentPlacement, attachmentTypeNames, attachmentMaterial,
} from './attachment-generator';
import { resetSpringState } from '../../renderer/3d/spring-bone-solver';
import { mat4, quat, vec3 } from 'gl-matrix';

const _nanoid = () => Math.random().toString(36).slice(2, 10);
const hexToRgb01 = (hex: string): { r: number; g: number; b: number } => {
    let h = (hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};
const rgb01ToHex = (r: number, g: number, b: number): string => {
    const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
};

type ClothingSlot = 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants';

interface FaceRig extends FaceRigState {
    textures: Map<string, RasterTextureManager>;
    faceAspect: number;
    _blinkTimer: ReturnType<typeof setTimeout> | null;
    _holdTimer:  ReturnType<typeof setTimeout> | null;
}
const DEFAULT_BLINK: FaceBlinkConfig = { mode: 'random', minSec: 2.5, maxSec: 6.0, holdMs: 110, enabled: true, doubleProbability: 0.15, doubleGapMinMs: 150, doubleGapMaxMs: 320 };

interface HairRig { bodyMeshId: string; hairMeshId: string; params: HairParams; gradient: RasterTextureManager; }
interface ClothingRig { bodyMeshId: string; slot: ClothingSlot; clothingMeshId: string; params: ClothingParams; gradient?: RasterTextureManager; }
interface AttachmentRig { id: string; bodyMeshId: string; attachmentMeshId: string; placement: AttachmentPlacement; params: AttachmentParams; }

/** What the character subsystem needs from Scene3DManager (kept narrow). */
export interface Scene3DCharacterHost {
    getMesh(id: string): Mesh3D | null;
    getAllMeshes(): Mesh3D[];
    getOrbitController(): OrbitController | null;
    getCamera(): Camera3D;
    /** Apply a saved render style to a regenerated overlay mesh (restore paths). */
    setRenderStyle(meshId: string, style: RenderStyle): void;
    /** Keep a skeleton's spring sim awake briefly so a new charm/chain settles into its hang. */
    keepSpringsAlive(skelId: string): void;
}

export class Scene3DCharacter {
    private _faceRigs = new Map<string, FaceRig>();
    private _hairRigs = new Map<string, HairRig>();
    private _clothingRigs = new Map<string, ClothingRig>();   // key = `${bodyMeshId}:${slot}`
    private _attachments = new Map<string, AttachmentRig>();
    private _bodyParams = new Map<string, import('./body-generator').BodyParams>();
    private _bodyArmSurface = new Map<string, ArmSurface>();
    private _bodyLegSurface = new Map<string, ArmSurface>();
    private _bodyTorsoSurface = new Map<string, ArmRing[]>();
    /** During a multi-slot refit: the fit built once and shared by every setClothingParams call. Null otherwise. */
    private _sharedBodyFit: { bodyMeshId: string; fit: BodyFit } | null = null;
    private _suppressHairRefit = false;

    constructor(
        private readonly ctx: ManagerContext,
        private readonly host: Scene3DCharacterHost,
    ) {}

    // ═══════════════════════════════════════════════════════════════════════════
    //  Face rig
    // ═══════════════════════════════════════════════════════════════════════════

    private _ensureRig(bodyMeshId: string): FaceRig | null {
        let rig = this._faceRigs.get(bodyMeshId);
        if (rig) return rig;
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return null;
        const headJointIdx = body.skeleton.data.joints.findIndex(j => j.name === 'head');
        if (headJointIdx < 0) return null;
        const decal = this._buildFaceDecal(body, headJointIdx);
        if (!decal) return null;
        rig = {
            bodyMeshId, skeletonId: body.skeleton.id, headJointIdx, decalMeshId: decal.id,
            expressions: [], textures: new Map(), activeId: null, blinkId: null,
            blink: { ...DEFAULT_BLINK }, faceAspect: this._faceAspect(body, headJointIdx),
            _blinkTimer: null, _holdTimer: null,
        };
        this._faceRigs.set(bodyMeshId, rig);
        return rig;
    }

    ensureFace3D(bodyMeshId: string): boolean { return !!this._ensureRig(bodyMeshId); }

    private _headRegionBBox(body: SkinnedMesh3D, headIdx: number): { min: [number,number,number]; max: [number,number,number] } | null {
        const g = body.geometry;
        if (!g || g.vertices.length === 0) return null;
        const v = g.vertices, ji = body.jointIndices, jw = body.jointWeights;
        const n = v.length / 12;
        let mnx=Infinity,mny=Infinity,mnz=Infinity, mxx=-Infinity,mxy=-Infinity,mxz=-Infinity, found=false;
        for (let i = 0; i < n; i++) {
            let w = 0;
            for (let k = 0; k < 4; k++) if (ji[i*4+k] === headIdx) w += jw[i*4+k];
            if (w < 0.5) continue;
            const x=v[i*12], y=v[i*12+1], z=v[i*12+2];
            if (x<mnx)mnx=x; if (y<mny)mny=y; if (z<mnz)mnz=z;
            if (x>mxx)mxx=x; if (y>mxy)mxy=y; if (z>mxz)mxz=z;
            found = true;
        }
        return found ? { min:[mnx,mny,mnz], max:[mxx,mxy,mxz] } : null;
    }

    /** Head-region bbox (rest space) — public because hair/attachment fitting frames off the head too. */
    headRegionBBox(body: SkinnedMesh3D, headIdx: number) { return this._headRegionBBox(body, headIdx); }

    private _faceAspect(body: SkinnedMesh3D, headIdx: number): number {
        const bb = this._headRegionBBox(body, headIdx);
        if (!bb) return 1;
        const w = (bb.max[0] - bb.min[0]) * 0.95;
        const h = (bb.max[1] - bb.min[1]) * 0.42;
        return h > 1e-4 ? w / h : 1;
    }

    private _buildFaceDecal(body: SkinnedMesh3D, headIdx: number): SkinnedMesh3D | null {
        const bb = this._headRegionBBox(body, headIdx);
        if (!bb) return null;
        const g = body.geometry;
        if (!g) return null;
        const cx = (bb.min[0]+bb.max[0])*0.5;
        const hX = bb.max[0]-bb.min[0], hY = bb.max[1]-bb.min[1], hZ = bb.max[2]-bb.min[2];
        const cy = bb.min[1] + hY*0.55;
        const hcy = (bb.min[1]+bb.max[1])*0.5;
        const cz = (bb.min[2]+bb.max[2])*0.5;
        const hw = hX*0.95*0.5, hh = hY*0.42*0.5;

        const vsrc = g.vertices, ji0 = body.jointIndices, jw0 = body.jointWeights, nv = vsrc.length / 12;
        const fX: number[] = [], fY: number[] = [], fZ: number[] = [];
        for (let i = 0; i < nv; i++) {
            let w = 0; for (let k = 0; k < 4; k++) if (ji0[i*4+k] === headIdx) w += jw0[i*4+k];
            if (w < 0.5 || vsrc[i*12+2] <= cz) continue;
            fX.push(vsrc[i*12]); fY.push(vsrc[i*12+1]); fZ.push(vsrc[i*12+2]);
        }
        const offset = Math.max(hZ*0.02, 0.001);
        const surfZ = (x: number, y: number): number => {
            const ds: { d: number; z: number }[] = [];
            for (let i = 0; i < fZ.length; i++) { const dx = fX[i]-x, dy = fY[i]-y; ds.push({ d: dx*dx + dy*dy, z: fZ[i] }); }
            ds.sort((a, b) => a.d - b.d);
            let sw = 0, swz = 0;
            for (let i = 0; i < Math.min(4, ds.length); i++) { const w = 1 / (ds[i].d + 1e-6); sw += w; swz += w * ds[i].z; }
            return sw > 0 ? swz/sw : bb.max[2];
        };
        const NC = 9, NR = 5, out: number[] = [];
        for (let row = 0; row < NR; row++) for (let col = 0; col < NC; col++) {
            const u = col/(NC-1), v = row/(NR-1);
            const x = cx - hw + u*2*hw, y = cy + hh - v*2*hh;
            const z = surfZ(x, y) + offset;
            const nx = x-cx, ny = y-hcy, nz = z-cz, nl = Math.hypot(nx,ny,nz)||1;
            out.push(x, y, z, nx/nl, ny/nl, nz/nl, u, v, 1, 0, 0, 1);
        }
        const idx: number[] = [];
        for (let row = 0; row < NR-1; row++) for (let col = 0; col < NC-1; col++) {
            const a = row*NC+col, b = a+1, c = a+NC, d = c+1;
            idx.push(a, c, d, a, d, b);
        }
        const geometry: MeshGeometry = { vertices: new Float32Array(out), indices: new Uint32Array(idx), format: '12float' };
        const decal = new SkinnedMesh3D(this.ctx.interactionService, body.x, body.y, body.z, { primitive: 'custom', geometry });
        decal.name        = 'FaceEyes';
        decal.isFaceDecal = true;
        decal.transformViaSkeleton = true;
        decal.skeletonId  = body.skeletonId;
        decal.skeleton    = body.skeleton;
        const nVerts = NC*NR;
        const ji = new Uint8Array(nVerts*4), jw = new Float32Array(nVerts*4);
        for (let i = 0; i < nVerts; i++) { ji[i*4] = headIdx; jw[i*4] = 1; }
        decal.jointIndices = ji;
        decal.jointWeights = jw;
        decal.skinDirty    = true;
        decal.setDiffuseColor(0, 0, 0, 1);
        decal.material.emissive    = { r: 1, g: 1, b: 1, a: 1 };
        decal.material.doubleSided = true;
        decal.visible = false;
        this.ctx.sceneGraph.root.addChild(decal);
        this.ctx.emitSceneGraphChanged();
        return decal;
    }

    private _ensureExpressionTexture(rig: FaceRig, exprId: string, size = 1024): RasterTextureManager | null {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return null;
        let mgr = rig.textures.get(exprId);
        const isNew = !mgr;
        if (!mgr) { mgr = new RasterTextureManager(device); rig.textures.set(exprId, mgr); }
        const cur = mgr.getTextureSize();
        const tex = mgr.ensureTexture(cur.w || size, cur.h || size);
        if (isNew) {
            const enc = device.createCommandEncoder();
            enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), clearValue: { r:0,g:0,b:0,a:0 }, loadOp:'clear', storeOp:'store' }] }).end();
            device.queue.submit([enc.finish()]);
        }
        return mgr;
    }

    private _applyTexture(rig: FaceRig, exprId: string | null): void {
        const decal = this.host.getMesh(rig.decalMeshId);
        if (!decal) return;
        const tex = exprId ? (rig.textures.get(exprId)?.getTexture() ?? null) : null;
        decal.diffuseTexture     = tex;
        decal.material.hasTexture = !!tex;
        decal.visible            = !!tex;
        decal.gpuDirty           = true;
        this.ctx.scheduleRender();
    }

    createFaceExpression(bodyMeshId: string, name?: string): string | null {
        const rig = this._ensureRig(bodyMeshId);
        if (!rig) return null;
        const id = 'expr_' + _nanoid();
        const isFirst = rig.expressions.length === 0;
        rig.expressions.push({ id, name: name || `Expression ${rig.expressions.length + 1}`, isBlink: false });
        this._ensureExpressionTexture(rig, id);
        if (isFirst) { rig.activeId = id; this._applyTexture(rig, id); }
        this.ctx.scheduleRender();
        return id;
    }

    deleteFaceExpression(bodyMeshId: string, exprId: string): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return;
        rig.expressions = rig.expressions.filter(e => e.id !== exprId);
        rig.textures.delete(exprId);
        if (rig.blinkId === exprId) { rig.blinkId = null; this._restartBlink(rig); }
        if (rig.activeId === exprId) {
            rig.activeId = rig.expressions.find(e => !e.isBlink)?.id ?? rig.expressions[0]?.id ?? null;
            this._applyTexture(rig, rig.activeId);
        }
        this.ctx.scheduleRender();
    }

    setActiveFaceExpression(bodyMeshId: string, exprId: string): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig || !rig.expressions.some(e => e.id === exprId)) return;
        rig.activeId = exprId;
        this._applyTexture(rig, exprId);
    }

    renameFaceExpression(bodyMeshId: string, exprId: string, name: string): void {
        const e = this._faceRigs.get(bodyMeshId)?.expressions.find(x => x.id === exprId);
        if (e) e.name = name;
    }

    setFaceBlinkExpression(bodyMeshId: string, exprId: string | null): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return;
        for (const e of rig.expressions) e.isBlink = (e.id === exprId);
        rig.blinkId = exprId && rig.expressions.some(e => e.id === exprId) ? exprId : null;
        if (rig.blinkId) this._ensureExpressionTexture(rig, rig.blinkId);
        this._restartBlink(rig);
    }

    setFaceBlinkConfig(bodyMeshId: string, cfg: Partial<FaceBlinkConfig>): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return;
        rig.blink = { ...rig.blink, ...cfg };
        this._restartBlink(rig);
    }

    setAutoBlink(bodyMeshId: string, opts: Partial<FaceBlinkConfig>): void {
        const rig = this._ensureRig(bodyMeshId);
        if (!rig) return;
        rig.blink = { ...rig.blink, ...opts };
        if (rig.blink.enabled !== false && rig.activeId && (!rig.blinkId || !rig.textures.has(rig.blinkId))) {
            const base = rig.expressions.find(e => e.id === rig.activeId)?.eyeParams ?? this.getDefaultEyeParams();
            const id = this.createFaceExpression(bodyMeshId, 'Blink');
            if (id) {
                this.setFaceExpressionProcedural(bodyMeshId, id, { ...base, closed: true });
                this.setFaceBlinkExpression(bodyMeshId, id);
                return;
            }
        }
        this._restartBlink(rig);
    }

    getFaceExpressions(bodyMeshId: string): { expressions: FaceExpression[]; activeId: string | null; blinkId: string | null; blink: FaceBlinkConfig } | null {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return null;
        return { expressions: rig.expressions.map(e => ({ ...e })), activeId: rig.activeId, blinkId: rig.blinkId, blink: { ...rig.blink } };
    }

    getFaceExpressionTextureManager(bodyMeshId: string, exprId: string): RasterTextureManager | null {
        const rig = this._ensureRig(bodyMeshId);
        if (!rig) return null;
        return this._ensureExpressionTexture(rig, exprId);
    }

    private _renderEyeParamsToTexture(mgr: RasterTextureManager, params: EyeParams, aspect = 1): void {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return;
        const cur = mgr.getTextureSize();
        const W = cur.w || 1024, H = cur.h || 1024;
        const tex = mgr.ensureTexture(W, H);

        const big = document.createElement('canvas');
        big.width = W; big.height = H;
        const bctx = big.getContext('2d');
        if (!bctx) return;

        const px = params.pixelResolution > 0 ? Math.max(16, Math.min(Math.round(params.pixelResolution), Math.min(W, H))) : 0;
        if (px > 0) {
            const small = document.createElement('canvas');
            small.width = px; small.height = Math.max(16, Math.round(px * H / W));
            const sctx = small.getContext('2d');
            if (!sctx) return;
            renderEyes(sctx, params, small.width, small.height, aspect);
            bctx.imageSmoothingEnabled = false;
            bctx.clearRect(0, 0, W, H);
            bctx.drawImage(small, 0, 0, small.width, small.height, 0, 0, W, H);
        } else {
            renderEyes(bctx, params, W, H, aspect);
        }
        device.queue.copyExternalImageToTexture({ source: big, flipY: false }, { texture: tex }, [W, H]);
    }

    getDefaultEyeParams(): EyeParams { return defaultEyeParams(); }

    private _eyeVPosForBody(bodyMeshId: string): number {
        const rig = this._faceRigs.get(bodyMeshId);
        const ep = rig?.expressions.find(e => e.id === rig.activeId)?.eyeParams;
        return ep?.verticalPos ?? defaultEyeParams().verticalPos;
    }

    eyeYForBody(bodyMeshId: string, head: { cy: number; ry: number }): number {
        const v = this._eyeVPosForBody(bodyMeshId);
        return head.cy + head.ry * (0.52 - 0.84 * v);
    }

    setFaceExpressionProcedural(bodyMeshId: string, exprId: string, params: EyeParams): void {
        const rig = this._ensureRig(bodyMeshId);
        if (!rig) return;
        const expr = rig.expressions.find(e => e.id === exprId);
        if (!expr) return;
        const mgr = this._ensureExpressionTexture(rig, exprId);
        if (!mgr) return;
        this._renderEyeParamsToTexture(mgr, params, rig.faceAspect);
        expr.eyeParams = params;
        if (rig.activeId === null) rig.activeId = exprId;
        this._applyTexture(rig, rig.activeId);
        this.ctx.scheduleRender();
    }

    getFaceExpressionParams(bodyMeshId: string, exprId: string): EyeParams | null {
        const rig = this._faceRigs.get(bodyMeshId);
        return rig?.expressions.find(e => e.id === exprId)?.eyeParams ?? null;
    }

    setFaceGaze(bodyMeshId: string, x: number, y: number): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig || !rig.activeId) return;
        const expr = rig.expressions.find(e => e.id === rig.activeId);
        if (!expr?.eyeParams) return;
        expr.eyeParams.gazeX = Math.max(-1, Math.min(1, x));
        expr.eyeParams.gazeY = Math.max(-1, Math.min(1, y));
        const mgr = this._ensureExpressionTexture(rig, expr.id);
        if (mgr) this._renderEyeParamsToTexture(mgr, expr.eyeParams, rig.faceAspect);
        this._applyTexture(rig, rig.activeId);
        this.ctx.scheduleRender();
    }

    getFaceDecalMeshId(bodyMeshId: string): string | null { return this._faceRigs.get(bodyMeshId)?.decalMeshId ?? null; }
    getEyesMeshId(bodyMeshId: string): string | null { return this._faceRigs.get(bodyMeshId)?.decalMeshId ?? null; }

    frameFace3D(bodyMeshId: string): boolean {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D)) return false;
        const ctrl = this.host.getOrbitController();
        if (!ctrl) return false;
        const headIdx = this._faceRigs.get(bodyMeshId)?.headJointIdx
            ?? body.skeleton?.data.joints.findIndex(j => j.name === 'head') ?? -1;
        if (headIdx < 0) return false;
        const bb = this._headRegionBBox(body, headIdx);
        if (!bb) return false;
        const cam = this.host.getCamera();
        const cx = (bb.min[0] + bb.max[0]) * 0.5 + body.x;
        const cy = (bb.min[1] + bb.max[1]) * 0.5 + body.y;
        const cz = (bb.min[2] + bb.max[2]) * 0.5 + body.z;
        const half = Math.max(bb.max[1] - bb.min[1], bb.max[0] - bb.min[0]) * 0.5 * 1.5;
        cam.setTarget(cx, cy, cz);
        if (cam.mode === 'orthographic') {
            cam.orthoSize = Math.max(0.05, half);
            ctrl.radius = Math.max(ctrl.radius, half * 4);
        } else {
            ctrl.radius = Math.max(0.05, half / Math.tan(Math.max(0.05, cam.fov) * 0.5));
        }
        ctrl.setSpherical(0, 0.06);
        this.ctx.scheduleRender();
        return true;
    }

    private _cancelBlink(rig: FaceRig): void {
        if (rig._blinkTimer) { clearTimeout(rig._blinkTimer); rig._blinkTimer = null; }
        if (rig._holdTimer)  { clearTimeout(rig._holdTimer);  rig._holdTimer  = null; }
    }
    private _restartBlink(rig: FaceRig): void {
        this._cancelBlink(rig);
        if (rig.blink.enabled === false) return;
        if (!rig.blinkId || !rig.textures.has(rig.blinkId)) return;
        const b = rig.blink;
        const wait = b.mode === 'fixed' ? b.minSec : b.minSec + Math.random() * Math.max(0, b.maxSec - b.minSec);
        rig._blinkTimer = setTimeout(() => this._fireBlink(rig), Math.max(200, wait * 1000));
    }
    private _fireBlink(rig: FaceRig, isSecond = false): void {
        rig._blinkTimer = null;
        if (!rig.blinkId) return;
        this._applyTexture(rig, rig.blinkId);
        rig._holdTimer = setTimeout(() => {
            rig._holdTimer = null;
            this._applyTexture(rig, rig.activeId);
            const b = rig.blink;
            if (!isSecond && (b.doubleProbability ?? 0) > 0 && Math.random() < (b.doubleProbability ?? 0)) {
                const gMin = b.doubleGapMinMs ?? 150, gMax = b.doubleGapMaxMs ?? 320;
                const gap = gMin + Math.random() * Math.max(0, gMax - gMin);
                rig._blinkTimer = setTimeout(() => this._fireBlink(rig, true), Math.max(40, gap));
            } else {
                this._restartBlink(rig);
            }
        }, Math.max(40, rig.blink.holdMs));
    }

    serializeFaceRigs(): FaceRigState[] {
        const out: FaceRigState[] = [];
        for (const rig of this._faceRigs.values()) {
            out.push({
                bodyMeshId: rig.bodyMeshId, skeletonId: rig.skeletonId, headJointIdx: rig.headJointIdx,
                decalMeshId: rig.decalMeshId, expressions: rig.expressions.map(e => ({ ...e })),
                activeId: rig.activeId, blinkId: rig.blinkId, blink: { ...rig.blink },
            });
        }
        return out;
    }
    getFaceTextureExports(): { key: string; mgr: RasterTextureManager; procedural: boolean }[] {
        const out: { key: string; mgr: RasterTextureManager; procedural: boolean }[] = [];
        for (const rig of this._faceRigs.values())
            for (const [exprId, mgr] of rig.textures) {
                const procedural = !!rig.expressions.find(e => e.id === exprId)?.eyeParams;
                out.push({ key: `${rig.bodyMeshId}:${exprId}`, mgr, procedural });
            }
        return out;
    }
    async restoreFaceRigs(states: FaceRigState[] | undefined, faceBlobs: Map<string, ArrayBuffer>): Promise<void> {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device || !states?.length) return;
        for (const st of states) {
            const body = this.host.getMesh(st.bodyMeshId);
            if (!(body instanceof SkinnedMesh3D) || !body.skeleton) continue;
            const decal = this._buildFaceDecal(body, st.headJointIdx);
            if (!decal) continue;
            const rig: FaceRig = {
                bodyMeshId: st.bodyMeshId, skeletonId: body.skeleton.id, headJointIdx: st.headJointIdx,
                decalMeshId: decal.id, expressions: st.expressions.map(e => ({ ...e })), textures: new Map(),
                activeId: st.activeId, blinkId: st.blinkId, blink: { ...st.blink },
                faceAspect: this._faceAspect(body, st.headJointIdx), _blinkTimer: null, _holdTimer: null,
            };
            for (const e of rig.expressions) {
                const buf = faceBlobs.get(`${st.bodyMeshId}:${e.id}`);
                const mgr = new RasterTextureManager(device);
                rig.textures.set(e.id, mgr);
                if (buf && buf.byteLength) {
                    try {
                        const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
                        const tex = mgr.ensureTexture(bmp.width, bmp.height);
                        device.queue.copyExternalImageToTexture({ source: bmp, flipY: false }, { texture: tex }, [bmp.width, bmp.height]);
                    } catch (err) { console.warn('[Face] restore texture failed', e.id, err); }
                } else if (e.eyeParams) {
                    this._renderEyeParamsToTexture(mgr, e.eyeParams, rig.faceAspect);
                } else {
                    this._ensureExpressionTexture(rig, e.id);
                }
            }
            this._faceRigs.set(st.bodyMeshId, rig);
            this._applyTexture(rig, rig.activeId);
            this._restartBlink(rig);
        }
        this.ctx.scheduleRender();
    }

    /** After a body regen, rebuild the face decal against the new head bbox. */
    refitFaceAfterBodyRegen(bodyMeshId: string): void {
        const fr = this._faceRigs.get(bodyMeshId);
        const body = this.host.getMesh(bodyMeshId);
        if (!fr || !(body instanceof SkinnedMesh3D)) return;
        try {
            const old = this.host.getMesh(fr.decalMeshId); old?.parent?.removeChild(old);
            const decal = this._buildFaceDecal(body, fr.headJointIdx);
            if (decal) {
                fr.decalMeshId = decal.id;
                fr.faceAspect  = this._faceAspect(body, fr.headJointIdx);
                this._applyTexture(fr, fr.activeId);
            }
        } catch (e) { console.warn('[Body] face re-fit failed', e); }
    }

    prepareFaceRigDeletion(bodyMeshId: string): { drop: () => void; restore: () => void } | null {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return null;
        return {
            drop:    () => { this._cancelBlink(rig); this._faceRigs.delete(bodyMeshId); },
            restore: () => { this._faceRigs.set(bodyMeshId, rig); this._restartBlink(rig); },
        };
    }

    /** Capture every overlay-rig entry for a body (hair / clothing / attachments / body params + surface
     *  caches) as undoable drop/restore closures — the delete-character path owns these maps' lifecycle
     *  via this subsystem now, so the captured values are held here (not in the manager). Face is captured
     *  separately via prepareFaceRigDeletion. */
    captureBodyOverlaysForDeletion(bodyMeshId: string): { drop: () => void; restore: () => void } {
        const drops: (() => void)[] = [], restores: (() => void)[] = [];
        const cap = (map: Map<string, any>, key: string) => {
            if (!map.has(key)) return;
            const v = map.get(key);
            drops.push(() => map.delete(key)); restores.push(() => map.set(key, v));
        };
        for (const m of [this._bodyParams, this._bodyArmSurface, this._bodyLegSurface, this._bodyTorsoSurface, this._hairRigs] as Map<string, any>[])
            cap(m, bodyMeshId);
        for (const k of [...this._clothingRigs.keys()]) if (k.startsWith(bodyMeshId + ':')) cap(this._clothingRigs as unknown as Map<string, any>, k);
        for (const [k, rig] of [...this._attachments]) if (rig.bodyMeshId === bodyMeshId) cap(this._attachments as unknown as Map<string, any>, k);
        return { drop: () => { for (const d of drops) d(); }, restore: () => { for (const r of restores) r(); } };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Skin tone
    // ═══════════════════════════════════════════════════════════════════════════

    setSkinTone(bodyMeshId: string, hex: string): void {
        const body = this.host.getMesh(bodyMeshId);
        if (!body) return;
        const c = hexToRgb01(hex);
        body.setDiffuseColor(c.r, c.g, c.b, 1);
        body.gpuDirty = true;
        this.ctx.scheduleRender();
    }
    getSkinTone(bodyMeshId: string): string | null {
        const d = this.host.getMesh(bodyMeshId)?.material?.diffuse;
        return d ? rgb01ToHex(d.r, d.g, d.b) : null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Hair
    // ═══════════════════════════════════════════════════════════════════════════

    getDefaultHairParams(): HairParams { return { ...DEFAULT_HAIR_PARAMS }; }
    getHairParams(bodyMeshId: string): HairParams | null { return this._hairRigs.get(bodyMeshId)?.params ?? null; }
    getHairMeshId(bodyMeshId: string): string | null { return this._hairRigs.get(bodyMeshId)?.hairMeshId ?? null; }

    private _collisionVertsForHair(bodyMeshId: string, body: SkinnedMesh3D): Float32Array | undefined {
        const parts: Float32Array[] = [];
        if (body.geometry?.vertices && body.geometry.vertices.length >= 12) parts.push(body.geometry.vertices);
        for (const slot of ['top', 'bottom', 'shoes', 'socks', 'undershirt', 'underpants'] as const) {
            const cr = this._clothingRigs.get(`${bodyMeshId}:${slot}`);
            if (!cr) continue;
            const cm = this.host.getMesh(cr.clothingMeshId);
            if (cm?.geometry?.vertices && cm.geometry.vertices.length >= 12) parts.push(cm.geometry.vertices);
        }
        if (parts.length === 0) return undefined;
        if (parts.length === 1) return parts[0];
        let n = 0; for (const p of parts) n += p.length;
        const out = new Float32Array(n);
        let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    setHairParams(bodyMeshId: string, params: HairParams): void {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const headIdx = body.skeleton.data.joints.findIndex(j => j.name === 'head');
        if (headIdx < 0) return;
        const bb = this._headRegionBBox(body, headIdx);
        if (!bb) return;
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return;
        const head: HeadFrame = {
            cx: (bb.min[0]+bb.max[0])*0.5, cy: (bb.min[1]+bb.max[1])*0.5, cz: (bb.min[2]+bb.max[2])*0.5,
            rx: (bb.max[0]-bb.min[0])*0.5, ry: (bb.max[1]-bb.min[1])*0.5, rz: (bb.max[2]-bb.min[2])*0.5,
        };
        const result = generateHair(head, params, this._collisionVertsForHair(bodyMeshId, body));
        const skel = body.skeleton;

        const prevBase = skel.data.joints.findIndex(j => j.name.startsWith('springTail_') || j.name.startsWith('springCharm_'));
        if (prevBase >= 0) skel.truncateJoints(prevBase);
        skel.data.springChains = [];
        resetSpringState(skel);

        const rig = this._hairRigs.get(bodyMeshId);
        if (rig) { const old = this.host.getMesh(rig.hairMeshId); old?.parent?.removeChild(old); }
        const gradient = rig?.gradient ?? new RasterTextureManager(device);

        const hair = new SkinnedMesh3D(this.ctx.interactionService, body.x, body.y, body.z, { primitive: 'custom', geometry: result.geometry });
        hair.name = 'Hair'; hair.isHair = true; hair.visible = true; hair.transformViaSkeleton = true;
        hair.skeletonId = body.skeletonId; hair.skeleton = skel;
        const { ji, jw } = this._buildHairSpringRig(skel, headIdx, head, result);
        this._ensureBodyColliders(bodyMeshId, params.frontDrape ?? 0);
        hair.jointIndices = ji; hair.jointWeights = jw; hair.skinDirty = true;
        hair.material.doubleSided = true;
        hair.setDiffuseColor(1, 1, 1, 1);
        const tex = this._renderHairGradient(gradient, params);
        if (tex) { hair.diffuseTexture = tex; hair.material.hasTexture = true; }
        hair.material.alphaCutout = String(params.hairMode ?? 'chunky').toLowerCase() === 'cards';
        const sheen = Math.max(0, Math.min(1, params.sheen ?? 0));
        hair.material.hairSheen = sheen > 0.02;
        hair.material.specular = { r: sheen, g: sheen, b: sheen, a: 1 };
        hair.material.shininess = 48;
        hair.gpuDirty = true;
        this.ctx.sceneGraph.root.addChild(hair);
        this.ctx.emitSceneGraphChanged();

        this._hairRigs.set(bodyMeshId, { bodyMeshId, hairMeshId: hair.id, params, gradient });
        this._rebuildAllCharms(bodyMeshId);
        this.ctx.scheduleRender();
    }

    private _buildHairSpringRig(skel: Skeleton3D, headIdx: number, head: HeadFrame, result: ReturnType<typeof generateHair>): { ji: Uint8Array; jw: Float32Array } {
        const nVerts = result.geometry.vertices.length / 12;
        const ji = new Uint8Array(nVerts * 4), jw = new Float32Array(nVerts * 4);
        for (let i = 0; i < nVerts; i++) { ji[i*4] = headIdx; jw[i*4] = 1; }
        if (result.tailBones.length === 0) return { ji, jw };

        const headRest = mat4.invert(mat4.create(), skel.data.joints[headIdx].inverseBindMatrix as unknown as mat4);
        const Rh = mat4.getRotation(quat.create(), headRest);
        const RhInv = quat.invert(quat.create(), Rh);
        const Hp = vec3.fromValues(headRest[12], headRest[13], headRest[14]);

        const tailChains: number[][] = [];
        for (let t = 0; t < result.tailBones.length; t++) {
            const P = result.tailBones[t];
            const chain: number[] = [];
            let parentIdx = headIdx;
            let prev = Hp;
            for (let b = 0; b < P.length; b++) {
                const Pi = vec3.fromValues(P[b][0], P[b][1], P[b][2]);
                const localPos = vec3.transformQuat(vec3.create(), vec3.subtract(vec3.create(), Pi, prev), RhInv);
                const idx = skel.addJoint(parentIdx, [localPos[0], localPos[1], localPos[2]], `springTail_${t}_${b}`, true);
                const restW = mat4.fromRotationTranslation(mat4.create(), Rh, Pi);
                mat4.invert(skel.data.joints[idx].inverseBindMatrix as unknown as mat4, restW);
                chain.push(idx);
                parentIdx = idx; prev = Pi;
            }
            tailChains.push(chain);
            const isDrape = t >= result.drapeFromTailId;
            (skel.data.springChains ??= []).push({
                id: crypto.randomUUID(),
                jointIndices: chain,
                stiffness: isDrape ? 0.4 : 0, drag: 0.55, gravity: 0.004, gravityDir: [0, -1, 0],
                hitRadius: head.rx * 0.18, enabled: true,
            });
        }
        skel.finalizeJointBatch();

        const chestIdx = skel.data.joints.findIndex(j => j.name === 'chest');
        for (let i = 0; i < nVerts; i++) {
            const t = result.tailVertId[i];
            if (t < 0 || t >= tailChains.length) continue;
            let v = Math.max(0, Math.min(1, result.geometry.vertices[i*12 + 7]));
            if (t >= result.drapeFromTailId) {
                if (v < DRAPE_SPRING_FROM) {
                    if (chestIdx >= 0) {
                        const cw = v / DRAPE_SPRING_FROM;
                        ji[i*4] = headIdx;    jw[i*4]   = 1 - cw;
                        ji[i*4+1] = chestIdx; jw[i*4+1] = cw;
                    }
                    continue;
                }
                v = (v - DRAPE_SPRING_FROM) / (1 - DRAPE_SPRING_FROM);
            }
            const f = v * (TAIL_BONES - 1);
            const b0 = Math.min(TAIL_BONES - 1, Math.floor(f)), b1 = Math.min(TAIL_BONES - 1, b0 + 1);
            const w1 = f - b0, ch = tailChains[t];
            ji[i*4] = ch[b0]; jw[i*4] = 1 - w1;
            ji[i*4+1] = ch[b1]; jw[i*4+1] = w1;
        }
        return { ji, jw };
    }

    removeHair(bodyMeshId: string): void {
        const rig = this._hairRigs.get(bodyMeshId);
        if (!rig) return;
        const m = this.host.getMesh(rig.hairMeshId);
        m?.parent?.removeChild(m);
        const body = this.host.getMesh(bodyMeshId);
        if (body instanceof SkinnedMesh3D && body.skeleton) {
            const skel = body.skeleton;
            const base = skel.data.joints.findIndex(j => j.name.startsWith('springTail_') || j.name.startsWith('springCharm_'));
            if (base >= 0) skel.truncateJoints(base);
            skel.data.springChains = [];
            skel.data.springColliders = [];
            resetSpringState(skel);
        }
        this._hairRigs.delete(bodyMeshId);
        this._rebuildAllCharms(bodyMeshId);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    private _renderHairGradient(mgr: RasterTextureManager, p: HairParams): GPUTexture | null {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return null;
        const cards = String(p.hairMode ?? 'chunky').toLowerCase() === 'cards';
        const W = cards ? 64 : 16, H = 256;
        const tex = mgr.ensureTexture(W, H);
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) return null;
        const g = ctx2d.createLinearGradient(0, 0, 0, H);
        const tip = p.gradient ? p.tipColor : p.rootColor;
        g.addColorStop(0, p.rootColor);
        g.addColorStop(Math.max(0, Math.min(1, 1 - p.tipFade)), p.rootColor);
        g.addColorStop(1, tip);
        ctx2d.fillStyle = g; ctx2d.fillRect(0, 0, W, H);
        if (cards) {
            const img = ctx2d.getImageData(0, 0, W, H);
            const d = img.data;
            const nStrands = Math.max(2, Math.round(p.strandDensity ?? 5));
            const rootSolid = 0.4;
            const solidity = Math.max(0.05, Math.min(1, p.alphaCutoff ?? 0.5));
            const h1 = (n: number) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
            for (let y = 0; y < H; y++) {
                const v = y / (H - 1);
                for (let x = 0; x < W; x++) {
                    const cell = (x / (W - 1)) * nStrands;
                    const si = Math.floor(cell), sp = cell - si;
                    const sEnd = 0.55 + h1(si * 3.1) * 0.45;
                    const sWidth = (0.5 + h1(si * 1.7) * 0.5) * solidity;
                    const sBright = 0.78 + h1(si * 2.3) * 0.4;
                    const taper = v < rootSolid ? 1 : Math.max(0, 1 - (v - rootSolid) / (sEnd - rootSolid + 1e-3));
                    const half = sWidth * (0.3 + 0.7 * taper);
                    const opaque = v < rootSolid || (v < sEnd && Math.abs(sp - 0.5) < half);
                    const o = (y * W + x) * 4;
                    if (opaque) {
                        d[o]   = Math.min(255, d[o]   * sBright);
                        d[o+1] = Math.min(255, d[o+1] * sBright);
                        d[o+2] = Math.min(255, d[o+2] * sBright);
                        d[o+3] = 255;
                    } else {
                        d[o+3] = 0;
                    }
                }
            }
            ctx2d.putImageData(img, 0, 0);
        }
        device.queue.copyExternalImageToTexture({ source: canvas, flipY: false }, { texture: tex }, [W, H]);
        return tex;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Clothing
    // ═══════════════════════════════════════════════════════════════════════════

    getDefaultClothingParams(slot: ClothingSlot): ClothingParams {
        return slot === 'top' ? defaultTopParams() : slot === 'bottom' ? defaultBottomParams() : slot === 'shoes' ? defaultShoeParams()
            : slot === 'socks' ? defaultSockParams() : slot === 'undershirt' ? defaultUndershirtParams() : defaultUnderpantsParams();
    }
    getClothingPresetNames(slot: ClothingSlot): string[] { return clothingPresetNames(slot); }
    getClothingPreset(slot: ClothingSlot, name: string): ClothingParams { return clothingPreset(slot, name); }
    getClothingParams(bodyMeshId: string, slot: ClothingSlot): ClothingParams | null {
        return this._clothingRigs.get(`${bodyMeshId}:${slot}`)?.params ?? null;
    }

    setClothingParams(bodyMeshId: string, params: ClothingParams): void {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return;
        const fit = (this._sharedBodyFit && this._sharedBodyFit.bodyMeshId === bodyMeshId)
            ? this._sharedBodyFit.fit
            : this._buildBodyFit(body);
        if (!fit) return;
        if (params.slot === 'top') {
            const raw = (params as TopParams).sleeveLength as number | string;
            const n = normSleeveLength(raw);
            if (raw !== n) params = { ...(params as TopParams), sleeveLength: n };
        }
        const result = params.slot === 'top' ? generateTop(fit, params)
            : params.slot === 'bottom' ? generateBottom(fit, params, (this._clothingRigs.get(`${bodyMeshId}:shoes`)?.params as ShoeParams) ?? null)
            : params.slot === 'shoes' ? generateShoe(fit, params)
            : params.slot === 'socks' ? generateSock(fit, params)
            : params.slot === 'undershirt' ? generateUndershirt(fit, params)
            : generateUnderpants(fit, params);

        const key = `${bodyMeshId}:${params.slot}`;
        const rig = this._clothingRigs.get(key);
        if (rig) { const old = this.host.getMesh(rig.clothingMeshId); old?.parent?.removeChild(old); }

        const mesh = new SkinnedMesh3D(this.ctx.interactionService, body.x, body.y, body.z, { primitive: 'custom', geometry: result.geometry });
        mesh.name = params.slot === 'top' ? 'Top' : params.slot === 'bottom' ? 'Bottom' : params.slot === 'shoes' ? 'Shoes' : params.slot === 'socks' ? 'Socks' : params.slot === 'undershirt' ? 'Undershirt' : 'Underpants'; mesh.isClothing = true; mesh.visible = true; mesh.transformViaSkeleton = true;
        mesh.skeletonId = body.skeletonId; mesh.skeleton = body.skeleton;
        mesh.jointIndices = result.jointIndices; mesh.jointWeights = result.jointWeights; mesh.skinDirty = true;
        mesh.material.doubleSided = true;
        mesh.material.metalness = 0;
        mesh.material.roughness = params.slot === 'shoes' ? 0.5 : params.slot === 'socks' ? 0.92 : params.slot === 'bottom' ? 0.88 : 0.85;
        const gradient = this._applyClothingColor(mesh, params, rig?.gradient, device);
        const pat = params.pattern;
        if (pat && pat.mode !== 'none') {
            const pc = hexToRgb01(pat.secondaryColor);
            mesh.material.patternMode = pat.mode;
            mesh.material.patternColor = { r: pc.r, g: pc.g, b: pc.b, a: 1 };
            mesh.material.patternFreq = pat.freq; mesh.material.patternAngle = pat.angle;
            mesh.material.patternScale = pat.scale; mesh.material.patternSpacing = pat.spacing;
        } else {
            mesh.material.patternMode = 'none';
        }
        mesh.gpuDirty = true;
        this.ctx.sceneGraph.root.addChild(mesh);
        this.ctx.emitSceneGraphChanged();

        this._clothingRigs.set(key, { bodyMeshId, slot: params.slot, clothingMeshId: mesh.id, params, gradient });
        if (!this._suppressHairRefit && !rig) {
            const hr = this._hairRigs.get(bodyMeshId);
            if (hr) { try { this.setHairParams(bodyMeshId, hr.params); } catch (e) { console.warn('[Hair] re-fit after clothing failed', e); } }
        }
        if (params.slot === 'shoes' && !this._suppressHairRefit) {
            const br = this._clothingRigs.get(`${bodyMeshId}:bottom`);
            if (br) { try { this.setClothingParams(bodyMeshId, br.params); } catch (e) { console.warn('[Bottom] re-pile on shoe failed', e); } }
        }
        if ((params.slot === 'bottom' || params.slot === 'top' || params.slot === 'shoes' || params.slot === 'socks') && !this._suppressHairRefit) {
            let need = false;
            for (const r of this._attachments.values()) if (r.bodyMeshId === bodyMeshId && (r.placement.waistAngle != null || r.params.type === 'chain')) { need = true; break; }
            if (need) this._rebuildAllCharms(bodyMeshId);
        }
        this.ctx.scheduleRender();
    }

    removeClothing(bodyMeshId: string, slot: ClothingSlot): void {
        const rig = this._clothingRigs.get(`${bodyMeshId}:${slot}`);
        if (!rig) return;
        const m = this.host.getMesh(rig.clothingMeshId);
        m?.parent?.removeChild(m);
        this._clothingRigs.delete(`${bodyMeshId}:${slot}`);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    serializeClothingRigs(): { bodyMeshId: string; slot: ClothingSlot; params: ClothingParams; renderStyle?: RenderStyle }[] {
        return [...this._clothingRigs.values()].map(r => {
            const rs = this.host.getMesh(r.clothingMeshId)?.material.renderStyle;
            return { bodyMeshId: r.bodyMeshId, slot: r.slot, params: r.params, ...(rs && rs !== 'default' ? { renderStyle: rs } : {}) };
        });
    }
    restoreClothingRigs(states: { bodyMeshId: string; slot: ClothingSlot; params: ClothingParams; renderStyle?: RenderStyle }[] | undefined): void {
        if (!states?.length) return;
        for (const st of states) {
            try {
                this.setClothingParams(st.bodyMeshId, st.params);
                if (st.renderStyle && st.renderStyle !== 'default') {
                    const id = this.getClothingMeshId(st.bodyMeshId, st.slot);
                    if (id) this.host.setRenderStyle(id, st.renderStyle);
                }
            } catch (e) { console.warn('[Clothing] restore failed', st.slot, e); }
        }
    }

    clothingRigKeyForMesh(meshId: string): string | null {
        for (const r of this._clothingRigs.values()) if (r.clothingMeshId === meshId) return `${r.bodyMeshId}:${r.slot}`;
        return null;
    }
    getClothingMeshId(bodyMeshId: string, slot: ClothingSlot): string | null {
        return this._clothingRigs.get(`${bodyMeshId}:${slot}`)?.clothingMeshId ?? null;
    }

    serializeHairRigs(): { bodyMeshId: string; params: HairParams; renderStyle?: RenderStyle }[] {
        return [...this._hairRigs.values()].map(r => {
            const rs = this.host.getMesh(r.hairMeshId)?.material.renderStyle;
            return { bodyMeshId: r.bodyMeshId, params: r.params, ...(rs && rs !== 'default' ? { renderStyle: rs } : {}) };
        });
    }
    restoreHairRigs(states: { bodyMeshId: string; params: HairParams; renderStyle?: RenderStyle }[] | undefined): void {
        if (!states?.length) return;
        for (const st of states) {
            try {
                this.setHairParams(st.bodyMeshId, st.params);
                if (st.renderStyle && st.renderStyle !== 'default') {
                    const id = this.getHairMeshId(st.bodyMeshId);
                    if (id) this.host.setRenderStyle(id, st.renderStyle);
                }
            } catch (e) { console.warn('[Hair] restore failed', e); }
        }
    }

    private _applyClothingColor(mesh: SkinnedMesh3D, params: ClothingParams, existing: RasterTextureManager | undefined, device: GPUDevice): RasterTextureManager | undefined {
        const base = hexToRgb01(params.baseColor);
        const hasTrim = params.trimWidth > 0.001 && !!params.trimColor && params.trimColor !== params.baseColor;
        if (!params.gradient && !hasTrim) {
            mesh.diffuseTexture = null; mesh.material.hasTexture = false;
            mesh.setDiffuseColor(base.r, base.g, base.b, 1);
            return undefined;
        }
        const mgr = existing ?? new RasterTextureManager(device);
        const W = 16, H = 128;
        const tex = mgr.ensureTexture(W, H);
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        const c2d = canvas.getContext('2d');
        if (c2d) {
            this._drawGarmentColorCanvas(c2d, W, H, params);
            device.queue.copyExternalImageToTexture({ source: canvas, flipY: false }, { texture: tex }, [W, H]);
            mesh.diffuseTexture = tex; mesh.material.hasTexture = true;
            mesh.setDiffuseColor(1, 1, 1, 1);
        }
        return mgr;
    }

    private _drawGarmentColorCanvas(c2d: CanvasRenderingContext2D, W: number, H: number, params: ClothingParams): void {
        if (params.gradient) {
            const grad = c2d.createLinearGradient(0, 0, 0, H);
            grad.addColorStop(0, params.baseColor);
            grad.addColorStop(Math.max(0, 1 - params.trimWidth), params.baseColor);
            grad.addColorStop(1, params.trimColor);
            c2d.fillStyle = grad; c2d.fillRect(0, 0, W, H);
        } else {
            c2d.fillStyle = params.baseColor; c2d.fillRect(0, 0, W, H);
            const hasTrim = params.trimWidth > 0.001 && !!params.trimColor && params.trimColor !== params.baseColor;
            if (hasTrim) {
                const bandPx = Math.max(1, Math.round(H * Math.min(0.45, params.trimWidth)));
                c2d.fillStyle = params.trimColor;
                c2d.fillRect(0, 0, W, bandPx);
                c2d.fillRect(0, H - bandPx, W, bandPx);
            }
        }
    }

    seedGarmentPaintTexture(meshId: string, mgr: RasterTextureManager): boolean {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return false;
        let params: ClothingParams | undefined;
        for (const r of this._clothingRigs.values()) if (r.clothingMeshId === meshId) { params = r.params; break; }
        if (!params) return false;
        const tex = mgr.getTexture();
        if (!tex) return false;
        const sz = mgr.getTextureSize();
        const W = Math.max(1, sz.w), H = Math.max(1, sz.h);
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        const c2d = canvas.getContext('2d');
        if (!c2d) return false;
        this._drawGarmentColorCanvas(c2d, W, H, params);
        device.queue.copyExternalImageToTexture({ source: canvas, flipY: false }, { texture: tex }, [W, H]);
        return true;
    }

    async retintGarmentPaint(mgr: RasterTextureManager, from: ClothingParams, to: ClothingParams): Promise<boolean> {
        const device = this.ctx.webgpuRenderer.getDevice();
        const tex = mgr.getTexture();
        if (!device || !tex) return false;
        const sz = mgr.getTextureSize();
        const W = Math.max(1, sz.w), H = Math.max(1, sz.h);
        let bmp: ImageBitmap;
        try {
            const blob = await mgr.exportToBlob('image/png');
            if (!blob || blob.size === 0) return false;
            bmp = await createImageBitmap(blob);
        } catch { return false; }
        const mkCtx = (): CanvasRenderingContext2D | null => {
            const c = document.createElement('canvas'); c.width = W; c.height = H; return c.getContext('2d');
        };
        const curC = mkCtx(), oldC = mkCtx(), newC = mkCtx();
        if (!curC || !oldC || !newC) { bmp.close?.(); return false; }
        curC.drawImage(bmp, 0, 0, W, H); bmp.close?.();
        this._drawGarmentColorCanvas(oldC, W, H, from);
        this._drawGarmentColorCanvas(newC, W, H, to);
        const cur = curC.getImageData(0, 0, W, H), old = oldC.getImageData(0, 0, W, H), nw = newC.getImageData(0, 0, W, H);
        const cd = cur.data, od = old.data, nd = nw.data;
        const EPS = 12;
        let changed = false;
        for (let i = 0; i < cd.length; i += 4) {
            if (Math.abs(cd[i] - od[i]) <= EPS && Math.abs(cd[i + 1] - od[i + 1]) <= EPS && Math.abs(cd[i + 2] - od[i + 2]) <= EPS) {
                cd[i] = nd[i]; cd[i + 1] = nd[i + 1]; cd[i + 2] = nd[i + 2];
                changed = true;
            }
        }
        if (!changed) return false;
        curC.putImageData(cur, 0, 0);
        device.queue.copyExternalImageToTexture({ source: curC.canvas, flipY: false }, { texture: tex }, [W, H]);
        this.ctx.scheduleRender();
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Attachments / charms
    // ═══════════════════════════════════════════════════════════════════════════

    attachmentTypeNames(): AttachmentType[] { return attachmentTypeNames(); }
    getDefaultAttachmentParams(type: AttachmentType): AttachmentParams { return defaultAttachmentParams(type); }
    getDefaultAttachmentPlacement(type: AttachmentType): AttachmentPlacement { return defaultAttachmentPlacement(type); }

    addAttachment(bodyMeshId: string, type: AttachmentType, placement?: AttachmentPlacement, params?: AttachmentParams): string | null {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return null;
        const id = 'charm_' + _nanoid();
        const rig: AttachmentRig = {
            id, bodyMeshId, attachmentMeshId: '',
            placement: placement ?? defaultAttachmentPlacement(type),
            params: params ?? defaultAttachmentParams(type),
        };
        this._attachments.set(id, rig);
        this._buildAttachment(id);
        if (!rig.attachmentMeshId) { this._attachments.delete(id); return null; }
        if (body.skeletonId) {
            if (body.skeleton?.data.springChains?.length) this._ensureBodyColliders(bodyMeshId);
            this.host.keepSpringsAlive(body.skeletonId);
        }
        return id;
    }

    setAttachmentParams(id: string, params: AttachmentParams): void {
        const rig = this._attachments.get(id); if (!rig) return;
        rig.params = params; this._rebuildAllCharms(rig.bodyMeshId);
    }
    setAttachmentPlacement(id: string, placement: AttachmentPlacement): void {
        const rig = this._attachments.get(id); if (!rig) return;
        rig.placement = placement; this._rebuildAllCharms(rig.bodyMeshId);
    }
    getAttachment(id: string): { id: string; type: AttachmentType; placement: AttachmentPlacement; params: AttachmentParams } | null {
        const r = this._attachments.get(id);
        return r ? { id, type: r.params.type, placement: r.placement, params: r.params } : null;
    }
    listAttachments(bodyMeshId: string): { id: string; type: AttachmentType; placement: AttachmentPlacement; params: AttachmentParams }[] {
        return [...this._attachments.values()].filter(r => r.bodyMeshId === bodyMeshId)
            .map(r => ({ id: r.id, type: r.params.type, placement: r.placement, params: r.params }));
    }
    removeAttachment(id: string): void {
        const rig = this._attachments.get(id); if (!rig) return;
        const bodyMeshId = rig.bodyMeshId;
        const m = this.host.getMesh(rig.attachmentMeshId); m?.parent?.removeChild(m);
        this._attachments.delete(id);
        this._rebuildAllCharms(bodyMeshId);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }
    getAttachmentMeshId(id: string): string | null { return this._attachments.get(id)?.attachmentMeshId || null; }

    private _waistbandLoopOffset(bodyMeshId: string, fit: BodyFit, ang: number): [number, number, number] {
        const hips = fit.joints['hips']; if (!hips) return [0, 0, 0];
        const hr = hips.radius ?? 0.1;
        const dx = Math.sin(ang), dz = Math.cos(ang);
        const bottomMeshId = this._clothingRigs.get(`${bodyMeshId}:bottom`)?.clothingMeshId;
        const bottomGeom = bottomMeshId ? this.host.getMesh(bottomMeshId)?.geometry ?? null : null;
        if (!bottomGeom) return [dx * hr * 1.02, hr * 0.45, dz * hr * 1.02];
        const v = bottomGeom.vertices, n = v.length / 12;
        let maxY = -Infinity; for (let j = 0; j < n; j++) if (v[j * 12 + 1] > maxY) maxY = v[j * 12 + 1];
        const waistY = maxY - hr * 0.06, yTol = hr * 0.4;
        let bestProj = -Infinity, bx = dx * hr * 1.02, bz = dz * hr * 1.02;
        for (let j = 0; j < n; j++) {
            if (Math.abs(v[j * 12 + 1] - waistY) > yTol) continue;
            const px = v[j * 12] - hips.pos[0], pz = v[j * 12 + 2] - hips.pos[2];
            const proj = px * dx + pz * dz;
            if (proj > bestProj) { bestProj = proj; bx = px; bz = pz; }
        }
        return [bx + dx * 0.004, waistY - hips.pos[1], bz + dz * 0.004];
    }

    addBeltLoops(bodyMeshId: string, count = 5, params?: AttachmentParams): string[] {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return [];
        const fit = this._buildBodyFit(body);
        if (!fit?.joints['hips']) return [];
        const ids: string[] = [];
        for (let i = 0; i < Math.max(1, count); i++) {
            const ang = (i / Math.max(1, count)) * Math.PI * 2;
            const offset = this._waistbandLoopOffset(bodyMeshId, fit, ang);
            const id = this.addAttachment(bodyMeshId, 'beltloop', { joint: 'hips', offset, scale: 1, waistAngle: ang }, params ? { ...params } : defaultAttachmentParams('beltloop'));
            if (id) ids.push(id);
        }
        return ids;
    }

    setCharacterSparkle(bodyMeshId: string, on: boolean, style: 'glint' | 'star' = 'glint'): void {
        const val: boolean | 'glint' | 'star' = on ? style : false;
        for (const r of this._attachments.values()) {
            if (r.bodyMeshId !== bodyMeshId || attachmentMaterial(r.params).metalness < 0.5) continue;
            r.params = { ...r.params, sparkle: val };
            const m = this.host.getMesh(r.attachmentMeshId);
            if (m) { m.material.sparkleEnabled = on && style === 'glint'; m.material.sparkleStar = on && style === 'star'; }
        }
        this.ctx.scheduleRender();
    }

    private _chainDrapeSurface(bodyMeshId: string): { verts: Float32Array } | undefined {
        const parts: Float32Array[] = [];
        for (const slot of ['bottom', 'top', 'shoes', 'socks'] as const) {
            const rig = this._clothingRigs.get(`${bodyMeshId}:${slot}`);
            const g = rig ? this.host.getMesh(rig.clothingMeshId)?.geometry : null;
            if (g?.vertices?.length) parts.push(g.vertices);
        }
        if (!parts.length) return undefined;
        if (parts.length === 1) return { verts: parts[0] };
        let total = 0; for (const p of parts) total += p.length;
        const verts = new Float32Array(total);
        let off = 0; for (const p of parts) { verts.set(p, off); off += p.length; }
        return { verts };
    }

    private _buildAttachment(id: string): void {
        const rig = this._attachments.get(id); if (!rig) return;
        const body = this.host.getMesh(rig.bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const fit = this._buildBodyFit(body); if (!fit) return;
        if (fit.head) fit.eyeY = this.eyeYForBody(rig.bodyMeshId, fit.head);
        if (rig.params.type === 'chain' || rig.params.type === 'pendant') fit.drapeSurface = this._chainDrapeSurface(rig.bodyMeshId);
        const skel = body.skeleton;
        const old = rig.attachmentMeshId ? this.host.getMesh(rig.attachmentMeshId) : null;
        old?.parent?.removeChild(old);
        const rederive = (r: AttachmentRig): void => {
            if (r.placement.waistAngle != null) r.placement = { ...r.placement, offset: this._waistbandLoopOffset(r.bodyMeshId, fit, r.placement.waistAngle) };
        };
        rederive(rig);
        let placement = rig.placement, params = rig.params;
        if (params.type === 'chain' && (params.fromLoop || params.toLoop)) {
            const from = params.fromLoop ? this._attachments.get(params.fromLoop) : undefined;
            const to   = params.toLoop   ? this._attachments.get(params.toLoop)   : undefined;
            if (from) { rederive(from); placement = { ...placement, joint: from.placement.joint, offset: from.placement.offset }; }
            if (to)   { rederive(to);   params = { ...params, chainMode: 'swag', endJoint: to.placement.joint, endOffset: to.placement.offset }; }
        }
        const result = generateAttachment(fit, placement, params);
        if (!result) { rig.attachmentMeshId = ''; return; }
        const anchorIdx = skel.data.joints.findIndex(j => j.name === placement.joint);
        if (anchorIdx < 0) { rig.attachmentMeshId = ''; return; }

        const bindIdx = (result.bindJoints ?? []).map(name => { const i = skel.data.joints.findIndex(j => j.name === name); return i >= 0 ? i : anchorIdx; });
        const dangleIdx: number[] = [];
        if (result.dangleBones.length) {
            const anchorRest = mat4.invert(mat4.create(), skel.data.joints[anchorIdx].inverseBindMatrix as unknown as mat4);
            const Ra = mat4.getRotation(quat.create(), anchorRest);
            const RaInv = quat.invert(quat.create(), Ra);
            let parentIdx = anchorIdx;
            let prev = vec3.fromValues(anchorRest[12], anchorRest[13], anchorRest[14]);
            for (let b = 0; b < result.dangleBones.length; b++) {
                const Pi = vec3.fromValues(result.dangleBones[b][0], result.dangleBones[b][1], result.dangleBones[b][2]);
                const localPos = vec3.transformQuat(vec3.create(), vec3.subtract(vec3.create(), Pi, prev), RaInv);
                const jIdx = skel.addJoint(parentIdx, [localPos[0], localPos[1], localPos[2]], `springCharm_${id}_${b}`);
                mat4.invert(skel.data.joints[jIdx].inverseBindMatrix as unknown as mat4, mat4.fromRotationTranslation(mat4.create(), Ra, Pi));
                dangleIdx.push(jIdx); parentIdx = jIdx; prev = Pi;
            }
            const db = result.dangleBones;
            if (db.length >= 2) {
                const wDir = vec3.subtract(vec3.create(),
                    vec3.fromValues(db[db.length - 1][0], db[db.length - 1][1], db[db.length - 1][2]),
                    vec3.fromValues(db[db.length - 2][0], db[db.length - 2][1], db[db.length - 2][2]));
                const lDir = vec3.transformQuat(vec3.create(), wDir, RaInv);
                const tip = skel.data.joints[dangleIdx[dangleIdx.length - 1]];
                tip.tailOffset = [lDir[0], lDir[1], lDir[2]];
            }
            skel.computeWorldMatrices();
            const sp = result.springParams ?? { stiffness: 0.5, drag: 0.6, gravity: 0.005, hitRadius: 0.015 };
            (skel.data.springChains ??= []).push({
                id: 'sc_' + id, jointIndices: dangleIdx,
                stiffness: sp.stiffness, drag: sp.drag, gravity: sp.gravity, gravityDir: [0, -1, 0], hitRadius: sp.hitRadius, enabled: true,
            });
        }
        const local2skel = [anchorIdx, ...bindIdx, ...dangleIdx];
        const ji = result.jointIndices;
        for (let i = 0; i < ji.length; i++) ji[i] = local2skel[ji[i]] ?? anchorIdx;

        const mesh = new SkinnedMesh3D(this.ctx.interactionService, body.x, body.y, body.z, { primitive: 'custom', geometry: result.geometry });
        mesh.name = rig.params.type.charAt(0).toUpperCase() + rig.params.type.slice(1);
        mesh.isAttachment = true; mesh.visible = true; mesh.transformViaSkeleton = true;
        mesh.skeletonId = body.skeletonId; mesh.skeleton = body.skeleton;
        mesh.jointIndices = ji; mesh.jointWeights = result.jointWeights; mesh.skinDirty = true;
        mesh.material.doubleSided = true;
        const col = hexToRgb01(rig.params.color); mesh.setDiffuseColor(col.r, col.g, col.b, 1);
        const mat = attachmentMaterial(rig.params);
        mesh.material.metalness = mat.metalness; mesh.material.roughness = mat.roughness;
        const spk = rig.params.sparkle;
        mesh.material.sparkleEnabled = spk === true || spk === 'glint';
        mesh.material.sparkleStar = spk === 'star';
        mesh.gpuDirty = true;
        this.ctx.sceneGraph.root.addChild(mesh);
        rig.attachmentMeshId = mesh.id;
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    private _rebuildAllCharms(bodyMeshId: string): void {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const skel = body.skeleton;
        const base = skel.data.joints.findIndex(j => j.name.startsWith('springCharm_'));
        if (base >= 0) {
            skel.truncateJoints(base);
            skel.data.springChains = (skel.data.springChains ?? []).filter(c => c.jointIndices.every(i => i < base));
            resetSpringState(skel);
        }
        for (const r of this._attachments.values()) if (r.bodyMeshId === bodyMeshId) this._buildAttachment(r.id);
        if (skel.data.springChains?.length) this._ensureBodyColliders(bodyMeshId);
        this.host.keepSpringsAlive(skel.id);
    }

    serializeAttachments(): { id: string; bodyMeshId: string; placement: AttachmentPlacement; params: AttachmentParams }[] {
        return [...this._attachments.values()].map(r => ({ id: r.id, bodyMeshId: r.bodyMeshId, placement: r.placement, params: r.params }));
    }
    restoreAttachments(states: { id: string; bodyMeshId: string; placement: AttachmentPlacement; params: AttachmentParams }[] | undefined): void {
        if (!states?.length) return;
        for (const st of states) {
            const rig: AttachmentRig = { id: st.id, bodyMeshId: st.bodyMeshId, attachmentMeshId: '', placement: st.placement, params: st.params };
            this._attachments.set(st.id, rig);
            try { this._buildAttachment(st.id); } catch (e) { console.warn('[Charm] restore failed', st.id, e); }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Spring colliders + body fit
    // ═══════════════════════════════════════════════════════════════════════════

    private _garmentRadiusAt(geom: { vertices: Float32Array }, center: readonly number[], axis: readonly number[], slabHalf: number): number | null {
        const v = geom.vertices, n = v.length / 12, rs: number[] = [];
        for (let i = 0; i < n; i++) {
            const px = v[i * 12] - center[0], py = v[i * 12 + 1] - center[1], pz = v[i * 12 + 2] - center[2];
            const t = px * axis[0] + py * axis[1] + pz * axis[2];
            if (Math.abs(t) > slabHalf) continue;
            rs.push(Math.hypot(px - t * axis[0], py - t * axis[1], pz - t * axis[2]));
        }
        if (rs.length < 4) return null;
        rs.sort((a, b) => a - b);
        return rs[Math.floor(rs.length * 0.7)];
    }
    private _garmentHalfDepthAt(geom: { vertices: Float32Array }, center: readonly number[], half: number): number | null {
        const v = geom.vertices, n = v.length / 12; let maxAbsZ = 0, cnt = 0;
        for (let i = 0; i < n; i++) {
            const px = v[i * 12] - center[0], py = v[i * 12 + 1] - center[1], pz = v[i * 12 + 2] - center[2];
            if (Math.abs(py) > half || Math.abs(px) > half) continue;
            const az = Math.abs(pz); if (az > maxAbsZ) maxAbsZ = az; cnt++;
        }
        return cnt >= 4 ? maxAbsZ : null;
    }

    private _ensureBodyColliders(bodyMeshId: string, frontDrape?: number): void {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const skel = body.skeleton;
        const fit = this._buildBodyFit(body); if (!fit) return;
        const cols: SpringCollider[] = [];
        const drape = frontDrape ?? (this._hairRigs.get(bodyMeshId)?.params.frontDrape ?? 0);
        const bottomMeshId = this._clothingRigs.get(`${bodyMeshId}:bottom`)?.clothingMeshId;
        const bottomGeom = bottomMeshId ? this.host.getMesh(bottomMeshId)?.geometry ?? null : null;
        const topMeshId = this._clothingRigs.get(`${bodyMeshId}:top`)?.clothingMeshId
                       ?? this._clothingRigs.get(`${bodyMeshId}:undershirt`)?.clothingMeshId;
        const topGeom = topMeshId ? this.host.getMesh(topMeshId)?.geometry ?? null : null;
        const BUF = 0.006;

        const sphere = (name: string, scale: number, skinMargin: number, garmentGeom: typeof bottomGeom): void => {
            const j = fit.joints[name]; if (!j) return;
            let r = j.radius * scale + skinMargin;
            if (garmentGeom) { const gr = this._garmentRadiusAt(garmentGeom, j.pos, [0, 1, 0], j.radius * 0.6); if (gr) r = Math.max(r, gr + BUF); }
            cols.push({ jointIdx: j.idx, offset: [0, 0, 0], radius: Math.max(0.01, r) });
        };
        sphere('head',  1.04, 0.004, null);
        {
            const jc = fit.joints['chest'];
            if (jc) {
                let r = jc.radius * 0.72 + 0.012;
                if (topGeom) { const d = this._garmentHalfDepthAt(topGeom, jc.pos, jc.radius * 0.6); if (d) r = d + BUF; }
                cols.push({ jointIdx: jc.idx, offset: [0, 0, 0], radius: Math.max(0.02, r) });
            }
        }
        {
            const jb = fit.joints['lowerback'] ?? fit.joints['spine'];
            const bgeom = body.geometry;
            if (jb) {
                let r = jb.radius * 0.72 + 0.012;
                if (bgeom) { const d = this._garmentHalfDepthAt(bgeom, jb.pos, jb.radius * 0.6); if (d) r = d + BUF; }
                cols.push({ jointIdx: jb.idx, offset: [0, 0, 0], radius: Math.max(0.02, r) });
            }
        }
        if (drape > 0) { sphere('shoulder_L', 0.85, 0.006, null); sphere('shoulder_R', 0.85, 0.006, null); }

        const hipsCap = fit.joints['hips'], upLc = fit.joints['upperleg_L'], upRc = fit.joints['upperleg_R'];
        if (hipsCap) {
            const hrad = hipsCap.radius ?? 0.1;
            let topY = hipsCap.pos[1] + hrad * 0.5;
            const botY = (upLc && upRc) ? (upLc.pos[1] + upRc.pos[1]) / 2 : hipsCap.pos[1] - hrad * 0.8;
            let r = hrad + 0.012;
            if (bottomGeom) {
                const v = bottomGeom.vertices, n = v.length / 12, ds: number[] = [];
                let maxY = -Infinity; for (let i = 0; i < n; i++) if (v[i * 12 + 1] > maxY) maxY = v[i * 12 + 1];
                topY = maxY - hrad * 0.08;
                for (let i = 0; i < n; i++) {
                    const px = v[i * 12], py = v[i * 12 + 1], pz = v[i * 12 + 2];
                    if (py < botY || py > topY + 0.02) continue;
                    if (pz < hipsCap.pos[2] - 0.01) continue;
                    ds.push(Math.hypot(px - hipsCap.pos[0], pz - hipsCap.pos[2]));
                }
                if (ds.length > 3) { ds.sort((a, b) => a - b); r = Math.max(r, ds[Math.floor(ds.length * 0.9)] + BUF); }
            }
            const ibH = skel.data.joints[hipsCap.idx].inverseBindMatrix as unknown as mat4;
            const top = vec3.transformMat4(vec3.create(), vec3.fromValues(hipsCap.pos[0], topY, hipsCap.pos[2]), ibH);
            const bot = vec3.transformMat4(vec3.create(), vec3.fromValues(hipsCap.pos[0], botY, hipsCap.pos[2]), ibH);
            cols.push({ jointIdx: hipsCap.idx, offset: [top[0], top[1], top[2]], radius: Math.max(0.01, r), tail: [bot[0], bot[1], bot[2]] });
        }

        let legRmax = 0;
        for (const s of ['L', 'R'] as const) {
            const up = fit.joints['upperleg_' + s], lo = fit.joints['lowerleg_' + s];
            if (!up || !lo) continue;
            const seg = [lo.pos[0] - up.pos[0], lo.pos[1] - up.pos[1], lo.pos[2] - up.pos[2]];
            const segLen = Math.hypot(seg[0], seg[1], seg[2]) || 0.1;
            const axis = [seg[0] / segLen, seg[1] / segLen, seg[2] / segLen];
            const mid = [(up.pos[0] + lo.pos[0]) / 2, (up.pos[1] + lo.pos[1]) / 2, (up.pos[2] + lo.pos[2]) / 2];
            let r = up.radius + 0.012;
            if (bottomGeom) { const gr = this._garmentRadiusAt(bottomGeom, mid, axis, segLen * 0.35); if (gr) r = Math.max(r, gr + BUF); }
            legRmax = Math.max(legRmax, r);
            const ib = skel.data.joints[up.idx].inverseBindMatrix as unknown as mat4;
            const t = vec3.transformMat4(vec3.create(), vec3.fromValues(lo.pos[0], lo.pos[1], lo.pos[2]), ib);
            cols.push({ jointIdx: up.idx, offset: [0, 0, 0], radius: r, tail: [t[0], t[1], t[2]] });
        }

        const upL = fit.joints['upperleg_L'], upR = fit.joints['upperleg_R'], hipsJ = fit.joints['hips'];
        if (upL && upR && hipsJ) {
            const cx = (upL.pos[0] + upR.pos[0]) / 2, cy = (upL.pos[1] + upR.pos[1]) / 2, cz = (upL.pos[2] + upR.pos[2]) / 2;
            let r = Math.max(legRmax, Math.max(upL.radius, upR.radius));
            if (bottomGeom) {
                const v = bottomGeom.vertices, n = v.length / 12, fwd: number[] = [];
                for (let i = 0; i < n; i++) {
                    const px = v[i * 12], py = v[i * 12 + 1], pz = v[i * 12 + 2];
                    if (Math.abs(py - cy) > 0.05 || Math.abs(px - cx) > 0.06) continue;
                    if (pz - cz > 0) fwd.push(pz - cz);
                }
                if (fwd.length > 2) { fwd.sort((a, b) => a - b); r = Math.max(r, fwd[Math.floor(fwd.length * 0.8)] + BUF); }
            }
            const ibH = skel.data.joints[hipsJ.idx].inverseBindMatrix as unknown as mat4;
            const off = vec3.transformMat4(vec3.create(), vec3.fromValues(cx, cy, cz), ibH);
            cols.push({ jointIdx: hipsJ.idx, offset: [off[0], off[1], off[2]], radius: r });
        }
        skel.data.springColliders = cols;
    }

    private _buildBodyFit(body: SkinnedMesh3D): BodyFit | null {
        const skel = body.skeleton, g = body.geometry, ji = body.jointIndices, jw = body.jointWeights;
        if (!skel || !g || !ji || !jw) return null;
        const idxPos = new Map<number, [number, number, number]>();
        const byName = new Map<string, number>();
        const inv = mat4.create();
        for (const j of skel.data.joints) {
            mat4.invert(inv, j.inverseBindMatrix as unknown as mat4);
            idxPos.set(j.index, [inv[12], inv[13], inv[14]]);
            byName.set(j.name, j.index);
        }
        const dirByIdx = new Map<number, [number, number, number]>();
        for (const j of skel.data.joints) {
            const me = idxPos.get(j.index)!;
            const par = j.parentIndex >= 0 ? idxPos.get(j.parentIndex) : null;
            let d: [number, number, number] = par ? [me[0]-par[0], me[1]-par[1], me[2]-par[2]] : [0, 1, 0];
            const l = Math.hypot(d[0], d[1], d[2]) || 1; d = [d[0]/l, d[1]/l, d[2]/l];
            dirByIdx.set(j.index, d);
        }
        const dists = new Map<number, number[]>();
        const sectorMax = new Map<number, number[]>();
        const armNames = ['shoulder_L', 'shoulder_R', 'lowerarm_L', 'lowerarm_R', 'hand_L', 'hand_R'];
        const armJointIdx = new Set<number>();
        for (const nm of armNames) { const ix = byName.get(nm); if (ix !== undefined) armJointIdx.add(ix); }
        const armBuckets = new Map<number, number[]>();
        const headIdx = byName.get('head');
        let hMnX = Infinity, hMnY = Infinity, hMnZ = Infinity, hMxX = -Infinity, hMxY = -Infinity, hMxZ = -Infinity;
        const n = g.vertices.length / 12;
        for (let i = 0; i < n; i++) {
            const px = g.vertices[i*12], py = g.vertices[i*12+1], pz = g.vertices[i*12+2];
            let domK = 0, domW = -1;
            for (let k = 0; k < 4; k++) { const wv = jw[i*4+k]; if (wv > domW) { domW = wv; domK = k; } }
            if (headIdx !== undefined && ji[i*4+domK] === headIdx && domW >= 0.5) {
                if (px<hMnX)hMnX=px; if(py<hMnY)hMnY=py; if(pz<hMnZ)hMnZ=pz;
                if (px>hMxX)hMxX=px; if(py>hMxY)hMxY=py; if(pz>hMxZ)hMxZ=pz;
            }
            for (let k = 0; k < 4; k++) {
                if (jw[i*4+k] < 0.4) continue;
                const jIdx = ji[i*4+k], jp = idxPos.get(jIdx), d = dirByIdx.get(jIdx);
                if (!jp || !d) continue;
                const rx = px-jp[0], ry = py-jp[1], rz = pz-jp[2];
                const along = rx*d[0] + ry*d[1] + rz*d[2];
                const perp = Math.hypot(rx - d[0]*along, ry - d[1]*along, rz - d[2]*along);
                let arr = dists.get(jIdx); if (!arr) { arr = []; dists.set(jIdx, arr); } arr.push(perp);
                const oxz = Math.hypot(rx, rz);
                if (oxz > 1e-5) {
                    let sm = sectorMax.get(jIdx); if (!sm) { sm = new Array(GARMENT_RING).fill(0); sectorMax.set(jIdx, sm); }
                    const sec = ((Math.round(Math.atan2(rz, rx) / (2*Math.PI) * GARMENT_RING) % GARMENT_RING) + GARMENT_RING) % GARMENT_RING;
                    if (oxz > sm[sec]) sm[sec] = oxz;
                }
                if (k === domK && armJointIdx.has(jIdx)) {
                    let ab = armBuckets.get(jIdx); if (!ab) { ab = []; armBuckets.set(jIdx, ab); } ab.push(perp);
                }
            }
        }
        const pct = (arr: number[] | undefined, q: number, fallback: number): number => {
            if (!arr || !arr.length) return fallback;
            arr.sort((a, b) => a - b);
            return arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] || fallback;
        };
        const radiusOf = (idx: number): number => pct(dists.get(idx), 0.9, 0.05);
        const OCT = 1 / Math.cos(Math.PI / GARMENT_RING);
        const dirRadiiOf = (idx: number): number[] => {
            const sm = sectorMax.get(idx), scalar = radiusOf(idx);
            const out = new Array<number>(GARMENT_RING);
            for (let k = 0; k < GARMENT_RING; k++) out[k] = ((sm && sm[k] > 0) ? sm[k] : scalar) * OCT;
            return out;
        };
        const joints: Record<string, JointFit | undefined> = {};
        for (const [name, idx] of byName) joints[name] = { idx, pos: idxPos.get(idx)!, radius: radiusOf(idx), radii: dirRadiiOf(idx) };
        const arms: { L?: ArmFit; R?: ArmFit } = {};
        for (const s of ['L', 'R'] as const) {
            const shI = byName.get('shoulder_' + s), loI = byName.get('lowerarm_' + s), haI = byName.get('hand_' + s);
            if (shI === undefined || loI === undefined) continue;
            const elbow = radiusOf(loI);
            arms[s] = {
                capR:   pct(armBuckets.get(shI), 0.70, elbow * 1.2),
                elbowR: pct(armBuckets.get(loI), 0.70, elbow),
                wristR: elbow * 0.72,
            };
        }
        let armSurface = this._bodyArmSurface.get(body.id);
        let legSurface = this._bodyLegSurface.get(body.id);
        let torsoSurface = this._bodyTorsoSurface.get(body.id);
        if (!armSurface || !legSurface || !torsoSurface) {
            const bp = this._bodyParams.get(body.id);
            if (bp) {
                const r = generateBodyResult(bp);
                armSurface = r.armSurface; this._bodyArmSurface.set(body.id, armSurface);
                legSurface = r.legSurface; this._bodyLegSurface.set(body.id, legSurface);
                torsoSurface = r.torsoSurface; this._bodyTorsoSurface.set(body.id, torsoSurface);
            }
        }
        const head = hMxY > hMnY ? {
            cx: (hMnX + hMxX) / 2, cy: (hMnY + hMxY) / 2, cz: (hMnZ + hMxZ) / 2,
            rx: (hMxX - hMnX) / 2, ry: (hMxY - hMnY) / 2, rz: (hMxZ - hMnZ) / 2,
        } : undefined;
        return { joints, arms, body: { verts: g.vertices, ji, jw, gridCache: new Map() }, armSurface, legSurface, torsoSurface, head };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Overlay refit + body registration (called by the manager's body orchestration)
    // ═══════════════════════════════════════════════════════════════════════════

    /** Re-fit a character's overlays (garments, hair, charms, face decal) after the body shape changed. */
    refitOverlays(bodyMeshId: string): void {
        this._suppressHairRefit = true;
        const bodyForFit = this.host.getMesh(bodyMeshId);
        if (bodyForFit instanceof SkinnedMesh3D) {
            const fit = this._buildBodyFit(bodyForFit);
            if (fit) this._sharedBodyFit = { bodyMeshId, fit };
        }
        try {
            for (const slot of ['top', 'bottom', 'shoes', 'socks', 'undershirt', 'underpants'] as const) {
                const cr = this._clothingRigs.get(`${bodyMeshId}:${slot}`);
                if (cr) { try { this.setClothingParams(bodyMeshId, cr.params); } catch (e) { console.warn('[Body] clothing re-fit failed', slot, e); } }
            }
        } finally {
            this._sharedBodyFit = null;
            this._suppressHairRefit = false;
        }
        const hr = this._hairRigs.get(bodyMeshId);
        if (hr) { try { this.setHairParams(bodyMeshId, hr.params); } catch (e) { console.warn('[Body] hair re-fit failed', e); } }
        if (!hr && this._attachments.size) { try { this._rebuildAllCharms(bodyMeshId); } catch (e) { console.warn('[Body] charm re-fit failed', e); } }
        this.refitFaceAfterBodyRegen(bodyMeshId);
    }

    /** Public body-fit + chain-drape surface — the manager's attachment-PREVIEW path (which builds a throwaway
     *  charm mesh) reuses these so its fit matches the committed one. */
    buildBodyFit(body: SkinnedMesh3D): BodyFit | null { return this._buildBodyFit(body); }
    chainDrapeSurface(bodyMeshId: string): { verts: Float32Array } | undefined { return this._chainDrapeSurface(bodyMeshId); }

    /** The manager registers a body's params + generator surfaces here (on create / setBodyParams regen). */
    registerBody(bodyMeshId: string, params: import('./body-generator').BodyParams, armSurface: ArmSurface, legSurface: ArmSurface, torsoSurface: ArmRing[]): void {
        this._bodyParams.set(bodyMeshId, params);
        this._bodyArmSurface.set(bodyMeshId, armSurface);
        this._bodyLegSurface.set(bodyMeshId, legSurface);
        this._bodyTorsoSurface.set(bodyMeshId, torsoSurface);
    }
    getBodyParams(bodyMeshId: string): import('./body-generator').BodyParams | null { return this._bodyParams.get(bodyMeshId) ?? null; }
    serializeBodyParams(): { bodyMeshId: string; params: import('./body-generator').BodyParams }[] {
        return [...this._bodyParams.entries()].map(([bodyMeshId, params]) => ({ bodyMeshId, params }));
    }
    restoreBodyParams(states: { bodyMeshId: string; params: import('./body-generator').BodyParams }[] | undefined): void {
        if (!states?.length) return;
        for (const st of states) this._bodyParams.set(st.bodyMeshId, st.params);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Shared part-color revert + cross-subsystem queries (picking / undo)
    // ═══════════════════════════════════════════════════════════════════════════

    /** Re-apply a part's generated look after a user texture override is cleared. Handles garments, hair, eyes,
     *  and the body (flat skin-tone). */
    reapplyPartColor(meshId: string): void {
        const device = this.ctx.webgpuRenderer.getDevice();
        const mesh = this.host.getMesh(meshId);
        if (!device || !mesh) return;
        for (const r of this._clothingRigs.values()) if (r.clothingMeshId === meshId) {
            if (mesh instanceof SkinnedMesh3D) r.gradient = this._applyClothingColor(mesh, r.params, r.gradient, device);
            mesh.gpuDirty = true; this.ctx.scheduleRender(); return;
        }
        for (const r of this._hairRigs.values()) if (r.hairMeshId === meshId) {
            const tex = this._renderHairGradient(r.gradient, r.params);
            if (tex) { mesh.diffuseTexture = tex; mesh.material.hasTexture = true; }
            else     { mesh.diffuseTexture = null; mesh.material.hasTexture = false; }
            mesh.gpuDirty = true; this.ctx.scheduleRender(); return;
        }
        if (this.reapplyFaceIfOwned(meshId)) return;
        mesh.diffuseTexture = null; mesh.material.hasTexture = false; mesh.gpuDirty = true;
        this.ctx.scheduleRender();
    }

    reapplyFaceIfOwned(meshId: string): boolean {
        for (const r of this._faceRigs.values()) if (r.decalMeshId === meshId) {
            this._applyTexture(r, r.activeId);
            this.ctx.scheduleRender();
            return true;
        }
        return false;
    }

    hasFace(bodyMeshId: string): boolean { return this._faceRigs.has(bodyMeshId); }

    /** True if `meshId` is a body that OWNS overlays (has a face/hair/clothing rig). */
    hasOverlayBody(meshId: string): boolean {
        return this._faceRigs.has(meshId) || this._hairRigs.has(meshId)
            || [...this._clothingRigs.values()].some(r => r.bodyMeshId === meshId);
    }

    /** If `meshId` is an overlay (eye decal / hair / garment / charm), the body it belongs to; else null. */
    overlayBodyOf(meshId: string): string | null {
        for (const r of this._faceRigs.values())     if (r.decalMeshId       === meshId) return r.bodyMeshId;
        for (const r of this._hairRigs.values())      if (r.hairMeshId        === meshId) return r.bodyMeshId;
        for (const r of this._clothingRigs.values())  if (r.clothingMeshId    === meshId) return r.bodyMeshId;
        for (const r of this._attachments.values())   if (r.attachmentMeshId  === meshId) return r.bodyMeshId;
        return null;
    }

    /** The overlay mesh ids of one character (eye decal + hair + garments) — for select-whole-character. */
    overlayMeshIds(bodyId: string): string[] {
        const ids: string[] = [];
        const eyes = this.getEyesMeshId(bodyId); if (eyes) ids.push(eyes);
        const hr = this._hairRigs.get(bodyId); if (hr) ids.push(hr.hairMeshId);
        for (const r of this._clothingRigs.values()) if (r.bodyMeshId === bodyId) ids.push(r.clothingMeshId);
        return ids;
    }
}
