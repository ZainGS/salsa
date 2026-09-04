import { describe, it, expect } from 'vitest';
import { sceneAuthoringTools, runSceneAuthoringTool } from './scene-authoring-tools';
import type { SceneAuthoringAPI } from './scene-authoring-api';

// A Proxy spy: every property access returns a recording function, so we don't hand-list the ~35 API verbs.
function spyApi() {
    const calls: Record<string, unknown[]> = {};
    const api = new Proxy({}, {
        get: (_t, prop: string) => (...args: unknown[]) => { calls[prop] = args; return `${prop}-ret`; },
    }) as unknown as SceneAuthoringAPI;
    return { api, calls };
}

describe('sceneAuthoringTools (schema)', () => {
    const tools = sceneAuthoringTools();

    it('produces a non-trivial tool list with the expected shape', () => {
        expect(tools.length).toBeGreaterThan(25);
        for (const t of tools) {
            expect(typeof t.name).toBe('string');
            expect(typeof t.description).toBe('string');
            expect(t.input_schema.type).toBe('object');
            expect(t.input_schema.properties).toBeTypeOf('object');
        }
    });

    it('tool names are unique', () => {
        const names = tools.map(t => t.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('★ every generated tool has a dispatch case (schema ↔ dispatcher stay in sync)', () => {
        const { api } = spyApi();
        for (const t of tools) {
            expect(() => runSceneAuthoringTool(api, t.name, {}), `tool "${t.name}" is not dispatched`).not.toThrow();
        }
    });
});

describe('runSceneAuthoringTool (dispatch)', () => {
    it('routes primitive verbs with the input object + returns the verb result', () => {
        const { api, calls } = spyApi();
        expect(runSceneAuthoringTool(api, 'addBox', { x: 1, width: 2 })).toBe('addBox-ret');
        expect(calls.addBox).toEqual([{ x: 1, width: 2 }]);
    });

    it('splits id-plus-object verbs correctly', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'setPosition', { id: 'a', x: 5, z: 9 });
        expect(calls.setPosition).toEqual(['a', { id: 'a', x: 5, z: 9 }]);
        runSceneAuthoringTool(api, 'setColor', { id: 'a', r: 1, g: 0, b: 0 });
        expect(calls.setColor).toEqual(['a', 1, 0, 0, 1]);   // alpha defaults to 1
        runSceneAuthoringTool(api, 'select', { ids: ['x', 'y'] });
        expect(calls.select).toEqual([['x', 'y']]);
    });

    it('addCylinder + addCone forward the taper (radiusTop)', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'addCylinder', { radius: 0.5, radiusTop: 0.1 });
        expect(calls.addCylinder).toEqual([{ radius: 0.5, radiusTop: 0.1 }]);
        runSceneAuthoringTool(api, 'addCone', { radius: 0.3 });
        expect(calls.addCone).toEqual([{ radius: 0.3 }]);
    });

    it('addMetaballs forwards the blob list', () => {
        const { api, calls } = spyApi();
        const blobs = [{ shape: 'capsule', a: [0, 0, -1], b: [0, 0, 1], radius: 0.3, blend: 0.3 }];
        runSceneAuthoringTool(api, 'addMetaballs', { blobs, resolution: 40 });
        expect(calls.addMetaballs).toEqual([{ blobs, resolution: 40 }]);
    });

    it('setSurfaceMaterial routes name + opts; setSceneStyle takes the style', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'setSurfaceMaterial', { id: 'm', name: 'ashlar', tileSize: 2, weather: 'mossy' });
        expect(calls.setSurfaceMaterial).toEqual(['m', 'ashlar', { tint: undefined, tileSize: 2, weather: 'mossy' }]);
        runSceneAuthoringTool(api, 'setSceneStyle', { style: 'cel' });
        expect(calls.setSceneStyle).toEqual(['cel']);
    });

    it('addProp passes typeId + params + transform positionally', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'addProp', { typeId: 'bench', params: { width: 2 }, transform: { x: 1 } });
        expect(calls.addProp).toEqual(['bench', { width: 2 }, { x: 1 }]);
    });

    it('throws on an unknown tool name', () => {
        const { api } = spyApi();
        expect(() => runSceneAuthoringTool(api, 'notARealTool', {})).toThrow(/Unknown scene-authoring tool/);
    });

    it('applyScenePlan runs every op inside one begin/end batch and returns per-op results', async () => {
        const { api, calls } = spyApi();
        const out = await (runSceneAuthoringTool(api, 'applyScenePlan', {
            ops: [
                { tool: 'addBox', input: { x: 1 } },
                { tool: 'setColor', input: { id: 'a', r: 1, g: 0, b: 0 } },
            ],
        }) as Promise<{ tool: string; result: unknown }[]>);
        expect(calls.beginBatch).toBeDefined();
        expect(calls.endBatch).toBeDefined();
        expect(out).toEqual([
            { tool: 'addBox', result: 'addBox-ret' },
            { tool: 'setColor', result: 'setColor-ret' },
        ]);
        expect(calls.addBox).toEqual([{ x: 1 }]);
    });

    it('applyScenePlan awaits async ops before closing the batch', async () => {
        // an async verb inside a plan must resolve to its VALUE, not leave a pending Promise
        const authoring = new Proxy({}, {
            get: (_t, p: string) => p === 'addCharacter' ? async () => 'char-1' : (...a: unknown[]) => `${p}-ret-${a.length}`,
        }) as unknown as import('./scene-authoring-api').SceneAuthoringAPI;
        const out = await (runSceneAuthoringTool(authoring, 'applyScenePlan', { ops: [{ tool: 'addCharacter', input: {} }] }) as Promise<{ tool: string; result: unknown }[]>);
        expect(out[0].result).toBe('char-1');   // resolved value, not a Promise
    });

    it('applyScenePlan refuses to nest', async () => {
        const { api } = spyApi();
        const out = await (runSceneAuthoringTool(api, 'applyScenePlan', { ops: [{ tool: 'applyScenePlan', input: {} }] }) as Promise<{ result: { error?: string } }[]>);
        expect(out[0].result.error).toMatch(/nested/);
    });
});

