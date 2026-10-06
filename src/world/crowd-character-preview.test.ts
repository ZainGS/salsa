/**
 * CROWD CHARACTERS — Phase 0 contact sheet (docs/specs/crowd-characters.md). Renders baked crowd archetypes next to
 * SAME-PALETTE mannequins with the crowd's flat shading, plus a street-distance sheet, and prints tris / bake ms /
 * the gate. Runs only with CROWD_PREVIEW=<dir>:
 *   CROWD_PREVIEW=out npx vitest run src/world/crowd-character-preview.test.ts
 * (CROWD_PREVIEW_N = archetype count, default 6.)
 */
import { describe, it, expect } from 'vitest';
import { bakeCrowdArchetype, crowdCharacterParams, CC_CODE_SKIN, CC_CODE_PHONE, ccSlotCode, CC_SLOT_TOP, CC_SLOT_HAIR, CC_SLOT_LEGS, CC_SLOT_SHOES, CC_SLOT_SKIRT, type CrowdCharMesh, type CrowdCharClass } from './crowd-character';
import { emitPerson, personLook, ARCHETYPES, PED_PALETTE, PED_SHADE, type PersonLook, type PersonSink, type PedColor, type Pose } from './mannequin';
import { Accum3D } from './meshbuild';
import { encodePNG } from '../services/managers/pose-preview';

type RGB = [number, number, number];
/** A mannequin look of the same silhouette class (deterministic scan). */
export function lookForClass(cls: CrowdCharClass, salt: number): PersonLook {
    for (let s = 0; s < 4000; s++) {
        const arch = (s * 7 + salt) % ARCHETYPES.length, look = personLook(arch, s * 131 + salt);
        const long = look.hairStyle === 'long' || look.hairStyle === 'bob' || look.hairStyle === 'pony' || look.hairStyle === 'bun';
        if (!!look.skirt === cls.skirt && look.fem === cls.fem && long === cls.longHair && look.garment !== 'robe' && look.garment !== 'coat' && look.hat === 'none') return look;
    }
    return personLook(0, salt);
}
const colourOf = (code: number, look: PersonLook): RGB => {
    const c: PedColor = code === CC_CODE_SKIN ? 'skin' : code === ccSlotCode(CC_SLOT_TOP) ? look.top : code === ccSlotCode(CC_SLOT_HAIR) ? look.hair
        : code === ccSlotCode(CC_SLOT_LEGS) ? look.legs : code === ccSlotCode(CC_SLOT_SHOES) ? look.shoes : code === ccSlotCode(CC_SLOT_SKIRT) ? (look.skirt ?? look.legs) : code === CC_CODE_PHONE ? 'black' : 'grey';
    return PED_PALETTE[c];
};

interface Fig { P: Float32Array; I: Uint32Array; C: Uint8Array }
/** Person-local (x fwd, z right) → render world (front faces +Z), offset dx. */
function figOfChar(m: CrowdCharMesh, look: PersonLook, dx: number): Fig {
    const n = m.pos.length / 3, P = new Float32Array(n * 3), C = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
        P[i * 3] = -m.pos[i * 3 + 2] + dx; P[i * 3 + 1] = m.pos[i * 3 + 1]; P[i * 3 + 2] = m.pos[i * 3];
        const c = colourOf(m.code[i], look); C[i * 3] = c[0] * 255; C[i * 3 + 1] = c[1] * 255; C[i * 3 + 2] = c[2] * 255;
    }
    return { P, I: m.indices, C };
}
function figOfMannequin(look: PersonLook, pose: Pose, dx: number, lod: 0 | 1): Fig {
    const accs = new Map<PedColor, Accum3D>();
    const acc = (c: PedColor): Accum3D => { let a = accs.get(c); if (!a) { a = new Accum3D(); accs.set(c, a); } return a; };
    const sink: PersonSink = {
        top: () => acc(look.top), skin: () => acc('skin'), hair: () => acc(look.hair), leg: () => acc(look.legs), shoes: () => acc(look.shoes),
        skirt: () => look.skirt ? acc(look.skirt) : null, bag: () => acc(look.bagColor), umbrella: () => null, collar: () => look.collar ? acc(look.collar) : null, extra: (c) => acc(c),
    };
    emitPerson(sink, { o: [dx, 0, 0], f: [0, 1], u: 1 }, { ...look, bag: 'none' }, { pose, lod });
    const P: number[] = [], I: number[] = [], C: number[] = [];
    for (const [c, a] of accs) {
        const g = a.geometry(), base = P.length / 3, rgb = PED_PALETTE[c];
        for (let o = 0; o < g.vertices.length; o += 12) { P.push(g.vertices[o], g.vertices[o + 1], g.vertices[o + 2]); C.push(rgb[0] * 255, rgb[1] * 255, rgb[2] * 255); }
        for (const k of g.indices) I.push(k + base);
    }
    return { P: Float32Array.from(P), I: Uint32Array.from(I), C: Uint8Array.from(C) };
}

