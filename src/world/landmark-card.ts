/**
 * src/world/landmark-card.ts
 *
 * Landmark hover-card CANVAS PAINTING — the pure CanvasRenderingContext2D half of the hover-card feature
 * (docs/specs/hover-outline.md), extracted from WorldManager (audit C3 first cut). WorldManager keeps the
 * stateful half (card/pill mesh lifecycle, fade/grow/spin animation, hover tracking) and calls these to
 * rasterize the textures via setCanvasTexture3D.
 *
 * Drawn imperatively rather than via HTML/CSS so the bubbly look (rounded corners, drop shadow, rotated
 * header pill) renders WITHOUT the experimental HTML-in-Canvas browser flag. Sprite geometry flips V, so
 * everything is drawn upright.
 */

import type { Landmark } from './types';
import { LANDMARK_LABEL } from './signtext';

export type LandmarkCardStyle = 'default' | 'playful';

/** Corner radius of the 3D card texture (px); the extruded slab geometry matches it. */
export const CARD3D_RADIUS_PX = 44;

/** A short friendly line per landmark type (the AC-style "message"). */
export const LM_TAGLINE: Record<string, string> = {
    cityhall: 'Where the town runs itself.', station: 'All aboard — the city rolls through here.',
    museum: 'Art, bones, and quiet halls.', hospital: 'Patched up and sent on their way.',
    shrine: 'A calm spot for a wish.', radiotower: 'Beaming the city to the world.',
    postoffice: 'Letters in, parcels out.', stadium: 'Roar of the home crowd.',
    powerplant: 'Keeping every light on.', megatower: 'It scrapes the sky.', school: 'Recess never ends here.',
};

/** Rounded-rect path helper (roundRect is widely supported; fall back to arcs if not). */
export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    if (typeof (ctx as unknown as { roundRect?: unknown }).roundRect === 'function') {
        ctx.beginPath(); (ctx as CanvasRenderingContext2D & { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(x, y, w, h, rr); return;
    }
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

/** Word-wrap `text` to `maxW`, return the lines (measured with the ctx's current font). */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; }
        else line = test;
    }
    if (line) lines.push(line);
    return lines;
}

/** Draw the standalone 3D header pill texture — an angle-free rounded orange tab with the centred name (auto-fit). */
export function drawLandmarkPill(ctx: CanvasRenderingContext2D, w: number, h: number, name: string): void {
    const m = 10;   // margin for the drop shadow
    const pw = w - m * 2, ph = h - m * 2;
    ctx.save();
    ctx.shadowColor = 'rgba(150,90,10,0.45)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 5;
    roundRectPath(ctx, m, m, pw, ph, ph / 2);
    ctx.fillStyle = '#f4a521'; ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let fs = 52;
    const setF = () => (ctx.font = `800 ${fs}px 'Arial Rounded MT Bold','Nunito',system-ui,sans-serif`);
    setF();
    const maxW = pw - 44;
    while (ctx.measureText(name).width > maxW && fs > 22) { fs -= 2; setF(); }
    ctx.fillText(name, w / 2, h / 2 + 1);
}

/** Paint the hover info card (rasterized to a billboard sprite via setCanvasTexture3D).
 *  `style` picks the look; `is3D` = the extruded-slab variant (no shadow — real depth — and the card fills
 *  the texture so the slab's textured front lines up with its rounded rim; the pill is a separate overlay). */
