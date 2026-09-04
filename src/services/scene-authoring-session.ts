import type { SceneAuthoringAPI } from './scene-authoring-api';
import { sceneAuthoringTools, runSceneAuthoringTool, type ToolDef } from './scene-authoring-tools';

/**
 * Transport-agnostic agentic authoring loop (docs/specs/god-object-status-and-mcp.md §5.4). Salsa owns the loop —
 * tool dispatch, async-verb awaiting, screenshot-as-image feedback, the turn cap — and the HOST injects a single
 * {@link CallModel} transport (its Anthropic proxy / SDK call). No model SDK enters the engine bundle, no API key
 * touches the browser, and the loop is unit-testable with a scripted `callModel`.
 *
 * The message/content/tool shapes below mirror the Anthropic Messages API 1:1, so a host proxy can pass the raw
 * response straight through as a {@link ModelResponse}.
 */

export interface ModelImageSource { type: 'base64'; media_type: string; data: string; }

/** Prompt-caching breakpoint marker (Anthropic shape). Placed on a content block to cache the prefix up to it. */
export interface CacheControl { type: 'ephemeral'; }

/** A content block, in Anthropic Messages shape (the subset this loop produces/consumes). `cache_control` on the
 *  last block of the last message is the ROLLING cache breakpoint the loop stamps to cache the growing transcript
 *  (the host proxy caches the static system + tools prefix separately). */
export type ModelContentBlock = (
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: 'image'; source: ModelImageSource }>; is_error?: boolean }
    | { type: 'image'; source: ModelImageSource }
) & { cache_control?: CacheControl };

export interface ModelMessage { role: 'user' | 'assistant'; content: string | ModelContentBlock[]; }

/** What the loop hands the transport for one model call. `tools` is {@link sceneAuthoringTools}(). */
export interface ModelRequest { system: string; tools: ToolDef[]; messages: ModelMessage[]; maxTokens: number; }

/** What the transport must return (map the model response into this — it's Anthropic's shape). */
export interface ModelResponse { content: ModelContentBlock[]; stop_reason: string | null; }

/** The single dependency the host injects: perform ONE model call (via its proxy / SDK). */
export type CallModel = (req: ModelRequest) => Promise<ModelResponse>;

export interface AuthoringSessionOptions {
    /** Override the default system prompt. */
    system?: string;
    /** Max output tokens per model call (default 4096). */
    maxTokens?: number;
    /** Safety cap on model round-trips (default 16). */
    maxTurns?: number;
    /** How many of the MOST RECENT screenshots to keep in the transcript; older ones are replaced with a text stub
     *  to stop stale ~1.4k-token images from riding along in every subsequent turn (default 2). 0 = prune all past
     *  the current turn; Infinity = never prune. */
    keepRecentImages?: number;
    /** Stamp a rolling prompt-cache breakpoint on the last message each turn so the growing transcript caches
     *  (the host proxy still caches the static system + tools prefix). Default true. */
    cacheConversation?: boolean;
    /** Prefill the opening message with the artboard frame (center / up-axis / recommendedScale / bounds) so the
     *  model ALWAYS has it up front — no reliance on it calling getArtboard. Default true. Skipped automatically if
     *  there's no active illustration frame. */
    injectArtboardContext?: boolean;
    /** After the model finishes, auto-call fitToFrame() so the composition is guaranteed in-bounds regardless of the
     *  model's scale choices (idempotent — safe even if the model already called it). Default true. */
    autoFitToFrame?: boolean;
    /** Apply bright studio lighting at session start so authored content is visible (the engine default is dim).
     *  Default true. Set false when adding to a doc whose lighting you want to preserve. */
    ensureLighting?: boolean;
    /** Observability hook fired after each tool runs (for host logging / progress UI). */
    onToolResult?: (call: { name: string; input: unknown; result: unknown; isError: boolean }) => void;
}

