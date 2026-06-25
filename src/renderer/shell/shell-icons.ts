/**
 * shell-icons.ts — Procedural placeholder icons for the Shell UI.
 *
 * Draws simple, recognizable transparent silhouettes (pencil, gear, plus) to a
 * canvas. Each returns both a data URL (for the thumbnail atlas) and raw RGBA
 * pixels (for the Billboard3D mesh generator, which needs the alpha channel to
 * trace the cutout silhouette). Real art can replace these later — the shell
 * just needs *something* shaped + transparent to demo the 3D cutouts.
 */

export interface PlaceholderIcon {
  dataUrl: string;
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
}

export type IconKind = 'pencil' | 'gear' | 'plus' | 'star' | 'frog' | 'download';

const SIZE = 256;

/** Map a system-app key to an icon kind. */
export function iconKindForSystemKey(key: string | undefined): IconKind {
  switch (key) {
    case 'illustrator': return 'pencil';
    case 'settings':    return 'gear';
    default:            return 'plus'; // install / unknown
  }
}

/** Ink-blue used for the screen-print outlines on every icon. */
const INK = '#1a4c7c';
const INK_W = 8;

/** Fill the current path, then stroke it in ink (the inked-flat look). */
function inkFill(ctx: CanvasRenderingContext2D, fill: string, lineW = INK_W) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = lineW;
  ctx.stroke();
}

export function drawPlaceholderIcon(kind: IconKind): PlaceholderIcon {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  switch (kind) {
    case 'pencil': drawPencil(ctx); break;
    case 'gear':   drawGear(ctx); break;
    case 'plus':   drawPlus(ctx); break;
    case 'star':     drawStar(ctx); break;
    case 'frog':     drawFrog(ctx); break;
    case 'download': drawDownload(ctx); break;
  }

  const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data;
  return { dataUrl: canvas.toDataURL('image/png'), rgba, w: SIZE, h: SIZE };
}

function drawPencil(ctx: CanvasRenderingContext2D) {
  const c = SIZE / 2;
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(-Math.PI / 4);
  const w = 56, len = 150;
  // body
  roundRect(ctx, -w / 2, -len / 2, w, len * 0.72, 10);
  inkFill(ctx, '#f6c94b');
  // metal band
  ctx.beginPath();
  ctx.rect(-w / 2, len / 2 - len * 0.28 - 14, w, 16);
  inkFill(ctx, '#c9cdd6', 6);
  // eraser
  roundRect(ctx, -w / 2, len / 2 - len * 0.28 + 2, w, len * 0.16, 8);
  inkFill(ctx, '#ec6a8f');
  // tip
  ctx.beginPath();
  ctx.moveTo(-w / 2, -len / 2);
  ctx.lineTo(w / 2, -len / 2);
  ctx.lineTo(0, -len / 2 - 42);
  ctx.closePath();
  inkFill(ctx, '#e8b04a');
  // graphite
  ctx.beginPath();
  ctx.moveTo(-12, -len / 2 - 24);
  ctx.lineTo(12, -len / 2 - 24);
  ctx.lineTo(0, -len / 2 - 42);
  ctx.closePath();
  inkFill(ctx, '#3a3a40', 5);
  ctx.restore();
}

function drawGear(ctx: CanvasRenderingContext2D) {
  const c = SIZE / 2;
  const teeth = 7;
  const rOuter = 110, rInner = 66, toothW = 0.34;
  ctx.save();
  ctx.translate(c, c);
  ctx.beginPath();
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const a1 = a0 + (toothW / teeth) * Math.PI * 2;
    const a2 = ((i + 1) / teeth) * Math.PI * 2 - (toothW / teeth) * Math.PI * 2;
    const a3 = ((i + 1) / teeth) * Math.PI * 2;
    pt(ctx, rInner, a0, i === 0, true);
    pt(ctx, rOuter, a1, false, false);
    pt(ctx, rOuter, a2, false, false);
    pt(ctx, rInner, a3, false, false);
  }
  ctx.closePath();
  inkFill(ctx, '#9aa3b2');
  // hub
  ctx.beginPath(); ctx.arc(0, 0, 46, 0, Math.PI * 2);
  inkFill(ctx, '#6b7484');
  // center hole (darker, not transparent — keeps a clean silhouette)
  ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2);
  inkFill(ctx, '#3f4654', 5);
  ctx.restore();
}

