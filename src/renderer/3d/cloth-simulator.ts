/**
 * ClothSimulator — GPU compute-based cloth physics.
 *
 * Four-pass pipeline per step:
 *   1. Verlet integration      (parallel, one thread per vertex)
 *   2. Constraint solve        (parallel, graph-colored: one pass per color group per iteration)
 *   3. Collision response      (parallel, one thread per vertex)
 *   4. Pose update             (parallel: writes positions + normals into the VERTEX|STORAGE buffer)
 *
 * The parallel constraint pass (vs the old serial single-thread approach) uses graph coloring
 * so constraints in the same color group have no shared vertices — each thread writes to
 * distinct memory, no atomics needed. The simulator dispatches one compute pass per
 * (iteration, color group) pair using dynamic uniform offsets.
 *
 * The pose pass eliminates the GPU→CPU→GPU readback roundtrip for live rendering.
 * After each step(), simulated positions and recomputed normals are written directly
 * into poseVertexBuf (GPUBufferUsage.STORAGE | VERTEX). Renderer3D can use this
 * buffer as a vertex buffer override, bypassing mapAsync/setGeometry entirely.
 *
 * Usage:
 *   const sim = new ClothSimulator(gpuDevice);
 *   sim.init(geometryResult, physicsConfig);
 *   sim.setCollision({ type: 'sphere', center: [0, 0, 0], radius: 0.5 });
 *   const positions = await sim.runToConvergence('hang', gridConfig);
 *   sim.destroy();
 */

import {
  CLOTH_INTEGRATE_SHADER,
  CLOTH_CONSTRAIN_SHADER,
  CLOTH_COLLIDE_SHADER,
  CLOTH_POSE_SHADER,
} from './shaders/cloth-shaders';
import type { ClothGeometryResult } from './cloth-geometry-builder';
import type { ClothGridConfig, ClothPhysicsConfig } from '../../scene-graph/shapes/cloth-mesh-3d';

// ── Proxy types ──────────────────────────────────────────────────────────────

export type DrapeProxy =
  | { type: 'none' }
  | { type: 'ground'; y?: number }
  | { type: 'sphere'; center?: [number, number, number]; radius: number }
  | { type: 'box'; min: [number, number, number]; max: [number, number, number] };

// ── Sizes / constants ─────────────────────────────────────────────────────────

/** Integrate params struct size (8 floats = 32 bytes). */
const INTEGRATE_PARAMS_SIZE = 32;
/** Constrain params struct size (4 u32 = 16 bytes). */
const CONSTRAIN_PARAMS_SIZE = 16;
/** Collision params struct size (4 x vec4 = 64 bytes). */
const COLLISION_PARAMS_SIZE = 64;
/** Pose params struct size (1 u32, padded to 16 bytes). */
const POSE_PARAMS_SIZE = 16;
/** 4 bytes per u32/f32. */
const F32 = 4;
/** 16 bytes per vec4f. */
const VEC4 = 16;
/** Bytes per packed constraint (a: u32, b: u32, restLen: f32, _pad: u32). */
const CONSTRAINT_STRIDE = 16;
/** GPU workgroup size for per-vertex passes. */
const WG = 64;
/**
 * Byte stride between per-group constrain param slots in the dynamic-offset
 * uniform buffer. Must be >= minUniformBufferOffsetAlignment (256 on all
 * WebGPU implementations).
 */
const CON_PARAM_STRIDE = 256;

// ── ClothSimulator ────────────────────────────────────────────────────────────

export class ClothSimulator {
  private device: GPUDevice;

  // Pipelines (lazy-initialised on first init() call)
  private integratePipeline: GPUComputePipeline | null = null;
  private constrainPipeline: GPUComputePipeline | null = null;
  private collidePipeline:   GPUComputePipeline | null = null;
  private posePipeline:      GPUComputePipeline | null = null;

  // BGLs
  private integrateBGL: GPUBindGroupLayout | null = null;
  private constrainBGL: GPUBindGroupLayout | null = null;
  private collideBGL:   GPUBindGroupLayout | null = null;
  private poseBGL:      GPUBindGroupLayout | null = null;

