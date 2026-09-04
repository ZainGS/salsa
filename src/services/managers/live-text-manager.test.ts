import { describe, it, expect } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { LiveTextManager, type LiveTextHost } from './live-text-manager';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import type { ManagerContext } from './manager-context';

// LiveTextNode create/style/edit/flatten route through the node's DOM + GPU paths (browser-only). These pin the
// CPU-safe surface the god-object used to own inline: the scene-graph traversal (findLiveTextNode), the missing-node
// null-guards, and the edit-session accessor. The interactive HTML-in-Canvas paths are browser-verified.
const noopHost: LiveTextHost = { getActiveVectorLayerId: () => null, getTextEffectEngine: () => null };

function makeEnv() {
    const calls = { scheduleRender: 0, emitChanged: 0 };
    const rect: { cb?: unknown; hovered?: unknown } = {};
    const sceneGraph = new SceneGraph();
    const ctx = {
        sceneGraph,
        shapeFactory: {},
        webgpuRenderer: {},
        interactionService: {
            set rectDrawCallback(v: unknown) { rect.cb = v; },
            set hoveredLiveTextId(v: unknown) { rect.hovered = v; },
        },
        rasterLayerManager: undefined,
        scheduleRender: () => { calls.scheduleRender++; },
        emitSceneGraphChanged: () => { calls.emitChanged++; },
    } as unknown as ManagerContext;
    return { mgr: new LiveTextManager(ctx, noopHost), sceneGraph, calls, rect };
}

describe('LiveTextManager', () => {
    it('starts with no active editing session', () => {
        expect(makeEnv().mgr.editingLiveTextId).toBeNull();
    });

    it('getLiveTextNode returns null when no matching node exists', () => {
        expect(makeEnv().mgr.getLiveTextNode('nope')).toBeNull();
    });

    it('editing/content/style ops on a missing node are safe no-ops', () => {
        const { mgr } = makeEnv();
        expect(() => mgr.beginLiveTextEditing('x')).not.toThrow();
        expect(() => mgr.enterLiveTextEditingAt('x', 10, 10)).not.toThrow();
        expect(() => mgr.endLiveTextEditing('x')).not.toThrow();
        expect(() => mgr.setLiveTextContent('x', 'hi')).not.toThrow();
        expect(() => mgr.setLiveTextStyle('x', { bold: true })).not.toThrow();
        expect(() => mgr.setLiveTextEffects('x', [])).not.toThrow();
        // begin found no node → the edit-session id stays null
        expect(mgr.editingLiveTextId).toBeNull();
    });

    it('flattenLiveText resolves false when the node is missing', async () => {
        expect(await makeEnv().mgr.flattenLiveText('x')).toBe(false);
    });

    it('setRectDrawCallback installs the callback and clears the hover on null', () => {
        const { mgr, rect } = makeEnv();
        const cb = () => {};
        mgr.setRectDrawCallback(cb);
        expect(rect.cb).toBe(cb);
        mgr.setRectDrawCallback(null);
        expect(rect.cb).toBeNull();
        expect(rect.hovered).toBeNull();
    });
});
