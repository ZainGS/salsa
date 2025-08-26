`
TexturedInst:
What it is: The data each quad instance needs to render:
world, local — transforms to place/scale/rotate the quad.
uvScale, uvOffset — control tiling and panning of the texture.
layerIndex — which layer of the texture array to sample.
flags — bitfield (e.g., bit 0: pattern(1) vs stamp(0) — use it in the shader if behavior differs).
tint — multiply color (e.g., for recoloring stamps or pattern colorizing).
These map 1:1 to the fields you’ll read in WGSL.

TexturedInstanceBuffer:
What it is: A resizable storage buffer that packs many TexturedInsts (one per rendered quad). It:
Starts with a capacity, doubles on demand (ensure).
Writes each instance at a 256-byte stride (good: matches WebGPU alignment).
Exposes .count for your draw call (instance count).
This lets you call one draw(6, instanceCount) for all patterns/stamps.
`

export type TexturedInst = {
  world: Float32Array;   // 16 floats
  local: Float32Array;   // 16 floats
  uvScale: [number, number]; // 2
  uvOffset: [number, number]; // 2
  layerIndex: number;    // 1 (u32)
  flags: number;         // 1 (u32) bit 0: pattern(1)/stamp(0)
  tint: [number,number,number,number]; // 4
};

export class TexturedInstanceBuffer {
  private device: GPUDevice;
  private buf!: GPUBuffer;
  private capacity = 0;
  count = 0;

  constructor(device: GPUDevice, initialCapacity = 256) {
    this.device = device;
    this.resize(initialCapacity);
  }

  getBuffer() { return this.buf; }

  beginFrame() { this.count = 0; }

  ensure(n: number) {
    if (n <= this.capacity) return;
    let cap = this.capacity || 1;
    while (cap < n) cap <<= 1;
    this.resize(cap);
  }

  private resize(cap: number) {
    const bytesPerInst = 256;
    const size = cap * bytesPerInst;
    const newBuf = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.buf?.destroy?.();
    this.buf = newBuf;
    this.capacity = cap;
  }

    write(i: number, inst: TexturedInst) {
    const out = new Float32Array(64);

    out.set(inst.world, 0);     // 0..15 (64 B)
    out.set(inst.local, 16);    // 16..31 (+64 B = 128)
    out[32] = inst.uvScale[0];  // (+8 = 136)
    out[33] = inst.uvScale[1];
    out[34] = inst.uvOffset[0]; // (+8 = 144)
    out[35] = inst.uvOffset[1];

    // layer / flags as u32
    const u32 = new Uint32Array(out.buffer);
    u32[36] = inst.layerIndex >>> 0; // byte 144 + 8 = 152
    u32[37] = inst.flags >>> 0;      // byte 156

    // padding (two f32) to reach 160-byte boundary for tint
    out[38] = 0.0;
    out[39] = 0.0;

    // move tint to index 40 (byte 160) — properly aligned
    out.set(inst.tint, 40);     // 40..43

    this.device.queue.writeBuffer(this.buf, i * 256, out);
    }
}