export interface AuthoringSessionResult {
    /** The model's final assistant text. */
    text: string;
    /** How many model round-trips it took. */
    turns: number;
    /** Why the loop ended: the model's `stop_reason` (e.g. 'end_turn') or 'max_turns'. */
    stoppedReason: string;
    /** The full message transcript (assistant turns + tool-result turns) — for the host to inspect/persist. */
    messages: ModelMessage[];
}

export const DEFAULT_AUTHORING_SYSTEM =
    'You author 2D/3D scenes in a live editor by calling tools. 3D verbs use world-space coordinates; 2D vector ' +
    'verbs use illustration space. Build the requested scene, then use describeScene / listObjects / screenshot to ' +
    'check your work and self-correct (a screenshot is returned to you as an image — look at it). Prefer ' +
    'applyScenePlan to place many objects in one shot, then refine. When the scene matches the request, stop. You ' +
    'ADD to the existing scene — never assume you should wipe it; the user manages clearing the canvas themselves.\n\n' +
    'FRAMING + SCALE (READ CAREFULLY — this is where scenes go wrong). In illustration mode the world uses UNUSUAL ' +
    'units and an easy-to-mistake axis, so ALWAYS call getArtboard FIRST and author relative to what it returns:\n' +
    '  • UP IS +Y, not +Z. Build vertical things (a pole, a tree, a figure) growing along +Y. The camera looks down ' +
    '−Z; +X is right, +Y is up on screen. Confusing Y and Z sends objects flying off to the side.\n' +
    '  • SCALE: do NOT assume size 1 is reasonable — a unit primitive is nearly invisible. Size objects using ' +
    'getArtboard.recommendedScale (a unit primitive × recommendedScale ≈ 10% of the frame height); a full-height ' +
    'object ≈ worldHeight tall.\n' +
    '  • POSITION: place content around getArtboard.center and keep each object\'s bounds inside min..max.\n' +
    '  • When you are unsure about scale or things look wrong, just call fitToFrame() once at the END — it scales + ' +
    'centers everything to fit the frame automatically. This is the reliable way to GUARANTEE the composition is ' +
    'in-bounds. Prefer building a single hero object around the origin and calling fitToFrame over hand-tuning pixels.\n' +
    'getSceneBounds gives the world VOLUME of existing content; isInView(id) confirms one object is in-frame; a ' +
    'screenshot shows you the result — look at it and correct.\n\n' +
    'MESH EDITING — to sculpt a primitive into a detailed form (a gem, a spaceship, an organic shape), do NOT just ' +
    'scale/rotate. Add a box/sphere/cylinder, then edit its topology with the MESH EDIT tools. The ops are ' +
    'INDEX-BASED and you are working blind, so ALWAYS read the mesh first: call describeMesh, then prefer ' +
    'facesByNormal (axis [0,1,0] = the top faces) to pick elements — it returns just the indices you need, far ' +
    'cheaper than dumping every face via listFaces. Common recipes: greeble/panel = insetFaces then extrudeFaces; ' +
    'sharp gem edges = bevelEdge; taper a tip to a point = setProportionalEdit(enabled,radius) then moveVertex the ' +
    'tip, or weldVertices a ring down; smooth/organic = addSubdivisionModifier then applyModifier. Re-run the ' +
    'read-back after topology changes — indices shift. For SURFACE ROUGHNESS / relief (rocks, asteroids, gnarled ' +
    'bark, terrain) use addSubdivisionModifier THEN addDisplaceModifier (noise pushes the surface in/out along its ' +
    'normals). For BOOLEAN combining use booleanMesh(idA, idB, op): "subtract" cuts idB out of idA (holes, hollows, ' +
    'notches, punch windows), "union" merges two solids, "intersect" keeps the overlap — inputs should be closed ' +
    'solids (primitives/revolves), and both operands are consumed by default.\n\n' +
    'MATERIALS / TEXTURING — objects default to FLAT COLOR. To make them look like real materials call ' +
    'setSurfaceMaterial(id, name) with a procedural surface (ashlar/brick/granite/slate/sandstone/grass/dirt/cobble/' +
    'concrete/plank(wood)) — real surfacing, no image needed (tint recolors, tileSize sizes the blocks; works on any ' +
    'mesh). For a STYLIZED / hand-painted / low-poly-diorama look also call setSceneStyle("cel") (toon shading) — ' +
    'that is what makes a scene read as polished rather than flat plastic. surfaceMaterials lists the names.\n\n' +
    'SMOOTH / REVOLVED SHAPES — for anything ROUND with a varying radius (cone, tapered spike, vase, column, goblet, ' +
    'bottle, finial, dome), use a surface of revolution, NOT stacked/shrinking box extrudes. addCone / addCylinder ' +
    'with radiusTop handle simple tapers; addRevolve(profile) handles any silhouette — profile is a list of ' +
    '[radius, y] points bottom→top (radius 0 at an end = a point/tip), e.g. a spike = [[0.3,-0.5],[0.05,0.3],[0,0.6]]. ' +
    'For anything that FOLLOWS A CURVE with varying thickness (horn, tentacle, branch, pipe, cable, snake) use ' +
    'addTube(path, radii): path = [x,y,z] spine points, radii = thickness at each (taper to 0 for a tip). ' +
    'These are exact and smooth at any resolution. Reserve mesh-editing for faceted/hard-surface detail.\n\n' +
    'ORGANIC / CREATURES — for animals, creatures, slime, coral, clouds, or anything blobby that BRANCHES and MERGES, ' +
    'do NOT box-model (it fails). For an ANIMAL (dog/cat/horse/lizard/…) the easiest path is addCreature({species, …}) ' +
    '— a ready parametric quadruped/biped (pass rigged:true to also rig it, then animate via getSkeletonForMesh + ' +
    'poseBone/createClip). For anything else organic use addMetaballs(blobs): spheres/capsules/' +
    'ellipsoids that SMOOTHLY FUSE (blend ~0.2-0.4; a quadruped ≈ one body capsule + 4 leg capsules + a neck + a head ' +
    'sphere). Normals come out smooth automatically. Creatures come out LEAN by default (auto-decimated to ~40%); ' +
    'pass decimate (0..1, fraction of triangles to keep) to tune, or simplifyMesh(id, ratio) to decimate ANY dense ' +
    'mesh (metaballs/boolean results) — same silhouette, cheaper; it drops UVs so re-apply setSurfaceMaterial after.\n\n' +
    'WHEN TO MESH-EDIT vs NOT: box-modeling shines for HARD-SURFACE / stylized / faceted forms — gems, crystals, ' +
    'panels, greebles, buildings, robots, weapons. It is a POOR fit for realistic ORGANIC forms (animals, faces, ' +
    'plants): sculpting a convincing creature by moving indexed vertices blind is not achievable and produces a ' +
    'lumpy mess. For organic subjects: prefer a procedural generator when one exists (addCharacter for humanoids), ' +
    'or COMPOSE the form from several primitives (spheres/cylinders for body/legs/head) and smooth the whole with ' +
    'addSubdivisionModifier — do NOT subdivideFace-spam a single cube and drag vertices. If asked for photoreal ' +
    'organic detail the engine cannot do, build a clean STYLIZED version and say so rather than producing chaos.\n\n' +
    'RIGGING + ANIMATION — to make something move: createSkeleton, then addBone to build the hierarchy inside the ' +
    'mesh (use getSceneBounds / listVertices to place bones sensibly, parentIndex chains them), then bindMesh to ' +
    'skin it. Pose with poseBone (EULER DEGREES, not quaternions) or setIKTarget ("put the paw at this point"). To ' +
    'animate: createClip, then for each keyframe pose the skeleton and recordPose(frame), then playClip. A ' +
    'character from addCharacter is already rigged — get its skeleton with getSkeletonForMesh, and setIdle for ' +
    'instant lifelike breathing.\n\n' +
    'EFFICIENCY (each turn re-sends the whole transcript — keep it lean): (1) prefer applyScenePlan to emit many ' +
    'objects/edits in ONE call, then refine, rather than one tool per turn. (2) Screenshot SPARINGLY — only after a ' +
    'milestone, not every op — and keep it small (the default 512 is fine to judge composition). (3) Prefer ' +
    'targeted read-backs (facesByNormal, getObject) over dumping everything (listFaces, describeScene) when you ' +
    'only need a few values.';