export function drawLandmarkCard(
    ctx: CanvasRenderingContext2D, w: number, h: number, lm: Landmark, style: LandmarkCardStyle, is3D: boolean,
): void {
    const name = (LANDMARK_LABEL[lm.type] ?? 'BUILDING').toUpperCase();
    const kind = lm.type.replace(/([a-z])([A-Z])/g, '$1 $2');
    const tag = LM_TAGLINE[lm.type] ?? 'A city landmark.';
    const cap = kind.charAt(0).toUpperCase() + kind.slice(1);

    if (style === 'playful') {
        // Two layouts. 2D: the card is INSET in the texture with bleed room so its drop shadow + the pill (which
        // overhangs the top border) don't clip at the texture edge. 3D (extruded slab): NO shadow (real depth),
        // and the card FILLS the texture (margin 0) with a corner radius that MATCHES the rounded slab geometry,
        // so the textured front lines up with the slab's rounded rim — no drawn border (the slab edge is the
        // border). The pill sits INSIDE the top.
        const d3 = is3D;
        const LR = d3 ? 0 : 26, TOP = d3 ? 0 : 44, BOT = d3 ? 0 : 28;
        const cardX = LR, cardY = TOP, cardW = w - LR * 2, cardH = h - TOP - BOT;
        const rad = d3 ? CARD3D_RADIUS_PX : 44;

        // ── Bubbly cream card (drop shadow + drawn border only in 2D) ─────────────
        ctx.save();
        if (!d3) { ctx.shadowColor = 'rgba(120,96,50,0.32)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 7; }
        roundRectPath(ctx, cardX, cardY, cardW, cardH, rad);
        ctx.fillStyle = '#fbf4de'; ctx.fill();
        ctx.restore();
        if (!d3) {
            roundRectPath(ctx, cardX, cardY, cardW, cardH, rad);
            ctx.lineWidth = 7; ctx.strokeStyle = '#efe0af'; ctx.stroke();
        }

        // ── Angled orange header PILL — 2D draws it here (overhangs the top border). 3D does NOT: the pill is a
        // SEPARATE billboard-child overlay mesh so it can truly stick out above the slab. ──
        if (!d3) {
            const pillH = 46;
            ctx.save();
            ctx.translate(cardX + 50, cardY - 1);
            ctx.rotate((-4 * Math.PI) / 180);
            ctx.font = "800 28px 'Arial Rounded MT Bold','Nunito',system-ui,sans-serif";
            const tw = ctx.measureText(name).width;
            ctx.shadowColor = 'rgba(150,90,10,0.40)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 4;
            roundRectPath(ctx, -14, -pillH / 2, tw + 52, pillH, pillH / 2);
            ctx.fillStyle = '#f4a521'; ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
            ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle';
            ctx.fillText(name, 12, 1);
            ctx.restore();
        }

        // ── Tagline (adaptive: shrink a size if it would run past 2 lines) + sub-label right beneath it ──
        const padX = cardX + (d3 ? 30 : 32);
        const wrapW = cardW - (d3 ? 56 : 60);
        let fs = 38;
        ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
        ctx.font = `800 ${fs}px 'Arial Rounded MT Bold','Nunito',system-ui,sans-serif`;
        let lines = wrapText(ctx, tag, wrapW);
        if (lines.length > 2) {
            fs = 31;
            ctx.font = `800 ${fs}px 'Arial Rounded MT Bold','Nunito',system-ui,sans-serif`;
            lines = wrapText(ctx, tag, wrapW);
        }
        const lineH = fs * 1.16;
        ctx.fillStyle = '#6f5a37';
        let ty = (d3 ? cardY + 92 : cardY + 76);   // 3D: start below the overhanging pill overlay's top-left footprint
        for (const line of lines) { ctx.fillText(line, padX, ty); ty += lineH; }

        ctx.fillStyle = '#b39a6a';
        ctx.font = "23px 'Nunito',system-ui,sans-serif";
        ctx.fillText(`${cap} · Landmark`, padX, Math.min(ty + 2, cardY + cardH - 18));
        return;
    }

    // ── 'default' — sleek dark card ───────────────────────────────────────────────
    const m = 10, cardX = m, cardY = m, cardW = w - m * 2, cardH = h - m * 2, rad = 22;
    const g = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
    g.addColorStop(0, '#12203a'); g.addColorStop(1, '#0a1424');
    roundRectPath(ctx, cardX, cardY, cardW, cardH, rad);
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#4fd6ff'; ctx.stroke();

    const padX = cardX + 28;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#4fd6ff';
    ctx.font = "20px sans-serif";
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '3px';
    ctx.fillText('LANDMARK', padX, cardY + 44);
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
    ctx.fillStyle = '#eaf6ff';
    ctx.font = "bold 54px sans-serif";
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
    ctx.fillText(name, padX, cardY + 108);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.fillStyle = '#a9c7e6';
    ctx.font = "26px sans-serif";
    ctx.fillText(cap, padX, cardY + 150);
}
