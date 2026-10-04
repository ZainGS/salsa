import { describe, it, expect } from 'vitest';
import { generateBodyResult, NEW_BODY_DEFAULTS, NEW_BODY_FACE_NORMALS } from './body-generator';
import { headRegionBBoxOf } from './body-fit';

// BodyParams.faceNormals (visual-polish item 10): the anime face-normal proxy. Only the head's NORMALS change.
describe('anime face normals (BodyParams.faceNormals)', () => {
    const classic = generateBodyResult({ seamBlend: 0.5 });
    const anime = generateBodyResult({ seamBlend: 0.5, faceNormals: 1 });
    const V0 = classic.geometry.vertices, V1 = anime.geometry.vertices, nv = V0.length / 12;
    const s = classic.skinning, head = s.jointNames.indexOf('head');
    const headW = (i: number) => { let w = 0; for (let k = 0; k < 4; k++) if (s.jointIndices[i * 4 + k] === head) w += s.jointWeights[i * 4 + k]; return w; };

    it('absent = 0 = the classic body, bit-identical; new bodies get it on', () => {
        expect(generateBodyResult({ seamBlend: 0.5, faceNormals: 0 }).geometry.vertices).toEqual(V0);
        expect(NEW_BODY_DEFAULTS.faceNormals).toBe(NEW_BODY_FACE_NORMALS);
        expect(NEW_BODY_FACE_NORMALS).toBeGreaterThan(0);
    });

    it('changes only head normals: positions, uvs, tangent w, indices and weights are untouched', () => {
        expect(V1.length).toBe(V0.length);
        expect(anime.geometry.indices).toEqual(classic.geometry.indices);
        expect(anime.skinning.jointIndices).toEqual(s.jointIndices);
        expect(anime.skinning.jointWeights).toEqual(s.jointWeights);
        let changedNonHead = 0;
        for (let i = 0; i < nv; i++) {
            for (const c of [0, 1, 2, 6, 7, 11]) expect(V1[i * 12 + c]).toBe(V0[i * 12 + c]);
            const moved = [3, 4, 5].some((c) => V1[i * 12 + c] !== V0[i * 12 + c]);
            if (moved && headW(i) === 0) changedNonHead++;
            expect(Math.hypot(V1[i * 12 + 3], V1[i * 12 + 4], V1[i * 12 + 5])).toBeCloseTo(1, 4);   // still unit
        }
        expect(changedNonHead).toBe(0);
    });

    it('the front of the face shades as nearly one plane (normals close to +Z), the classic face does not', () => {
        const bb = headRegionBBoxOf(V0, s.jointIndices, s.jointWeights, head)!;
        const cx = (bb.min[0] + bb.max[0]) / 2, hX = bb.max[0] - bb.min[0], hY = bb.max[1] - bb.min[1];
        const spread = (V: Float32Array) => {
            let sum = 0, n = 0, worst = 1;
            for (let i = 0; i < nv; i++) {
                if (headW(i) < 0.99) continue;
                const x = V[i * 12], y = V[i * 12 + 1], z = V[i * 12 + 2];
                // The face proper: the front 30% of the head's depth, between the chin and the brow, inside the cheeks.
                if (z < bb.max[2] - (bb.max[2] - bb.min[2]) * 0.3 || Math.abs(x - cx) > hX * 0.3 || y < bb.min[1] + hY * 0.2 || y > bb.min[1] + hY * 0.65) continue;
                const nz = V[i * 12 + 5];
                sum += nz; n++; worst = Math.min(worst, nz);
            }
            return { mean: sum / n, worst, n };
        };
        const a = spread(V1), c = spread(V0);
        expect(a.n).toBeGreaterThan(8);
        // Measured 2026-10-03: anime mean 0.97 / worst 0.86 vs classic 0.71 / 0.31 (the nose + cheek facets).
        expect(a.mean).toBeGreaterThan(0.93);
        expect(a.worst).toBeGreaterThan(0.75);   // no facet turned far away (the nose / cheek wedges)
        expect(a.mean).toBeGreaterThan(c.mean + 0.15);
        expect(a.worst).toBeGreaterThan(c.worst + 0.2);
    });
});