/** Run one tool_use block: dispatch it, await async verbs, turn a screenshot data-URL into an image tool_result. */
async function runToolBlock(
    authoring: SceneAuthoringAPI,
    block: { id: string; name: string; input: unknown },
    onToolResult?: AuthoringSessionOptions['onToolResult'],
): Promise<ModelContentBlock> {
    try {
        let result: unknown = runSceneAuthoringTool(authoring, block.name, block.input as Record<string, unknown>);
        if (result instanceof Promise) result = await result;
        onToolResult?.({ name: block.name, input: block.input, result, isError: false });

        // A screenshot must go back as an IMAGE block so the model can actually SEE it (the visual critic loop).
        if (block.name === 'screenshot' && typeof result === 'string' && result.startsWith('data:image')) {
            const comma = result.indexOf(',');
            const media = result.slice(5, result.indexOf(';'));   // 'data:<media>;base64,...'
            return { type: 'tool_result', tool_use_id: block.id, content: [{ type: 'image', source: { type: 'base64', media_type: media || 'image/png', data: result.slice(comma + 1) } }] };
        }
        return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result ?? null) };
    } catch (e) {
        onToolResult?.({ name: block.name, input: block.input, result: String(e), isError: true });
        return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: String(e instanceof Error ? e.message : e) };
    }
}

