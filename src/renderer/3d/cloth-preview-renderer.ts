/**
 * ClothPreviewRenderer — renders a single Mesh3D into a secondary <canvas>
 * element using its own GPUCanvasContext, Renderer3D, and Camera3D.
 *
 * Designed for the Cloth Builder modal: attach it to a small canvas,
 * call render() after each positions update, and destroy() on close.
 *
 * The camera auto-fits to the mesh's world-space AABB on the first render.
 * Optional pointer-drag orbit is enabled by default.
 */

import { Camera3D } from './camera-3d';
import { Renderer3D } from './renderer-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';

export interface ClothPreviewOptions {
    /** RGBA background clear color. Default: dark neutral [0.08, 0.08, 0.10, 1]. */
    bgColor?: [number, number, number, number];
    /** Allow mouse/touch orbit on the preview canvas. Default: true. */
    orbitEnabled?: boolean;
}

export class ClothPreviewRenderer {
    private _device:   GPUDevice;
    private _canvas:   HTMLCanvasElement;
    private _ctx:      GPUCanvasContext;
    private _format:   GPUTextureFormat;
    private _camera:   Camera3D;
    private _renderer: Renderer3D;
    private _bgColor:  [number, number, number, number];
    private _destroyed = false;

    // Depth texture — recreated when canvas pixel size changes
    private _depthTex:  GPUTexture | null = null;
    private _depthView: GPUTextureView | null = null;
    private _lastW = 0;
    private _lastH = 0;

    // Auto-fit state (radius + orthoSize set once; target tracked every frame)
    private _fitted = false;

    // Orbit state (spherical coordinates around _orbitTarget)
    private _orbitEnabled: boolean;
    private _orbitTheta  = 0;          // +Z side — same direction as illustration camera
    private _orbitPhi    = Math.PI / 2; // horizontal — matches illustration camera (front view)
    private _orbitRadius = 1;
    private _orbitTarget: [number, number, number] = [0, 0, 0];
    private _pointerDown = false;

