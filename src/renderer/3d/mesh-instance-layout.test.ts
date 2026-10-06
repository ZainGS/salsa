/**
 * src/renderer/3d/mesh-instance-layout.test.ts — a SOURCE-SCANNING contract test for the per-instance
 * storage-buffer layout.
 *
 * The JS side writes the `MeshInstance` record at a fixed byte STRIDE (`MESH_INSTANCE_STRIDE`), and every WGSL
 * shader that reads it declares its own `struct MeshInstance` (some full, some deliberately padded for a
 * vertex-only pass). If any of those disagree on the total size, the GPU reads garbage — and it fails SILENTLY
 * (a garbled render, not an error). This test makes that drift a RED TEST instead: it parses the TS stride and
 * every WGSL `struct MeshInstance`, computes each struct's size under WGSL layout rules, and asserts they all match.
 *
 * (This is the "golden rule → wall" conversion from docs/SYSTEMS.md: keep the MeshInstance stride synced across
 * the TS constant and all WGSL structs.)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** WGSL size + alignment (bytes) for the scalar/vector/matrix types used in the MeshInstance structs. Throws on
 *  an unknown type so a new field type can't slip past the check unnoticed. */
function typeLayout(t: string): { size: number; align: number } {
    switch (t) {
        case 'f32': case 'u32': case 'i32':                 return { size: 4, align: 4 };
        case 'vec2<f32>': case 'vec2<u32>': case 'vec2<i32>': return { size: 8, align: 8 };
        case 'vec3<f32>': case 'vec3<u32>': case 'vec3<i32>': return { size: 12, align: 16 };
        case 'vec4<f32>': case 'vec4<u32>': case 'vec4<i32>': return { size: 16, align: 16 };
        case 'mat3x3<f32>':                                  return { size: 48, align: 16 };
        case 'mat4x4<f32>':                                  return { size: 64, align: 16 };
        default: throw new Error(`mesh-instance-layout: unknown WGSL type "${t}" — add it to typeLayout()`);
    }
}
const alignUp = (n: number, a: number): number => Math.ceil(n / a) * a;

/** Compute the WGSL byte size of a `struct { ... }` body (offset-align each field; round up to the struct's
 *  own alignment = its largest member alignment). */
function structSize(body: string): number {
    let offset = 0, maxAlign = 1, fields = 0;
    for (const raw of body.split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim();          // strip line comments
        const m = line.match(/^\w+\s*:\s*(mat4x4<f32>|mat3x3<f32>|vec[234]<[uif]32>|[uif]32)\s*,?/);
        if (!m) continue;
        const { size, align } = typeLayout(m[1]);
        offset = alignUp(offset, align) + size;
        maxAlign = Math.max(maxAlign, align);
        fields++;
    }
    expect(fields).toBeGreaterThan(0);                            // guard: the regex actually matched fields
    return alignUp(offset, maxAlign);
}

/** Every `struct MeshInstance { … }` block in a WGSL source string. */
function meshInstanceStructs(src: string): string[] {
    return [...src.matchAll(/struct\s+MeshInstance\s*\{([^}]*)\}/g)].map((m) => m[1]);
}

describe('MeshInstance layout — TS stride ↔ every WGSL struct', () => {
    it('MESH_INSTANCE_STRIDE is 240 (60 floats)', () => {
        const renderer = read('./renderer-3d.ts');
        const m = renderer.match(/MESH_INSTANCE_STRIDE\s*=\s*(\d+)/);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBe(240);
    });

    it('every WGSL `struct MeshInstance` lays out to exactly the TS stride (no silent drift)', () => {
        const stride = Number(read('./renderer-3d.ts').match(/MESH_INSTANCE_STRIDE\s*=\s*(\d+)/)![1]);
        // Scan EVERY non-test .ts under src/renderer (not a hand-kept list) — a hand list is how the 224-byte
        // silhouette-outline struct slipped past the 224→240 stride bump.
        const rendererRoot = fileURLToPath(new URL('..', import.meta.url));
        const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
            const full = join(dir, d.name);
            if (d.isDirectory()) return walk(full);
            return d.name.endsWith('.ts') && !d.name.endsWith('.test.ts') ? [full] : [];
        });
        const files = walk(rendererRoot).filter((f) => readFileSync(f, 'utf8').includes('struct MeshInstance'));
        let total = 0;
        for (const f of files) {
            for (const body of meshInstanceStructs(readFileSync(f, 'utf8'))) {
                total++;
                expect(structSize(body), `${f}: struct MeshInstance size`).toBe(stride);
            }
        }
        // Sanity: we actually found the structs (the ~9 declarations noted in SYSTEMS.md) — so a broken regex
        // can't make this pass vacuously.
        expect(files.length).toBeGreaterThanOrEqual(7);
        expect(total).toBeGreaterThanOrEqual(13);
    });
});

// ── Field-level contract (mobile-parity CLOTH-3) ────────────────────────────────────────────────────────────────
// The CPU writer (renderer-3d.ts) stores a few lanes as RAW u32 (dataView.setUint32): the material flags (float 43)
// and the texture / normal-map layer indices (44, 45). Every other lane is an f32 value. A WGSL struct that declares
// a raw-u32 lane as f32 and bitcasts it is WRONG on real hardware: a flags word with only bits < 23 set is a
// SUBNORMAL f32, which mobile drivers flush to zero (garments lost their texture / pattern / style on an Android
// tablet). So every named field of every `struct MeshInstance` must sit at the CPU writer's offset with the CPU
// writer's scalar kind. Fields named with a leading underscore are unread padding: offset-checked, kind-free.

