/**
 * ViewGizmo — Navigation gizmo overlay for 3D camera control.
 *
 * Renders a small fixed-positioned 2D canvas anchored to the top-right corner
 * of the WebGPU canvas, showing the live XYZ camera orientation.
 * - Drag anywhere on the widget to orbit the camera.
 * - Click an axis handle to snap to that standard view.
 */

import { Camera3D } from './camera-3d';
import { OrbitController } from './orbit-controller';
import { addZonelessListener, removeZonelessListener } from '../util/zoneless-listeners';

const SIZE  = 60;              // gizmo canvas size in px (was 120 — 50% smaller). All tuned pixel values
const SCALE = SIZE / 120;      // below scale off the original 120px design, so changing SIZE stays proportional.
const CX    = SIZE / 2;
const CY    = SIZE / 2;
const SPOKE = SIZE / 2 - 18 * SCALE;   // axis length (= 0.35·SIZE; keeps the spoke:handle proportion)
const R_POS = 13 * SCALE;              // +axis handle radius
const R_NEG = 7  * SCALE;              // -axis handle radius
const PAD   = 12;   // px from canvas edge (screen inset — independent of gizmo size)

interface AxisDef {
    dir:      [number, number, number];
    label:    string;
    color:    string;
    dimColor: string;
    snapPos:  [number, number]; // [azimuth, elevation]
    snapNeg:  [number, number];
}

// azimuth/elevation convention from OrbitController.applySpherical():
//   pos = target + radius * [cosEl*sin(az), sin(el), cosEl*cos(az)]
const AXES: AxisDef[] = [
    { dir: [1,0,0], label: 'X', color: '#e05454', dimColor: '#7a2a2a',
      snapPos: [ Math.PI / 2, 0],   snapNeg: [-Math.PI / 2, 0] },
    { dir: [0,1,0], label: 'Y', color: '#4ab04a', dimColor: '#265a26',
      snapPos: [0,  Math.PI / 2 - 0.05], snapNeg: [0, -(Math.PI / 2 - 0.05)] },
    { dir: [0,0,1], label: 'Z', color: '#4a7ee0', dimColor: '#1e3a7a',
      snapPos: [0, 0],              snapNeg: [Math.PI, 0] },
];

interface Proj { sx: number; sy: number; depth: number; }

/** Where the nav gizmo sits, relative to the WebGPU canvas's on-screen rect. */
export interface ViewGizmoPosition {
    /** Which corner to anchor to. Default 'top-left'. */
    corner?: 'top-left' | 'top-right' | 'top-center';
    /** Inset (px) from the anchored side edge — left for top-left, right for top-right. Default PAD (12). */
    offsetX?: number;
    /** Inset (px) from the top edge. Default PAD (12). Lets the host clear an overlay toolbar. */
    offsetY?: number;
}

export class ViewGizmo {
    private _canvas3d: HTMLCanvasElement;  // the WebGPU canvas (for bounds tracking)
    private _el: HTMLCanvasElement;        // our 2D overlay canvas
    private _ctx: CanvasRenderingContext2D;
    private _camera: Camera3D;
    private _orbit: OrbitController;
    private _onChanged: () => void;

    private _dragging = false;
    private _lastX = 0;
    private _lastY = 0;
    private _startX = 0;
    private _startY = 0;
    private _hasMoved = false;
    private _ro: ResizeObserver;
    private _pos: Required<ViewGizmoPosition> = { corner: 'top-left', offsetX: PAD, offsetY: PAD + 14 };

    constructor(
        canvas3d: HTMLCanvasElement,
        camera: Camera3D,
        orbit: OrbitController,
        onChanged: () => void,
        position?: ViewGizmoPosition,
    ) {
        this._canvas3d   = canvas3d;
        this._camera     = camera;
        this._orbit      = orbit;
        this._onChanged  = onChanged;
        if (position) this._pos = { ...this._pos, ...position };

        // Build overlay canvas and attach to document.body at fixed position
        const el = document.createElement('canvas');
        el.width  = SIZE;
        el.height = SIZE;
        el.style.cssText = [
            'position:fixed',
            'z-index:9000',
            'cursor:grab',
            'touch-action:none',
            'user-select:none',
            'border-radius:50%',
        ].join(';');
        document.body.appendChild(el);
        this._el  = el;
        this._ctx = el.getContext('2d')!;

        this._reposition();

        // Track canvas resize / scroll / layout changes
        this._ro = new ResizeObserver(() => this._reposition());
        this._ro.observe(canvas3d);
        window.addEventListener('scroll', this._reposition, true);
        window.addEventListener('resize', this._reposition);

        // Use the element itself for move/up — pointer capture routes all events here. Zoneless so hovering
        // the view gizmo doesn't wake Angular CD on every pointermove (see zoneless-listeners).
        addZonelessListener(el, 'pointerdown',   this._onDown);
        addZonelessListener(el, 'pointermove',   this._onMove);
        addZonelessListener(el, 'pointerup',     this._onUp);
        addZonelessListener(el, 'pointercancel', this._onUp);
    }