/** True if this content block is a tool_result carrying image(s) — a screenshot returned to the model. */
function isImageResult(b: ModelContentBlock): boolean {
    return b.type === 'tool_result' && Array.isArray(b.content) && b.content.some(c => c.type === 'image');
}

/**
 * Replace all but the `keep` most-recent screenshot tool_results with a tiny text stub. Screenshots are ~1.4k
 * tokens each and otherwise ride along in EVERY subsequent turn's re-sent transcript — the dominant cost of a
 * long visual-critic session. The model rarely needs to re-see an old frame; the latest one(s) stay live.
 */
function pruneOldImages(messages: ModelMessage[], keep: number): void {
    if (!Number.isFinite(keep)) return;
    const imageBlocks: ModelContentBlock[] = [];
    for (const m of messages) {
        if (typeof m.content === 'string') continue;
        for (const b of m.content) if (isImageResult(b)) imageBlocks.push(b);
    }
    const stubCount = Math.max(0, imageBlocks.length - Math.max(0, keep));
    for (let i = 0; i < stubCount; i++) {
        const b = imageBlocks[i];
        if (b.type === 'tool_result' && Array.isArray(b.content)) b.content = '[screenshot omitted to save context]';
    }
}

/**
 * Move the single rolling prompt-cache breakpoint to the last block of the last message, so each turn's re-sent
 * transcript is a cache HIT up to there (the host proxy caches the static system + tools prefix). Clears any prior
 * breakpoint first so we never exceed Anthropic's 4-breakpoint budget (proxy uses 2, this is the 3rd).
 */
function stampRollingCacheBreakpoint(messages: ModelMessage[]): void {
    for (const m of messages) {
        if (typeof m.content !== 'string') for (const b of m.content) delete b.cache_control;
    }
    const last = messages[messages.length - 1];
    if (!last) return;
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
    const tail = last.content[last.content.length - 1];
    if (tail) tail.cache_control = { type: 'ephemeral' };
}

/** Build the artboard-frame prefill appended to the opening prompt, so the model has the frame up front instead of
 *  having to call getArtboard. Returns '' if there's no active illustration frame (getArtboard → null / non-object). */