/** The CPU record, by byte offset (renderer-3d.ts slot writers; MESH_INSTANCE_STRIDE = 240). */
const CPU_LAYOUT: Record<string, { offset: number; type: string }> = {
    modelMatrix:    { offset: 0,   type: 'mat4x4<f32>' },
    normalMatrix:   { offset: 64,  type: 'mat4x4<f32>' },
    diffuseColor:   { offset: 128, type: 'vec4<f32>' },
    specularColor:  { offset: 144, type: 'vec4<f32>' },
    emissive:       { offset: 160, type: 'vec3<f32>' },
    flags:          { offset: 172, type: 'u32' },
    textureIndex:   { offset: 176, type: 'u32' },
    normalMapIndex: { offset: 180, type: 'u32' },
    roughness:      { offset: 184, type: 'f32' },
    metalness:      { offset: 188, type: 'f32' },
    patternColor:   { offset: 192, type: 'vec4<f32>' },
    patternParams:  { offset: 208, type: 'vec4<f32>' },
    uvTransform:    { offset: 224, type: 'vec4<f32>' },
};

/** The fields of a struct body with their WGSL byte offsets. */
function structFields(body: string): { name: string; type: string; offset: number; size: number }[] {
    const out: { name: string; type: string; offset: number; size: number }[] = [];
    let offset = 0;
    for (const raw of body.split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        const m = line.match(/^(\w+)\s*:\s*(mat4x4<f32>|mat3x3<f32>|vec[234]<[uif]32>|[uif]32)\s*,?/);
        if (!m) continue;
        const { size, align } = typeLayout(m[2]);
        offset = alignUp(offset, align);
        out.push({ name: m[1], type: m[2], offset, size });
        offset += size;
    }
    return out;
}

/** Every non-test .ts under src/renderer that declares a `struct MeshInstance`. */
function meshInstanceFiles(): string[] {
    const rendererRoot = fileURLToPath(new URL('..', import.meta.url));
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const full = join(dir, d.name);
        if (d.isDirectory()) return walk(full);
        return d.name.endsWith('.ts') && !d.name.endsWith('.test.ts') ? [full] : [];
    });
    return walk(rendererRoot).filter((f) => readFileSync(f, 'utf8').includes('struct MeshInstance'));
}

describe('MeshInstance layout — every WGSL field matches the CPU writer (CLOTH-3)', () => {
    it('the CPU layout table agrees with the writer: exactly floats 43-45 are written as raw u32', () => {
        const r3 = read('./renderer-3d.ts');
        const u32Floats = new Set([...r3.matchAll(/setUint32\(\((?:offset|off) \+ (\d+)\) \* 4/g)].map((m) => Number(m[1])));
        expect([...u32Floats].sort((a, b) => a - b)).toEqual([43, 44, 45]);
        const tableU32 = Object.values(CPU_LAYOUT).filter((f) => f.type === 'u32').map((f) => f.offset / 4).sort((a, b) => a - b);
        expect(tableU32).toEqual([43, 44, 45]);
        // The emissive rgb stays three f32 values at floats 40-42.
        expect(r3).toMatch(/data\[offset \+ 40\] = mat3d\.emissive\.r;/);
        expect(r3).toMatch(/dataView\.setUint32\(\(offset \+ 43\) \* 4, encodeMaterialFlags\(mat3d\), true\);/);
    });

    it('every named field of every struct MeshInstance sits at the CPU offset with the CPU type', () => {
        let structs = 0;
        for (const f of meshInstanceFiles()) {
            for (const body of meshInstanceStructs(readFileSync(f, 'utf8'))) {
                structs++;
                const fields = structFields(body);
                // the flags lane is always declared (and as u32), in every copy
                expect(fields.find((x) => x.name === 'flags'), `${f}: MeshInstance.flags`).toEqual(
                    { name: 'flags', type: 'u32', offset: 172, size: 4 });
                for (const fd of fields) {
                    if (fd.name.startsWith('_')) {
                        // padding: must not straddle the flags lane with an f32 type (that is the CLOTH-3 bug shape)
                        if (fd.offset <= 172 && fd.offset + fd.size > 172) expect(fd.type, `${f}: ${fd.name} covers the flags lane`).toBe('u32');
                        continue;
                    }
                    const cpu = CPU_LAYOUT[fd.name];
                    expect(cpu, `${f}: unknown MeshInstance field "${fd.name}" (add it to CPU_LAYOUT)`).toBeDefined();
                    expect(fd.offset, `${f}: ${fd.name} offset`).toBe(cpu.offset);
                    expect(fd.type, `${f}: ${fd.name} type`).toBe(cpu.type);
                }
            }
        }
        expect(structs).toBeGreaterThanOrEqual(13);
    });

    it('no shader still reads the old f32 lane or bitcasts an instance field', () => {
        for (const f of meshInstanceFiles()) {
            const s = readFileSync(f, 'utf8');
            expect(s, `${f}: emissiveColor (the old vec4 with flags in .a)`).not.toMatch(/emissiveColor/);
            expect(s, `${f}: bitcast of an instance field`).not.toMatch(/bitcast<u32>\(\s*(?:inst|u_instances\[[^\]]*\]|instances\[[^\]]*\])\./);
        }
    });

    it('every instance member a shader reads is declared in its MeshInstance struct', () => {
        let reads = 0;
        for (const f of meshInstanceFiles()) {
            const s = readFileSync(f, 'utf8');
            const declared = new Set(meshInstanceStructs(s).flatMap((b) => structFields(b).map((x) => x.name)));
            for (const m of s.matchAll(/\b(?:inst|u_instances\[[^\]]*\]|instances\[[^\]]*\])\.(\w+)/g)) {
                reads++;
                expect(declared.has(m[1]), `${f}: reads instance member "${m[1]}"`).toBe(true);
            }
        }
        expect(reads).toBeGreaterThan(50);
    });
});
