import { describe, it, expect } from 'vitest';
import { SCRIPT_CONTEXT_DTS, SCRIPT_SNIPPETS } from './script-context-dts';
import { ScriptCompiler } from './script-compiler';

describe('SCRIPT_CONTEXT_DTS + SCRIPT_SNIPPETS', () => {
  it('the .d.ts is non-empty and declares the ScriptContext + hooks', () => {
    expect(SCRIPT_CONTEXT_DTS.length).toBeGreaterThan(100);
    expect(SCRIPT_CONTEXT_DTS).toContain('interface ScriptContext');
    for (const hook of ['onStart', 'onTick', 'onTrigger', 'onInteract']) {
      expect(SCRIPT_CONTEXT_DTS).toContain(`function ${hook}`);
    }
  });

  it('every starter snippet compiles cleanly and defines at least one hook', () => {
    const c = new ScriptCompiler();
    expect(SCRIPT_SNIPPETS.length).toBeGreaterThan(0);
    for (const s of SCRIPT_SNIPPETS) {
      const r = c.compile(s.source);
      expect(r.ok, `${s.name} should compile: ${r.error?.message}`).toBe(true);
      const hooks = r.script!;
      const any = hooks.onStart || hooks.onTick || hooks.onTrigger || hooks.onInteract;
      expect(any, `${s.name} defines a hook`).toBeTruthy();
    }
  });
});
