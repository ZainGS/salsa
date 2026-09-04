import { describe, it, expect } from 'vitest';
import { runAuthoringSession, type CallModel, type ModelResponse, type ModelContentBlock, type ModelMessage } from './scene-authoring-session';
import type { SceneAuthoringAPI } from './scene-authoring-api';

// A callModel that replays a fixed script of responses, recording every request it received.
function scripted(responses: ModelResponse[]) {
    const requests: Parameters<CallModel>[0][] = [];
    let i = 0;
    // Snapshot `messages` per call — the loop reuses the same array reference, so store a deep copy to inspect the
    // exact state sent on each turn (else every request would show the final post-loop state).
    const callModel: CallModel = async (req) => {
        requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
        return responses[Math.min(i++, responses.length - 1)];
    };
    return { callModel, requests };
}

// Proxy spy: every verb records its args + returns `${name}-ret`. `overrides` lets a test customise a verb.
function spyAuthoring(overrides: Record<string, (...a: unknown[]) => unknown> = {}) {
    const calls: Record<string, unknown[]> = {};
    const authoring = new Proxy({}, {
        get: (_t, prop: string) => overrides[prop] ?? ((...args: unknown[]) => { calls[prop] = args; return `${prop}-ret`; }),
    }) as unknown as SceneAuthoringAPI;
    return { authoring, calls };
}