// BodyParams.headShape (2026-10-04): the anime head (round cranium + cheeks, soft V-line jaw) and its shaped neck shadow.
describe('anime head shape + neck shadow (BodyParams.headShape)', () => {
    const nb = generateBodyResult({ ...NEW_BODY_DEFAULTS });
    const V = nb.geometry.vertices, nv = V.length / 12, s = nb.skinning;
    const head = s.jointNames.indexOf('head'), neck = s.jointNames.indexOf('neck');
    const wOf = (i: number, j: number) => { let w = 0; for (let k = 0; k < 4; k++) if (s.jointIndices[i * 4 + k] === j) w += s.jointWeights[i * 4 + k]; return w; };
    const bb = headRegionBBoxOf(V, s.jointIndices, s.jointWeights, head)!;
    const cx = (bb.min[0] + bb.max[0]) / 2, cz = (bb.min[2] + bb.max[2]) / 2;
    const hX = bb.max[0] - bb.min[0], hY = bb.max[1] - bb.min[1], hZ = bb.max[2] - bb.min[2];
    const N = (i: number): [number, number, number] => [V[i * 12 + 3], V[i * 12 + 4], V[i * 12 + 5]];
    const lam = (i: number, L: number[]) => { const n = N(i), l = Math.hypot(L[0], L[1], L[2]); return Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / l); };
    const idx = (f: (i: number) => boolean) => { const o: number[] = []; for (let i = 0; i < nv; i++) if (f(i)) o.push(i); return o; };
    const face = idx((i) => wOf(i, head) > 0.99 && V[i * 12 + 2] > bb.max[2] - hZ * 0.3 && Math.abs(V[i * 12] - cx) < hX * 0.3
        && V[i * 12 + 1] > bb.min[1] + hY * 0.2 && V[i * 12 + 1] < bb.min[1] + hY * 0.65);
    // The neck's front half (the part a front / three-quarter camera sees), below the head.
    const neckFront = idx((i) => wOf(i, neck) >= 0.45 &&V[i * 12 + 1] < bb.min[1] + hY * 0.05 && V[i * 12 + 2] > cz + 0.002
        && Math.abs(V[i * 12] - cx) < hX * 0.35);
    // Under the chin: the under-jaw ring + the top of the neck at the front centre.
    const underJaw = idx((i) => V[i * 12 + 1] < bb.min[1] + hY * 0.06 && V[i * 12 + 1] > bb.min[1] - hY * 0.12
        && V[i * 12 + 2] > cz + hZ * 0.15 && Math.abs(V[i * 12] - cx) < hX * 0.12 && (wOf(i, head) > 0.5 || wOf(i, neck) >= 0.5));
    // Key lights from above-front (strict: no neck vertex brighter than the face) and from the side (the neck is a
    // cylinder, so its lit side may catch a side light a little more than the flat face plane: compare medians).
    const LIGHTS = [[0, 0.6, 0.8], [0, 0.35, 0.94], [0.3, 0.9, 0.3], [0.2, 0.7, 0.68]];
    const SIDE_LIGHTS = [[0.5, 0.6, 0.62], [-0.5, 0.7, 0.5]];

    it('absent / 0 = the classic head, bit-identical; new bodies get the anime head; same topology', () => {
        const a = generateBodyResult({ seamBlend: 0.5, faceNormals: 1 }).geometry, b = generateBodyResult({ seamBlend: 0.5, faceNormals: 1, headShape: 0 }).geometry;
        expect(b.vertices).toEqual(a.vertices);
        expect(NEW_BODY_DEFAULTS.headShape).toBeGreaterThan(0);
        const c = generateBodyResult({ seamBlend: 0.5, faceNormals: 1, headShape: 1 }).geometry;
        expect(c.vertices.length).toBe(a.vertices.length);
        expect(c.indices.length).toBe(a.indices.length);   // same triangles (the winding pass may flip a few)
    });

    it('a softer, narrower jaw: the jaw line is narrower than the cheeks and no single chin vertex spikes forward', () => {
        const ring = (y0: number, y1: number) => idx((i) => wOf(i, head) > 0.99 && V[i * 12 + 1] >= y0 && V[i * 12 + 1] < y1);
        const width = (ids: number[]) => { let a = Infinity, b = -Infinity; for (const i of ids) { a = Math.min(a, V[i * 12]); b = Math.max(b, V[i * 12]); } return b - a; };
        const jaw = width(ring(bb.min[1] + hY * 0.05, bb.min[1] + hY * 0.2)), cheek = width(ring(bb.min[1] + hY * 0.3, bb.min[1] + hY * 0.45));
        expect(jaw).toBeLessThan(cheek * 0.9);
        // chin: the frontmost vertex is not far ahead of its neighbours (a rounded chin, not a spike)
        const low = ring(bb.min[1], bb.min[1] + hY * 0.2).sort((p, q) => V[q * 12 + 2] - V[p * 12 + 2]);
        expect(V[low[0] * 12 + 2] - V[low[Math.min(low.length - 1, 4)] * 12 + 2]).toBeLessThan(hZ * 0.06);
    });

    it('the face still shades as one plane', () => {
        let sum = 0; for (const i of face) sum += N(i)[2];
        expect(face.length).toBeGreaterThan(8);
        expect(sum / face.length).toBeGreaterThan(0.9);
    });

    it('neck luminance across the jaw seam: the lit neck is never brighter than the face; under the chin is in shadow', () => {
        expect(neckFront.length).toBeGreaterThan(6);
        expect(underJaw.length).toBeGreaterThan(2);
        for (const L of LIGHTS) {
            const fl = face.map((i) => lam(i, L)).sort((p, q) => p - q), faceMed = fl[fl.length >> 1];
            const neckMax = Math.max(...neckFront.map((i) => lam(i, L)));
            const jawMean = underJaw.reduce((acc, i) => acc + lam(i, L), 0) / underJaw.length;
            if (process.env.NECK_LUM) {
                console.log('[neck]', L, 'face', faceMed.toFixed(3), 'neckMax', neckMax.toFixed(3), 'underJaw', jawMean.toFixed(3));
                for (const i of neckFront) if (lam(i, L) > faceMed + 0.03) console.log('[neck-hot]', i, Array.from(V.slice(i * 12, i * 12 + 6)).map((q) => q.toFixed(3)).join(','), 'neckW', wOf(i, neck).toFixed(2), 'headW', wOf(i, head).toFixed(2), 'bbminY', bb.min[1].toFixed(3), 'cz', cz.toFixed(3));
            }
            expect(neckMax, `light ${L}`).toBeLessThanOrEqual(faceMed + 0.03);
            expect(jawMean, `light ${L}`).toBeLessThan(faceMed - 0.15);
        }
        const med = (a: number[]) => { const b = [...a].sort((p, q) => p - q); return b[b.length >> 1]; };
        for (const L of SIDE_LIGHTS) {
            const faceMed = med(face.map((i) => lam(i, L))), neckMed = med(neckFront.map((i) => lam(i, L)));
            const jawMean = underJaw.reduce((acc, i) => acc + lam(i, L), 0) / underJaw.length;
            if (process.env.NECK_LUM) console.log('[neck-side]', L, 'face', faceMed.toFixed(3), 'neckMed', neckMed.toFixed(3), 'underJaw', jawMean.toFixed(3));
            expect(neckMed, `side light ${L}`).toBeLessThanOrEqual(faceMed + 0.03);
            expect(jawMean, `side light ${L}`).toBeLessThan(faceMed - 0.1);
        }
    });

    it('rim-safe: no front-facing neck / under-chin normal is grazing to a front camera (the Fresnel rim lit those white)', () => {
        for (const i of [...neckFront, ...underJaw]) {
            const x = V[i * 12] - cx, z = V[i * 12 + 2] - cz, sf = z / Math.max(1e-9, Math.hypot(x, z));
            if (sf < 0.7) continue;                           // the sides are silhouette anyway
            expect(N(i)[2], `vertex ${i}`).toBeGreaterThan(0.55);
        }
    });

    it('the classic head + face normals keep their old neck (only anime heads get the neck shadow)', () => {
        const a = generateBodyResult({ seamBlend: 0.5, faceNormals: 1, headShape: 0 }).geometry.vertices;
        const b = generateBodyResult({ seamBlend: 0.5, faceNormals: 1 }).geometry.vertices;
        expect(Array.from(a)).toEqual(Array.from(b));
    });
});
