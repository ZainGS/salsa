import { describe, it, expect } from 'vitest';
import { nearestInteractable, InteractionSystem, type Interactable, type Vec3 } from './interaction';

const list: Interactable[] = [
    { id: 'door',  position: [0, 0, 0], range: 2 },
    { id: 'sign',  position: [5, 0, 0], range: 2 },
    { id: 'chest', position: [0, 0, 1], range: 2 },
];

describe('nearestInteractable', () => {
    it('returns the nearest interactable within range', () => {
        const r = nearestInteractable([0.2, 0, 0], list);   // closest to door, chest ~1.02 away
        expect(r?.id).toBe('door');
    });
    it('respects each interactable\'s own range', () => {
        // Player near the sign but just outside its range 2 (distance 2.5) → no result.
        expect(nearestInteractable([7.5, 0, 0], list)).toBeNull();
        // A far item with a huge range is reachable.
        const big: Interactable[] = [{ id: 'beacon', position: [0, 0, 0], range: 100 }];
        expect(nearestInteractable([50, 0, 0], big)?.id).toBe('beacon');
    });
    it('picks the closest when several are in range', () => {
        const r = nearestInteractable([0, 0, 0.6], list);   // chest at z=1 (0.4) beats door at 0.6
        expect(r?.id).toBe('chest');
    });
    it('uses 3D distance (height counts)', () => {
        const tall: Interactable[] = [{ id: 'lamp', position: [0, 5, 0], range: 2 }];
        expect(nearestInteractable([0, 0, 0], tall)).toBeNull();   // 5 up, out of range 2
    });
    it('empty list → null', () => {
        expect(nearestInteractable([0, 0, 0] as Vec3, [])).toBeNull();
    });
});

describe('InteractionSystem', () => {
    it('setInteractables + nearest', () => {
        const sys = new InteractionSystem();
        sys.setInteractables(list);
        expect(sys.nearest([0.1, 0, 0])?.id).toBe('door');
        expect(sys.interactables.length).toBe(3);
        sys.setInteractables([]);
        expect(sys.nearest([0, 0, 0])).toBeNull();
    });
});
