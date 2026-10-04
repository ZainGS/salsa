import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { generateHair, hairStylePreset, DEFAULT_HAIR_PARAMS, type HairParams } from './hair-generator';
import { LOCK_STYLE_DEFAULTS } from './hair-locks';
import {
    HAIR_CONTROL_MODES, HAIR_NON_GEOMETRY_KEYS, HAIR_GATHERED_INERT, hairControlModeOf, hairControlVisible, hairControlVisibleFor, hairGatheredOf,
    type HairControlMode,
} from './hair-control-modes';

// The mode → control map (the "Styled hair shows controls that do nothing" panel bug, 2026-10-04): every control a
// panel shows for a hair mode must change that mode's hair, and every control it hides must not.

const HEAD = { cx: 0, cy: 1.6, cz: 0, rx: 0.09, ry: 0.11, rz: 0.1 };
type P = Partial<HairParams> & Record<string, unknown>;

const BASE: Record<HairControlMode, P> = {
    chunky: { ...DEFAULT_HAIR_PARAMS, hairMode: 'chunky' },
    cards: { ...DEFAULT_HAIR_PARAMS, hairMode: 'cards' },
    locks: { ...hairStylePreset('twintails', 5)!, sideLock: true, gather: false },   // loose: the crown locks are built
};

/** Prerequisites that make a key matter at all (applied in every mode, so a hidden key is tested with its feature on). */
const CONTEXT: Record<string, P> = {
    lockCurlType: { lockCurl: 0.5 }, lockCurlFreq: { lockCurl: 0.5 },
    drillTurns: { tailForm: 'drill' }, tailLocks: { tailForm: 'bundle' },
    fringeSide: { fringeStyle: 'swept' },
    bunSize: { bunStyle: 'round' },
    beardLength: { facialHair: 'full' }, beardDensity: { facialHair: 'full' },
    sideLockLength: { sideLock: true }, sideLockWidth: { sideLock: true }, sideLockCount: { sideLock: true },
    spikePattern: { spikeCap: true }, spikeLength: { spikeCap: true }, spikeJitter: { spikeCap: true },
    lengthFront: { scalpLength: 1 }, lengthSide: { scalpLength: 1 }, lengthBack: { scalpLength: 1 }, scalpBluntness: { scalpLength: 1 },
    curlType: { scalpLength: 1 }, layering: { scalpLength: 1 }, chop: { scalpLength: 1 },
    curlAmount: { scalpLength: 1, curlType: 'wave' }, curlFreq: { scalpLength: 1, curlType: 'wave' }, curlPhaseJitter: { scalpLength: 1, curlType: 'wave' },
    partingPosition: { partingStyle: 'parted' }, partingWidth: { partingStyle: 'parted' },
    frontDrapeSide: { frontDrape: 1 }, frontDrapeOrigin: { frontDrape: 1 }, frontDrapeLength: { frontDrape: 1 },
    frontDrapeWaveX: { frontDrape: 1 }, frontDrapeWaveZ: { frontDrape: 1 }, frontDrapeStrays: { frontDrape: 1 },
    frontDrapeStrayX: { frontDrape: 1, frontDrapeStrays: 2 }, frontDrapeStrayZ: { frontDrape: 1, frontDrapeStrays: 2 },
    capLayers: { cardifyCap: true }, cardDetail: { cardifyCap: true },
};

/** A clearly different value for a key (explicit where a generic nudge would clamp / round back to the same build). */
const ALT: Record<string, unknown> = {
    fringeStyle: 'straight', lockLayers: 1, ahoge: 1, fringeCount: 4, lockCount: 20, sideLockCount: 2, tailLocks: 7,
    bangCount: 3, cardsPerClump: 5, cardSegments: 14, strandDensity: 9, capLayers: 5, drillTurns: 6, lockSeed: 4242,
    tailForm: 'braid', lockCurlType: 'spiral', lockCurlFreq: 4, bunStyle: 'round', facialHair: 'full', tailStyle: 'pony',
    curlType: 'spiral', partingStyle: 'fringe', spikePattern: 'grid', frontDrapeSide: 'left', frontDrapeOrigin: 'front',
    tailTip: 'blunt', hairlineFront: 0.25, gather: false, sideLock: false, buzzCut: true, spikeCap: true, cardifyCap: true,
    frontDrape: 1, scalpLength: 1, fringeHeight: 0.15, crownRound: 0.4, tailHeight: 0.1, bunSize: 0.9,
    fringeSide: -0.8, frontDrapeStrays: 2,
};

function altValue(key: string, cur: unknown): unknown {
    if (key in ALT && ALT[key] !== cur) return ALT[key];
    if (typeof cur === 'boolean') return !cur;
    if (typeof cur === 'number') return cur === 0 ? 0.35 : cur * 0.7;
    if (cur === undefined) {
        const d = (LOCK_STYLE_DEFAULTS as unknown as Record<string, unknown>)[key];
        if (typeof d === 'number') return d === 0 ? 0.5 : d * 0.7;
        if (typeof d === 'boolean') return !d;
        return 0.4;
    }
    return cur;
}