function artboardPrefill(authoring: SceneAuthoringAPI): string {
    const art = (authoring as { getArtboard?: () => unknown }).getArtboard?.();
    if (!art || typeof art !== 'object' || !Array.isArray((art as { center?: unknown }).center)) return '';
    const a = art as { center: number[]; upAxis: string; recommendedScale: number; min: number[]; max: number[]; projection: string };
    return `\n\n[ILLUSTRATION FRAME — author relative to THIS. center=${JSON.stringify(a.center)}, up=+${String(a.upAxis).toUpperCase()} (build vertical things along +Y), recommendedScale=${a.recommendedScale} (multiply a unit primitive by this), bounds min=${JSON.stringify(a.min)} max=${JSON.stringify(a.max)} (keep object bounds inside this), projection=${a.projection}. Place content around center. When unsure about scale, call fitToFrame() at the end to guarantee it's framed.]`;
}

/**
 * Drive an authoring session: send `prompt` to the model (via `callModel`), execute every tool call it makes against
 * `authoring`, feed the results back, and loop until the model stops (or the turn cap). Returns the final text +
 * transcript. Never throws for a tool error — those go back to the model as `is_error` results so it can recover.
 */
export async function runAuthoringSession(
    prompt: string,
    authoring: SceneAuthoringAPI,
    callModel: CallModel,
    opts: AuthoringSessionOptions = {},
): Promise<AuthoringSessionResult> {
    const tools = sceneAuthoringTools();
    const system = opts.system ?? DEFAULT_AUTHORING_SYSTEM;
    const maxTokens = opts.maxTokens ?? 4096;
    const maxTurns = opts.maxTurns ?? 16;
    const keepRecentImages = opts.keepRecentImages ?? 2;
    const cacheConversation = opts.cacheConversation ?? true;
    const injectArtboardContext = opts.injectArtboardContext ?? true;
    const autoFitToFrame = opts.autoFitToFrame ?? true;
    const ensureLighting = opts.ensureLighting ?? true;

    // Make authored content visible up front — the engine's default scene lighting is dim (best-effort, scoped to
    // this session; pass ensureLighting:false to preserve an existing doc's lighting).
    if (ensureLighting) { try { (authoring as { setStudioLighting?: () => void }).setStudioLighting?.(); } catch { /* best-effort */ } }

    const opening = injectArtboardContext ? prompt + artboardPrefill(authoring) : prompt;
    const messages: ModelMessage[] = [{ role: 'user', content: opening }];

    // Deterministic finalize: guarantee the composition is in-frame regardless of what the model did with scale
    // (idempotent — a no-op if content already fits, or if there's no 3D content / frame).
    const finalize = (text: string, turns: number, stoppedReason: string): AuthoringSessionResult => {
        if (autoFitToFrame) { try { (authoring as { fitToFrame?: (p?: number) => unknown }).fitToFrame?.(); } catch { /* best-effort */ } }
        return { text, turns, stoppedReason, messages };
    };

    for (let turn = 1; turn <= maxTurns; turn++) {
        // Trim cost before each send: drop stale screenshots, then move the rolling cache breakpoint to the tail.
        pruneOldImages(messages, keepRecentImages);
        if (cacheConversation) stampRollingCacheBreakpoint(messages);
        const res = await callModel({ system, tools, messages, maxTokens });
        messages.push({ role: 'assistant', content: res.content });

        if (res.stop_reason !== 'tool_use') {
            const text = res.content.filter((b): b is Extract<ModelContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('\n');
            return finalize(text, turn, res.stop_reason ?? 'end_turn');
        }

        const results: ModelContentBlock[] = [];
        for (const block of res.content) {
            if (block.type === 'tool_use') results.push(await runToolBlock(authoring, block, opts.onToolResult));
        }
        messages.push({ role: 'user', content: results });
    }

    return finalize('', maxTurns, 'max_turns');
}
