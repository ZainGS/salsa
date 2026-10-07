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
import { noteRasterContentWrite } from '../../renderer/raster/raster-content-version';
import { EyeParams, renderEyes, defaultEyeParams, blinkParamsFor } from './eye-generator';
import {
    type FaceFeatureParams, type FaceLayout, type ExpressionShape, type ExpressionWeights, type FaceExpressionName,
    normalizeFaceFeatureParams, blendExpressionShapes, lerpExpressionShape, expressionWeights, dominantExpression,
    eyeLayoutFromParams, computeFringe, buildFaceOverlayGeometry, eyeDecalSurfaceZ, renderFaceLayer, faceLodBold,
} from './face-features';
import type { FaceExpression, FaceBlinkConfig, FaceRigState } from './scene3d-manager';
import { HairParams, generateHair, DEFAULT_HAIR_PARAMS, HeadFrame, TAIL_BONES, DRAPE_SPRING_FROM } from './hair-generator';
import { skirtSteerSignal, steerSkirtWeights, SkirtFollow, type SkirtSteer } from './skirt-steer';
import { buildHemSwing, applyHemSwing, resetHemSwing, hipsSwingFrame, HemSwing, type HemSwingData } from './skirt-swing';
import { createHideMaskJob, maskedIndices, type MaskSkinned } from './body-hide-mask';
import { layerOver, LAYER_OVER, limbSidesFromNames, LAYER_GAP, type LayerGarment } from './garment-layers';
import {
    ClothingParams, TopParams, BottomParams, ShoeParams, BodyFit, JointFit, ArmFit,
    generateTop, generateBottom, generateShoe, generateSock, generateUndershirt, generateUnderpants,
    defaultTopParams, defaultBottomParams, defaultShoeParams, defaultSockParams, defaultUndershirtParams, defaultUnderpantsParams,
    clothingPresetNames, clothingPreset, normSleeveLength, RING as GARMENT_RING,
} from './clothing-generator';
import { generateBodyResult, type ArmSurface, type ArmRing } from './body-generator';
import { headRegionBBoxOf, buildBodyFitFrom } from './body-fit';
import type { HairResult } from './hair-generator';
import {
    generateGarment, normalizeGarmentParams, hairCollisionVerts, headFrameFromBBox, HAIR_COLLISION_SLOT_ORDER,
    type GarmentGenResult, type CharacterParts,
} from './character-parts';
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
    /** Face kit runtime (face-features.ts) — present while `features` is set. Never serialized. */
    feat?: FaceKitRuntime;
}
type Timer = ReturnType<typeof setTimeout> | null;
/** The face kit's per-character runtime: the two overlay meshes + their textures, the cached layout, and the current
 *  expression (weights = the target, shape = what is drawn, extra = an additive brow pulse). */
interface FaceKitRuntime {
    skinMeshId: string | null; browMeshId: string | null;
    skinTex: RasterTextureManager | null; browTex: RasterTextureManager | null;
    canvases: { skin?: HTMLCanvasElement; brow?: HTMLCanvasElement; small?: HTMLCanvasElement };
    layout: FaceLayout | null;
    weights: ExpressionWeights; shape: ExpressionShape; extra: Partial<ExpressionShape>;
    anim: Timer; hold: Timer; pulse: Timer; life: Timer;
    /** True while a held expression (holdMs / an idle smile) is up — the idle smile waits. */
    holding: boolean;
    /** Distance LOD line-weight multiplier (face-features.faceLodBold) + the body, held to skip a scene walk per frame. */
    bold: number;
    body: SkinnedMesh3D | null;
}
/** Eye decal grid size (Scene3DCharacter._buildFaceDecal) — the face kit reads its surface. */
const EYE_DECAL_NC = 9, EYE_DECAL_NR = 5;
const DEFAULT_BLINK: FaceBlinkConfig = { mode: 'random', minSec: 2.5, maxSec: 6.0, holdMs: 110, enabled: true, doubleProbability: 0.15, doubleGapMinMs: 150, doubleGapMaxMs: 320 };

interface HairRig { bodyMeshId: string; hairMeshId: string; params: HairParams; gradient: RasterTextureManager; }
interface ClothingRig {
    bodyMeshId: string; slot: ClothingSlot; clothingMeshId: string; params: ClothingParams; gradient?: RasterTextureManager;
    /** RUNTIME-ONLY skirt steering (R6.3, skirt-steer.ts): the steer data + the exact weight arrays it was built for
     *  (never steer a mesh whose skin arrays were replaced) + the last signal written. Rebuilt with the garment. */
    steer?: { data: SkirtSteer; ji: Uint8Array; jw: Float32Array; last: number; mesh?: Mesh3D; follow?: SkirtFollow };
    /** RUNTIME-ONLY (fit round 2): the garment as generated, before layering over the garments under it. */
    raw?: GarmentGenResult;
    /** RUNTIME-ONLY skirt hem swing (skirt-swing.ts): data + spring state + the hips bind position + whether the live
     *  vertices are currently displaced. Rebuilt with the garment. */
    swing?: { data: HemSwingData; state: HemSwing; hipsBind: [number, number, number]; displaced: boolean };
}
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
    /** True while Play runs — skirts get their follow-through then (item 13). Optional (absent = never). */
    isPlaying?(): boolean;
}

/** The specular a non-matte skin / garment has (DEFAULT_MATERIAL's), restored when matte is turned off. */
const GLOSSY_SPECULAR = { r: 0.3, g: 0.3, b: 0.3, a: 1 };
/** MATTE (Material3D.matte on the body; visual-polish item 10): a skin / garment mesh with no specular — so Cel's
 *  hard highlight dot and Cel-HD's smooth gloss streak are gone (PBR keeps its roughness, which drives it there).
 *  Off = the classic specular back, exactly. Marks the mesh for the instance re-pack. */