    // ── Position tracking ──────────────────────────────────────────

    /** Change the gizmo's placement at runtime (host layout / panel changes). */
    setPosition(position: ViewGizmoPosition): void {
        this._pos = { ...this._pos, ...position };
        this._reposition();
    }

    private _reposition = (): void => {
        const r = this._canvas3d.getBoundingClientRect();
        const { corner, offsetX, offsetY } = this._pos;
        // Position relative to the WebGPU canvas's on-screen rect. offsetX/offsetY let the host inset past an
        // overlay toolbar/panel so the gizmo lands in the VISIBLE canvas area.
        this._el.style.top  = (r.top + offsetY) + 'px';
        const left = corner === 'top-right'  ? r.right - SIZE - offsetX
                   : corner === 'top-center' ? r.left + (r.width - SIZE) / 2
                   : /* top-left */            r.left + offsetX;
        this._el.style.left = left + 'px';
    };

    // ── Event handlers ─────────────────────────────────────────────

    private _onDown = (e: PointerEvent): void => {
        e.stopPropagation();
        this._dragging = true;
        this._hasMoved = false;
        this._lastX  = e.clientX;
        this._lastY  = e.clientY;
        this._startX = e.clientX;
        this._startY = e.clientY;
        this._el.style.cursor = 'grabbing';
        this._el.setPointerCapture(e.pointerId);
        // Stop any in-flight damping so it doesn't fight the gizmo drag.
        this._orbit.stopDamping();
    };

    private _onMove = (e: PointerEvent): void => {
        if (!this._dragging) return;
        const dx = e.clientX - this._lastX;
        const dy = e.clientY - this._lastY;
        this._lastX = e.clientX;
        this._lastY = e.clientY;

        const totalDx = e.clientX - this._startX;
        const totalDy = e.clientY - this._startY;
        if (!this._hasMoved && (totalDx * totalDx + totalDy * totalDy) > 16) {
            this._hasMoved = true;
        }

        if (this._hasMoved) {
            this._orbit.azimuth   -= dx * this._orbit.orbitSpeed;
            this._orbit.elevation += dy * this._orbit.orbitSpeed;
            this._orbit.elevation  = Math.max(
                this._orbit.minElevation,
                Math.min(this._orbit.maxElevation, this._orbit.elevation),
            );
            this._orbit.applySpherical();
            this._onChanged();
            this.draw();
        }
    };

    private _onUp = (e: PointerEvent): void => {
        if (!this._dragging) return;
        this._dragging = false;
        this._el.style.cursor = 'grab';

        if (!this._hasMoved) {
            const snap = this._hitSnap(e.offsetX, e.offsetY);
            if (snap) {
                this._orbit.setSpherical(snap[0], snap[1]);
                this._onChanged();
                this.draw();
            }
        }
    };

    // ── Projection ────────────────────────────────────────────────

    private _project(dir: [number, number, number]): Proj {
        const v = this._camera.getViewMatrix() as unknown as Float32Array;
        // Multiply direction by the rotation part of the view matrix (column-major, 3×3 upper-left)
        const sx    =  v[0]*dir[0] + v[4]*dir[1] + v[8] *dir[2];
        const sy    = -(v[1]*dir[0] + v[5]*dir[1] + v[9] *dir[2]); // negate: screen-Y is down
        const depth =  v[2]*dir[0] + v[6]*dir[1] + v[10]*dir[2];
        return { sx, sy, depth };
    }