describe('runSceneAuthoringTool (mesh editing)', () => {
    it('extrudeFaces passes id + faceIndices + distance positionally', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'extrudeFaces', { id: 'm', faceIndices: [0, 2], distance: 0.5 });
        expect(calls.extrudeFaces).toEqual(['m', [0, 2], 0.5]);
    });

    it('facesByNormal defaults threshold to 0.7', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'facesByNormal', { id: 'm', axis: [0, 1, 0] });
        expect(calls.facesByNormal).toEqual(['m', [0, 1, 0], 0.7]);
    });

    it('moveVertex splits id + index + delta', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'moveVertex', { id: 'm', vertexIndex: 4, dx: 0, dy: 1, dz: 0 });
        expect(calls.moveVertex).toEqual(['m', 4, 0, 1, 0]);
    });

    it('addMirrorModifier defaults axis=x, clipping=true', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'addMirrorModifier', { id: 'm' });
        expect(calls.addMirrorModifier).toEqual(['m', 'x', true]);
    });

    it('deleteFaces forwards undefined faceIndices (→ act on selection)', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'deleteFaces', { id: 'm' });
        expect(calls.deleteFaces).toEqual(['m', undefined]);
    });
});

describe('runSceneAuthoringTool (scene bounds / framing)', () => {
    it('getSceneBounds + getArtboard take no args', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'getSceneBounds', {});
        runSceneAuthoringTool(api, 'getArtboard', {});
        expect(calls.getSceneBounds).toEqual([]);
        expect(calls.getArtboard).toEqual([]);
    });

    it('isInView forwards the id', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'isInView', { id: 'obj9' });
        expect(calls.isInView).toEqual(['obj9']);
    });

    it('fitToFrame defaults padding to 0.9', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'fitToFrame', {});
        expect(calls.fitToFrame).toEqual([0.9]);
    });

    it('setStudioLighting takes no args', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'setStudioLighting', {});
        expect(calls.setStudioLighting).toEqual([]);
    });
});

describe('runSceneAuthoringTool (rigging + animation)', () => {
    it('addBone passes skeletonId + parentIndex + position + name positionally', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'addBone', { skeletonId: 's', parentIndex: -1, position: [0, 1, 0], name: 'root' });
        expect(calls.addBone).toEqual(['s', -1, [0, 1, 0], 'root']);
    });

    it('poseBone bundles x/y/z into a Vec3 euler object', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'poseBone', { skeletonId: 's', jointIndex: 3, y: 45 });
        expect(calls.poseBone).toEqual(['s', 3, { x: undefined, y: 45, z: undefined }]);
    });

    it('createClip defaults fps=24, endFrame=60', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'createClip', { skeletonId: 's', name: 'walk' });
        expect(calls.createClip).toEqual(['s', 'walk', 24, 60]);
    });

    it('bindMesh forwards meshId + skeletonId', () => {
        const { api, calls } = spyApi();
        runSceneAuthoringTool(api, 'bindMesh', { meshId: 'm', skeletonId: 's' });
        expect(calls.bindMesh).toEqual(['m', 's']);
    });
});
