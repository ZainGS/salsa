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
import { readFileSync } from 'node:fs';

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
    it('MESH_INSTANCE_STRIDE is 224 (56 floats)', () => {
        const renderer = read('./renderer-3d.ts');
        const m = renderer.match(/MESH_INSTANCE_STRIDE\s*=\s*(\d+)/);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBe(224);
    });

    it('every WGSL `struct MeshInstance` lays out to exactly the TS stride (no silent drift)', () => {
        const stride = Number(read('./renderer-3d.ts').match(/MESH_INSTANCE_STRIDE\s*=\s*(\d+)/)![1]);
        const files = [
            './shaders/mesh3d-shaders.ts',
            './shaders/shadow-shaders.ts',
            './shaders/skinning-shaders.ts',
            './shaders/outline-shaders.ts',
            './shaders/highlight-shaders.ts',
        ];
        let total = 0;
        for (const f of files) {
            for (const body of meshInstanceStructs(read(f))) {
                total++;
                expect(structSize(body), `${f}: struct MeshInstance size`).toBe(stride);
            }
        }
        // Sanity: we actually found the structs (the ~9 declarations noted in SYSTEMS.md) — so a broken regex
        // can't make this pass vacuously.
        expect(total).toBeGreaterThanOrEqual(8);
    });
});
