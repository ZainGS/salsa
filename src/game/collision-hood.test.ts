import { describe, it, expect } from 'vitest';
import { CollisionHood, type HoodBox } from './collision-hood';

/** Fake world: axis-aligned boxes; "touches" = box overlap. */
type B = { id: number; b: HoodBox; mover?: boolean };
const overlap = (a: HoodBox, b: HoodBox) => a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2];

function world(): B[] {
  const out: B[] = [];
  let id = 0;
  for (let x = -20; x <= 20; x += 2) for (let z = -20; z <= 20; z += 2) out.push({ id: id++, b: [x, 0, z, x + 1, 1, z + 1] });
  out.push({ id: id++, b: [100, 0, 100, 101, 1, 101], mover: true });
  return out;
}

describe('CollisionHood (P6)', () => {
  const W = world();
  let regionCalls = 0;
  const hood = new CollisionHood<B>({
    region: (x0, z0, x1, z1) => { regionCalls++; return W.filter((m) => m.mover || (m.b[3] >= x0 && m.b[0] <= x1 && m.b[5] >= z0 && m.b[2] <= z1)); },
    touches: (m, b) => overlap(m.b, b),
    alwaysKeep: (m) => !!m.mover,
  }, { growth: 3 });

  it('serves bounded rays from one list until a ray leaves the box', () => {
    const l1 = hood.candidatesFor([0.5, 0.5, 0.5], [1, 0, 0], 1)!;
    expect(l1).not.toBeNull();
    expect(hood.stats.rebuilds).toBe(1);
    // Every mesh a segment inside the box can touch is in the list.
    const box = hood.box!;
    for (const m of W) if (!m.mover && overlap(m.b, box as HoodBox)) expect(l1).toContain(m);
    expect(l1.some((m) => m.mover)).toBe(true);   // movers always kept
    const l2 = hood.candidatesFor([1, 0.5, 0.5], [0, 0, 1], 0.5)!;
    expect(l2).toBe(l1);
    expect(hood.stats.rebuilds).toBe(1);
    // Leave the box → re-centred.
    hood.candidatesFor([15, 0.5, 15], [1, 0, 0], 1);
    expect(hood.stats.rebuilds).toBe(2);
    expect(regionCalls).toBe(2);
  });

  it('passes unbounded rays through (null → the caller keeps its own list)', () => {
    expect(hood.candidatesFor([0, 5, 0], [0, -1, 0], Infinity)).toBeNull();
  });

  it('reset forgets the box', () => {
    hood.reset();
    expect(hood.box).toBeNull();
  });
});
