/** Sign palette discipline (persona-polish B5): curated per-mood colours with value spread, white + black boxes, no
 *  pure primaries, lettering that follows the face, all pure hashes. */
import { describe, it, expect } from 'vitest';
import { SIGN_PALETTES, pickSignColors, letteringFor, signLum, signMoodFor, temperSignColor, signGlowTextColor, type SignMood } from './sign-style';

describe('sign palette (B5)', () => {
    it('every mood mixes hue and value: at least one near-white, one near-black or deep tone, and no pure primaries', () => {
        for (const [mood, pal] of Object.entries(SIGN_PALETTES)) {
            const L = pal.map(signLum);
            expect(Math.max(...L), mood).toBeGreaterThan(0.8);
            expect(Math.min(...L), mood).toBeLessThan(0.25);
            for (const c of pal) expect(c.filter(x => x >= 0.99).length + c.filter(x => x <= 0.01).length, `${mood} ${c}`).toBeLessThan(2);
        }
    });
    it('three distinct colours per building, deterministic, with value spread', () => {
        for (const mood of Object.keys(SIGN_PALETTES) as SignMood[]) {
            for (let k = 0; k < 200; k++) {
                const t = pickSignColors(mood, k * 2654435761);
                expect(t).toEqual(pickSignColors(mood, k * 2654435761));
                expect(new Set(t.map(c => c.join(','))).size).toBe(3);
                const L = t.map(signLum);
                expect(Math.max(...L) - Math.min(...L)).toBeGreaterThanOrEqual(0.3 - 1e-9);
            }
        }
    });
    it('a style palette neon joins tempered (no clipped channel)', () => {
        const t = temperSignColor([1, 0.12, 0.18]);
        expect(Math.max(...t)).toBeLessThanOrEqual(0.94 + 1e-9);
        const seen = new Set<string>();
        for (let k = 0; k < 300; k++) for (const c of pickSignColors('shop', k * 7919, [[1, 0.12, 0.18]])) seen.add(c.map(x => x.toFixed(3)).join(','));
        expect([...seen].some(s => s === t.map(x => x.toFixed(3)).join(','))).toBe(true);
    });
    it('lettering follows the face: ink on light boxes, glowing text on dark ones', () => {
        for (let k = 0; k < 20; k++) {
            expect(['ink', 'inkColor']).toContain(letteringFor([0.93, 0.93, 0.9], k));
            expect(['glowColor', 'light']).toContain(letteringFor([0.07, 0.07, 0.08], k));
            expect(letteringFor([0.46, 0.27, 0.78], k)).toBe('light');
        }
        expect(signGlowTextColor([[0.07, 0.07, 0.08], [0.93, 0.93, 0.9], [0.1, 0.64, 0.7]])[2]).toBeGreaterThan(0.8);   // teal → a bright teal glow
    });
    it('visual-polish #8: text always contrasts with its (glowing) box - no cream text on a mid-light face', () => {
        // every curated face + the P5 / P4 style neons (tempered), over many keys
        const faces: number[][] = [...Object.values(SIGN_PALETTES).flat(),
            ...[[1.0, 0.12, 0.18], [1.0, 0.95, 0.95], [0.20, 0.85, 1.0], [1.0, 0.78, 0.10], [0.95, 0.20, 0.75], [1.0, 0.55, 0.20], [0.35, 0.80, 0.55]].map(temperSignColor)];
        for (const f of faces) for (let k = 0; k < 16; k++) {
            const l = letteringFor(f, k * 977), L = signLum(f);
            if (l === 'light' || l === 'glowColor') expect(L, `${f}`).toBeLessThanOrEqual(0.5);   // cream / glowing text: dark or saturated faces only
            else expect(L, `${f}`).toBeGreaterThan(0.5);                                          // dark ink: light faces
            if (l === 'inkColor') expect(L, `${f}`).toBeGreaterThan(0.75);                      // coloured ink (L <= ~0.4) only on clearly light faces
        }
        expect(letteringFor([0.1, 0.64, 0.7], 3)).toBe('ink');       // teal lightbox (L 0.53): was cream text
        expect(letteringFor([0.93, 0.53, 0.16], 3)).toBe('ink');     // orange (L 0.59): was cream text
        expect(letteringFor([0.82, 0.26, 0.17], 3)).toBe('light');   // the P5 red keeps white lettering
    });
    it('district → mood', () => {
        expect(signMoodFor('downtown')).toBe('nightlife');
        expect(signMoodFor('market')).toBe('food');
        expect(signMoodFor('residential')).toBe('quiet');
        expect(signMoodFor('mixed')).toBe('shop');
        expect(signMoodFor('mixed', 'neon-arcade')).toBe('nightlife');
    });
});