/** Orthographic flat rasterizer with the CROWD shading: colour x diffuse x (sun·lambert + ambient + emissive lift). */
function renderSheet(rows: Fig[][], views: { yaw: number; pitch?: number }[], tile: number): Uint8Array {
    const cols = views.length, W = tile * cols, H = tile * rows.length;
    const rgb = new Uint8Array(W * H * 3).fill(226), zb = new Float32Array(W * H).fill(-Infinity);
    rows.forEach((figs, ri) => views.forEach((v, vi) => {
        const ox = vi * tile, oy = ri * tile, cy = 0.9, scale = (tile * 0.94) / 1.95;
        const ya = (v.yaw * Math.PI) / 180, pa = ((v.pitch ?? 0) * Math.PI) / 180, cyw = Math.cos(ya), syw = Math.sin(ya), cp = Math.cos(pa), sp = Math.sin(pa);
        for (const f of figs) {
            const n = f.P.length / 3, S = new Float32Array(n * 3);
            for (let i = 0; i < n; i++) {
                const x = f.P[i * 3], y = f.P[i * 3 + 1] - cy, z = f.P[i * 3 + 2];
                const rx = x * cyw - z * syw, rz = x * syw + z * cyw, ry = y * cp + rz * sp, rz2 = -y * sp + rz * cp;
                S[i * 3] = ox + tile / 2 + rx * scale; S[i * 3 + 1] = oy + tile / 2 - ry * scale; S[i * 3 + 2] = rz2;
            }
            for (let t = 0; t < f.I.length; t += 3) {
                const a = f.I[t], b = f.I[t + 1], c = f.I[t + 2];
                const ax = S[a * 3], ay = S[a * 3 + 1], bx = S[b * 3], by = S[b * 3 + 1], cx = S[c * 3], cy2 = S[c * 3 + 1];
                const area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx - ax);
                if (Math.abs(area) < 1e-9) continue;
                const ux = bx - ax, uy = -(by - ay), uz = (S[b * 3 + 2] - S[a * 3 + 2]) * scale, wx = cx - ax, wy = -(cy2 - ay), wz = (S[c * 3 + 2] - S[a * 3 + 2]) * scale;
                let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
                if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
                const lam = Math.max(0, nx * -0.35 + ny * 0.55 + nz * 0.76);
                const shade = PED_SHADE.diffuse * (0.75 * lam + 0.3 + PED_SHADE.emissive);
                const base = [f.C[a * 3], f.C[a * 3 + 1], f.C[a * 3 + 2]];
                const x0 = Math.max(ox, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(ox + tile - 1, Math.ceil(Math.max(ax, bx, cx)));
                const y0 = Math.max(oy, Math.floor(Math.min(ay, by, cy2))), y1 = Math.min(oy + tile - 1, Math.ceil(Math.max(ay, by, cy2)));
                for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
                    const qx = px + 0.5, qy = py + 0.5;
                    const w0 = ((bx - qx) * (cy2 - qy) - (by - qy) * (cx - qx)) / area, w1 = ((cx - qx) * (ay - qy) - (cy2 - qy) * (ax - qx)) / area, w2 = 1 - w0 - w1;
                    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                    const d = w0 * S[a * 3 + 2] + w1 * S[b * 3 + 2] + w2 * S[c * 3 + 2], o = py * W + px;
                    if (d <= zb[o]) continue; zb[o] = d;
                    rgb[o * 3] = Math.min(255, base[0] * shade); rgb[o * 3 + 1] = Math.min(255, base[1] * shade); rgb[o * 3 + 2] = Math.min(255, base[2] * shade);
                }
            }
        }
        for (let py = oy; py < oy + tile; py++) { const o = (py * W + ox) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = 180; }
        for (let px = ox; px < ox + tile; px++) { const o = (oy * W + px) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = 180; }
    }));
    return encodePNG(W, H, rgb);
}

