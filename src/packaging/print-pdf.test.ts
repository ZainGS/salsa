import { describe, it, expect } from 'vitest';
import { buildPrintPdf, rgbaToRgb } from './print-pdf';
import { unzlibSync } from 'fflate';

const dec = new TextDecoder('latin1');

function solidPage(w: number, h: number, wMm: number, hMm: number, rgbVal: [number, number, number]) {
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { rgb[i * 3] = rgbVal[0]; rgb[i * 3 + 1] = rgbVal[1]; rgb[i * 3 + 2] = rgbVal[2]; }
    return { rgb, widthPx: w, heightPx: h, widthMm: wMm, heightMm: hMm };
}

describe('buildPrintPdf — structure + physical sizing (spec §4: print at ACTUAL size)', () => {
    it('emits a valid header, page count, and mm-exact MediaBoxes in points', () => {
        // Front insert (120.5mm square) + tray card (150.5 × 117.5) shaped pages.
        const bytes = buildPrintPdf([
            solidPage(4, 4, 120.5, 120.5, [255, 0, 0]),
            solidPage(6, 3, 150.5, 117.5, [0, 255, 0]),
        ], { title: 'CD Print Set' });
        const s = dec.decode(bytes);
        expect(s.startsWith('%PDF-1.4')).toBe(true);
        expect(s.endsWith('%%EOF\n')).toBe(true);
        expect(s).toContain('/Count 2');
        // 120.5mm → 341.5748pt, 150.5mm → 426.6142pt, 117.5mm → 333.0709pt (1pt = 25.4/72 mm)
        expect(s).toContain('/MediaBox [0 0 341.5748 341.5748]');
        expect(s).toContain('/MediaBox [0 0 426.6142 333.0709]');
        expect(s).toContain('/Title (CD Print Set)');
        // Each page scales its image to the full page in the content stream.
        expect(s).toContain('q 341.5748 0 0 341.5748 0 0 cm /Im0 Do Q');
    });

    it('embeds the image LOSSLESSLY (FlateDecode round-trips to the exact pixels)', () => {
        const page = solidPage(3, 2, 10, 10, [12, 34, 56]);
        const bytes = buildPrintPdf([page]);
        const s = dec.decode(bytes);
        expect(s).toContain('/Width 3 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode');
        // Extract the image stream bytes between "stream\n" and "\nendstream" after the image dict.
        const head = s.indexOf('/Filter /FlateDecode');
        const start = s.indexOf('stream\n', head) + 'stream\n'.length;
        const end = s.indexOf('\nendstream', start);
        const decoded = unzlibSync(bytes.slice(start, end));
        expect([...decoded]).toEqual([...page.rgb]);
    });

    it('xref offsets point at the right objects', () => {
        const bytes = buildPrintPdf([solidPage(2, 2, 50, 50, [1, 2, 3])]);
        const s = dec.decode(bytes);
        const xrefAt = s.lastIndexOf('\nxref\n') + 1;   // NOT lastIndexOf('xref\n') — that matches inside 'startxref'
        expect(Number(s.slice(s.lastIndexOf('startxref\n') + 10, s.lastIndexOf('%%EOF')))).toBe(xrefAt);
        // Every "NNNNNNNNNN 00000 n" entry must land on "<num> 0 obj".
        const entries = [...s.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
        entries.forEach((off, i) => {
            expect(s.slice(off, off + String(i + 1).length + 6)).toBe(`${i + 1} 0 obj`);
        });
    });

    it('rejects empty input and mismatched buffers', () => {
        expect(() => buildPrintPdf([])).toThrow();
        expect(() => buildPrintPdf([{ rgb: new Uint8Array(5), widthPx: 2, heightPx: 2, widthMm: 10, heightMm: 10 }])).toThrow();
    });
});

describe('rgbaToRgb', () => {
    it('strips alpha and preserves channel order', () => {
        const rgba = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128]);
        expect([...rgbaToRgb(rgba, 2, 1)]).toEqual([10, 20, 30, 40, 50, 60]);
        expect(() => rgbaToRgb(new Uint8Array(7), 2, 1)).toThrow();
    });
});
