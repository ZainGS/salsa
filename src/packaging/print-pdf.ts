/**
 * src/packaging/print-pdf.ts
 *
 * Minimal PURE print-PDF writer (docs/specs/cd-jewel-case-designer.md §4 — "the product's credibility").
 * Builds a valid PDF 1.4 where each page is one raster image placed at its EXACT physical size: the page
 * MediaBox is the piece's real millimetre dimensions (in PDF points, 1pt = 1/72"), and the image fills it —
 * so a print shop printing "actual size" reproduces the dieline 1:1, with the pixel density chosen at render
 * time (300 DPI default upstream).
 *
 * Images are embedded LOSSLESSLY: raw RGB rows zlib-compressed via fflate (`/Filter /FlateDecode`,
 * `/ColorSpace /DeviceRGB`, 8 bits/channel) — no JPEG artefacts in print output, no PNG re-parsing (PDF can't
 * embed PNG IDAT directly because of per-row filter bytes). No external PDF library; the writer emits the
 * object graph + a correct xref table by hand, which keeps it dependency-free and unit-testable.
 *
 * Colour note (spec §4): output is RGB by design for the MVP — the print partner converts to CMYK. A CMYK
 * soft-proof/export is Phase 2.
 */

import { zlibSync } from 'fflate';

export interface PrintPdfPage {
  /** Tightly packed RGB pixels (3 bytes/px, row-major, no alpha, no padding). */
  rgb: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** Physical page size — the image is placed to fill it exactly. */
  widthMm: number;
  heightMm: number;
}

const MM_TO_PT = 72 / 25.4;

/** Format a physical dimension in points: fixed 4 decimals keeps dieline sizes exact + output deterministic. */
function pt(mm: number): string { return (mm * MM_TO_PT).toFixed(4); }

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Build a multi-page print PDF. Throws on an empty page list or a pixel-buffer size mismatch. */
export function buildPrintPdf(pages: PrintPdfPage[], meta?: { title?: string; producer?: string }): Uint8Array {
  if (!pages.length) throw new Error('buildPrintPdf: no pages');
  for (const p of pages) {
    if (p.rgb.length !== p.widthPx * p.heightPx * 3) {
      throw new Error(`buildPrintPdf: rgb length ${p.rgb.length} ≠ ${p.widthPx}×${p.heightPx}×3`);
    }
  }

  // Object numbering: 1 = catalog, 2 = pages root, 3 = info; then per page i: page, image, contents.
  const objs: Uint8Array[] = [];   // body of each object, in object-number order starting at 1
  const pageObjNums: number[] = [];
  let next = 4;

  const kidsRefs: string[] = [];
  const pageChunks: { num: number; body: Uint8Array }[] = [];
  for (const p of pages) {
    const pageNum = next++, imgNum = next++, contNum = next++;
    pageObjNums.push(pageNum);
    kidsRefs.push(`${pageNum} 0 R`);
    const w = pt(p.widthMm), h = pt(p.heightMm);

    pageChunks.push({
      num: pageNum,
      body: ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contNum} 0 R >>`),
    });

    const zipped = zlibSync(p.rgb);
    const imgHead = ascii(`<< /Type /XObject /Subtype /Image /Width ${p.widthPx} /Height ${p.heightPx} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${zipped.length} >>\nstream\n`);
    const imgTail = ascii('\nendstream');
    const img = new Uint8Array(imgHead.length + zipped.length + imgTail.length);
    img.set(imgHead, 0); img.set(zipped, imgHead.length); img.set(imgTail, imgHead.length + zipped.length);
    pageChunks.push({ num: imgNum, body: img });

    // Content stream: scale the unit-square image XObject to the full page.
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    pageChunks.push({ num: contNum, body: ascii(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`) });
  }

  const esc = (s: string): string => s.replace(/[\\()]/g, (c) => '\\' + c);
  objs.push(ascii('<< /Type /Catalog /Pages 2 0 R >>'));                                       // 1
  objs.push(ascii(`<< /Type /Pages /Kids [${kidsRefs.join(' ')}] /Count ${pages.length} >>`)); // 2
  objs.push(ascii(`<< /Producer (${esc(meta?.producer ?? 'Salsa Print Export')})` +
    (meta?.title ? ` /Title (${esc(meta.title)})` : '') + ' >>'));                             // 3
  for (const c of pageChunks) objs.push(c.body);                                               // 4..N in order

  // Serialize with a byte-accurate xref.
  const parts: Uint8Array[] = [ascii('%PDF-1.4\n%âãÏÓ\n')];   // binary-comment marker line
  let offset = parts[0].length;
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    const head = ascii(`${i + 1} 0 obj\n`);
    const tail = ascii('\nendobj\n');
    offsets.push(offset);
    parts.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });
  const xrefStart = offset;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(ascii(xref));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Strip the alpha channel from RGBA canvas pixels (print pages are opaque; art is composited on white upstream). */
export function rgbaToRgb(rgba: Uint8ClampedArray | Uint8Array, widthPx: number, heightPx: number): Uint8Array {
  const n = widthPx * heightPx;
  if (rgba.length !== n * 4) throw new Error(`rgbaToRgb: length ${rgba.length} ≠ ${widthPx}×${heightPx}×4`);
  const rgb = new Uint8Array(n * 3);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
    rgb[k] = rgba[j]; rgb[k + 1] = rgba[j + 1]; rgb[k + 2] = rgba[j + 2];
  }
  return rgb;
}
