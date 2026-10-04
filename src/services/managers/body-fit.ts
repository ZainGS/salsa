// Pure body-fit maths (no scene-graph / DOM / WebGPU) — shared by Scene3DCharacter (main thread) and the
// 'character' worker lane (src/services/workers/character-jobs.ts), so a garment fitted in the worker sees the
// exact BodyFit the main thread would build. Moved verbatim out of scene3d-character.ts (which re-exports it).

import { mat4 } from 'gl-matrix';
import { RING as GARMENT_RING, type BodyFit, type JointFit, type ArmFit } from './clothing-generator';

/** Everything a BodyFit is computed from — plain data, so garments can be fit (and TESTED) without a live
 *  SkinnedMesh3D/Skeleton3D. `joints` = each joint's index, name, parent and inverse-bind matrix. */
export interface BodyFitSource {
    verts: Float32Array; ji: Uint8Array; jw: Float32Array;
    joints: { index: number; name: string; parentIndex: number; inverseBindMatrix: ArrayLike<number> }[];
    armSurface?: BodyFit['armSurface']; legSurface?: BodyFit['legSurface']; torsoSurface?: BodyFit['torsoSurface'];
    /** The body's triangle list → surface-interpolated garment weights on seam-blended bodies (BodyMeshData.indices). */
    indices?: Uint32Array;
}

/** The body-fit computation (joint radii, directional radii, arm cap/elbow radii, head bbox) as a pure function —
 *  moved VERBATIM out of Scene3DCharacter._buildBodyFit, which now calls it (clothing/hair audit 2026-09-28). */
export function buildBodyFitFrom(src: BodyFitSource): BodyFit {
    {
        const idxPos = new Map<number, [number, number, number]>();
        const byName = new Map<string, number>();
        const inv = mat4.create();
        for (const j of src.joints) {
            mat4.invert(inv, j.inverseBindMatrix as unknown as mat4);
            idxPos.set(j.index, [inv[12], inv[13], inv[14]]);
            byName.set(j.name, j.index);
        }
        const dirByIdx = new Map<number, [number, number, number]>();
        for (const j of src.joints) {
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
        const g = { vertices: src.verts }, ji = src.ji, jw = src.jw;
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
        const head = hMxY > hMnY ? {
            cx: (hMnX + hMxX) / 2, cy: (hMnY + hMxY) / 2, cz: (hMnZ + hMxZ) / 2,
            rx: (hMxX - hMnX) / 2, ry: (hMxY - hMnY) / 2, rz: (hMxZ - hMnZ) / 2,
        } : undefined;
        return { joints, arms, body: { verts: g.vertices, ji, jw, indices: src.indices, gridCache: new Map() },
            armSurface: src.armSurface, legSurface: src.legSurface, torsoSurface: src.torsoSurface, head };
    }
}

/** Rest-space bbox of the verts whose summed weight on `headIdx` is ≥ 0.5 — the head frame hair + face decals fit to.
 *  (Scene3DCharacter._headRegionBBox calls this.) */
export function headRegionBBoxOf(v: Float32Array, ji: ArrayLike<number>, jw: ArrayLike<number>, headIdx: number): { min: [number,number,number]; max: [number,number,number] } | null {
    if (v.length === 0) return null;
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
