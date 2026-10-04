import { describe, it, expect } from 'vitest';
import { ByteLru } from './byte-lru';

// performance-plan P10.D3 — the streamed-tile caches are bounded by bytes AND count, oldest evicted first.

describe('ByteLru', () => {
    it('evicts the oldest entries once the byte cap is exceeded', () => {
        const ev: string[] = [];
        const c = new ByteLru<number>(100, Infinity, (k) => ev.push(k));
        c.put('a', 1, 40); c.put('b', 2, 40); c.put('c', 3, 40);
        expect(c.keys()).toEqual(['b', 'c']);
        expect(c.bytes).toBe(80);
        expect(ev).toEqual(['a']);
    });
    it('evicts by count too', () => {
        const c = new ByteLru<number>(Infinity, 2);
        c.put('a', 1, 1); c.put('b', 2, 1); c.put('c', 3, 1);
        expect(c.keys()).toEqual(['b', 'c']);
        expect(c.evicted).toBe(1);
    });
    it('take removes the entry; re-putting it makes it the most recent', () => {
        const c = new ByteLru<string>(100, 3);
        c.put('a', 'A', 10); c.put('b', 'B', 10); c.put('c', 'C', 10);
        expect(c.take('a')).toBe('A');
        expect(c.take('a')).toBeNull();
        expect(c.bytes).toBe(20);
        c.put('a', 'A', 10); c.put('d', 'D', 10);   // 'b' is now the oldest
        expect(c.keys()).toEqual(['c', 'a', 'd']);
    });
    it('replacing a key updates its bytes; an entry bigger than the cap is not kept', () => {
        const c = new ByteLru<number>(50);
        c.put('a', 1, 10); c.put('a', 2, 30);
        expect(c.size).toBe(1); expect(c.bytes).toBe(30);
        c.put('huge', 3, 80);
        expect(c.has('huge')).toBe(false);
        expect(c.bytes).toBeLessThanOrEqual(50);
    });
    it('an endless stream of retires stays bounded', () => {
        const c = new ByteLru<number>(64, 8);
        for (let i = 0; i < 10000; i++) c.put(`t${i}`, i, 1 + (i % 13));
        expect(c.size).toBeLessThanOrEqual(8);
        expect(c.bytes).toBeLessThanOrEqual(64);
        c.setCaps(10, 2);
        expect(c.size).toBeLessThanOrEqual(2);
        expect(c.bytes).toBeLessThanOrEqual(10);
        c.clear();
        expect(c.size).toBe(0); expect(c.bytes).toBe(0);
    });
});
