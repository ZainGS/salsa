import { describe, it, expect } from 'vitest';
import { ScriptBehaviorManager } from './script-behavior-manager';

describe('ScriptBehaviorManager — attach/enable/list/persist', () => {
  it('set attaches (enabled=true default) and get returns it', () => {
    const m = new ScriptBehaviorManager();
    m.set('n1', 'export function onTick(){}', { name: 'Patrol' });
    const b = m.get('n1');
    expect(b).toMatchObject({ nodeId: 'n1', enabled: true, name: 'Patrol' });
    expect(m.get('missing')).toBeNull();
    expect(m.has('n1')).toBe(true);
  });

  it('set replaces source but preserves prior enabled/name unless overridden', () => {
    const m = new ScriptBehaviorManager();
    m.set('n1', 'src A', { name: 'Foo' });
    m.setEnabled('n1', false);
    m.set('n1', 'src B');   // no opts
    const b = m.get('n1')!;
    expect(b.source).toBe('src B');
    expect(b.enabled).toBe(false);   // preserved
    expect(b.name).toBe('Foo');      // preserved
    m.set('n1', 'src C', { enabled: true, name: 'Bar' });
    expect(m.get('n1')).toMatchObject({ enabled: true, name: 'Bar' });
  });

  it('remove + setEnabled report whether they applied', () => {
    const m = new ScriptBehaviorManager();
    m.set('n1', 'x');
    expect(m.setEnabled('n1', false)).toBe(true);
    expect(m.setEnabled('nope', false)).toBe(false);
    expect(m.remove('n1')).toBe(true);
    expect(m.remove('n1')).toBe(false);
  });

  it('list / listEnabled / size', () => {
    const m = new ScriptBehaviorManager();
    m.set('a', 'x'); m.set('b', 'y'); m.set('c', 'z');
    m.setEnabled('b', false);
    expect(m.size).toBe(3);
    expect(m.list().map((b) => b.nodeId)).toEqual(['a', 'b', 'c']);
    expect(m.listEnabled().map((b) => b.nodeId)).toEqual(['a', 'c']);
  });

  it('serialize → restore round-trips; restore clears first and skips malformed', () => {
    const m = new ScriptBehaviorManager();
    m.set('a', 'srcA', { name: 'A' });
    m.set('b', 'srcB'); m.setEnabled('b', false);
    const snap = m.serialize();

    const m2 = new ScriptBehaviorManager();
    m2.set('stale', 'should be gone');
    m2.restore(snap);
    expect(m2.has('stale')).toBe(false);              // cleared first
    expect(m2.get('a')).toMatchObject({ source: 'srcA', enabled: true, name: 'A' });
    expect(m2.get('b')!.enabled).toBe(false);

    // malformed entries are skipped, valid ones kept
    m2.restore([{ nodeId: 'ok', source: 's', enabled: true }, { nodeId: 42 } as any, null as any]);
    expect(m2.size).toBe(1);
    expect(m2.has('ok')).toBe(true);
  });

  it('clear empties the map', () => {
    const m = new ScriptBehaviorManager();
    m.set('a', 'x');
    m.clear();
    expect(m.size).toBe(0);
  });
});