export function applyMatte(mesh: Mesh3D, on: boolean): void {
    mesh.material.specular = on ? { r: 0, g: 0, b: 0, a: 1 } : { ...GLOSSY_SPECULAR };
    mesh.materialDirty = true; mesh.gpuDirty = true; mesh.stateDirty = true;
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
    /** Worker-PRECOMPUTED overlay geometry (performance-plan P3.2d — primeGeneratedParts): consumed ONCE by the next
     *  setClothingParams / setHairParams whose inputs match exactly (params JSON + the body's vertex buffer identity
     *  + shoes / garment params); anything else falls back to generating synchronously, so it can never change output. */
    private _primed = new Map<string, { verts: Float32Array; garments: Map<string, { sig: string; result: GarmentGenResult }>; hair: { sig: string; result: HairResult } | null }>();
    /** RUNTIME-ONLY bodies (the Play auto default player, play-auto-player.ts): their rigs work normally (face blink,
     *  hair springs, garment fits) but every serialize* / texture export skips them, and a document load keeps them
     *  (the cached character outlives documents). Keyed by body mesh id. */
    private _runtimeBodies = new Set<string>();

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
        return headRegionBBoxOf(g.vertices, body.jointIndices!, body.jointWeights!, headIdx);   // pure (body-fit.ts) — the worker uses the same
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
            noteRasterContentWrite(tex);   // incremental autosave: this painted texture changed
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
        this._syncProceduralBlink(rig);   // the blink frame = THIS state's eyes, closed
        this._applyTexture(rig, exprId);
        this._faceKitEyesChanged(rig);    // brows follow this state's eyes
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
        this._syncProceduralBlink(rig);
        this._restartBlink(rig);
    }

    setFaceBlinkConfig(bodyMeshId: string, cfg: Partial<FaceBlinkConfig>): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return;
        rig.blink = { ...rig.blink, ...cfg };
        this._syncProceduralBlink(rig);
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
                this.setFaceExpressionProcedural(bodyMeshId, id, blinkParamsFor(base)!);   // a deep copy, closed
                this.setFaceBlinkExpression(bodyMeshId, id);
                return;
            }
        }
        this._syncProceduralBlink(rig);
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
        noteRasterContentWrite(tex);   // incremental autosave: this painted texture changed
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
        if (exprId === rig.activeId) { this._syncProceduralBlink(rig); this._faceKitEyesChanged(rig); }   // open eyes edited → blink frame + brows follow
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

    /** The current gaze of a body's eyes (the active expression's), or null (no procedural eyes). */
    getFaceGaze(bodyMeshId: string): [number, number] | null {
        const rig = this._faceRigs.get(bodyMeshId);
        const ep = rig?.expressions.find(e => e.id === rig.activeId)?.eyeParams;
        return ep ? [ep.gazeX ?? 0, ep.gazeY ?? 0] : null;
    }
    /** Blink NOW (a clip face event) — the auto-blink timer restarts after it. No-op without a blink expression. */
    blinkNow(bodyMeshId: string): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig?.blinkId || !rig.textures.has(rig.blinkId)) return;
        this._cancelBlink(rig);
        this._fireBlink(rig);
        this.ctx.scheduleRender();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Face kit — brows / mouth / nose / blush / hair shadow (face-features.ts)
    // ═══════════════════════════════════════════════════════════════════════════

    /** Patch (or first enable) a face's kit params. Grows the face rig if needed. Live: re-renders the overlays. */
    setFaceFeatures(bodyMeshId: string, patch: Partial<FaceFeatureParams>): boolean {
        const rig = this._ensureRig(bodyMeshId);
        if (!rig) return false;
        const prev = rig.features;
        const next = normalizeFaceFeatureParams({ ...(prev ?? {}), ...patch });
        rig.features = next;
        const restExprChanged = !prev || prev.expression !== next.expression;
        if (!next.enabled) { this._teardownFaceKit(rig); this._applyEyeShade(rig); this.ctx.scheduleRender(); return true; }
        if (!rig.feat) this._buildFaceKit(rig);
        const f = rig.feat;
        if (!f) return false;
        if (prev && (prev.browsThroughHair !== next.browsThroughHair || prev.eyesThroughHair !== next.eyesThroughHair || !prev.enabled)) f.layout = null;   // the pulls are part of the layout pass
        if (restExprChanged && !f.holding) { f.weights = expressionWeights(next.expression); f.shape = blendExpressionShapes(f.weights); }
        this._applyEyeShade(rig);
        this._restartFaceLife(rig);
        this._renderFaceKit(rig);
        return true;
    }

    /** A COPY of a face's kit params, or null (no face, or a face saved before the kit that was never turned on). */
    getFaceFeatures(bodyMeshId: string): FaceFeatureParams | null {
        const p = this._faceRigs.get(bodyMeshId)?.features;
        return p ? { ...p } : null;
    }

    /** Show an expression: a name ('neutral' | 'smile' | 'open' | 'frown' | 'surprised', or 'default' = the resting one)
     *  or a weight blend ({ smile: 0.6, open: 0.4 }). Blends over `blendMs` (default 180; 0 = snap). `weight` scales a
     *  named expression; `holdMs` returns to the resting expression after that long. False without a face kit. */
    setCharacterExpression(bodyMeshId: string, expr: FaceExpressionName | ExpressionWeights | 'default' | string, opts: { blendMs?: number; weight?: number; holdMs?: number } = {}): boolean {
        const rig = this._faceRigs.get(bodyMeshId);
        const f = rig?.feat;
        if (!rig || !f || !rig.features) return false;
        let w = expressionWeights(expr === 'default' ? rig.features.expression : expr);
        if (typeof opts.weight === 'number' && Number.isFinite(opts.weight)) {
            const k = Math.max(0, opts.weight);
            w = Object.fromEntries(Object.entries(w).map(([n, v]) => [n, (v ?? 0) * k])) as ExpressionWeights;
        }
        f.weights = w;
        if (f.hold) { clearTimeout(f.hold); f.hold = null; }
        f.holding = false;
        const blendMs = opts.blendMs ?? 180;
        this._animateFaceShape(rig, blendExpressionShapes(w), blendMs);
        if (opts.holdMs && opts.holdMs > 0) {
            f.holding = true;
            f.hold = setTimeout(() => { f.hold = null; f.holding = false; this.setCharacterExpression(bodyMeshId, 'default', { blendMs: Math.max(blendMs, 220) }); }, opts.holdMs);
        }
        return true;
    }

    /** The current expression: its weights and the dominant name, or null without a face kit. */
    getCharacterExpression(bodyMeshId: string): { name: FaceExpressionName; weights: ExpressionWeights } | null {
        const f = this._faceRigs.get(bodyMeshId)?.feat;
        return f ? { name: dominantExpression(f.weights), weights: { ...f.weights } } : null;
    }

    /** A quick brow raise (the "blink with a brow raise" life cue; also a clip face event). `amount` in brow-raise units. */
    pulseBrows(bodyMeshId: string, amount = 0.45, holdMs = 160): void {
        const rig = this._faceRigs.get(bodyMeshId);
        const f = rig?.feat;
        if (!rig || !f) return;
        if (f.pulse) clearTimeout(f.pulse);
        const up = 70, down = 280, t0 = performance.now();
        const step = () => {
            const t = performance.now() - t0;
            const k = t < up ? t / up : t < up + holdMs ? 1 : Math.max(0, 1 - (t - up - holdMs) / down);
            f.extra = { browRaise: amount * (k * k * (3 - 2 * k)) };
            this._renderFaceKit(rig);
            f.pulse = k > 0 || t < up ? setTimeout(step, 16) : null;
            if (!f.pulse) { f.extra = {}; this._renderFaceKit(rig); }
        };
        step();
    }

    /** The overlay mesh ids of a face kit (skin layer + brow layer). */
    getFaceKitMeshIds(bodyMeshId: string): string[] {
        const f = this._faceRigs.get(bodyMeshId)?.feat;
        return f ? [f.skinMeshId, f.browMeshId].filter((x): x is string => !!x) : [];
    }

    private _animateFaceShape(rig: FaceRig, to: ExpressionShape, ms: number): void {
        const f = rig.feat!;
        if (f.anim) { clearTimeout(f.anim); f.anim = null; }
        if (!(ms > 0)) { f.shape = to; this._renderFaceKit(rig); return; }
        const from = { ...f.shape }, t0 = performance.now();
        const step = () => {
            const t = Math.min(1, (performance.now() - t0) / ms), e = t * t * (3 - 2 * t);
            f.shape = lerpExpressionShape(from, to, e);
            this._renderFaceKit(rig);
            f.anim = t < 1 ? setTimeout(step, 16) : null;
        };
        step();
    }

    /** Head frame shared by the eye decal and the kit: centre, half width, eye-band centre + half height (rest space). */
    private _faceFrame(body: SkinnedMesh3D, headIdx: number) {
        const bb = this._headRegionBBox(body, headIdx);
        if (!bb) return null;
        const hX = bb.max[0] - bb.min[0], hY = bb.max[1] - bb.min[1], hZ = bb.max[2] - bb.min[2];
        const cx = (bb.min[0] + bb.max[0]) * 0.5, cz = (bb.min[2] + bb.max[2]) * 0.5;
        return { bb, hX, hY, hZ, cx, cz, hw: hX * 0.95 * 0.5, eyeCy: bb.min[1] + hY * 0.55, eyeHh: hY * 0.42 * 0.5 };
    }

    /** Build the two overlay meshes (skin layer + brow layer) by raycasting the head surface, in front of the eye decal. */
    private _buildFaceKit(rig: FaceRig): void {
        this._teardownFaceKit(rig);
        const body = this.host.getMesh(rig.bodyMeshId);
        const decal = this.host.getMesh(rig.decalMeshId);
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton || !body.geometry || !device) return;
        const fr = this._faceFrame(body, rig.headJointIdx);
        if (!fr) return;
        const { bb, hY, hZ, cx, hw } = fr;
        const eyeZ = decal?.geometry && decal.geometry.vertices.length === EYE_DECAL_NC * EYE_DECAL_NR * 12
            ? eyeDecalSurfaceZ(decal.geometry.vertices, EYE_DECAL_NC, EYE_DECAL_NR) : null;
        const margin = hZ * 0.012;
        const minZ = eyeZ ? (x: number, y: number) => eyeZ(x, y) + margin : undefined;
        const src = { vertices: body.geometry.vertices, indices: body.geometry.indices, jointIndices: body.jointIndices!, jointWeights: body.jointWeights! };
        const skinRect = { x0: cx - hw, x1: cx + hw, y0: bb.min[1], y1: bb.min[1] + hY * 0.86 };
        const browRect = { x0: cx - hw * 0.94, x1: cx + hw * 0.94, y0: bb.min[1] + hY * 0.44, y1: bb.min[1] + hY * 0.80 };
        const mk = (name: string, rect: typeof skinRect, cols: number, rows: number): SkinnedMesh3D | null => {
            const g = buildFaceOverlayGeometry(src, rig.headJointIdx, rect, cols, rows, hZ * 0.006, minZ, hY * 0.15);
            if (!g) return null;
            const m = new SkinnedMesh3D(this.ctx.interactionService, body.x, body.y, body.z, { primitive: 'custom', geometry: { vertices: g.vertices, indices: g.indices, format: '12float' } as MeshGeometry });
            m.name = name;
            m.isFaceDecal = true;      // persistence / restyle exclusions of the face decal
            m.isFaceFeatures = true;   // multiply pass, no shadow
            m.frameExclude = true;
            m.transformViaSkeleton = true;
            m.skeletonId = body.skeletonId; m.skeleton = body.skeleton;
            m.jointIndices = g.jointIndices; m.jointWeights = g.jointWeights; m.skinDirty = true;
            m.setDiffuseColor(1, 1, 1, 1);
            m.material.emissive = { r: 0, g: 0, b: 0, a: 1 };
            m.material.renderStyle = 'unlit';
            m.material.doubleSided = true;
            m.excludeFromDocument = !!body.excludeFromDocument;
            m.visible = false;
            this.ctx.sceneGraph.root.addChild(m);
            return m;
        };
        const skin = mk('FaceFeatures', skinRect, 41, 49);
        const brow = mk('FaceBrows', browRect, 37, 17);
        this.ctx.emitSceneGraphChanged();
        const tex = (w: number, h: number) => { const t = new RasterTextureManager(device); t.ensureTexture(w, h); return t; };
        const p = rig.features ?? normalizeFaceFeatureParams();
        const weights = expressionWeights(p.expression);
        rig.feat = {
            skinMeshId: skin?.id ?? null, browMeshId: brow?.id ?? null,
            skinTex: skin ? tex(1024, 1024) : null, browTex: brow ? tex(1024, 512) : null,
            canvases: {}, layout: null,
            weights, shape: blendExpressionShapes(weights), extra: {},
            anim: null, hold: null, pulse: null, life: null, holding: false,
            bold: 1, body,
        };
        this._ensureFaceLodCallback();
    }

    // ── Face kit distance LOD: thicker lines when the face is small on screen (Play distance). ──
    private _faceLodCb: (() => boolean) | null = null;
    /** Registered once, on the first face kit. Every 8th frame: each kit face's on-screen width (vs the viewport) picks a
     *  line-weight level; a level change re-paints that face. Never keeps the render loop alive. */
    private _ensureFaceLodCallback(): void {
        if (this._faceLodCb) return;
        let frame = 0;
        this._faceLodCb = () => {
            if ((frame++ & 7) !== 0) return false;
            const cam = this.host.getCamera();
            if (!cam) return false;
            const cp = cam.position, ortho = cam.mode === 'orthographic';
            const tanH = Math.tan(Math.max(0.05, cam.fov) * 0.5), aspect = Math.max(0.1, cam.aspect || 1);
            for (const rig of this._faceRigs.values()) {
                const f = rig.feat;
                if (!f?.layout || !f.body || !rig.features?.enabled) continue;
                const ot = f.body.skeleton?.objectTransform;
                const L = f.layout, lx = L.midX, ly = L.eyes[0].cy;
                const s = ot ? Math.hypot(ot[0], ot[1], ot[2]) : 1;
                const px = ot ? ot[0] * lx + ot[4] * ly + ot[12] : f.body.x + lx, py = ot ? ot[1] * lx + ot[5] * ly + ot[13] : f.body.y + ly, pz = ot ? ot[2] * lx + ot[6] * ly + ot[14] : f.body.z;
                const faceW = (L.skin.x1 - L.skin.x0) * s;
                const d = Math.hypot(cp[0] - px, cp[1] - py, cp[2] - pz);
                const frac = ortho ? faceW / (2 * Math.max(1e-4, cam.orthoSize) * aspect) : faceW / (2 * Math.max(1e-4, d) * tanH * aspect);
                const b = faceLodBold(frac, f.bold);
                if (b !== f.bold) { f.bold = b; this._renderFaceKit(rig); }
            }
            return false;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._faceLodCb, 'faceKitLod');
    }

    /** Remove the overlays (and stop the kit's timers). rig.features stays (a disable keeps the params). */
    private _teardownFaceKit(rig: FaceRig): void {
        const f = rig.feat;
        if (f) {
            for (const t of [f.anim, f.hold, f.pulse, f.life]) if (t) clearTimeout(t);
            for (const id of [f.skinMeshId, f.browMeshId]) { const m = id ? this.host.getMesh(id) : null; m?.parent?.removeChild(m); }
            rig.feat = undefined;
            this.ctx.emitSceneGraphChanged();
        }
    }

    /** Stop the kit's timers only (document load / character delete). */
    private _cancelFaceKitTimers(rig: FaceRig): void {
        const f = rig.feat;
        if (!f) return;
        for (const k of ['anim', 'hold', 'pulse', 'life'] as const) { const t = f[k]; if (t) clearTimeout(t); f[k] = null; }
        f.holding = false;
    }

    /** The kit sits the eyes in the face: part of their light comes from the scene (eyeShade), the rest stays emissive.
     *  Without the kit (or eyeShade 0) the eyes are the classic unlit full-bright decal — bit-identical to before. */
    private _applyEyeShade(rig: FaceRig): void {
        const decal = this.host.getMesh(rig.decalMeshId);
        if (!decal) return;
        const k = rig.features?.enabled ? Math.max(0, Math.min(1, rig.features.eyeShade)) : 0;
        if (!rig.features?.enabled) decal.faceDepthPull = 0;   // see-through bangs are a kit feature (set by the layout)
        decal.setDiffuseColor(k, k, k, 1);
        decal.material.emissive = { r: 1 - k, g: 1 - k, b: 1 - k, a: decal.material.emissive.a ?? 1 };
        decal.materialDirty = true;
        decal.gpuDirty = true;
    }

    /** Where everything goes on THIS head: rects, eyes (from the active expression's eye params), nose / chin / face width
     *  from the geometry, the hair fringe, and the brow layer's depth pull. Cached on the runtime until eyes / hair /
     *  body change. */
    private _faceKitLayout(rig: FaceRig): FaceLayout | null {
        const f = rig.feat;
        if (!f) return null;
        if (f.layout) return f.layout;
        const body = this.host.getMesh(rig.bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.geometry) return null;
        const fr = this._faceFrame(body, rig.headJointIdx);
        if (!fr) return null;
        const { bb, hY, hZ, cx, cz, hw } = fr;
        const ep = rig.expressions.find(e => e.id === rig.activeId)?.eyeParams
            ?? rig.expressions.find(e => !e.isBlink && e.eyeParams)?.eyeParams ?? defaultEyeParams();
        const eyes = eyeLayoutFromParams(ep, { cx, cy: fr.eyeCy, hw, hh: fr.eyeHh });
        const V = body.geometry.vertices, JI = body.jointIndices!, JW = body.jointWeights!, nv = V.length / 12;
        const headW = (i: number) => { let w = 0; for (let k = 0; k < 4; k++) if (JI[i * 4 + k] === rig.headJointIdx) w += JW[i * 4 + k]; return w; };
        let noseZ = -Infinity, noseY = bb.min[1] + hY * 0.37, frontZ = -Infinity;
        for (let i = 0; i < nv; i++) {
            if (headW(i) < 0.5) continue;
            const x = V[i * 12], y = V[i * 12 + 1], z = V[i * 12 + 2];
            if (z > frontZ) frontZ = z;
            if (Math.abs(x - cx) < hw * 0.3 && y > bb.min[1] + hY * 0.2 && y < bb.min[1] + hY * 0.5 && z > noseZ) { noseZ = z; noseY = y; }
        }
        let chinY = bb.min[1] + hY * 0.08, chinBest = Infinity;
        const zFront = cz + (frontZ - cz) * 0.5;
        for (let i = 0; i < nv; i++) {
            if (headW(i) < 0.5) continue;
            const x = V[i * 12], y = V[i * 12 + 1], z = V[i * 12 + 2];
            if (Math.abs(x - cx) < hw * 0.2 && z > zFront && y < noseY && y < chinBest) { chinBest = y; chinY = y; }
        }
        const top = noseY, bot = chinY, mouthY = top + (bot - top) * 0.5;
        let faceHalfW = hw * 0.6;
        { let m = 0; for (let i = 0; i < nv; i++) { if (headW(i) < 0.5) continue; const y = V[i * 12 + 1]; if (Math.abs(y - mouthY) < hY * 0.06 && V[i * 12 + 2] > cz) m = Math.max(m, Math.abs(V[i * 12] - cx)); } if (m > 0) faceHalfW = m; }
        const browMesh = f.browMeshId ? this.host.getMesh(f.browMeshId) : null;
        const skin = { x0: cx - hw, x1: cx + hw, y0: bb.min[1], y1: bb.min[1] + hY * 0.86 };
        const brow = { x0: cx - hw * 0.94, x1: cx + hw * 0.94, y0: bb.min[1] + hY * 0.44, y1: bb.min[1] + hY * 0.80 };
        // Hair: the fringe profile (hair shadow) and how far the brows must pull forward to clear it.
        let fringe: FaceLayout['fringe'] = null, pull = 0, eyePull = 0;
        const hr = this._hairRigs.get(rig.bodyMeshId);
        const hairMesh = hr ? this.host.getMesh(hr.hairMeshId) : null;
        if (hairMesh?.geometry?.vertices.length) {
            const hv = hairMesh.geometry.vertices, hi = hairMesh.geometry.indices;
            const cards = String(hr!.params.hairMode ?? 'chunky').toLowerCase() === 'cards';
            fringe = { y: computeFringe(hv, hi, skin, cz, 160, 160, 12, cards ? 0.5 : Infinity) };
            // The gap is measured against the DEEPEST point under a brow / eye (the face curves back toward the outer
            // corners), not the overlay's front-most (nose-bridge) point, or the outer ends stay behind the bangs.
            const nearEye = (x: number) => eyes.some((e) => Math.abs(x - e.cx) < e.halfW * 1.4);
            let browFaceZ = Infinity;
            if (browMesh?.geometry) { const bv = browMesh.geometry.vertices; for (let i = 0; i < bv.length; i += 12) if (nearEye(bv[i])) browFaceZ = Math.min(browFaceZ, bv[i + 2]); }
            let hairZ = -Infinity;
            for (let i = 0; i < hv.length; i += 12) {
                const x = hv[i], y = hv[i + 1];
                if (x > brow.x0 && x < brow.x1 && y > brow.y0 - hY * 0.1 && y < brow.y1 + hY * 0.1) hairZ = Math.max(hairZ, hv[i + 2]);
            }
            if (Number.isFinite(hairZ) && Number.isFinite(browFaceZ)) pull = Math.min(hZ * 0.5, Math.max(hZ * 0.03, hairZ - browFaceZ + hZ * 0.03));
            // Bangs over the EYES: the eyes draw through them too ("see-through bangs", eyesThroughHair), or — with that
            // off — the brows hide with the eyes (brows floating on the hair above hidden eyes read wrong).
            const eyeTop = eyes[0].cy + eyes[0].halfH, fy = fringe.y, n = fy.length;
            let covered = 0, cols = 0;
            for (let i = 0; i < n; i++) {
                const x = skin.x0 + ((i + 0.5) / n) * (skin.x1 - skin.x0);
                if (Math.abs(Math.abs(x - cx) - Math.abs(eyes[1].cx - cx)) > eyes[1].halfW) continue;   // over an eye
                cols++; if (!Number.isNaN(fy[i]) && fy[i] < eyeTop) covered++;
            }
            const eyesCovered = cols > 0 && covered / cols > 0.5;
            if (eyesCovered && rig.features?.eyesThroughHair !== false) {
                const decal = this.host.getMesh(rig.decalMeshId);
                let decalZ = Infinity, eyeHairZ = -Infinity;
                if (decal?.geometry && decal.geometry.vertices.length === EYE_DECAL_NC * EYE_DECAL_NR * 12) {
                    const ez = eyeDecalSurfaceZ(decal.geometry.vertices, EYE_DECAL_NC, EYE_DECAL_NR);
                    for (const e of eyes) for (const dx of [-1.3, 0, 1.3]) { const z = ez(e.cx + dx * e.halfW, e.cy); if (Number.isFinite(z)) decalZ = Math.min(decalZ, z); }
                }
                const ey0 = fr.eyeCy - fr.eyeHh - hY * 0.1, ey1 = fr.eyeCy + fr.eyeHh + hY * 0.15;   // wide: a card's verts can sit outside the band it covers
                for (let i = 0; i < hv.length; i += 12) { const x = hv[i], y = hv[i + 1]; if (x > cx - hw && x < cx + hw && y > ey0 && y < ey1) eyeHairZ = Math.max(eyeHairZ, hv[i + 2]); }
                if (Number.isFinite(decalZ) && Number.isFinite(eyeHairZ)) eyePull = Math.min(hZ * 0.5, Math.max(hZ * 0.03, eyeHairZ - decalZ + hZ * 0.03));
            } else if (eyesCovered) pull = 0;
        }
        if (browMesh) browMesh.faceDepthPull = rig.features?.browsThroughHair === false ? 0 : pull;
        const eyeDecal = this.host.getMesh(rig.decalMeshId);
        if (eyeDecal) eyeDecal.faceDepthPull = rig.features?.enabled ? eyePull : 0;
        f.layout = { skin, brow, midX: cx, eyes, noseY, chinY, faceHalfW, fringe };
        return f.layout;
    }

    /** Paint both layers for the current expression and upload them (premultiplied — the multiply blend needs m·a). */
    private _renderFaceKit(rig: FaceRig): void {
        const f = rig.feat, p = rig.features;
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!f || !p || !device || typeof document === 'undefined') return;
        const L = this._faceKitLayout(rig);
        if (!L) return;
        const body = this.host.getMesh(rig.bodyMeshId);
        const d = body?.material?.diffuse;
        const colors = { skin: [d?.r ?? 0.9, d?.g ?? 0.75, d?.b ?? 0.65] as [number, number, number], hairRoot: this._hairRigs.get(rig.bodyMeshId)?.params.rootColor ?? null, bold: f.bold };
        const shape = { ...f.shape };
        for (const [k, v] of Object.entries(f.extra)) (shape as unknown as Record<string, number>)[k] += v as number;
        // Texel density: −1 = the eyes' (the same px across the face width), 0 = crisp full-res.
        const eyePx = rig.expressions.find(e => e.id === rig.activeId)?.eyeParams?.pixelResolution ?? 0;
        const px = p.pixelResolution < 0 ? eyePx : p.pixelResolution;
        const faceW = L.skin.x1 - L.skin.x0;
        const paint = (layer: 'skin' | 'brow', mgr: RasterTextureManager | null, meshId: string | null) => {
            const mesh = meshId ? this.host.getMesh(meshId) : null;
            if (!mgr || !mesh) return;
            const { w: W, h: H } = mgr.getTextureSize();
            const tex = mgr.ensureTexture(W, H);
            const big = (f.canvases[layer] ??= document.createElement('canvas'));
            if (big.width !== W || big.height !== H) { big.width = W; big.height = H; }
            const bctx = big.getContext('2d');
            if (!bctx) return;
            const R = layer === 'skin' ? L.skin : L.brow;
            if (px > 0) {
                const sw = Math.max(8, Math.round(px * (R.x1 - R.x0) / faceW)), sh = Math.max(8, Math.round(px * (R.y1 - R.y0) / faceW));
                const small = (f.canvases.small ??= document.createElement('canvas'));
                small.width = sw; small.height = sh;
                const sctx = small.getContext('2d');
                if (!sctx) return;
                renderFaceLayer(sctx, layer, p, L, shape, colors, sw, sh);
                bctx.setTransform(1, 0, 0, 1, 0, 0);
                bctx.clearRect(0, 0, W, H);
                bctx.imageSmoothingEnabled = false;
                bctx.drawImage(small, 0, 0, sw, sh, 0, 0, W, H);
            } else {
                renderFaceLayer(bctx, layer, p, L, shape, colors, W, H);
            }
            device.queue.copyExternalImageToTexture({ source: big, flipY: false }, { texture: tex, premultipliedAlpha: true }, [W, H]);
            noteRasterContentWrite(tex);   // incremental autosave: this painted texture changed
            mesh.diffuseTexture = tex;
            mesh.material.hasTexture = true;
            mesh.visible = p.enabled;
            mesh.gpuDirty = true;
        };
        paint('skin', f.skinTex, f.skinMeshId);
        paint('brow', f.browTex, f.browMeshId);
        this.ctx.scheduleRender();
    }

    /** Eyes moved / reshaped (active expression edited or switched): re-place the brows + lid-dependent bits. */
    private _faceKitEyesChanged(rig: FaceRig): void {
        if (!rig.feat) return;
        rig.feat.layout = null;
        this._renderFaceKit(rig);
    }

    /** Hair changed (or removed): the fringe shadow, the brow pull and the auto brow colour follow. */
    private _faceKitHairChanged(bodyMeshId: string): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig?.feat) return;
        rig.feat.layout = null;
        this._renderFaceKit(rig);
    }

    /** Occasional idle smiles (FaceFeatureParams.lifeSmile): every ~10–22 s, from the resting expression only. */
    private _restartFaceLife(rig: FaceRig): void {
        const f = rig.feat;
        if (!f) return;
        if (f.life) { clearTimeout(f.life); f.life = null; }
        if (!rig.features?.enabled || !rig.features.lifeSmile) return;
        f.life = setTimeout(() => {
            if (!rig.feat || rig.feat !== f) return;
            f.life = null;
            const rest = rig.features?.expression ?? 'neutral';
            const atRest = !f.holding && dominantExpression(f.weights) === rest;
            if (atRest && rest !== 'smile' && rest !== 'open') this.setCharacterExpression(rig.bodyMeshId, 'smile', { weight: 0.55 + Math.random() * 0.35, blendMs: 280, holdMs: 1400 + Math.random() * 1800 });
            this._restartFaceLife(rig);
        }, 10000 + Math.random() * 12000);
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

    /** Drop every per-character registry before a document restore (audit 2026-09-28 P6). Each restore* returns early
     *  on empty input, so a document with no characters used to KEEP the previous doc's rigs — and the next save
     *  re-serialized them into this one. The meshes themselves are removed by the 3D restore; this is registry-only
     *  (plus stopping each face rig's blink timers so they don't fire on dead decals). */
    clearForDocumentLoad(): void {
        // Runtime-only bodies (the cached Play auto player) are not part of any document: keep their rigs.
        const keep = (bodyId: string) => this._runtimeBodies.has(bodyId);
        for (const [k, rig] of [...this._faceRigs]) if (!keep(k)) { this._cancelBlink(rig); this._cancelFaceKitTimers(rig); this._faceRigs.delete(k); }
        for (const k of [...this._hairRigs.keys()]) if (!keep(k)) this._hairRigs.delete(k);
        for (const [k, r] of [...this._clothingRigs]) if (!keep(r.bodyMeshId)) this._clothingRigs.delete(k);
        for (const [k, r] of [...this._attachments]) if (!keep(r.bodyMeshId)) this._attachments.delete(k);
        for (const m of [this._bodyParams, this._bodyArmSurface, this._bodyLegSurface, this._bodyTorsoSurface] as Map<string, unknown>[])
            for (const k of [...m.keys()]) if (!keep(k)) m.delete(k);
    }

    /** Mark a body RUNTIME-ONLY (never serialized; survives clearForDocumentLoad). See _runtimeBodies. */
    markRuntimeBody(bodyMeshId: string): void { this._runtimeBodies.add(bodyMeshId); }
    /** True if `bodyMeshId` is a runtime-only body. */
    isRuntimeBody(bodyMeshId: string): boolean { return this._runtimeBodies.has(bodyMeshId); }
    /** True if `meshId` is a runtime-only body OR an overlay part (decal / hair / garment / charm) of one. */
    isRuntimePart(meshId: string): boolean {
        if (this._runtimeBodies.size === 0) return false;
        if (this._runtimeBodies.has(meshId)) return true;
        const b = this.overlayBodyOf(meshId);
        return b !== null && this._runtimeBodies.has(b);
    }

    /** Re-derive a PROCEDURAL blink frame from the active expression's eyes (see FaceBlinkConfig.followOpenEyes).
     *  The blink used to be a one-time COPY of the eyes taken when auto-blink first ran, so later edits (deco dots
     *  set to 0, a new lash colour, moved eyes) flashed back in the old settings on every blink. Only touches a blink
     *  frame that is procedural and closed; hand-drawn frames and hand-drawn eyes are left alone. */
    private _syncProceduralBlink(rig: FaceRig): void {
        if (rig.blink.followOpenEyes === false || !rig.blinkId || rig.blinkId === rig.activeId) return;
        const blink = rig.expressions.find(e => e.id === rig.blinkId);
        const open = rig.expressions.find(e => e.id === rig.activeId);
        if (!blink?.eyeParams?.closed || !open?.eyeParams) return;
        const next = blinkParamsFor(open.eyeParams, blink.eyeParams);
        if (!next) return;
        blink.eyeParams = next;
        const mgr = this._ensureExpressionTexture(rig, blink.id);
        if (mgr) this._renderEyeParamsToTexture(mgr, next, rig.faceAspect);
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
        // Face kit life cue: now and then a blink comes with a small brow raise.
        const lb = rig.features?.enabled ? rig.features.lifeBrowRaise : 0;
        if (!isSecond && lb > 0 && rig.feat && Math.random() < lb) this.pulseBrows(rig.bodyMeshId, 0.35 + Math.random() * 0.25);
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
            if (this._runtimeBodies.has(rig.bodyMeshId)) continue;   // runtime-only (Play auto player): never saved
            out.push({
                bodyMeshId: rig.bodyMeshId, skeletonId: rig.skeletonId, headJointIdx: rig.headJointIdx,
                decalMeshId: rig.decalMeshId, expressions: rig.expressions.map(e => ({ ...e })),
                activeId: rig.activeId, blinkId: rig.blinkId, blink: { ...rig.blink },
                ...(rig.features ? { features: { ...rig.features } } : {}),   // face kit: params only (overlays regenerate)
            });
        }
        return out;
    }
    getFaceTextureExports(): { key: string; mgr: RasterTextureManager; procedural: boolean }[] {
        const out: { key: string; mgr: RasterTextureManager; procedural: boolean }[] = [];
        for (const rig of this._faceRigs.values()) {
            if (this._runtimeBodies.has(rig.bodyMeshId)) continue;   // runtime-only: no face PNG in the save
            for (const [exprId, mgr] of rig.textures) {
                const procedural = !!rig.expressions.find(e => e.id === exprId)?.eyeParams;
                out.push({ key: `${rig.bodyMeshId}:${exprId}`, mgr, procedural });
            }
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
                        noteRasterContentWrite(tex);   // incremental autosave: this painted texture changed
                    } catch (err) { console.warn('[Face] restore texture failed', e.id, err); }
                } else if (e.eyeParams) {
                    this._renderEyeParamsToTexture(mgr, e.eyeParams, rig.faceAspect);
                } else {
                    this._ensureExpressionTexture(rig, e.id);
                }
            }
            this._faceRigs.set(st.bodyMeshId, rig);
            this._syncProceduralBlink(rig);   // repairs a saved blink frame that went stale before this fix
            this._applyTexture(rig, rig.activeId);
            this._restartBlink(rig);
            // Face kit: regenerate from params. A face saved before the kit has no `features` → untouched (eyes only).
            if (st.features) { rig.features = normalizeFaceFeatureParams(st.features); this._enableFaceKitFromParams(rig); }
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
                if (fr.features) this._enableFaceKitFromParams(fr);   // the overlays re-raycast the new head
            }
        } catch (e) { console.warn('[Body] face re-fit failed', e); }
    }

    /** (Re)build a face kit from rig.features (load / body refit): overlays + eye shade + life, keeping the expression. */
    private _enableFaceKitFromParams(rig: FaceRig): void {
        const p = rig.features;
        if (!p) return;
        if (!p.enabled) { this._teardownFaceKit(rig); this._applyEyeShade(rig); return; }
        const keep = rig.feat ? { weights: rig.feat.weights, shape: rig.feat.shape } : null;
        this._buildFaceKit(rig);
        if (rig.feat && keep) { rig.feat.weights = keep.weights; rig.feat.shape = keep.shape; }
        this._applyEyeShade(rig);
        this._restartFaceLife(rig);
        this._renderFaceKit(rig);
    }

    prepareFaceRigDeletion(bodyMeshId: string): { drop: () => void; restore: () => void } | null {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return null;
        return {
            drop:    () => { this._cancelBlink(rig); this._cancelFaceKitTimers(rig); this._faceRigs.delete(bodyMeshId); },
            restore: () => { this._faceRigs.set(bodyMeshId, rig); this._restartBlink(rig); this._restartFaceLife(rig); },
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
        const fr = this._faceRigs.get(bodyMeshId);
        if (fr?.feat) this._renderFaceKit(fr);   // custom brow / mouth colours are skin-relative multipliers
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
    /** A COPY of the body's hair params (see getBodyParams — a host binding its UI to the live object mutated our state). */
    getHairParams(bodyMeshId: string): HairParams | null { const p = this._hairRigs.get(bodyMeshId)?.params; return p ? structuredClone(p) : null; }
    getHairMeshId(bodyMeshId: string): string | null { return this._hairRigs.get(bodyMeshId)?.hairMeshId ?? null; }

    private _collisionVertsForHair(bodyMeshId: string, body: SkinnedMesh3D): Float32Array | undefined {
        const parts: (Float32Array | undefined)[] = [body.geometry?.vertices];
        for (const slot of HAIR_COLLISION_SLOT_ORDER) {
            const cr = this._clothingRigs.get(`${bodyMeshId}:${slot}`);
            if (!cr) continue;
            parts.push(this.host.getMesh(cr.clothingMeshId)?.geometry?.vertices);
        }
        return hairCollisionVerts(parts);   // pure (character-parts.ts) — the worker builds the same soup
    }

    // ── Worker-precomputed overlays (performance-plan P3.2d) ──
    /** Stash worker-generated garments + hair for a body just created FROM `parts.body` (createProceduralCharacter3D).
     *  The following setClothingParams / setHairParams calls take them instead of generating — only when their inputs
     *  match exactly — then clearPrimedParts drops whatever is left. */
    primeGeneratedParts(bodyMeshId: string, parts: CharacterParts): void {
        const verts = this.host.getMesh(bodyMeshId)?.geometry?.vertices;
        if (!verts) return;
        const garments = new Map<string, { sig: string; result: GarmentGenResult }>();
        for (const g of parts.garments) garments.set(g.params.slot, { sig: JSON.stringify([g.params, g.shoes]), result: g.result });
        const hair = parts.hair ? { sig: JSON.stringify([parts.hair.params, parts.hair.garmentParams]), result: parts.hair.result } : null;
        this._primed.set(bodyMeshId, { verts, garments, hair });
    }
    clearPrimedParts(bodyMeshId: string): void { this._primed.delete(bodyMeshId); }
    private _takePrimedGarment(bodyMeshId: string, body: SkinnedMesh3D, params: ClothingParams, shoes: ShoeParams | null): GarmentGenResult | null {
        const p = this._primed.get(bodyMeshId);
        if (!p || p.verts !== body.geometry?.vertices) return null;
        const e = p.garments.get(params.slot);
        if (!e) return null;
        p.garments.delete(params.slot);   // one use — a re-fit / slider change regenerates
        return e.sig === JSON.stringify([params, shoes]) ? e.result : null;
    }
    private _takePrimedHair(bodyMeshId: string, body: SkinnedMesh3D, params: HairParams): HairResult | null {
        const p = this._primed.get(bodyMeshId);
        if (!p || !p.hair || p.verts !== body.geometry?.vertices) return null;
        const garmentParams: ClothingParams[] = [];
        for (const slot of HAIR_COLLISION_SLOT_ORDER) {
            const cr = this._clothingRigs.get(`${bodyMeshId}:${slot}`);
            if (cr && this.host.getMesh(cr.clothingMeshId)) garmentParams.push(cr.params);
        }
        const e = p.hair; p.hair = null;
        return e.sig === JSON.stringify([params, garmentParams]) ? e.result : null;
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
        const head: HeadFrame = headFrameFromBBox(bb);
        const result = this._takePrimedHair(bodyMeshId, body, params) ?? generateHair(head, params, this._collisionVertsForHair(bodyMeshId, body));
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
        let { ji, jw } = this._buildHairSpringRig(skel, headIdx, head, result);
        ({ ji, jw } = this._layerHairOverTop(bodyMeshId, skel, headIdx, hair, ji, jw));
        this._ensureBodyColliders(bodyMeshId, params.frontDrape ?? 0);
        hair.jointIndices = ji; hair.jointWeights = jw; hair.skinDirty = true;
        hair.material.doubleSided = true;
        hair.setDiffuseColor(1, 1, 1, 1);
        const tex = this._renderHairGradient(gradient, params);
        if (tex) { hair.diffuseTexture = tex; hair.material.hasTexture = true; }
        hair.material.alphaCutout = String(params.hairMode ?? 'chunky').toLowerCase() === 'cards';
        const sheen = Math.max(0, Math.min(1, params.sheen ?? 0));
        hair.material.hairSheen = sheen > 0.02;
        hair.material.hairBand = params.sheenBand === true;   // Cel / Cel-HD: the sheen as one crisp highlight band (flags2 bit 7)
        hair.material.specular = { r: sheen, g: sheen, b: sheen, a: 1 };
        hair.material.shininess = 48;
        this._inheritCharacterStyle(hair, body);
        hair.gpuDirty = true;
        this.ctx.sceneGraph.root.addChild(hair);
        this.ctx.emitSceneGraphChanged();

        this._hairRigs.set(bodyMeshId, { bodyMeshId, hairMeshId: hair.id, params, gradient });
        this._rebuildAllCharms(bodyMeshId);
        this._faceKitHairChanged(bodyMeshId);   // fringe shadow, brow pull + auto brow colour
        this.ctx.scheduleRender();
    }

    /**
     * Fit round 2: long hair that hangs down the back is the OUTERMOST layer. The head-bound hair verts below the nape
     * (cap flap, back cards) are pushed out over the top / undershirt (garment-layers layerOver, 6 mm) and take the shirt's
     * weights where they lie on it, so the tips ride the upper back instead of sinking into the shirt when the chest moves
     * (the tips poking through the shirt's upper back). Spring-tail verts are left to their springs. Deterministic, so
     * worker-primed and synchronous hair stay identical.
     */
    private _layerHairOverTop(bodyMeshId: string, skel: Skeleton3D, headIdx: number, hair: SkinnedMesh3D, ji: Uint8Array, jw: Float32Array): { ji: Uint8Array; jw: Float32Array } {
        const inners: LayerGarment[] = [];
        for (const s of ['top', 'undershirt'] as const) {
            const r = this._clothingRigs.get(`${bodyMeshId}:${s}`);
            const m = r ? this.host.getMesh(r.clothingMeshId) : null;
            if (m instanceof SkinnedMesh3D && m.geometry) inners.push({ geometry: { vertices: m.geometry.vertices, indices: m.geometry.indices as Uint32Array }, jointIndices: m.jointIndices, jointWeights: m.jointWeights });
        }
        const ni = skel.data.joints.findIndex(j => j.name === 'neck');
        if (!inners.length || ni < 0) return { ji, jw };
        const neckY = mat4.invert(mat4.create(), Array.from(skel.data.joints[ni].inverseBindMatrix as unknown as ArrayLike<number>) as unknown as mat4)[13];
        const V = hair.geometry.vertices;
        const movable = (v: number) => V[v * 12 + 1] < neckY && ji[v * 4] === headIdx && jw[v * 4] > 0.999;
        const { garment, moved } = layerOver({ geometry: { vertices: V, indices: hair.geometry.indices as Uint32Array }, jointIndices: ji, jointWeights: jw }, inners, undefined, movable, true);
        if (!moved && garment.jointWeights.every((w, i) => w === jw[i])) return { ji, jw };
        V.set(garment.geometry.vertices); hair.gpuDirty = true;
        return { ji: garment.jointIndices, jw: garment.jointWeights };
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
        this._faceKitHairChanged(bodyMeshId);
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
        noteRasterContentWrite(tex);   // incremental autosave: this painted texture changed
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
        const p = this._clothingRigs.get(`${bodyMeshId}:${slot}`)?.params;   // a COPY — see getBodyParams
        return p ? structuredClone(p) : null;
    }

    setClothingParams(bodyMeshId: string, params: ClothingParams): void {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return;
        params = normalizeGarmentParams(params);   // 'top' sleeveLength preset name → number (same object otherwise)
        const shoesP = params.slot === 'bottom' ? ((this._clothingRigs.get(`${bodyMeshId}:shoes`)?.params as ShoeParams) ?? null) : null;
        // A worker-precomputed garment (createProceduralCharacter3D) when its inputs match exactly; else generate now.
        let result: GarmentGenResult | null = this._takePrimedGarment(bodyMeshId, body, params, shoesP);
        if (!result) {
            const fit = (this._sharedBodyFit && this._sharedBodyFit.bodyMeshId === bodyMeshId)
                ? this._sharedBodyFit.fit
                : this._buildBodyFit(body);
            if (!fit) return;
            result = generateGarment(fit, params, shoesP);
        }
        // Fit round 2: the RAW generated garment is kept on the rig; what is drawn is it LAYERED over the garments under it
        // (garment-layers.ts: top over the bottom / undershirt, trousers over socks / underpants).
        const raw = result;
        result = this._layeredGarment(bodyMeshId, params, raw);

        const key = `${bodyMeshId}:${params.slot}`;
        const rig = this._clothingRigs.get(key);
        if (rig) { const old = this.host.getMesh(rig.clothingMeshId); old?.parent?.removeChild(old); }

        const mesh = new SkinnedMesh3D(this.ctx.interactionService, body.x, body.y, body.z, { primitive: 'custom', geometry: result.geometry });
        mesh.name = params.slot === 'top' ? 'Top' : params.slot === 'bottom' ? 'Bottom' : params.slot === 'shoes' ? 'Shoes' : params.slot === 'socks' ? 'Socks' : params.slot === 'undershirt' ? 'Undershirt' : 'Underpants'; mesh.isClothing = true; mesh.visible = true; mesh.transformViaSkeleton = true;
        mesh.skeletonId = body.skeletonId; mesh.skeleton = body.skeleton;
        mesh.jointIndices = result.jointIndices; mesh.jointWeights = result.jointWeights; mesh.skinDirty = true;
        mesh.material.doubleSided = true;
        // Fit round 2: the inside face draws as a dark lining (flags2 bit 8) — on the OPEN garments whose inside you see
        // through an opening (a skirt under the hem, a top at the neck / sleeves). Not on closed tubes (trousers, shorts,
        // socks, shoes): their back faces only show where the two legs' tubes overlap at the crotch, and a dark notch there
        // read worse than the old same-colour overlap (the browser captures).
        mesh.material.clothLining = params.slot === 'top' || params.slot === 'undershirt' || this._isSkirtRig(params);
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
        this._inheritCharacterStyle(mesh, body);
        if (body.material.matte) applyMatte(mesh, true);   // matte cel cloth (polish item 10)
        mesh.gpuDirty = true;
        this.ctx.sceneGraph.root.addChild(mesh);
        this.ctx.emitSceneGraphChanged();

        const steerData = (result as { skirtSteer?: SkirtSteer }).skirtSteer;
        const swing = this._buildSkirtSwing(body, params, mesh);
        this._clothingRigs.set(key, {
            bodyMeshId, slot: params.slot, clothingMeshId: mesh.id, params, gradient, raw,
            ...(steerData ? { steer: { data: steerData, ji: mesh.jointIndices, jw: mesh.jointWeights, last: 0, mesh } } : {}),
            ...(swing ? { swing } : {}),
        });
        if (steerData || swing) this._ensureSkirtSteerCallback();
        this._relayerOuter(bodyMeshId, params.slot);
        this._scheduleBodyMask(bodyMeshId);
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

    // ── Skirt steering (R6.3) — per frame, re-split a skirt's front/back panels toward the forward/trailing thigh ──
    private _skirtSteerCb: (() => boolean) | null = null;
    /** Registered once, on the first steered skirt. Cheap when idle: one signal per skirted character per frame, and
     *  the weights are only rewritten (→ one skinned-VB re-upload of a few hundred verts) when the signal moved by
     *  STEER_EPS. Keeps the render loop alive only while a skirt's Play follow-through is still settling. */
    private _ensureSkirtSteerCallback(): void {
        if (this._skirtSteerCb) return;
        const STEER_EPS = 0.04;
        let lastMs = 0;
        this._skirtSteerCb = () => {
            const playing = this.host.isPlaying?.() ?? false;
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const dt = lastMs ? (now - lastMs) / 1000 : 0;
            lastMs = now;
            let alive = false;
            for (const rig of this._clothingRigs.values()) {
                if (rig.swing && this._stepSkirtSwing(rig, playing, dt)) alive = true;
                const st = rig.steer;
                if (!st) continue;
                // P6 (performance-plan.md): the garment mesh is held on the steer record — getMesh is a whole-scene-graph
                // walk, and after Play's Stop the auto player's skirt is DETACHED (cached for the next Play), so the old
                // per-frame lookup walked every city node and found nothing (~0.4 ms a frame in the editor).
                let mesh: Mesh3D | null = st.mesh && st.mesh.id === rig.clothingMeshId ? st.mesh : null;
                if (!mesh) { mesh = this.host.getMesh(rig.clothingMeshId); if (mesh) st.mesh = mesh; }
                if (!mesh || !mesh.parent) continue;   // detached: not drawn, nothing to steer (re-attach resumes it)
                if (!(mesh instanceof SkinnedMesh3D) || !mesh.skeleton) continue;
                if (mesh.jointIndices !== st.ji || mesh.jointWeights !== st.jw) continue;   // skin arrays replaced → leave them
                const raw = skirtSteerSignal(mesh.skeleton.skinMatrices, st.data);
                // Item 13: in Play the panels FOLLOW the legs a beat late (SkirtFollow, a soft spring) instead of moving
                // as boards locked to the thighs; once settled (or in the editor) the exact static signal, as before.
                let s = raw;
                if (playing) {
                    const fol = (st.follow ??= new SkirtFollow());
                    const v = fol.update(raw, dt);
                    if (!fol.settled(raw)) { s = v; alive = true; }
                } else if (st.follow) st.follow.reset();
                // Skip small changes — but always land exactly on 0 / ±1 so a settled pose gets the exact weights.
                const settled = s === 0 || Math.abs(s) === 1;
                if (s === st.last || (Math.abs(s - st.last) < STEER_EPS && !settled)) continue;
                steerSkirtWeights(st.data, s, st.ji, st.jw);
                st.last = s;
                mesh.skinDirty = true;
            }
            return alive;   // only while a skirt is still swinging in Play
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._skirtSteerCb, 'skirtSteer');
    }

    // ── Fit round 2 (2026-10-04): layer order, body-hiding mask, skirt hem swing ─────────────────────────────────────

    private _isSkirtRig(p: ClothingParams | undefined): boolean { return !!p && p.slot === 'bottom' && (p as BottomParams).bottomStyle === 'skirt'; }

    /** `raw` layered over this character's current inner garments (their drawn geometry) — garment-layers.ts. */
    private _layeredGarment(bodyMeshId: string, params: ClothingParams, raw: GarmentGenResult): GarmentGenResult {
        const entry = LAYER_OVER.find(([o]) => o === params.slot);
        if (!entry || this._isSkirtRig(params)) return raw;
        const inners: LayerGarment[] = [];
        for (const s of entry[1]) {
            const r = this._clothingRigs.get(`${bodyMeshId}:${s}`);
            const m = r ? this.host.getMesh(r.clothingMeshId) : null;
            if (!(m instanceof SkinnedMesh3D) || !m.geometry) continue;
            // A swinging skirt's live vertices move in Play — layer over its rest shape.
            const verts = r!.swing ? r!.swing.data.rest : m.geometry.vertices;
            inners.push({ geometry: { vertices: verts, indices: m.geometry.indices as Uint32Array }, jointIndices: m.jointIndices, jointWeights: m.jointWeights });
        }
        if (!inners.length) return raw;
        // Side mask (the trousers-web fix): a left-leg vertex never layers over / takes weights from the right sock.
        const body = this.host.getMesh(bodyMeshId);
        const sides = body instanceof SkinnedMesh3D && body.skeleton ? limbSidesFromNames(body.skeleton.data.joints.map((j) => j.name)) : undefined;
        const { garment, moved } = layerOver(raw, inners, LAYER_GAP, undefined, false, sides);
        return moved > 0 || garment.jointWeights.some((w, i) => w !== raw.jointWeights[i])
            ? { ...raw, geometry: { ...raw.geometry, vertices: garment.geometry.vertices }, jointIndices: garment.jointIndices, jointWeights: garment.jointWeights }
            : raw;
    }

    /** Re-layer the garments that sit OVER `slot` (after it changed / was removed), writing into their meshes in place. */
    private _relayerOuter(bodyMeshId: string, slot: ClothingSlot): void {
        for (const [outerSlot, inners] of LAYER_OVER) {
            if (!(inners as readonly string[]).includes(slot)) continue;
            const r = this._clothingRigs.get(`${bodyMeshId}:${outerSlot}`);
            const m = r ? this.host.getMesh(r.clothingMeshId) : null;
            if (!r?.raw || !(m instanceof SkinnedMesh3D) || this._isSkirtRig(r.params)) continue;
            const lay = this._layeredGarment(bodyMeshId, r.params, r.raw);
            if (lay.geometry.vertices.length !== m.geometry.vertices.length || lay.jointWeights.length !== m.jointWeights.length) continue;
            m.geometry.vertices.set(lay.geometry.vertices);
            m.jointIndices.set(lay.jointIndices); m.jointWeights.set(lay.jointWeights);
            m.gpuDirty = true; m.skinDirty = true;
            this._relayerOuter(bodyMeshId, outerSlot as ClothingSlot);   // a top over re-layered trousers
        }
    }

    /** Hem swing for a skirt (hemSwing > 0): data from the mesh's rest vertices + the hips bind position. */
    private _buildSkirtSwing(body: SkinnedMesh3D, params: ClothingParams, mesh: SkinnedMesh3D): ClothingRig['swing'] | undefined {
        if (!this._isSkirtRig(params)) return undefined;
        const amt = Math.max(0, Math.min(1.5, (params as BottomParams).hemSwing ?? 1));
        if (amt <= 0 || !body.skeleton) return undefined;
        const hi = body.skeleton.data.joints.findIndex(j => j.name === 'hips');
        if (hi < 0) return undefined;
        const ib = body.skeleton.data.joints[hi].inverseBindMatrix as unknown as ArrayLike<number>;
        const hb = mat4.invert(mat4.create(), Array.from(ib) as unknown as mat4);
        const V = mesh.geometry.vertices;
        let top = -Infinity, bot = Infinity;
        for (let i = 1; i < V.length; i += 12) { if (V[i] > top) top = V[i]; if (V[i] < bot) bot = V[i]; }
        const data = buildHemSwing(V, [hb[12], top, hb[14]], bot, hi);
        if (!data) return undefined;
        return { data, state: new HemSwing(1.9, 0.32, amt), hipsBind: [hb[12], hb[13], hb[14]], displaced: false };
    }

    /** One frame of a skirt's hem swing (from the per-frame skirt callback). True while it still moves. */
    private _stepSkirtSwing(rig: ClothingRig, playing: boolean, dt: number): boolean {
        const sw = rig.swing!;
        const mesh = rig.steer?.mesh && rig.steer.mesh.id === rig.clothingMeshId ? rig.steer.mesh : this.host.getMesh(rig.clothingMeshId);
        if (!(mesh instanceof SkinnedMesh3D) || !mesh.parent || !mesh.skeleton) return false;
        const V = mesh.geometry.vertices;
        if (V.length !== sw.data.rest.length) return false;
        if (!playing) {
            if (sw.displaced) { resetHemSwing(sw.data, V); sw.displaced = false; mesh.skinDirty = true; }
            sw.state.reset();
            return false;
        }
        const S = mesh.skeleton.skinMatrices;
        if (!S || (sw.data.hips + 1) * 16 > S.length) return false;
        const f = hipsSwingFrame(S, sw.data.hips * 16, sw.hipsBind);
        sw.state.update(f[0], f[1], f[2], f[3], f[4], f[5], f[6], dt);
        const st = sw.state;
        if (st.settled) {
            if (sw.displaced) { resetHemSwing(sw.data, V); sw.displaced = false; mesh.skinDirty = true; }
            return false;
        }
        applyHemSwing(sw.data, st.lx, st.lz, st.flare, V);
        sw.displaced = true; mesh.skinDirty = true;
        return true;
    }

    // Body-hiding mask: computed after the outfit settles (debounced), one probe pose per tick so a slider drag never
    // stalls; until it lands the body draws in full (drawIndices cleared at once — a stale mask could hide skin a new
    // garment no longer covers).
    private _maskJobs = new Map<string, { timer: ReturnType<typeof setTimeout> | null; gen: number }>();
    private _maskGen = 0;
    private _scheduleBodyMask(bodyMeshId: string, delayMs = 250): void {
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D)) return;
        if (body.drawIndices) { body.drawIndices = null; body.skinDirty = true; }
        const prev = this._maskJobs.get(bodyMeshId);
        if (prev?.timer) clearTimeout(prev.timer);
        const gen = ++this._maskGen;
        const rec = { timer: null as ReturnType<typeof setTimeout> | null, gen };
        this._maskJobs.set(bodyMeshId, rec);
        if (typeof setTimeout === 'undefined') return;
        rec.timer = setTimeout(() => this._runBodyMask(bodyMeshId, gen), delayMs);
    }
    private _runBodyMask(bodyMeshId: string, gen: number): void {
        const rec = this._maskJobs.get(bodyMeshId);
        if (!rec || rec.gen !== gen) return;
        rec.timer = null;
        const body = this.host.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton || !body.geometry) { this._maskJobs.delete(bodyMeshId); return; }
        const garments: MaskSkinned[] = [];
        for (const r of this._clothingRigs.values()) {
            if (r.bodyMeshId !== bodyMeshId || r.params.hideBody === false) continue;
            const m = this.host.getMesh(r.clothingMeshId);
            if (!(m instanceof SkinnedMesh3D) || !m.parent || !m.visible || m.material.opacity < 1) continue;
            garments.push({ verts: r.swing ? r.swing.data.rest : m.geometry.vertices, indices: m.geometry.indices as Uint32Array, ji: m.jointIndices, jw: m.jointWeights });
        }
        if (!garments.length) { this._maskJobs.delete(bodyMeshId); return; }
        const joints = body.skeleton.data.joints, ib = new Float32Array(joints.length * 16);
        joints.forEach((j, i) => ib.set(j.inverseBindMatrix as unknown as ArrayLike<number>, i * 16));
        const indices = body.geometry.indices as Uint32Array, verts = body.geometry.vertices;
        const job = createHideMaskJob({ verts, indices, ji: body.jointIndices, jw: body.jointWeights }, indices, garments,
            { names: joints.map(j => j.name), parents: joints.map(j => j.parentIndex ?? -1), inverseBind: ib, method: body.skeleton.skinningMethod });
        const tick = (): void => {
            const cur = this._maskJobs.get(bodyMeshId);
            if (!cur || cur.gen !== gen) return;   // superseded by a newer outfit change
            if (!job.step()) { cur.timer = setTimeout(tick, 0); return; }
            this._maskJobs.delete(bodyMeshId);
            const b = this.host.getMesh(bodyMeshId);
            if (!(b instanceof SkinnedMesh3D) || b.geometry.indices !== indices) return;   // the body was rebuilt meanwhile
            b.drawIndices = maskedIndices(indices, job.result()!);
            b.skinDirty = true;
            this.ctx.scheduleRender();
        };
        tick();
    }

    /** BODY-HIDING MASK on/off for a character (every garment's hideBody). True when every garment hides the body. */
    getHideBodyUnderClothes(bodyMeshId: string): boolean {
        for (const r of this._clothingRigs.values()) if (r.bodyMeshId === bodyMeshId && r.params.hideBody === false) return false;
        return true;
    }
    setHideBodyUnderClothes(bodyMeshId: string, on: boolean): void {
        for (const r of this._clothingRigs.values()) if (r.bodyMeshId === bodyMeshId) r.params = { ...r.params, hideBody: on ? undefined : false };
        const body = this.host.getMesh(bodyMeshId);
        if (!on) {
            const rec = this._maskJobs.get(bodyMeshId); if (rec?.timer) clearTimeout(rec.timer); this._maskJobs.delete(bodyMeshId);
            if (body instanceof SkinnedMesh3D && body.drawIndices) { body.drawIndices = null; body.skinDirty = true; }
        } else this._scheduleBodyMask(bodyMeshId, 0);
        this.ctx.scheduleRender();
    }
    /** SKIRT HEM SWING amount (0 = off … 1 default … 1.5) of the character's skirt; null without a skirt. */
    getSkirtSwing(bodyMeshId: string): number | null {
        const r = this._clothingRigs.get(`${bodyMeshId}:bottom`);
        return r && this._isSkirtRig(r.params) ? Math.max(0, Math.min(1.5, (r.params as BottomParams).hemSwing ?? 1)) : null;
    }
    setSkirtSwing(bodyMeshId: string, amount: number): void {
        const r = this._clothingRigs.get(`${bodyMeshId}:bottom`);
        if (!r || !this._isSkirtRig(r.params)) return;
        const a = Math.max(0, Math.min(1.5, Number.isFinite(amount) ? amount : 1));
        r.params = { ...r.params, hemSwing: a } as ClothingParams;
        const body = this.host.getMesh(bodyMeshId), mesh = this.host.getMesh(r.clothingMeshId);
        if (r.swing && mesh instanceof SkinnedMesh3D && r.swing.displaced) { resetHemSwing(r.swing.data, mesh.geometry.vertices); mesh.skinDirty = true; }
        r.swing = body instanceof SkinnedMesh3D && mesh instanceof SkinnedMesh3D ? this._buildSkirtSwing(body, r.params, mesh) : undefined;
        if (r.swing) this._ensureSkirtSteerCallback();
        this.ctx.scheduleRender();
    }

    removeClothing(bodyMeshId: string, slot: ClothingSlot): void {
        const rig = this._clothingRigs.get(`${bodyMeshId}:${slot}`);
        if (!rig) return;
        const m = this.host.getMesh(rig.clothingMeshId);
        m?.parent?.removeChild(m);
        this._clothingRigs.delete(`${bodyMeshId}:${slot}`);
        this._relayerOuter(bodyMeshId, slot);
        this._scheduleBodyMask(bodyMeshId);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    serializeClothingRigs(): { bodyMeshId: string; slot: ClothingSlot; params: ClothingParams; renderStyle?: RenderStyle }[] {
        return [...this._clothingRigs.values()].filter(r => !this._runtimeBodies.has(r.bodyMeshId)).map(r => {
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
        return [...this._hairRigs.values()].filter(r => !this._runtimeBodies.has(r.bodyMeshId)).map(r => {
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
            noteRasterContentWrite(tex);   // incremental autosave: this painted texture changed
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
        noteRasterContentWrite(tex);   // incremental autosave: this painted texture changed
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
        noteRasterContentWrite(tex);   // incremental autosave: this painted texture changed
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
        this._inheritCharacterStyle(mesh, body);
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
        return [...this._attachments.values()].filter(r => !this._runtimeBodies.has(r.bodyMeshId)).map(r => ({ id: r.id, bodyMeshId: r.bodyMeshId, placement: r.placement, params: r.params }));
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
        return buildBodyFitFrom({
            verts: g.vertices, ji, jw, indices: g.indices,
            joints: skel.data.joints.map((j) => ({ index: j.index, name: j.name, parentIndex: j.parentIndex, inverseBindMatrix: j.inverseBindMatrix })),
            armSurface, legSurface, torsoSurface,
        });
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
    /** Forget a body's params + surfaces (a runtime-only body — the Play auto player — must not reach serializeBodyParams). */
    unregisterBody(bodyMeshId: string): void {
        this._bodyParams.delete(bodyMeshId);
        this._bodyArmSurface.delete(bodyMeshId);
        this._bodyLegSurface.delete(bodyMeshId);
        this._bodyTorsoSurface.delete(bodyMeshId);
    }
    /** A COPY of the body's params. It used to return the live stored object: Frogmarks binds its body sliders to what
     *  this returns, so dragging a slider mutated our stored params in place, and setBodyParams' "unchanged?" check then
     *  compared the object with itself and skipped the regenerate — body sliders did nothing on an existing character
     *  (they only worked on the creation preview, which uses its own object). */
    getBodyParams(bodyMeshId: string): import('./body-generator').BodyParams | null { const p = this._bodyParams.get(bodyMeshId); return p ? { ...p } : null; }
    serializeBodyParams(): { bodyMeshId: string; params: import('./body-generator').BodyParams }[] {
        return [...this._bodyParams.entries()].filter(([bodyMeshId]) => !this._runtimeBodies.has(bodyMeshId)).map(([bodyMeshId, params]) => ({ bodyMeshId, params }));
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
        for (const r of this._faceRigs.values())     if (r.decalMeshId       === meshId || (r.feat && (r.feat.skinMeshId === meshId || r.feat.browMeshId === meshId))) return r.bodyMeshId;
        for (const r of this._hairRigs.values())      if (r.hairMeshId        === meshId) return r.bodyMeshId;
        for (const r of this._clothingRigs.values())  if (r.clothingMeshId    === meshId) return r.bodyMeshId;
        for (const r of this._attachments.values())   if (r.attachmentMeshId  === meshId) return r.bodyMeshId;
        return null;
    }

    /** A freshly (re)built overlay — hair / garment / charm — takes the CHARACTER's style flags from its body: toon
     *  shadows + rim light (film-look-and-toon-shadows.md). The body material persists them, but overlays are rebuilt
     *  from params on every slider change and on load, so without this the flags set by setCharacterToonShadows3D /
     *  setCharacterRimLight3D were lost on the next regenerate or reload. */
    private _inheritCharacterStyle(mesh: SkinnedMesh3D, body: SkinnedMesh3D): void {
        if (body.material.toonShadow) mesh.material.toonShadow = true;
        if (body.material.rimEnabled) mesh.material.rimEnabled = true;
        if (body.material.retroColor) mesh.material.retroColor = true;   // PS1 colour opt-in (scope 'optIn')
    }

    /** The overlay mesh ids of one character (eye decal + hair + garments) — for select-whole-character. */
    overlayMeshIds(bodyId: string): string[] {
        const ids: string[] = [];
        const eyes = this.getEyesMeshId(bodyId); if (eyes) ids.push(eyes);
        ids.push(...this.getFaceKitMeshIds(bodyId));   // face kit overlays (brows / mouth / shading)
        const hr = this._hairRigs.get(bodyId); if (hr) ids.push(hr.hairMeshId);
        for (const r of this._clothingRigs.values()) if (r.bodyMeshId === bodyId) ids.push(r.clothingMeshId);
        // Charms too (audit C8: they were missing, so select-whole-character and the character style toggles skipped them).
        for (const r of this._attachments.values()) if (r.bodyMeshId === bodyId && r.attachmentMeshId) ids.push(r.attachmentMeshId);
        return ids;
    }
}

// buildBodyFitFrom / BodyFitSource moved to the pure ./body-fit (worker-safe); re-exported for existing importers.
export { buildBodyFitFrom, type BodyFitSource } from './body-fit';
