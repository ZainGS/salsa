import { describe, it, expect } from 'vitest';
import { drawLandmarkCard, drawLandmarkPill, wrapText, roundRectPath, LM_TAGLINE, CARD3D_RADIUS_PX } from './landmark-card';
import type { Landmark } from './types';

/** Minimal recording stub for CanvasRenderingContext2D — enough for the card painters. */
function mockCtx(charW = 10) {
    const calls: string[] = [];
    const ctx = {
        font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
        textAlign: '', textBaseline: '', letterSpacing: '0px',
        shadowColor: '', shadowBlur: 0, shadowOffsetY: 0,
        save: () => calls.push('save'), restore: () => calls.push('restore'),
        beginPath: () => calls.push('beginPath'), closePath: () => calls.push('closePath'),
        moveTo: () => {}, arcTo: () => calls.push('arcTo'),
        fill: () => calls.push('fill'), stroke: () => calls.push('stroke'),
        translate: () => {}, rotate: () => {},
        fillText: (t: string) => calls.push(`text:${t}`),
        measureText: (t: string) => ({ width: t.length * charW }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
    } as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
}

const LM: Landmark = { id: 1, type: 'museum', block: 0, footprint: [], center: [0, 0], entrance: [0, 0] };

describe('landmark-card — pure canvas painters', () => {
    it('wrapText splits on the measured width and keeps every word', () => {
        const { ctx } = mockCtx(10);
        const lines = wrapText(ctx, 'one two three four', 90);   // 9 chars fit per line
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.join(' ')).toBe('one two three four');
        expect(wrapText(ctx, 'short', 900)).toEqual(['short']);
    });

    it('roundRectPath falls back to arcTo when ctx.roundRect is missing', () => {
        const { ctx, calls } = mockCtx();
        roundRectPath(ctx, 0, 0, 100, 50, 10);
        expect(calls).toContain('beginPath');
        expect(calls.filter((c) => c === 'arcTo')).toHaveLength(4);
    });

    it('playful 2D card draws the header pill inline; 3D does not (pill is a separate mesh)', () => {
        const a = mockCtx();
        drawLandmarkCard(a.ctx, 512, 256, LM, 'playful', false);
        expect(a.calls.some((c) => c.startsWith('text:MUSEUM'))).toBe(true);       // inline pill label
        expect(a.calls.some((c) => c.includes(LM_TAGLINE.museum.split(' ')[0]))).toBe(true);

        const b = mockCtx();
        drawLandmarkCard(b.ctx, 512, 256, LM, 'playful', true);
        expect(b.calls.some((c) => c.startsWith('text:MUSEUM'))).toBe(false);      // no inline pill in 3D
    });

    it('default style draws the LANDMARK eyebrow + name', () => {
        const { ctx, calls } = mockCtx();
        drawLandmarkCard(ctx, 512, 256, LM, 'default', false);
        expect(calls).toContain('text:LANDMARK');
        expect(calls).toContain('text:MUSEUM');
    });

    it('pill auto-fits long names by shrinking the font', () => {
        const { ctx } = mockCtx(12);
        drawLandmarkPill(ctx, 360, 104, 'AN EXTREMELY LONG LANDMARK NAME');
        const fs = parseInt(/([0-9]+)px/.exec(ctx.font)?.[1] ?? '0', 10);
        expect(fs).toBeLessThan(52);
        expect(fs).toBeGreaterThanOrEqual(22);
    });

    it('CARD3D_RADIUS_PX stays in sync with the slab geometry contract', () => {
        expect(CARD3D_RADIUS_PX).toBe(44);
    });
});
