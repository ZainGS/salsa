import { describe, it, expect } from 'vitest';
import { KeyboardInput } from './keyboard-input';

describe('KeyboardInput → CharacterInput mapping', () => {
    it('maps WASD to forward/right', () => {
        const k = new KeyboardInput();
        k.press('KeyW'); expect(k.read().forward).toBe(1);
        k.press('KeyS'); expect(k.read().forward).toBe(0);   // W and S cancel
        k.release('KeyW'); expect(k.read().forward).toBe(-1);
        k.press('KeyD'); expect(k.read().right).toBe(1);
        k.press('KeyA'); expect(k.read().right).toBe(0);
    });

    it('arrows alias WASD/turn; Q/E turn; Space jumps', () => {
        const k = new KeyboardInput();
        k.press('ArrowUp'); expect(k.read().forward).toBe(1);
        k.clear();
        k.press('KeyE'); expect(k.read().look).toBe(1);
        k.press('KeyQ'); expect(k.read().look).toBe(0);
        k.clear();
        k.press('ArrowRight'); expect(k.read().look).toBe(1);
        k.clear();
        k.press('Space'); expect(k.read().jump).toBe(true);
    });

    it('attach/detach on a fake target adds+removes listeners and reads live events', () => {
        const handlers: Record<string, ((e: unknown) => void)[]> = {};
        const target = {
            addEventListener: (t: string, h: (e: unknown) => void) => { (handlers[t] ??= []).push(h); },
            removeEventListener: (t: string, h: (e: unknown) => void) => { handlers[t] = (handlers[t] ?? []).filter(x => x !== h); },
        } as unknown as EventTarget;
        const k = new KeyboardInput();
        k.attach(target);
        expect(handlers['keydown'].length).toBe(1);
        handlers['keydown'][0]({ code: 'KeyW', preventDefault() {} });
        expect(k.read().forward).toBe(1);
        handlers['keyup'][0]({ code: 'KeyW' });
        expect(k.read().forward).toBe(0);
        k.detach();
        expect(handlers['keydown'].length).toBe(0);   // listeners removed
    });

    it('blur clears held keys (no stuck movement)', () => {
        const handlers: Record<string, ((e: unknown) => void)[]> = {};
        const target = { addEventListener: (t: string, h: (e: unknown) => void) => { (handlers[t] ??= []).push(h); }, removeEventListener: () => {} } as unknown as EventTarget;
        const k = new KeyboardInput();
        k.attach(target);
        handlers['keydown'][0]({ code: 'KeyW', preventDefault() {} });
        expect(k.read().forward).toBe(1);
        handlers['blur'][0]({});
        expect(k.read().forward).toBe(0);
    });
});
