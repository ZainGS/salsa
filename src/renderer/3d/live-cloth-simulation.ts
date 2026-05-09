/**
 * LiveClothSimulation — continuously running cloth physics for interactive
 * builder preview and scene-level wind animation.
 *
 * The handle owns a ClothSimulator and drives it via requestAnimationFrame.
 * Each frame it dispatches N simulation steps, submits an async GPU readback,
 * and fires onPositionsUpdate with the result.
 *
 * Steps-per-frame auto-tunes:
 *  - CONVERGING (4 steps/frame)  — until max vertex displacement < CONVERGE_EPSILON
 *  - CONVERGED  (2 steps/frame)  — keeps wind/gravity alive without burning budget
 *
 * Wind zones are evaluated on the CPU each frame: for each vertex, zone
 * contributions are accumulated and written to the simulator's per-vertex wind
 * buffer. This keeps the GPU shader simple and lets JS-side zone parameters
 * change without a shader recompile.
 */

import { ClothSimulator, DrapeProxy } from './cloth-simulator';
import { buildClothGeometry, buildDefaultActiveCells } from './cloth-geometry-builder';
import type { ClothGeometryResult } from './cloth-geometry-builder';
import type { ClothGridConfig, ClothPhysicsConfig, WindZone } from '../../scene-graph/shapes/cloth-mesh-3d';

const DEFAULT_PHYSICS: ClothPhysicsConfig = {
    gravity: 9.8, damping: 0.98, stiffness: 30, thickness: 0, solidifyRounded: false,
};

const STEPS_CONVERGING = 4;
const STEPS_CONVERGED  = 2;
const CONVERGE_EPSILON = 0.001;
/**
 * How many rAF frames between CPU readbacks during live simulation.
 * The pose pass updates the GPU vertex buffer every frame; readbacks only happen
 * for convergence detection, wind zone evaluation, and simState persistence.
 * Value of 8 → ~8 fps for those updates, ~60 fps visual smoothness.
 */
const READBACK_INTERVAL = 8;

/**
 * Small Y-axis bias (world units) applied to vertex B of a stitch when `side`
 * is specified. Breaks the symmetry of the flat cloth so the pleat folds in
 * the intended direction when the simulation starts from the rest pose.
 */
const STITCH_FOLD_BIAS = 0.02;