  // Simulation buffers (allocated per init)
  private positionBuf:        GPUBuffer | null = null;
  private prevPosBuf:         GPUBuffer | null = null;
  private invMassBuf:         GPUBuffer | null = null;
  private constraintBuf:      GPUBuffer | null = null;
  private readbackBuf:        GPUBuffer | null = null;
  private bendStiffnessBuf:   GPUBuffer | null = null;
  private perVertexWindBuf:   GPUBuffer | null = null;
  private neighborBuf:        GPUBuffer | null = null;

  // Param buffers
  private intParamsBuf:       GPUBuffer | null = null;
  /** Per-color-group constrain params, accessed with dynamic offsets (stride = CON_PARAM_STRIDE). */
  private conColorParamsBuf:  GPUBuffer | null = null;
  private colParamsBuf:       GPUBuffer | null = null;
  private poseParamsBuf:      GPUBuffer | null = null;

  /**
   * STORAGE | VERTEX buffer written by the pose pass each step.
   * Renderer3D can use this as a vertex buffer override to skip the
   * GPU→CPU→GPU roundtrip during live cloth animation.
   */
  poseVertexBuf: GPUBuffer | null = null;

  // Bind groups (rebuilt per init)
  private integrateBG: GPUBindGroup | null = null;
  private constrainBG: GPUBindGroup | null = null;
  private collideBG:   GPUBindGroup | null = null;
  private poseBG:      GPUBindGroup | null = null;

  // Per-color-group dispatch ranges (indices into the global edges array)
  private _colorRanges: { start: number; end: number }[] = [];

  // State
  private _vertexCount    = 0;
  private _constraintCount = 0;
  private _bendStart      = 0;
  private _stitchStart    = 0;
  private _physics: ClothPhysicsConfig | null = null;
  private _proxy: DrapeProxy = { type: 'none' };
  private _ready = false;