describe.skipIf(!process.env.CROWD_PREVIEW)('crowd characters — Phase 0 contact sheet', () => {
    it('renders archetypes vs same-palette mannequins', async () => {
        const fs = await import('node:fs'), path = await import('node:path');
        const dir = process.env.CROWD_PREVIEW!; fs.mkdirSync(dir, { recursive: true });
        const N = Number(process.env.CROWD_PREVIEW_N ?? 6);
        const poses = (process.env.CROWD_PREVIEW_POSES ?? 'stand,rest').split(',') as Pose[];
        const report: string[] = [];
        const rowsNear: Fig[][] = [], rowsMid: Fig[][] = [], rowsFar: Fig[][] = [];
        for (let i = 0; i < N; i++) {
            const params = crowdCharacterParams(i);
            const a = bakeCrowdArchetype(params, poses, { keepFailed: !!process.env.CROWD_PREVIEW_ALL, noDecimate: !!process.env.CROWD_PREVIEW_FULL });
            const look = lookForClass(a.cls, i);
            report.push(`#${i} ${JSON.stringify(a.cls)} ${params.names.top} / ${params.names.bottom} / ${params.names.shoes} / hair ${params.names.hair}` +
                ` — full ${a.fullTris} tris ${JSON.stringify(a.fullByCode)}, bake ${a.bakeMs.toFixed(0)} ms, dropped [${a.dropped.join(',')}]`);
            for (const [p, cells] of Object.entries(a.gate)) report.push(`    ${p.padEnd(6)} ` + cells.map((c) => `${c.garment} poke ${c.poke.toFixed(1)}% ${c.pokeMm.toFixed(0)}mm tear ${c.tear.toFixed(1)}% web ${c.web} long ${c.long} edge ${(c.maxEdge * 100).toFixed(0)}cm ${c.pass ? 'ok' : 'FAIL'}`).join(' | '));
            for (const p of poses) {
                const b = a.poses.get(p);
                if (!b) { report.push(`    ${p}: DROPPED`); continue; }
                report.push(`    ${p}${a.dropped.includes(p) ? ' (GATE FAIL, shown)' : ''}: near ${b.near.tris} tris (${b.near.pos.length / 3} v), mid ${b.mid.tris} tris`);
                rowsNear.push([figOfChar(b.near, look, -0.33), figOfMannequin(look, p, 0.33, 0)]);
                rowsMid.push([figOfChar(b.mid, look, -0.33), figOfMannequin(look, p, 0.33, 1)]);
                rowsFar.push([figOfChar(b.mid, look, -0.33), figOfMannequin(look, p, 0.33, 1)]);
            }
        }
        const views = [{ yaw: 0 }, { yaw: 35, pitch: 8 }, { yaw: 90 }, { yaw: 180 }];
        fs.writeFileSync(path.join(dir, 'crowd-near.png'), renderSheet(rowsNear, views, 360));
        fs.writeFileSync(path.join(dir, 'crowd-mid.png'), renderSheet(rowsMid, views, 360));
        // street distance: ~60 px tall people
        fs.writeFileSync(path.join(dir, 'crowd-street.png'), renderSheet(rowsFar, [{ yaw: 0 }, { yaw: 35, pitch: 8 }, { yaw: 120 }], 70));
        if (process.env.CROWD_PREVIEW_ZOOM) fs.writeFileSync(path.join(dir, 'crowd-zoom.png'), renderSheet(rowsNear.slice(0, 4).map((r) => [r[0]]), [{ yaw: 0 }, { yaw: 35, pitch: 8 }], 900));
        fs.writeFileSync(path.join(dir, 'report.txt'), report.join('\n'));
        console.log(report.join('\n'));
        expect(rowsNear.length).toBeGreaterThan(0);
    }, 600_000);
});
