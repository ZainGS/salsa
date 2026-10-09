/**
 * hair-control-modes.ts — which HairParams key each hair BUILD actually reads (2026-10-04, the "Styled hair shows
 * controls that do nothing" panel bug). generateHair routes `hairMode: 'locks'` (Styled, hair-locks.ts) and 'cards';
 * anything else is the chunky build. The locks build returns before every legacy component (cap, bangs, spikes, buzz,
 * scalp length + curl, front drape, card tails), and the legacy builds never read the lock-style fields.
 *
 * A host panel shows a control only when `hairControlVisible(key, params.hairMode)`. The map is verified against the
 * generator by hair-control-modes.test.ts (perturb each key in each mode); the Frogmarks character panel keeps a
 * copy (character-panel.component.ts HAIR_CONTROL_MODES) that the same test compares when the repo is present.
 * Material-side keys (colours, gradient, sheen, the alpha cutoff) apply in every mode they are listed for.
 */

export type HairControlMode = 'cards' | 'chunky' | 'locks';

/** The build a hairMode value routes to. */
export function hairControlModeOf(hairMode: unknown): HairControlMode {
    const m = String(hairMode ?? '').toLowerCase().trim();
    return m === 'locks' || m === 'cards' ? m : 'chunky';
}

const ALL: readonly HairControlMode[] = ['cards', 'chunky', 'locks'];
const LEGACY: readonly HairControlMode[] = ['cards', 'chunky'];
const LOCKS: readonly HairControlMode[] = ['locks'];
const CARDS: readonly HairControlMode[] = ['cards'];
const CHUNKY: readonly HairControlMode[] = ['chunky'];

export const HAIR_CONTROL_MODES: Readonly<Record<string, readonly HairControlMode[]>> = {
    hairStyle: ALL,
    // Styled (locks) only
    fringeStyle: LOCKS, fringeHeight: LOCKS, fringeCount: LOCKS, fringeSide: LOCKS,
    hairLength: LOCKS, sideLength: LOCKS, lockCount: LOCKS, lockWidth: LOCKS, lockThickness: LOCKS,
    lockVolume: LOCKS, lockTaper: LOCKS, lockFlick: LOCKS, lockJitter: LOCKS, lockLayers: LOCKS,
    lockSeed: LOCKS, ahoge: LOCKS, gather: LOCKS, tailLocks: LOCKS,
    tailForm: LOCKS, drillTurns: LOCKS, lockCurl: LOCKS, lockCurlType: LOCKS, lockCurlFreq: LOCKS,
    lockSpike: LOCKS, hairPoof: LOCKS,
    // Shared by every mode
    crownRound: ALL, hairlineFront: ALL,
    bunStyle: ALL, bunSize: ALL,
    facialHair: ALL, beardLength: ALL, beardDensity: ALL,
    sideLock: ALL, sideLockLength: ALL, sideLockWidth: ALL, sideLockCount: ALL,
    tailStyle: ALL, tailHeight: ALL, tailSpread: ALL, tailLength: ALL, tailThickness: ALL,
    tailTaper: ALL, tailCurl: ALL,
    rootColor: ALL, tipColor: ALL, gradient: ALL, tipFade: ALL, sheen: ALL, sheenBand: ALL,
    // Chunky + Cards (the legacy build)
    verticalOffset: LEGACY, capThickness: LEGACY, backLength: LEGACY, capSweep: LEGACY,
    spikeCap: LEGACY, spikePattern: LEGACY, spikeLength: LEGACY, spikeJitter: LEGACY,
    buzzCut: LEGACY, sideCut: LEGACY,
    scalpLength: LEGACY, lengthFront: LEGACY, lengthSide: LEGACY, lengthBack: LEGACY, scalpBluntness: LEGACY,
    curlType: LEGACY, curlAmount: LEGACY, curlFreq: LEGACY, curlPhaseJitter: LEGACY, layering: LEGACY, chop: LEGACY,
    partingStyle: LEGACY, partingPosition: LEGACY, partingWidth: LEGACY, bangCount: LEGACY, bangLength: LEGACY,
    bangCurve: LEGACY, bangPointiness: LEGACY, bangOffset: LEGACY,
    tailStartTaper: LEGACY, tailTip: CHUNKY,   // card tails have no tip cap
    frontDrape: LEGACY, frontDrapeSide: LEGACY, frontDrapeOrigin: LEGACY, frontDrapeLength: LEGACY,
    frontDrapeWaveX: LEGACY, frontDrapeWaveZ: LEGACY, frontDrapeStrays: LEGACY, frontDrapeStrayX: LEGACY, frontDrapeStrayZ: LEGACY,
    chunkiness: LEGACY, volume: LEGACY,
    // Cards only
    cardWidth: CARDS, cardsPerClump: CARDS, cardSegments: CARDS, strandDensity: CARDS, alphaCutoff: CARDS,
    cardifyCap: CARDS, capLayers: CARDS, cardDetail: CARDS,
};

/** Keys that change the hair MATERIAL (or are informational), not its geometry. */
export const HAIR_NON_GEOMETRY_KEYS: readonly string[] = ['hairStyle', 'rootColor', 'tipColor', 'gradient', 'tipFade', 'sheen', 'sheenBand', 'alphaCutoff', 'strandDensity'];

/** True when the hair control for `key` has an effect in `hairMode`. Unknown keys stay visible. */
export function hairControlVisible(key: string, hairMode: unknown): boolean {
    const modes = HAIR_CONTROL_MODES[key];
    return !modes || modes.includes(hairControlModeOf(hairMode));
}

/** Styled hair that is GATHERED: `gather` on with a tail or a bun to tie into (buildLockHair then builds the
 *  pulled-back locks instead of the loose crown). */