  constructor(device: GPUDevice) {
    this.device = device;
    this._buildPipelines();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load geometry and physics config into the simulator.
   * Must be called before any step or runToConvergence call.
   */
  init(
    result: ClothGeometryResult,
    physics: ClothPhysicsConfig,
    initPositions?: Float32Array,
  ): void {
    this._destroyBuffers();

    const vc = result.vertexCount;
    const cc = result.constraintGraph.edges.length;
    this._vertexCount     = vc;
    this._constraintCount = cc;
    this._bendStart       = result.constraintGraph.bendStart;
    this._stitchStart     = result.constraintGraph.stitchStart;
    this._physics         = physics;

    // Build flat per-color-group dispatch ranges in type order:
    // structural colors → shear colors → bend colors → stitch colors.
    this._colorRanges = [
      ...result.constraintGraph.structColorRanges,
      ...result.constraintGraph.shearColorRanges,
      ...result.constraintGraph.bendColorRanges,
      ...result.constraintGraph.stitchColorRanges,
    ];

    const dev = this.device;

    // ── Position buffers ─────────────────────────────────────────────────────
    const posData = new Float32Array(vc * 4);
    const src = initPositions ?? result.flatPositions;
    for (let vi = 0; vi < vc; vi++) {
      posData[vi * 4    ] = src[vi * 3    ];
      posData[vi * 4 + 1] = src[vi * 3 + 1];
      posData[vi * 4 + 2] = src[vi * 3 + 2];
    }

    this.positionBuf = this._buf(posData.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, posData);
    this.prevPosBuf  = this._buf(posData.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, posData);

    // ── Inverse-mass buffer ───────────────────────────────────────────────────
    this.invMassBuf = this._buf(vc * F32,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, result.inverseMass);

    // ── Constraint buffer ─────────────────────────────────────────────────────
    const cData = new Uint32Array(cc * 4);
    const edges = result.constraintGraph.edges;
    for (let ci = 0; ci < cc; ci++) {
      const e = edges[ci];
      cData[ci * 4    ] = e.a;
      cData[ci * 4 + 1] = e.b;
      const view = new DataView(cData.buffer);
      view.setFloat32((ci * 4 + 2) * 4, e.restLength, true);
      cData[ci * 4 + 3] = 0;
    }
    this.constraintBuf = this._buf(Math.max(cc * CONSTRAINT_STRIDE, 16), GPUBufferUsage.STORAGE, cData);

    // ── Bend-stiffness buffer ─────────────────────────────────────────────────
    this.bendStiffnessBuf = this._buf(Math.max(vc * F32, 4),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, result.bendStiffness);

    // ── Per-vertex wind buffer ────────────────────────────────────────────────
    this.perVertexWindBuf = this._buf(Math.max(vc * VEC4, VEC4),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);

    // ── Neighbor buffer (for pose normal computation) ─────────────────────────
    this.neighborBuf = this._buf(
      Math.max(result.neighborBuf.byteLength, 16),
      GPUBufferUsage.STORAGE,
      result.neighborBuf,
    );

    // ── Integrate params buffer ───────────────────────────────────────────────
    this.intParamsBuf = dev.createBuffer({
      size: INTEGRATE_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._writeIntegrateParams(physics);

    // ── Constrain per-color-group params buffer (dynamic offset) ─────────────
    // Each slot occupies CON_PARAM_STRIDE bytes (256) for alignment.
    // Slot gi stores: { groupStart, groupEnd, bendStart, stitchStart }.
    const numGroups = this._colorRanges.length;
    const conParamData = new Uint32Array(Math.max(numGroups, 1) * (CON_PARAM_STRIDE / F32));
    for (let gi = 0; gi < numGroups; gi++) {
      const base = gi * (CON_PARAM_STRIDE / F32);
      conParamData[base    ] = this._colorRanges[gi].start;
      conParamData[base + 1] = this._colorRanges[gi].end;
      conParamData[base + 2] = this._bendStart;
      conParamData[base + 3] = this._stitchStart;
    }
    this.conColorParamsBuf = this._buf(
      Math.max(numGroups, 1) * CON_PARAM_STRIDE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      conParamData,
    );

    // ── Collision params buffer ───────────────────────────────────────────────
    this.colParamsBuf = dev.createBuffer({
      size: COLLISION_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._writeCollisionParams(this._proxy);

    // ── Readback buffer ───────────────────────────────────────────────────────
    this.readbackBuf = dev.createBuffer({
      size: vc * VEC4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // ── Pose vertex buffer (STORAGE | VERTEX, initialised from flat geometry) ─
    this.poseVertexBuf = this._buf(
      result.geometry.vertices.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      result.geometry.vertices,
    );

    // ── Pose params buffer ────────────────────────────────────────────────────
    const poseParamData = new Uint32Array(POSE_PARAMS_SIZE / F32);
    poseParamData[0] = vc;
    this.poseParamsBuf = this._buf(POSE_PARAMS_SIZE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, poseParamData);

    // ── Build bind groups ─────────────────────────────────────────────────────
    this._buildBindGroups();

    this._ready = true;
  }

  /** Pin additional vertices (set inverseMass = 0 in the GPU buffer). */
  pinVertices(indices: number[]): void {
    if (!this.invMassBuf || !this._ready) return;
    const data = new Float32Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
      this.device.queue.writeBuffer(this.invMassBuf, indices[i] * F32, data.subarray(i, i + 1));
    }
  }

  setCollision(proxy: DrapeProxy): void {
    this._proxy = proxy;
    if (this._ready && this.colParamsBuf) {
      this._writeCollisionParams(proxy);
    }
  }

  setInverseMass(inverseMass: Float32Array): void {
    if (!this._ready || !this.invMassBuf) return;
    const upload = inverseMass.length >= this._vertexCount
      ? inverseMass.subarray(0, this._vertexCount)
      : (() => {
          const padded = new Float32Array(this._vertexCount).fill(1.0);
          padded.set(inverseMass);
          return padded;
        })();
    this.device.queue.writeBuffer(this.invMassBuf, 0, upload);
  }

  setBendStiffness(map: Float32Array): void {
    if (!this._ready || !this.bendStiffnessBuf) return;
    const upload = map.length >= this._vertexCount
      ? map.subarray(0, this._vertexCount)
      : (() => {
          const padded = new Float32Array(this._vertexCount).fill(1.0);
          padded.set(map);
          return padded;
        })();
    this.device.queue.writeBuffer(this.bendStiffnessBuf, 0, upload);
  }

  setPerVertexWind(forces: Float32Array): void {
    if (!this._ready || !this.perVertexWindBuf) return;
    const expected = this._vertexCount * 4;
    const upload = forces.length >= expected ? forces.subarray(0, expected) : forces;
    this.device.queue.writeBuffer(this.perVertexWindBuf, 0, upload);
  }

  /**
   * Submit stepCount simulation steps to the GPU queue, followed by one pose
   * pass that writes updated positions and normals to poseVertexBuf.
   * All steps and the pose pass are encoded into a single command encoder and
   * submitted with one queue.submit() call.
   */
  step(dt = 0.016, stepCount = 1): void {
    if (!this._ready) throw new Error('ClothSimulator: call init() before step()');

    const enc = this.device.createCommandEncoder();

    for (let s = 0; s < stepCount; s++) {
      this._encodePasses(enc, dt);
    }

    // Pose pass: write positions + normals to the STORAGE|VERTEX buffer
    if (this.poseVertexBuf && this.poseBG) {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.posePipeline!);
      pass.setBindGroup(0, this.poseBG);
      pass.dispatchWorkgroups(Math.ceil(this._vertexCount / WG));
      pass.end();
    }

    this.device.queue.submit([enc.finish()]);
  }

  /**
   * Read current vertex positions from the GPU.
   * Returns a Float32Array of [x, y, z] per vertex.
   */
  async readPositions(): Promise<Float32Array> {
    if (!this._ready || !this.positionBuf || !this.readbackBuf) {
      return new Float32Array(this._vertexCount * 3);
    }

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.positionBuf, 0, this.readbackBuf, 0, this._vertexCount * VEC4);
    this.device.queue.submit([enc.finish()]);

    await this.readbackBuf.mapAsync(GPUMapMode.READ);
    const raw = new Float32Array(this.readbackBuf.getMappedRange());
    const out = new Float32Array(this._vertexCount * 3);
    for (let vi = 0; vi < this._vertexCount; vi++) {
      out[vi * 3    ] = raw[vi * 4    ];
      out[vi * 3 + 1] = raw[vi * 4 + 1];
      out[vi * 3 + 2] = raw[vi * 4 + 2];
    }
    this.readbackBuf.unmap();
    return out;
  }

  /**
   * Run simulation until convergence or maxSteps, whichever comes first.
   * Returns the final vertex positions [x,y,z] per vertex.
   */
  async runToConvergence(
    maxSteps      = 3000,
    stepsPerBatch = 64,
    epsilon       = 1e-4,
    dt            = 0.016,
  ): Promise<Float32Array> {
    let total = 0;
    let prev: Float32Array | null = null;

    while (total < maxSteps) {
      const batch = Math.min(stepsPerBatch, maxSteps - total);

      const enc = this.device.createCommandEncoder();
      for (let s = 0; s < batch; s++) {
        this._encodePasses(enc, dt);
      }
      this.device.queue.submit([enc.finish()]);

      const cur = await this.readPositions();
      if (prev) {
        let maxDelta = 0;
        for (let i = 0; i < cur.length; i++) {
          const d = Math.abs(cur[i] - prev[i]);
          if (d > maxDelta) maxDelta = d;
        }
        if (maxDelta < epsilon) return cur;
      }
      prev  = cur;
      total += batch;
    }

    return await this.readPositions();
  }

  /**
   * Hot-update physics uniforms without rebuilding geometry or resetting positions.
   */
  setPhysicsParams(
    params: Partial<Pick<ClothPhysicsConfig, 'gravity' | 'damping' | 'stiffness' | 'wind'>>,
  ): void {
    if (!this._ready || !this._physics) return;
    if (params.gravity   !== undefined) this._physics = { ...this._physics, gravity:   params.gravity };
    if (params.damping   !== undefined) this._physics = { ...this._physics, damping:   params.damping };
    if (params.stiffness !== undefined) this._physics = { ...this._physics, stiffness: params.stiffness };
    if (params.wind      !== undefined) this._physics = { ...this._physics, wind:      params.wind };
    this._writeIntegrateParams(this._physics);
    // stiffness is now a JS loop variable — no GPU buffer update needed when it changes
  }

  destroy(): void {
    this._destroyBuffers();
    this._ready = false;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Encode integrate → constrain (per-color parallel) → collide passes.
   * Called once per simulation step. Pose pass is NOT included here so
   * runToConvergence can call multiple steps before issuing it.
   */
  private _encodePasses(enc: GPUCommandEncoder, dt: number): void {
    // Integrate params (same for all steps in a batch — safe to overwrite repeatedly)
    if (this._physics) {
      const p = new Float32Array(INTEGRATE_PARAMS_SIZE / 4);
      const ph = this._physics;
      p[0] = dt;
      p[1] = ph.gravity;
      p[2] = ph.damping;
      p[3] = ph.wind?.x ?? 0;
      p[4] = ph.wind?.y ?? 0;
      p[5] = ph.wind?.z ?? 0;
      p[6] = this._vertexCount;
      this.device.queue.writeBuffer(this.intParamsBuf!, 0, p);
    }

    // 1. Integrate
    { const pass = enc.beginComputePass();
      pass.setPipeline(this.integratePipeline!);
      pass.setBindGroup(0, this.integrateBG!);
      pass.dispatchWorkgroups(Math.ceil(this._vertexCount / WG));
      pass.end(); }

    // 2. Constrain — parallel per-color-group, for stiffness iterations
    const stiffness = this._physics?.stiffness ?? 30;
    for (let iter = 0; iter < stiffness; iter++) {
      for (let gi = 0; gi < this._colorRanges.length; gi++) {
        const { start, end } = this._colorRanges[gi];
        const groupSize = end - start;
        if (groupSize === 0) continue;
        const pass = enc.beginComputePass();
        pass.setPipeline(this.constrainPipeline!);
        pass.setBindGroup(0, this.constrainBG!, [gi * CON_PARAM_STRIDE]);
        pass.dispatchWorkgroups(Math.ceil(groupSize / WG));
        pass.end();
      }
    }

    // 3. Collide
    if (this._proxy.type !== 'none') {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.collidePipeline!);
      pass.setBindGroup(0, this.collideBG!);
      pass.dispatchWorkgroups(Math.ceil(this._vertexCount / WG));
      pass.end();
    }
  }

  private _writeIntegrateParams(physics: ClothPhysicsConfig, dt = 0.016): void {
    const p = new Float32Array(INTEGRATE_PARAMS_SIZE / 4);
    p[0] = dt;              p[1] = physics.gravity;
    p[2] = physics.damping; p[3] = physics.wind?.x ?? 0;
    p[4] = physics.wind?.y ?? 0; p[5] = physics.wind?.z ?? 0;
    p[6] = this._vertexCount;
    this.device.queue.writeBuffer(this.intParamsBuf!, 0, p);
  }

  private _writeCollisionParams(proxy: DrapeProxy): void {
    const p = new Float32Array(COLLISION_PARAMS_SIZE / 4);
    const u = new Uint32Array(p.buffer);

    if (proxy.type === 'ground') {
      u[0] = 1; p[2] = proxy.y ?? 0;
    } else if (proxy.type === 'sphere') {
      u[0] = 2;
      p[3] = proxy.radius;
      const c = proxy.center ?? [0, 0, 0];
      p[4] = c[0]; p[5] = c[1]; p[6] = c[2];
    } else if (proxy.type === 'box') {
      u[0] = 3;
      p[8]  = proxy.min[0]; p[9]  = proxy.min[1]; p[10] = proxy.min[2];
      p[12] = proxy.max[0]; p[13] = proxy.max[1]; p[14] = proxy.max[2];
    }

    u[1] = this._vertexCount;
    this.device.queue.writeBuffer(this.colParamsBuf!, 0, p);
  }

  private _buildPipelines(): void {
    const dev = this.device;
    const visibility = GPUShaderStage.COMPUTE;

    // ── Integrate ────────────────────────────────────────────────────────────
    this.integrateBGL = dev.createBindGroupLayout({ entries: [
      { binding: 0, visibility, buffer: { type: 'storage' } },
      { binding: 1, visibility, buffer: { type: 'storage' } },
      { binding: 2, visibility, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility, buffer: { type: 'uniform' } },
      { binding: 4, visibility, buffer: { type: 'read-only-storage' } },
    ]});
    this.integratePipeline = dev.createComputePipeline({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [this.integrateBGL] }),
      compute: { module: dev.createShaderModule({ code: CLOTH_INTEGRATE_SHADER }), entryPoint: 'main' },
    });

    // ── Constrain (parallel, dynamic-offset uniform for per-group params) ────
    this.constrainBGL = dev.createBindGroupLayout({ entries: [
      { binding: 0, visibility, buffer: { type: 'storage' } },
      { binding: 1, visibility, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 4, visibility, buffer: { type: 'read-only-storage' } },
    ]});
    this.constrainPipeline = dev.createComputePipeline({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [this.constrainBGL] }),
      compute: { module: dev.createShaderModule({ code: CLOTH_CONSTRAIN_SHADER }), entryPoint: 'main' },
    });

    // ── Collide ──────────────────────────────────────────────────────────────
    this.collideBGL = dev.createBindGroupLayout({ entries: [
      { binding: 0, visibility, buffer: { type: 'storage' } },
      { binding: 1, visibility, buffer: { type: 'storage' } },
      { binding: 2, visibility, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility, buffer: { type: 'uniform' } },
    ]});
    this.collidePipeline = dev.createComputePipeline({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [this.collideBGL] }),
      compute: { module: dev.createShaderModule({ code: CLOTH_COLLIDE_SHADER }), entryPoint: 'main' },
    });

    // ── Pose ─────────────────────────────────────────────────────────────────
    this.poseBGL = dev.createBindGroupLayout({ entries: [
      { binding: 0, visibility, buffer: { type: 'read-only-storage' } }, // positions
      { binding: 1, visibility, buffer: { type: 'storage' } },           // vertexBuf (write)
      { binding: 2, visibility, buffer: { type: 'read-only-storage' } }, // neighbors
      { binding: 3, visibility, buffer: { type: 'uniform' } },           // params
    ]});
    this.posePipeline = dev.createComputePipeline({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [this.poseBGL] }),
      compute: { module: dev.createShaderModule({ code: CLOTH_POSE_SHADER }), entryPoint: 'main' },
    });
  }

  private _buildBindGroups(): void {
    const dev = this.device;

    this.integrateBG = dev.createBindGroup({ layout: this.integrateBGL!, entries: [
      { binding: 0, resource: { buffer: this.positionBuf! } },
      { binding: 1, resource: { buffer: this.prevPosBuf! } },
      { binding: 2, resource: { buffer: this.invMassBuf! } },
      { binding: 3, resource: { buffer: this.intParamsBuf! } },
      { binding: 4, resource: { buffer: this.perVertexWindBuf! } },
    ]});

    // Binding 3 uses dynamic offset — static size = CONSTRAIN_PARAMS_SIZE
    this.constrainBG = dev.createBindGroup({ layout: this.constrainBGL!, entries: [
      { binding: 0, resource: { buffer: this.positionBuf! } },
      { binding: 1, resource: { buffer: this.invMassBuf! } },
      { binding: 2, resource: { buffer: this.constraintBuf! } },
      { binding: 3, resource: { buffer: this.conColorParamsBuf!, offset: 0, size: CONSTRAIN_PARAMS_SIZE } },
      { binding: 4, resource: { buffer: this.bendStiffnessBuf! } },
    ]});

    this.collideBG = dev.createBindGroup({ layout: this.collideBGL!, entries: [
      { binding: 0, resource: { buffer: this.positionBuf! } },
      { binding: 1, resource: { buffer: this.prevPosBuf! } },
      { binding: 2, resource: { buffer: this.invMassBuf! } },
      { binding: 3, resource: { buffer: this.colParamsBuf! } },
    ]});

    this.poseBG = dev.createBindGroup({ layout: this.poseBGL!, entries: [
      { binding: 0, resource: { buffer: this.positionBuf! } },
      { binding: 1, resource: { buffer: this.poseVertexBuf! } },
      { binding: 2, resource: { buffer: this.neighborBuf! } },
      { binding: 3, resource: { buffer: this.poseParamsBuf! } },
    ]});
  }

  private _buf(size: number, usage: GPUBufferUsageFlags, data?: ArrayBufferView): GPUBuffer {
    if (data) {
      const buf = this.device.createBuffer({ size, usage, mappedAtCreation: true });
      const dst = new Uint8Array(buf.getMappedRange());
      dst.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      buf.unmap();
      return buf;
    }
    return this.device.createBuffer({ size, usage });
  }

  private _destroyBuffers(): void {
    for (const k of [
      'positionBuf', 'prevPosBuf', 'invMassBuf', 'constraintBuf',
      'readbackBuf', 'intParamsBuf', 'conColorParamsBuf', 'colParamsBuf',
      'bendStiffnessBuf', 'perVertexWindBuf', 'neighborBuf',
      'poseVertexBuf', 'poseParamsBuf',
    ] as const) {
      (this as any)[k]?.destroy();
      (this as any)[k] = null;
    }
    this.integrateBG = null;
    this.constrainBG = null;
    this.collideBG   = null;
    this.poseBG      = null;
    this._ready      = false;
  }
}