    private _hitSnap(mx: number, my: number): [number, number] | null {
        for (const ax of AXES) {
            for (const pos of [true, false]) {
                const d  = pos ? ax.dir : [-ax.dir[0], -ax.dir[1], -ax.dir[2]] as [number,number,number];
                const p  = this._project(d);
                const tx = CX + p.sx * SPOKE;
                const ty = CY + p.sy * SPOKE;
                const r  = (pos ? R_POS : R_NEG) + 3 * SCALE;
                if ((mx - tx)**2 + (my - ty)**2 <= r*r) return pos ? ax.snapPos : ax.snapNeg;
            }
        }
        return null;
    }

    // ── Drawing ───────────────────────────────────────────────────

    draw(): void {
        const ctx = this._ctx;
        ctx.clearRect(0, 0, SIZE, SIZE);

        ctx.save();
        ctx.beginPath();
        ctx.arc(CX, CY, SIZE / 2 - 1, 0, Math.PI * 2);
        ctx.clip();

        // Background
        ctx.fillStyle = 'rgba(16,18,26,0.72)';
        ctx.fillRect(0, 0, SIZE, SIZE);

        type LineItem   = { kind:'line';   x:number; y:number; color:string; depth:number; };
        type SphereItem = { kind:'sphere'; x:number; y:number; r:number; color:string; depth:number; label?:string; };
        const items: (LineItem | SphereItem)[] = [];

        for (const ax of AXES) {
            const neg: [number,number,number] = [-ax.dir[0], -ax.dir[1], -ax.dir[2]];
            const pp = this._project(ax.dir);
            const np = this._project(neg);
            const tx  = CX + pp.sx * SPOKE,  ty  = CY + pp.sy * SPOKE;
            const tx2 = CX + np.sx * SPOKE,  ty2 = CY + np.sy * SPOKE;

            items.push({ kind:'line',   x:tx,  y:ty,  color:ax.color,    depth:pp.depth });
            items.push({ kind:'line',   x:tx2, y:ty2, color:ax.dimColor,  depth:np.depth });
            items.push({ kind:'sphere', x:tx,  y:ty,  r:R_POS, color:ax.color,    depth:pp.depth, label:ax.label });
            items.push({ kind:'sphere', x:tx2, y:ty2, r:R_NEG, color:ax.dimColor, depth:np.depth });
        }

        items.sort((a, b) => a.depth - b.depth);

        // Lines
        for (const it of items) {
            if (it.kind !== 'line') continue;
            ctx.globalAlpha = it.depth < 0 ? 0.35 : 0.85;
            ctx.strokeStyle = it.color;
            ctx.lineWidth   = 2.5 * SCALE;
            ctx.beginPath();
            ctx.moveTo(CX, CY);
            ctx.lineTo(it.x, it.y);
            ctx.stroke();
        }

        // Spheres
        for (const it of items) {
            if (it.kind !== 'sphere') continue;
            const behind = it.depth < 0;
            ctx.globalAlpha = behind ? 0.38 : 1;

            if (!behind) {
                ctx.fillStyle = 'rgba(0,0,0,0.28)';
                ctx.beginPath();
                ctx.arc(it.x + 1.5 * SCALE, it.y + 2 * SCALE, it.r, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.fillStyle = it.color;
            ctx.beginPath();
            ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
            ctx.fill();

            if (!behind) {
                const g = ctx.createRadialGradient(it.x - it.r*0.3, it.y - it.r*0.35, it.r*0.05, it.x, it.y, it.r);
                g.addColorStop(0, 'rgba(255,255,255,0.36)');
                g.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
                ctx.fill();
            }

            if ((it as SphereItem).label) {
                ctx.globalAlpha = behind ? 0.38 : 1;
                ctx.fillStyle   = '#fff';
                ctx.font        = `bold ${Math.round(it.r * 0.88)}px system-ui,sans-serif`;
                ctx.textAlign   = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText((it as SphereItem).label!, it.x, it.y + 0.5);
            }
        }

        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.arc(CX, CY, SIZE / 2 - 1.5, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
    }

    destroy(): void {
        this._ro.disconnect();
        window.removeEventListener('scroll',   this._reposition, true);
        window.removeEventListener('resize',   this._reposition);
        removeZonelessListener(this._el, 'pointerdown',   this._onDown);
        removeZonelessListener(this._el, 'pointermove',   this._onMove);
        removeZonelessListener(this._el, 'pointerup',     this._onUp);
        removeZonelessListener(this._el, 'pointercancel', this._onUp);
        this._el.remove();
    }
}