function drawPlus(ctx: CanvasRenderingContext2D) {
  const c = SIZE / 2;
  const a = 60, t = 22; // half-arm, half-thick
  ctx.save();
  ctx.translate(c, c);
  // Single cross polygon (clean outline; round joins soften the corners).
  ctx.beginPath();
  const v = [
    [-t, -a], [t, -a], [t, -t], [a, -t], [a, t], [t, t],
    [t, a], [-t, a], [-t, t], [-a, t], [-a, -t], [-t, -t],
  ];
  v.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  inkFill(ctx, '#5fc28a');
  ctx.restore();
}

function drawStar(ctx: CanvasRenderingContext2D) {
  const c = SIZE / 2;
  ctx.save();
  ctx.translate(c, c);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 110 : 46;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  inkFill(ctx, '#f3d35b');
  ctx.restore();
}

/** Download arrow (down arrow into a tray) — Install Cart. Vertically symmetric,
 *  so its Billboard3D cutout reads the same from both sides (no mirror needed). */
function drawDownload(ctx: CanvasRenderingContext2D) {
  const c = SIZE / 2;
  ctx.save();
  ctx.translate(c, c);
  const fill = '#5fc28a';
  // stem
  roundRect(ctx, -20, -92, 40, 100, 12);
  inkFill(ctx, fill);
  // arrowhead (pointing down)
  ctx.beginPath();
  ctx.moveTo(-58, 0);
  ctx.lineTo(58, 0);
  ctx.lineTo(0, 70);
  ctx.closePath();
  inkFill(ctx, fill);
  // tray / baseline
  roundRect(ctx, -76, 90, 152, 28, 12);
  inkFill(ctx, fill);
  ctx.restore();
}

function drawFrog(ctx: CanvasRenderingContext2D) {
  const c = SIZE / 2;
  ctx.save();
  ctx.translate(c, c);
  // Eye bumps (behind, so they peek above the head).
  ctx.beginPath(); ctx.arc(-52, -58, 40, 0, Math.PI * 2); inkFill(ctx, '#7cc86c');
  ctx.beginPath(); ctx.arc(52, -58, 40, 0, Math.PI * 2); inkFill(ctx, '#7cc86c');
  // Head.
  roundRect(ctx, -92, -58, 184, 150, 56); inkFill(ctx, '#7cc86c');
  // Eye whites + pupils.
  ctx.beginPath(); ctx.arc(-52, -64, 23, 0, Math.PI * 2); inkFill(ctx, '#fbf7ea', 5);
  ctx.beginPath(); ctx.arc(52, -64, 23, 0, Math.PI * 2); inkFill(ctx, '#fbf7ea', 5);
  ctx.fillStyle = '#1a1a22';
  ctx.beginPath(); ctx.arc(-52, -62, 10, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(52, -62, 10, 0, Math.PI * 2); ctx.fill();
  // Smile.
  ctx.beginPath();
  ctx.moveTo(-46, 30);
  ctx.quadraticCurveTo(0, 64, 46, 30);
  ctx.strokeStyle = INK; ctx.lineWidth = 8; ctx.stroke();
  ctx.restore();
}

function pt(ctx: CanvasRenderingContext2D, r: number, a: number, move: boolean, _first: boolean) {
  const x = Math.cos(a) * r, y = Math.sin(a) * r;
  if (move) ctx.moveTo(x, y); else ctx.lineTo(x, y);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