export function hairGatheredOf(p: { hairMode?: unknown; gather?: unknown; tailStyle?: unknown; bunStyle?: unknown }): boolean {
    if (hairControlModeOf(p.hairMode) !== 'locks' || p.gather !== true) return false;
    const t = String(p.tailStyle ?? 'none').toLowerCase(), b = String(p.bunStyle ?? 'none').toLowerCase();
    return t !== 'none' || b !== 'none';
}

/** Styled-hair keys that only shape the LOOSE crown locks — inert while the hair is gathered (hairGatheredOf).
 *  hairLength / sideLength then only rescale the uv.v reference (vRef), not one vertex position. lockJitter is the
 *  exception: the Choppy fringe reads it too (hairControlVisibleFor). */
export const HAIR_GATHERED_INERT: readonly string[] = ['hairLength', 'sideLength', 'lockFlick', 'lockJitter', 'lockLayers', 'lockSpike'];

/** Chunky / Cards keys a BUZZ cut skips: generateHair then builds only the buzz cap (+ facial hair). */
export const HAIR_BUZZ_INERT: readonly string[] = [
    'verticalOffset', 'backLength', 'spikeCap', 'spikePattern', 'spikeLength', 'spikeJitter',
    'scalpLength', 'lengthFront', 'lengthSide', 'lengthBack', 'scalpBluntness',
    'curlType', 'curlAmount', 'curlFreq', 'curlPhaseJitter', 'layering', 'chop',
    'partingStyle', 'partingPosition', 'partingWidth', 'bangCount', 'bangLength', 'bangCurve', 'bangPointiness', 'bangOffset',
    'sideLock', 'sideLockLength', 'sideLockWidth', 'sideLockCount',
    'tailStyle', 'tailHeight', 'tailSpread', 'tailLength', 'tailThickness', 'tailTaper', 'tailStartTaper', 'tailCurl', 'tailTip',
    'frontDrape', 'frontDrapeSide', 'frontDrapeOrigin', 'frontDrapeLength', 'frontDrapeWaveX', 'frontDrapeWaveZ',
    'frontDrapeStrays', 'frontDrapeStrayX', 'frontDrapeStrayZ', 'bunStyle', 'bunSize',
    'cardWidth', 'cardsPerClump', 'cardSegments', 'cardifyCap', 'capLayers', 'cardDetail',
];

/** The params hairControlVisibleFor reads (a panel passes its HairParams; absent = the generator defaults). */
export type HairControlParams = { [key: string]: unknown };

/** hairControlVisible + the in-mode conditions (gathered hair, buzz cut, bang count, fringe shape, spikes, tails /
 *  front drape / cardified cap, facial hair). Use this when the full params are at hand. Every rule mirrors a
 *  generateHair / buildLockHair gate; hair-control-modes.test.ts verifies them by perturbing each key per scenario. */
export function hairControlVisibleFor(key: string, p: HairControlParams): boolean {
    if (!hairControlVisible(key, p.hairMode)) return false;
    const mode = hairControlModeOf(p.hairMode);
    const str = (v: unknown, d: string): string => String(v ?? d).toLowerCase().trim();
    const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const tails = str(p.tailStyle, 'none') !== 'none';
    if (str(p.facialHair, 'none') === 'none' && (key === 'beardLength' || key === 'beardDensity')) return false;
    if (mode === 'locks') {
        const fringe = str(p.fringeStyle, 'choppy');
        if (HAIR_GATHERED_INERT.includes(key) && hairGatheredOf(p)) return key === 'lockJitter' && fringe === 'choppy';
        if (key === 'fringeHeight') return fringe !== 'none';
        if (key === 'fringeSide') return fringe === 'swept' || fringe === 'parted';
        if (key === 'lockFlick') return num(p.lockSpike, 0) <= 0.01;            // spiky crown locks never flick
        const form = str(p.tailForm, 'bundle');
        if (key === 'tailTaper') return tails && form !== 'drill';            // the drill curl has its own taper
        if (key === 'tailLocks') return tails && form === 'bundle';
        if (key === 'drillTurns') return tails && form === 'drill';
        if (key.startsWith('tail') && key !== 'tailStyle') return tails;
        return true;
    }
    // Chunky / Cards (the legacy build)
    if (p.buzzCut === true) return !HAIR_BUZZ_INERT.includes(key);
    const bangs = Math.round(num(p.bangCount, 6)) > 0;
    const spiky = p.spikeCap === true;
    const drape = num(p.frontDrape, 0) > 0;
    const cardCap = p.cardifyCap === true && !spiky;                          // the spike cap replaces the card cap
    if (key === 'frontDrapeStrayX' || key === 'frontDrapeStrayZ') return drape && num(p.frontDrapeStrays, 0) >= 0.5;
    if (key.startsWith('frontDrape') && key !== 'frontDrape') return drape;
    switch (key) {
        case 'partingPosition': case 'partingWidth': return bangs && str(p.partingStyle, 'parted') !== 'fringe';
        case 'partingStyle': case 'bangLength': case 'bangCurve': case 'bangPointiness': case 'bangOffset':
        case 'verticalOffset': return bangs;                                   // verticalOffset only lifts the bang hairline
        case 'tailThickness': return tails || drape || spiky;                 // the drape + the spike tufts size from it
        case 'tailTaper': case 'tailTip': return tails || drape;
        case 'cardWidth': case 'cardsPerClump': case 'cardSegments': return tails || drape;   // card tails / drape only
        case 'cardDetail': return tails || drape || cardCap;
        case 'cardifyCap': return !spiky;
        case 'capLayers': return cardCap;
    }
    if (key.startsWith('tail') && key !== 'tailStyle') return tails;
    return true;
}