    constructor(device: GPUDevice, canvas: HTMLCanvasElement, opts: ClothPreviewOptions = {}) {
        this._device       = device;
        this._canvas       = canvas;
        this._bgColor      = opts.bgColor ?? [0.08, 0.08, 0.10, 1];
        this._orbitEnabled = opts.orbitEnabled ?? true;

        this._format = navigator.gpu?.getPreferredCanvasFormat() ?? 'bgra8unorm';

        const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
        if (!ctx) throw new Error('ClothPreviewRenderer: canvas does not support WebGPU');
        ctx.configure({ device, format: this._format, alphaMode: 'opaque' });
        this._ctx = ctx;

        this._camera   = new Camera3D({ position: [0, 2, 0], target: [0, 0, 0], mode: 'orthographic', orthoSize: 1, near: 0.01, far: 1000 });
        this._renderer = new Renderer3D(device, this._camera, this._format);
        this._renderer.forceDoubleSided = true;

        if (this._orbitEnabled) this._setupOrbit();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Render the mesh into the preview canvas.
     * Syncs canvas pixel dimensions to its CSS display size each frame so
     * the depth texture and aspect ratio are always correct.
     * Auto-fits the camera on the first call. Safe to call every frame.
     */
    render(mesh: Mesh3D): void {
        if (this._destroyed) return;

        // Sync canvas pixel size to CSS display size (accounts for devicePixelRatio).
        this._syncCanvasSize();

        if (!this._fitted) {
            this.autoFitCamera(mesh);
            this._fitted = true;
        } else {
            // Track mesh center every frame so the camera follows translation and simulation drift.
            // Radius and angles are preserved (user's orbit state).
            const c = this._worldAABBCenter(mesh);
            if (c) { this._orbitTarget = c; this._updateOrbitCamera(); }
        }

        const w = this._canvas.width  || 300;
        const h = this._canvas.height || 300;
        this._ensureDepthTexture(w, h);

        let swapTex: GPUTexture;
        try {
            swapTex = this._ctx.getCurrentTexture();
        } catch {
            return; // Canvas detached or context lost
        }

        const [br, bg, bb, ba] = this._bgColor;
        const encoder = this._device.createCommandEncoder();

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view:       swapTex.createView(),
                clearValue: { r: br, g: bg, b: bb, a: ba },
                loadOp:     'clear',
                storeOp:    'store',
            }],
            depthStencilAttachment: {
                view:              this._depthView!,
                depthClearValue:   1.0,
                depthLoadOp:       'clear',
                depthStoreOp:      'store',
                stencilClearValue: 0,
                stencilLoadOp:     'clear',
                stencilStoreOp:    'discard',
            },
        });

        this._renderer.drawMeshes(pass, [mesh], w, h);
        pass.end();

        this._device.queue.submit([encoder.finish()]);
    }

    /**
     * Position the camera so the mesh fills the preview.
     * Uses world-space AABB (localMatrix applied) so the camera target matches
     * where the renderer actually places the mesh.
     * Called automatically before the first render; call manually to reset.
     */
    autoFitCamera(mesh: Mesh3D): void {
        const bb = this._worldAABB(mesh);
        if (!bb) return;

        const { cx, cy, cz, extX, extY, extZ } = bb;
        const maxExt = Math.max(extX * 2, extY * 2, extZ * 2);

        this._orbitTarget = [cx, cy, cz];
        this._orbitRadius = Math.max(maxExt * 2, 0.5);
        // Match the illustration camera: look from +Z (theta=0), horizontal (phi=PI/2).
        // x_axis=(1,0,0) +X right, y_axis=(0,1,0) +Y up — same orientation as the 3D scene view.
        this._orbitTheta  = 0;
        this._orbitPhi    = Math.PI / 2;

        // Visible height = Y extent (hanging cloth) with Z extent as fallback for flat cloth.
        // Visible width = X extent (columns).
        const aspect = (this._canvas.width || 300) / (this._canvas.height || 300);
        const visibleH = Math.max(extY * 2, extZ * 2);
        const visibleW = extX * 2;
        this._camera.orthoSize = Math.max(visibleH, visibleW / aspect) / 2 * 1.3;

        this._updateOrbitCamera();
    }

    /** Re-trigger auto-fit on the next render call. */
    resetCamera(): void {
        this._fitted = false;
    }

    /**
     * Forward a GPU vertex buffer override to the internal Renderer3D.
     * When set, the preview renders from `buf` instead of the mesh's CPU-side
     * geometry — enabling zero-CPU-roundtrip preview via the live sim's poseVertexBuf.
     * Pass null to clear the override and fall back to mesh.geometry.
     */
    setVertexBufferOverride(meshId: string, buf: GPUBuffer | null): void {
        this._renderer.setVertexBufferOverride(meshId, buf);
    }

    destroy(): void {
        this._destroyed = true;
        this._depthTex?.destroy();
        this._depthTex  = null;
        this._depthView = null;
        this._renderer.destroy();
    }

    // ── Private ────────────────────────────────────────────────────────────────

    /** World-space AABB of a mesh (applies localMatrix). Returns null if no vertices. */
    private _worldAABB(mesh: Mesh3D): { cx: number; cy: number; cz: number; extX: number; extY: number; extZ: number } | null {
        const geom = mesh.geometry;
        if (!geom || geom.vertices.length === 0) return null;
        // Vertex stride: pos(3) + normal(3) + uv(2) + tangent(4) = 12 floats.
        const m = mesh.localMatrix as unknown as Float32Array;
        const v = geom.vertices;
        let wx0 = Infinity, wy0 = Infinity, wz0 = Infinity;
        let wx1 = -Infinity, wy1 = -Infinity, wz1 = -Infinity;
        for (let i = 0; i < v.length; i += 12) {
            const lx = v[i], ly = v[i + 1], lz = v[i + 2];
            const wx = m[0]*lx + m[4]*ly + m[8]*lz  + m[12];
            const wy = m[1]*lx + m[5]*ly + m[9]*lz  + m[13];
            const wz = m[2]*lx + m[6]*ly + m[10]*lz + m[14];
            if (wx < wx0) wx0 = wx; if (wx > wx1) wx1 = wx;
            if (wy < wy0) wy0 = wy; if (wy > wy1) wy1 = wy;
            if (wz < wz0) wz0 = wz; if (wz > wz1) wz1 = wz;
        }
        return {
            cx: (wx0 + wx1) / 2, cy: (wy0 + wy1) / 2, cz: (wz0 + wz1) / 2,
            extX: (wx1 - wx0) / 2, extY: (wy1 - wy0) / 2, extZ: (wz1 - wz0) / 2,
        };
    }

    /** Center of world-space AABB — used for per-frame tracking. */
    private _worldAABBCenter(mesh: Mesh3D): [number, number, number] | null {
        const bb = this._worldAABB(mesh);
        return bb ? [bb.cx, bb.cy, bb.cz] : null;
    }

    /** Resize the canvas backing store to match its CSS display size. */
    private _syncCanvasSize(): void {
        const dpr = window.devicePixelRatio || 1;
        const rect = this._canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width  * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (this._canvas.width !== w || this._canvas.height !== h) {
            this._canvas.width  = w;
            this._canvas.height = h;
        }
    }

    private _ensureDepthTexture(w: number, h: number): void {
        if (this._lastW === w && this._lastH === h && this._depthTex) return;
        this._depthTex?.destroy();
        this._depthTex = this._device.createTexture({
            size:   [w, h, 1],
            format: 'depth24plus-stencil8',
            usage:  GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._depthView = this._depthTex.createView();
        this._lastW = w;
        this._lastH = h;
    }

    private _updateOrbitCamera(): void {
        const { _orbitTheta: t, _orbitPhi: p, _orbitRadius: r, _orbitTarget: tgt } = this;
        const sinP = Math.sin(p);
        const x = tgt[0] + r * sinP * Math.sin(t);
        const y = tgt[1] + r * Math.cos(p);
        const z = tgt[2] + r * sinP * Math.cos(t);
        this._camera.lookAt(x, y, z, tgt[0], tgt[1], tgt[2]);
    }

    private _setupOrbit(): void {
        const canvas = this._canvas;

        const onDown = (e: PointerEvent) => {
            this._pointerDown = true;
            e.preventDefault();
            canvas.setPointerCapture(e.pointerId);
        };

        const onMove = (e: PointerEvent) => {
            if (!this._pointerDown) return;
            // movementX/Y are raw hardware deltas — unaffected by canvas
            // position, CSS transforms, scroll, or devicePixelRatio.
            this._orbitTheta -= e.movementX * 0.008;
            this._orbitPhi = Math.max(0.05, Math.min(Math.PI - 0.05,
                this._orbitPhi - e.movementY * 0.008));
            this._updateOrbitCamera();
        };

        const onUp = () => { this._pointerDown = false; };

        canvas.addEventListener('pointerdown',   onDown);
        canvas.addEventListener('pointermove',   onMove);
        canvas.addEventListener('pointerup',     onUp);
        canvas.addEventListener('pointercancel', onUp);
    }
}