const text = (t: string): ModelResponse => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
const toolUse = (id: string, name: string, input: unknown): ModelResponse => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
const findToolResult = (msgs: ModelMessage[]) =>
    msgs.flatMap(m => Array.isArray(m.content) ? m.content : []).find((b): b is Extract<ModelContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');

describe('runAuthoringSession', () => {
    it('returns the model text immediately when no tools are called', async () => {
        const { callModel } = scripted([text('nothing to build')]);
        const r = await runAuthoringSession('hi', spyAuthoring().authoring, callModel);
        expect(r.text).toBe('nothing to build');
        expect(r.turns).toBe(1);
        expect(r.stoppedReason).toBe('end_turn');
    });

    it('runs a tool call, feeds the result back, and loops to completion', async () => {
        const { authoring, calls } = spyAuthoring();
        const { callModel, requests } = scripted([toolUse('t1', 'addBox', { x: 1 }), text('made a box')]);
        const r = await runAuthoringSession('box', authoring, callModel);
        expect(calls.addBox).toEqual([{ x: 1 }]);
        expect(r.text).toBe('made a box');
        expect(r.turns).toBe(2);
        // the 2nd model call must have seen the tool_result appended
        const tr = findToolResult(requests[1].messages);
        expect(tr).toBeDefined();
        expect(tr!.tool_use_id).toBe('t1');
        expect(tr!.content).toBe(JSON.stringify('addBox-ret'));
    });

    it('sends a screenshot back as an IMAGE tool_result (the visual critic loop)', async () => {
        const { authoring } = spyAuthoring({ screenshot: async () => 'data:image/png;base64,AAAA' });
        const { callModel } = scripted([toolUse('s1', 'screenshot', {}), text('looks good')]);
        const r = await runAuthoringSession('shot', authoring, callModel);
        const tr = findToolResult(r.messages)!;
        expect(Array.isArray(tr.content)).toBe(true);
        const img = (tr.content as Array<{ type: string; source: { media_type: string; data: string } }>)[0];
        expect(img.type).toBe('image');
        expect(img.source.media_type).toBe('image/png');
        expect(img.source.data).toBe('AAAA');
    });

    it('turns a tool error into an is_error result and keeps going (never throws)', async () => {
        const { authoring } = spyAuthoring({ addBox: () => { throw new Error('boom'); } });
        const { callModel } = scripted([toolUse('e1', 'addBox', {}), text('recovered')]);
        const r = await runAuthoringSession('err', authoring, callModel);
        const tr = findToolResult(r.messages)!;
        expect(tr.is_error).toBe(true);
        expect(tr.content).toBe('boom');
        expect(r.text).toBe('recovered');   // the loop continued past the error
    });

    it('stops at the turn cap when the model never finishes', async () => {
        const callModel: CallModel = async () => toolUse('x', 'addBox', {});   // always asks for another tool
        const r = await runAuthoringSession('loop', spyAuthoring().authoring, callModel, { maxTurns: 3 });
        expect(r.turns).toBe(3);
        expect(r.stoppedReason).toBe('max_turns');
    });

    it('fires the onToolResult hook for observability', async () => {
        const seen: string[] = [];
        const { authoring } = spyAuthoring();
        const { callModel } = scripted([toolUse('t1', 'addSphere', { radius: 2 }), text('done')]);
        await runAuthoringSession('sphere', authoring, callModel, { onToolResult: c => seen.push(c.name) });
        expect(seen).toEqual(['addSphere']);
    });

    // Count screenshot tool_results that are still LIVE images (array content) vs stubbed (string) in a request.
    const imageCounts = (msgs: ModelMessage[]) => {
        let live = 0, stub = 0;
        for (const m of msgs) {
            if (!Array.isArray(m.content)) continue;
            for (const b of m.content) {
                if (b.type !== 'tool_result') continue;
                if (Array.isArray(b.content) && b.content.some(c => c.type === 'image')) live++;
                else if (b.content === '[screenshot omitted to save context]') stub++;
            }
        }
        return { live, stub };
    };

    it('prunes stale screenshots, keeping only the most recent N live (cost control)', async () => {
        const { authoring } = spyAuthoring({ screenshot: async () => 'data:image/png;base64,AAAA' });
        const { callModel, requests } = scripted([
            toolUse('s1', 'screenshot', {}), toolUse('s2', 'screenshot', {}),
            toolUse('s3', 'screenshot', {}), text('done'),
        ]);
        await runAuthoringSession('shots', authoring, callModel, { keepRecentImages: 1 });
        // The final send (turn 4) carries 3 screenshots — only the newest stays live, the older two are stubbed.
        const last = imageCounts(requests[requests.length - 1].messages);
        expect(last.live).toBe(1);
        expect(last.stub).toBe(2);
    });

    it('keepRecentImages: Infinity never prunes', async () => {
        const { authoring } = spyAuthoring({ screenshot: async () => 'data:image/png;base64,AAAA' });
        const { callModel, requests } = scripted([toolUse('s1', 'screenshot', {}), toolUse('s2', 'screenshot', {}), text('done')]);
        await runAuthoringSession('shots', authoring, callModel, { keepRecentImages: Infinity });
        expect(imageCounts(requests[requests.length - 1].messages).live).toBe(2);
    });

    // All content blocks across every message that carry a cache_control marker.
    const breakpoints = (msgs: ModelMessage[]) =>
        msgs.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.cache_control);

    it('stamps exactly ONE rolling cache breakpoint on the last block of the last message', async () => {
        const { authoring } = spyAuthoring();
        const { callModel, requests } = scripted([toolUse('t1', 'addBox', {}), toolUse('t2', 'addBox', {}), text('done')]);
        await runAuthoringSession('cache', authoring, callModel);
        for (const req of requests) {
            const bps = breakpoints(req.messages);
            expect(bps.length).toBe(1);   // never accumulates beyond the 1 rolling breakpoint
            const lastMsg = req.messages[req.messages.length - 1];
            const tail = Array.isArray(lastMsg.content) ? lastMsg.content[lastMsg.content.length - 1] : null;
            expect(tail?.cache_control).toEqual({ type: 'ephemeral' });   // …and it's on the tail block
        }
    });

    it('cacheConversation: false stamps no breakpoints', async () => {
        const { authoring } = spyAuthoring();
        const { callModel, requests } = scripted([toolUse('t1', 'addBox', {}), text('done')]);
        await runAuthoringSession('nocache', authoring, callModel, { cacheConversation: false });
        for (const req of requests) expect(breakpoints(req.messages).length).toBe(0);
    });

    const firstUserText = (msgs: ModelMessage[]) => {
        const c = msgs[0].content;
        return typeof c === 'string' ? c : c.filter((b): b is Extract<ModelContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('');
    };
    const artboard = { center: [0, 0, 0], upAxis: 'y', recommendedScale: 5, min: [-10, -13, 0], max: [10, 13, 0], projection: 'orthographic' };

    it('injects the artboard frame into the opening message by default', async () => {
        const { authoring } = spyAuthoring({ getArtboard: () => artboard });
        const { callModel, requests } = scripted([text('ok')]);
        await runAuthoringSession('make a lamp', authoring, callModel);
        const opening = firstUserText(requests[0].messages);
        expect(opening).toContain('make a lamp');
        expect(opening).toContain('ILLUSTRATION FRAME');
        expect(opening).toContain('recommendedScale=5');
    });

    it('skips artboard injection when there is no active frame (getArtboard → null)', async () => {
        const { authoring } = spyAuthoring({ getArtboard: () => null });
        const { callModel, requests } = scripted([text('ok')]);
        await runAuthoringSession('make a lamp', authoring, callModel);
        expect(firstUserText(requests[0].messages)).toBe('make a lamp');
    });

    it('injectArtboardContext: false leaves the prompt untouched', async () => {
        const { authoring } = spyAuthoring({ getArtboard: () => artboard });
        const { callModel, requests } = scripted([text('ok')]);
        await runAuthoringSession('make a lamp', authoring, callModel, { injectArtboardContext: false });
        expect(firstUserText(requests[0].messages)).toBe('make a lamp');
    });

    it('auto-calls fitToFrame when the session ends (guaranteed compose-in-bounds)', async () => {
        const { authoring, calls } = spyAuthoring();
        const { callModel } = scripted([toolUse('t1', 'addBox', {}), text('done')]);
        await runAuthoringSession('box', authoring, callModel);
        expect(calls.fitToFrame).toBeDefined();
    });

    it('auto-calls fitToFrame even on the max-turns exit', async () => {
        const { authoring, calls } = spyAuthoring();
        const callModel: CallModel = async () => toolUse('x', 'addBox', {});
        await runAuthoringSession('loop', authoring, callModel, { maxTurns: 2 });
        expect(calls.fitToFrame).toBeDefined();
    });

    it('autoFitToFrame: false does not call fitToFrame', async () => {
        const { authoring, calls } = spyAuthoring();
        const { callModel } = scripted([text('done')]);
        await runAuthoringSession('noop', authoring, callModel, { autoFitToFrame: false });
        expect(calls.fitToFrame).toBeUndefined();
    });

    it('applies studio lighting at session start by default', async () => {
        const { authoring, calls } = spyAuthoring();
        const { callModel } = scripted([text('done')]);
        await runAuthoringSession('lit', authoring, callModel);
        expect(calls.setStudioLighting).toBeDefined();
    });

    it('ensureLighting: false does not touch lighting', async () => {
        const { authoring, calls } = spyAuthoring();
        const { callModel } = scripted([text('done')]);
        await runAuthoringSession('nolight', authoring, callModel, { ensureLighting: false });
        expect(calls.setStudioLighting).toBeUndefined();
    });
});
