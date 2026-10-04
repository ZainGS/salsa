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

    it('R6.2: takePress counts Shift key-down EDGES once (a toggle, not a hold); auto-repeat does not re-count', () => {
        const handlers: Record<string, ((e: unknown) => void)[]> = {};
        const target = { addEventListener: (t: string, h: (e: unknown) => void) => { (handlers[t] ??= []).push(h); }, removeEventListener: () => {} } as unknown as EventTarget;
        const k = new KeyboardInput();
        k.attach(target);
        expect(k.takePress('ShiftLeft', 'ShiftRight')).toBe(0);
        handlers['keydown'][0]({ code: 'ShiftLeft', preventDefault() {} });
        handlers['keydown'][0]({ code: 'ShiftLeft', preventDefault() {} });   // auto-repeat while held
        expect(k.takePress('ShiftLeft', 'ShiftRight')).toBe(1);
        expect(k.takePress('ShiftLeft', 'ShiftRight')).toBe(0);                 // consumed
        handlers['keyup'][0]({ code: 'ShiftLeft' });
        handlers['keydown'][0]({ code: 'ShiftRight', preventDefault() {} });   // a quick tap between two ticks…
        handlers['keyup'][0]({ code: 'ShiftRight' });
        expect(k.takePress('ShiftLeft', 'ShiftRight')).toBe(1);                 // …is still seen
    });
});

describe('KeyboardInput — stuck-key guards (editor fly camera flew forward forever)', () => {
    const mk = (opts: ConstructorParameters<typeof KeyboardInput>[0] = {}) => {
        const handlers: Record<string, ((e: unknown) => void)[]> = {};
        const target = { addEventListener: (t: string, h: (e: unknown) => void) => { (handlers[t] ??= []).push(h); }, removeEventListener: () => {} } as unknown as EventTarget;
        const k = new KeyboardInput(opts); k.attach(target);
        return { k, down: (e: object) => handlers['keydown'][0]({ preventDefault() {}, ...e }), up: (e: object) => handlers['keyup'][0](e) };
    };
    it('ignores keys typed into a text field (and does not swallow them)', () => {
        const { k, down } = mk();
        let prevented = false;
        down({ code: 'KeyW', target: { tagName: 'INPUT', type: 'text' }, preventDefault() { prevented = true; } });
        expect(k.anyMoveHeld()).toBe(false);
        expect(prevented).toBe(false);
        down({ code: 'KeyW', target: { tagName: 'TEXTAREA' } });
        down({ code: 'KeyW', target: { tagName: 'DIV', isContentEditable: true } });
        expect(k.anyMoveHeld()).toBe(false);
        down({ code: 'KeyW', target: { tagName: 'INPUT', type: 'range' } });   // a slider is not a text field
        expect(k.anyMoveHeld()).toBe(true);
    });
    it('ignores Ctrl / Alt / Cmd shortcuts', () => {
        const { k, down } = mk();
        down({ code: 'KeyW', ctrlKey: true }); down({ code: 'KeyS', altKey: true }); down({ code: 'KeyD', metaKey: true });
        expect(k.anyMoveHeld()).toBe(false);
        down({ code: 'ControlLeft', ctrlKey: true });
        expect(k.ctrlHeld()).toBe(false);                  // the fly camera never captures Ctrl
    });
    it('Round 8 sneak keys (Play): Ctrl alone is captured, Ctrl + movement still moves, other Ctrl chords are left alone', () => {
        const { k, down, up } = mk({ sneakKeys: true });
        let prevented = 0;
        const pd = { preventDefault() { prevented++; } };
        down({ code: 'ControlLeft', ctrlKey: true, ...pd });
        expect(k.ctrlHeld()).toBe(true);
        expect(prevented).toBe(0);                          // the modifier itself is not swallowed
        down({ code: 'KeyW', ctrlKey: true, ...pd });       // sneak-walk forward
        expect(k.read().forward).toBe(1);
        expect(prevented).toBe(1);                          // Ctrl+W/S/D/A browser action suppressed where possible
        down({ code: 'KeyZ', ctrlKey: true, ...pd });       // Ctrl+Z: not movement, not captured
        down({ code: 'KeyF', ctrlKey: true, ...pd });       // Ctrl+F (find): not "use"
        expect(k.read().interact).toBe(false);
        expect(prevented).toBe(1);
        down({ code: 'ControlLeft', ctrlKey: true, altKey: true, ...pd });   // AltGr / Ctrl+Alt chords: host's
        up({ code: 'ControlLeft' });
        expect(k.ctrlHeld()).toBe(false);
        down({ code: 'KeyC', ...pd });
        expect(k.takePress('KeyC')).toBe(1);                // C = the sneak toggle
        down({ code: 'KeyC', ctrlKey: true, ...pd });       // Ctrl+C (copy) is NOT a toggle
        up({ code: 'KeyC' });
        expect(k.takePress('KeyC')).toBe(0);
    });
    it('readTick: a Space tap that went down AND up between two ticks still jumps once (item 13)', () => {
        const k = new KeyboardInput();
        k.press('Space'); k.release('Space');                 // both edges before the next fixed tick
        expect(k.read().jump).toBe(false);                     // read() alone loses it (not held)
        expect(k.readTick().jump).toBe(true);                  // the key-down edge counts for this tick…
        expect(k.readTick().jump).toBe(false);                 // …once
        k.press('Space');                                      // a HELD press: jump on every tick it's held
        expect(k.readTick().jump).toBe(true);
        expect(k.readTick().jump).toBe(true);
        k.release('Space');
        expect(k.readTick().jump).toBe(false);
    });
    it('releases keys whose keyup was lost once no keydown (incl. auto-repeat) arrives for the quiet window', () => {
        const k = new KeyboardInput();
        k.press('KeyW', 1000);
        expect(k.releaseIfStale(2500)).toBe(false);   // 1.5 s quiet: still held
        expect(k.anyMoveHeld()).toBe(true);
        expect(k.releaseIfStale(3100)).toBe(true);    // 2.1 s with no repeats → the keyup was lost
        expect(k.anyMoveHeld()).toBe(false);
    });
});