function _drapeStartY(
    proxy: DrapeProxy,
    flatPositions: Float32Array,
    config: ClothGridConfig,
    gravity: number,
): number {
    let proxyTop = 0;
    if (proxy.type === 'ground')       proxyTop = proxy.y ?? 0;
    else if (proxy.type === 'sphere')  proxyTop = (proxy.center?.[1] ?? 0) + proxy.radius;
    else if (proxy.type === 'box')     proxyTop = proxy.max[1];
    else return 0;

    let minY = Infinity;
    for (let vi = 0; vi < config.rows * config.cols; vi++) {
        const y = flatPositions[vi * 3 + 1];
        if (y < minY) minY = y;
    }
    const clearance = Math.sqrt(2 * gravity * 1.0);
    return proxyTop + clearance - minY;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Destroy a ClothSimulator only after any in-flight GPU readback settles.
 * Calling sim.destroy() while a mapAsync is pending causes WebGPU to throw
 * AbortError. By waiting for the promise to resolve OR reject first we let
 * the GPU finish the DMA transfer (or cancel it cleanly) before releasing
 * the buffer. The result of the readback is always discarded — this is purely
 * about safe resource teardown.
 */
function _destroyAfterReadback(
    sim:     ClothSimulator | null,
    pending: Promise<Float32Array> | null,
): void {
    if (!sim) return;
    if (pending) {
        pending.then(() => sim.destroy()).catch(() => sim.destroy());
    } else {
        sim.destroy();
    }
}

// ── LiveClothHandle ────────────────────────────────────────────────────────────

export interface LiveClothHandle {
    /**
     * Rebuild geometry + restart simulation.
     * Pass initPositions to continue from the current simulated pose instead of
     * resetting to flat — use this when adding/removing stitches so the cloth
     * doesn't snap back.
     */
    reset(
        grid:    ClothGridConfig,
        physics: ClothPhysicsConfig,
        mode:    'hang' | 'drape',
        proxy?:  DrapeProxy,
        initPositions?: Float32Array,
    ): void;

    /**
     * Hot-update gravity/damping/stiffness/wind uniforms without resetting positions.
     * Safe to call on every slider tick.
     */
    setPhysics(params: Partial<Pick<ClothPhysicsConfig,
        'gravity' | 'damping' | 'stiffness' | 'wind'>>): void;

    /**
     * Hot-swap the inverse-mass array without resetting positions.
     * Use this for pin/unpin so the cloth continues from its current pose.
     */
    setInverseMass(inverseMass: Float32Array): void;

    /**
     * Update the per-vertex bend-stiffness map. Values in [0, 1].
     * 0 = floppy (no bend resistance), 1 = stiff (full resistance).
     * Safe to call on every brush stroke tick.
     */
    setBendStiffness(map: Float32Array): void;

    /**
     * Replace the active wind zones evaluated each frame.
     * Pass [] to clear all spatial wind.
     */
    setWindZones(zones: WindZone[]): void;

    /**
     * Fired after each GPU readback with fresh vertex positions.
     * With GPU-side pose, readbacks happen every READBACK_INTERVAL frames
     * (for simState persistence, convergence detection, and wind zone evaluation)
     * rather than every frame. The pose pass keeps main-canvas rendering smooth.
     */
    onPositionsUpdate: ((positions: Float32Array) => void) | null;

    /**
     * STORAGE | VERTEX buffer written by the pose pass each step.
     * Set this as a vertex buffer override on Renderer3D to enable zero-copy rendering —
     * positions and normals are written directly on the GPU without a CPU roundtrip.
     * Null until the first step() completes, and when handle is not yet initialised.
     */
    readonly poseBuffer: GPUBuffer | null;

    /**
     * Fired when the pose buffer changes: receives the new buffer after reset(),
     * or null when the buffer is destroyed (handle.destroy() or reset() in progress).
     * Wire this to Renderer3D.setVertexBufferOverride() for seamless hot-swap.
     */
    onPoseBufferChange: ((buf: GPUBuffer | null) => void) | null;

    /** Current number of vertices (0 if not yet initialised). */
    readonly vertexCount: number;

    /** True while the rAF loop is running. */
    readonly running: boolean;

    pause():  void;
    resume(): void;

    /** Returns current positions via one GPU readback (~1–2 ms). */
    snapshot(): Promise<Float32Array>;

    /** Destroy all GPU resources and stop the loop. Always call on modal close. */
    destroy(): void;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class LiveClothSimulationImpl implements LiveClothHandle {
    onPositionsUpdate:  ((positions: Float32Array) => void) | null = null;
    onPoseBufferChange: ((buf: GPUBuffer | null) => void) | null = null;

    private _device:   GPUDevice;
    private _sim:      ClothSimulator | null = null;
    private _rafId:    number | null = null;
    private _paused    = false;
    private _destroyed = false;

    private _vertexCount  = 0;
    private _lastPositions: Float32Array | null = null;
    private _converged    = false;
    /**
     * Tracks the in-flight GPU readback promise. Storing the promise (rather
     * than just a boolean) lets reset() and destroy() defer ClothSimulator
     * destruction until mapAsync completes, avoiding WebGPU AbortError when a
     * buffer is destroyed while it's still being mapped.
     */
    private _pendingReadback: Promise<Float32Array> | null = null;

    /**
     * Incremented on every reset(). Pending readback callbacks capture this
     * value at dispatch time and early-exit if it has changed — prevents stale
     * GPU readback results from a previous reset from overwriting the new sim's
     * positions and causing visual "fighting".
     */
    private _simGeneration = 0;

    /** rAF frame counter — used to rate-limit CPU readbacks. */
    private _frameCount = 0;

    // Wind zones
    private _windZones:    WindZone[] = [];
    private _windTime      = 0;          // elapsed seconds (incremented each rAF)
    private _windForceBuf: Float32Array | null = null; // reused buffer, length = vc*4

    constructor(
        device:  GPUDevice,
        grid:    ClothGridConfig,
        physics: ClothPhysicsConfig,
        mode:    'hang' | 'drape',
        proxy:   DrapeProxy = { type: 'none' },
        initPositions?: Float32Array,
    ) {
        this._device = device;
        this._initSim(grid, physics, mode, proxy, initPositions);
        this._scheduleFrame();
    }

    get vertexCount(): number { return this._vertexCount; }
    get running():     boolean { return this._rafId !== null && !this._paused; }
    get poseBuffer():  GPUBuffer | null { return this._sim?.poseVertexBuf ?? null; }

    // ── Public API ──────────────────────────────────────────────────────────────

    reset(
        grid:    ClothGridConfig,
        physics: ClothPhysicsConfig,
        mode:    'hang' | 'drape',
        proxy:   DrapeProxy = { type: 'none' },
        initPositions?: Float32Array,
    ): void {
        if (this._destroyed) return;
        // Notify renderer to remove the old pose buffer before we destroy the sim.
        this.onPoseBufferChange?.(null);
        // Defer old-sim destruction until any in-flight mapAsync settles so we
        // don't destroy the GPU buffer while WebGPU is still reading from it.
        _destroyAfterReadback(this._sim, this._pendingReadback);
        this._sim            = null;
        this._pendingReadback = null;
        this._lastPositions  = null;
        this._converged      = false;
        this._windForceBuf   = null;
        this._frameCount     = 0;
        // Bump generation so stale readback callbacks from the old sim no-op.
        this._simGeneration++;
        this._initSim(grid, physics, mode, proxy, initPositions);
        // Re-read via cast to escape TS 5.7 private-method control-flow narrowing (null & Simulator = never).
        this.onPoseBufferChange?.((this._sim as ClothSimulator | null)?.poseVertexBuf ?? null);
    }

    setPhysics(params: Partial<Pick<ClothPhysicsConfig,
        'gravity' | 'damping' | 'stiffness' | 'wind'>>): void {
        this._sim?.setPhysicsParams(params);
        this._converged = false;
    }

    setInverseMass(inverseMass: Float32Array): void {
        this._sim?.setInverseMass(inverseMass);
        // Break convergence so pinned vertices visibly lock immediately.
        this._converged = false;
    }

    setBendStiffness(map: Float32Array): void {
        this._sim?.setBendStiffness(map);
    }

    setWindZones(zones: WindZone[]): void {
        this._windZones = zones;
        // Break convergence so zone changes are visible immediately
        this._converged = false;
    }

    pause():  void { this._paused = true; }
    resume(): void {
        if (this._paused) {
            this._paused = false;
            this._scheduleFrame();
        }
    }

    async snapshot(): Promise<Float32Array> {
        if (!this._sim) return new Float32Array(this._vertexCount * 3);
        return this._sim.readPositions();
    }

    destroy(): void {
        this._destroyed = true;
        if (this._rafId !== null) cancelAnimationFrame(this._rafId);
        this._rafId = null;
        this.onPoseBufferChange?.(null);
        _destroyAfterReadback(this._sim, this._pendingReadback);
        this._sim            = null;
        this._pendingReadback = null;
    }

    // ── Private ─────────────────────────────────────────────────────────────────

    private _initSim(
        grid:    ClothGridConfig,
        physics: ClothPhysicsConfig,
        mode:    'hang' | 'drape',
        proxy:   DrapeProxy,
        externalInitPositions?: Float32Array,
    ): void {
        const fullGrid: ClothGridConfig = {
            cols:             grid.cols           ?? 8,
            rows:             grid.rows           ?? 10,
            cellSize:         grid.cellSize       ?? 0.1,
            cornerRadius:     grid.cornerRadius   ?? 0,
            subdivisions:     grid.subdivisions   ?? 1,
            activeCells:      grid.activeCells?.length
                                  ? grid.activeCells
                                  : buildDefaultActiveCells(grid.cols ?? 8, grid.rows ?? 10),
            pinnedVertices:   grid.pinnedVertices ?? [],
            stitches:         grid.stitches,
            bendStiffnessMap: grid.bendStiffnessMap,
        };
        const fullPhysics: ClothPhysicsConfig = { ...DEFAULT_PHYSICS, ...physics };

        const result = buildClothGeometry(fullGrid);
        this._vertexCount  = result.vertexCount;
        this._windForceBuf = new Float32Array(result.vertexCount * 4); // pre-allocate

        let initPositions: Float32Array | undefined;

        if (externalInitPositions && externalInitPositions.length === result.vertexCount * 3) {
            // Continue from the provided pose (e.g. current simulated state before adding a stitch).
            initPositions = externalInitPositions;
        } else if (mode === 'drape') {
            const liftY = _drapeStartY(proxy, result.flatPositions, fullGrid, fullPhysics.gravity);
            if (liftY !== 0) {
                initPositions = new Float32Array(result.flatPositions);
                for (let vi = 0; vi < result.vertexCount; vi++) {
                    initPositions[vi * 3 + 1] += liftY;
                }
            }
        } else {
            // Starting from flat — apply stitch fold biases to break symmetry.
            // Each stitch with `side` gets a small ±Y nudge on vertex B so the
            // pleat folds in the intended direction when constraints start pulling.
            const stitches = fullGrid.stitches ?? [];
            const hasBias = stitches.some(s => s.side);
            if (hasBias) {
                initPositions = new Float32Array(result.flatPositions);
                for (const s of stitches) {
                    if (!s.side) continue;
                    const vi = s.b;
                    if (vi < 0 || vi >= result.vertexCount) continue;
                    const bias = s.side === 'front' ? STITCH_FOLD_BIAS : -STITCH_FOLD_BIAS;
                    initPositions[vi * 3 + 1] += bias;
                }
            }
        }

        const sim = new ClothSimulator(this._device);
        sim.init(result, fullPhysics, initPositions);

        if (mode === 'drape') {
            sim.setCollision(proxy);
        }

        this._sim = sim;
    }

    private _scheduleFrame(): void {
        if (this._destroyed || this._paused) return;
        this._rafId = requestAnimationFrame(() => {
            this._rafId = null;
            this._tick();
        });
    }

    private _tick(): void {
        if (this._destroyed || this._paused || !this._sim) return;

        this._frameCount++;
        // ~16 ms per rAF at 60 fps
        this._windTime += 1 / 60;

        // Evaluate wind zones and push per-vertex forces to the GPU.
        // Uses _lastPositions from the most recent readback (rate-limited below).
        if (this._windZones.length > 0 && this._windForceBuf && this._lastPositions) {
            this._evalWindZones();
            this._sim.setPerVertexWind(this._windForceBuf);
        }

        // All simulation steps + pose pass in one GPU submission.
        // The pose pass writes positions and normals directly into poseVertexBuf,
        // so the renderer sees the update this frame without any CPU roundtrip.
        const steps = this._converged ? STEPS_CONVERGED : STEPS_CONVERGING;
        this._sim.step(0.016, steps);

        // Rate-limited CPU readback — only needed for:
        //   • convergence detection
        //   • simState persistence (onPositionsUpdate → node.simState)
        //   • wind zone vertex position sampling
        // The pose buffer handles visual rendering between readbacks.
        if (!this._pendingReadback && this._frameCount % READBACK_INTERVAL === 0) {
            const capturedGen = this._simGeneration;
            this._pendingReadback = this._sim.readPositions();
            this._pendingReadback.then((positions) => {
                this._pendingReadback = null;
                if (this._destroyed || this._simGeneration !== capturedGen) return;

                if (this._lastPositions && !this._converged) {
                    let maxDelta = 0;
                    for (let i = 0; i < positions.length; i++) {
                        const d = Math.abs(positions[i] - this._lastPositions[i]);
                        if (d > maxDelta) maxDelta = d;
                    }
                    if (maxDelta < CONVERGE_EPSILON) this._converged = true;
                }
                this._lastPositions = positions;
                this.onPositionsUpdate?.(positions);
            }).catch(() => {
                // Readback was aborted (buffer destroyed mid-mapAsync). The
                // generation check above would have discarded it anyway — clear
                // the slot so the next tick can issue a fresh readback.
                this._pendingReadback = null;
            });
        }

        this._scheduleFrame();
    }

    /**
     * CPU-side wind zone evaluation: for each vertex, accumulate force contributions
     * from all zones. Writes into this._windForceBuf (vec4f per vertex, xyz = force).
     * Runs in <1 ms for typical cloth sizes (100–800 vertices).
     */
    private _evalWindZones(): void {
        const buf = this._windForceBuf!;
        const pos = this._lastPositions!;
        const vc  = this._vertexCount;
        const t   = this._windTime;

        buf.fill(0);

        for (const zone of this._windZones) {
            const pulse = (zone.pulsePeriod && zone.pulsePeriod > 0)
                ? 0.5 + 0.5 * Math.sin(2 * Math.PI * t / zone.pulsePeriod + (zone.pulsePhase ?? 0))
                : 1.0;

            const [wx, wy, wz] = zone.windVec;
            const cx = zone.center[0], cy = zone.center[1], cz = zone.center[2];

            if (zone.shape === 'sphere') {
                const r = zone.radius ?? 1;
                for (let vi = 0; vi < vc; vi++) {
                    const dx = pos[vi * 3    ] - cx;
                    const dy = pos[vi * 3 + 1] - cy;
                    const dz = pos[vi * 3 + 2] - cz;
                    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (dist > r) continue;
                    const atten = zone.falloff === 'linear' ? 1 - dist / r : 1.0;
                    const s = atten * pulse;
                    buf[vi * 4    ] += wx * s;
                    buf[vi * 4 + 1] += wy * s;
                    buf[vi * 4 + 2] += wz * s;
                }
            } else { // box
                const [hx, hy, hz] = zone.halfExtents ?? [1, 1, 1];
                for (let vi = 0; vi < vc; vi++) {
                    const lx = Math.abs(pos[vi * 3    ] - cx);
                    const ly = Math.abs(pos[vi * 3 + 1] - cy);
                    const lz = Math.abs(pos[vi * 3 + 2] - cz);
                    if (lx > hx || ly > hy || lz > hz) continue;
                    let atten = 1.0;
                    if (zone.falloff === 'linear') {
                        atten = Math.min(1 - lx / hx, Math.min(1 - ly / hy, 1 - lz / hz));
                    }
                    const s = atten * pulse;
                    buf[vi * 4    ] += wx * s;
                    buf[vi * 4 + 1] += wy * s;
                    buf[vi * 4 + 2] += wz * s;
                }
            }
        }
    }
}

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Create a live cloth simulation handle.
 * Pass initPositions to resume from a saved pose instead of starting from flat.
 * Returns null if the GPUDevice is unavailable.
 */
export function createLiveClothSimulation(
    device:  GPUDevice | null | undefined,
    grid:    ClothGridConfig,
    physics: ClothPhysicsConfig,
    mode:    'hang' | 'drape',
    proxy?:  DrapeProxy,
    initPositions?: Float32Array,
): LiveClothHandle | null {
    if (!device) return null;
    return new LiveClothSimulationImpl(device, grid, physics, mode, proxy ?? { type: 'none' }, initPositions);
}