const geom = (p: P) => generateHair(HEAD, p as Partial<HairParams>).geometry;
const same = (a: { vertices: Float32Array; indices: ArrayLike<number> }, b: { vertices: Float32Array; indices: ArrayLike<number> }) =>
    a.vertices.length === b.vertices.length && a.indices.length === b.indices.length && a.vertices.every((v, i) => v === b.vertices[i]);

describe('hair mode → control map (HAIR_CONTROL_MODES)', () => {
    it('routes hairMode values like generateHair (absent / unknown = chunky)', () => {
        expect(hairControlModeOf('locks')).toBe('locks');
        expect(hairControlModeOf(' Cards ')).toBe('cards');
        expect(hairControlModeOf(undefined)).toBe('chunky');
        expect(hairControlModeOf('chunky')).toBe('chunky');
        expect(hairControlVisible('lockCount', 'locks')).toBe(true);
        expect(hairControlVisible('lockCount', 'chunky')).toBe(false);
        expect(hairControlVisible('capThickness', 'locks')).toBe(false);
        expect(hairControlVisible('notAKey', 'locks')).toBe(true);
    });

    for (const mode of ['chunky', 'cards', 'locks'] as const) {
        it(`${mode}: every shown geometry control changes the hair, every hidden one does not`, () => {
            const wrong: string[] = [];
            for (const key of Object.keys(HAIR_CONTROL_MODES)) {
                if (HAIR_NON_GEOMETRY_KEYS.includes(key)) continue;
                const base: P = { ...BASE[mode], ...(CONTEXT[key] ?? {}) };
                const alt: P = { ...base, [key]: altValue(key, base[key]) };
                const changed = !same(geom(base), geom(alt));
                const shown = hairControlVisible(key, mode);
                if (changed !== shown) wrong.push(`${key} (${shown ? 'shown but inert' : 'hidden but live'})`);
            }
            expect(wrong, `${mode}: ${wrong.join(', ')}`).toEqual([]);
        });
    }

    it('locks, GATHERED (tails / bun tie): the loose-crown controls are inert, so a panel hides them (HAIR_GATHERED_INERT)', () => {
        const gathered: P = { ...BASE.locks, gather: true };
        expect(hairGatheredOf(gathered)).toBe(true);
        expect(hairGatheredOf({ ...gathered, tailStyle: 'none', bunStyle: 'none' })).toBe(false);   // nothing to gather into
        const wrong: string[] = [];
        for (const key of Object.keys(HAIR_CONTROL_MODES)) {
            if (HAIR_NON_GEOMETRY_KEYS.includes(key) || !hairControlVisible(key, 'locks') || key === 'gather') continue;
            const base: P = { ...gathered, ...(CONTEXT[key] ?? {}) };
            const changed = !same(geom(base), geom({ ...base, [key]: altValue(key, base[key]) }));
            const shown = hairControlVisibleFor(key, base);
            if (changed !== shown) wrong.push(`${key} (${shown ? 'shown but inert' : 'hidden but live'})`);
        }
        expect(wrong, wrong.join(', ')).toEqual([]);
    });

    it('the Frogmarks character panel copy matches (when the Frogmarks repo is checked out beside Salsa)', () => {
        const f = path.resolve(__dirname, '../../../../Frogmarks/Frogmarks/ClientApp/src/app/illustrate/components/character-panel/character-panel.component.ts');
        if (!fs.existsSync(f)) return;
        const src = fs.readFileSync(f, 'utf8');
        const body = src.slice(src.indexOf('HAIR_CONTROL_MODES'), src.indexOf('};', src.indexOf('HAIR_CONTROL_MODES')));
        const groups: Record<string, string> = { HC_ALL: 'cards,chunky,locks', HC_LEGACY: 'cards,chunky', HC_LOCKS: 'locks', HC_CARDS: 'cards', HC_CHUNKY: 'chunky' };
        const theirs: Record<string, string> = {};
        for (const m of body.matchAll(/(\w+):\s*(HC_\w+)/g)) theirs[m[1]] = groups[m[2]];
        const ours: Record<string, string> = {};
        for (const [k, v] of Object.entries(HAIR_CONTROL_MODES)) ours[k] = [...v].sort().join(',');
        expect(theirs).toEqual(ours);
        const g = /HAIR_GATHERED_INERT[^=]*=\s*\[([^\]]*)\]/.exec(src);
        expect(g, 'HAIR_GATHERED_INERT in the panel').not.toBeNull();
        expect(g![1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)).toEqual([...HAIR_GATHERED_INERT]);
    });
});
