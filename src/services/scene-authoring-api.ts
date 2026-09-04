import type ShapeManager from './shape-manager';
import type { Material3D } from '../renderer/3d/material-3d';
import type { BuildingParams } from '../world/building';
import type { ProcTransform } from './managers/procedural-object-manager';
import type { CreatorParamSchema } from './managers/creator-registry';
import type { LayoutParams } from '../world/types';
import { hexToRgba } from '../utils/color';
import { clothingPreset, clothingPresetNames } from './managers/clothing-generator';
import { DEFAULT_HAIR_PARAMS } from './managers/hair-generator';
import type { SdfBlob } from '../scene-graph/shapes/sdf-mesh';
import { CREATURE_SPECIES } from './managers/creature-generator';

/** A 3D point. All authoring coords are world-space; every field optional (defaults to 0). */
export interface Vec3 { x?: number; y?: number; z?: number; }

/** Euler angles in DEGREES (intrinsic XYZ) → unit quaternion [x,y,z,w]. LLMs reason about degrees far better than
 *  quaternions, so the rigging verbs take Euler and convert here. */
function eulerToQuat(xDeg: number, yDeg: number, zDeg: number): [number, number, number, number] {
    const hx = xDeg * Math.PI / 360, hy = yDeg * Math.PI / 360, hz = zDeg * Math.PI / 360;
    const cx = Math.cos(hx), sx = Math.sin(hx);
    const cy = Math.cos(hy), sy = Math.sin(hy);
    const cz = Math.cos(hz), sz = Math.sin(hz);
    return [
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    ];
}

/** Read a Blob (e.g. a screenshot) into an embeddable `data:` URL (base64). */
function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(new Error('blob read failed'));
        r.readAsDataURL(blob);
    });
}

/**
 * SceneAuthoringAPI — a thin, curated, STABLE façade over {@link ShapeManager} for programmatic / AI scene
 * authoring (the "MCP" surface; see docs/specs/god-object-status-and-mcp.md §5).
 *
 * Design contract:
 * - **Thin façade, not a rewrite.** Every verb delegates to an existing ShapeManager entry-point. The AI never
 *   touches the god-objects, and this contract stays stable while the managers keep refactoring underneath.
 * - **Params-as-schema.** The engine is "params → geometry" and persists as params-only markers, so anything
 *   authored here gets free save/reload. The generators' own param types ARE the tool schema.
 * - **Normalizes the known gotchas** (§4): exposes the missing `setMaterial` wrapper as {@link setMaterial};
 *   surfaces `sm.world.*` as {@link generateCity}; returns object IDs (not node objects) from every create verb.
 * - **Read-back for a closed loop:** {@link listObjects} / {@link describeScene} / {@link getSceneSettings} let a
 *   model see what it made and self-correct.
 *
 * v1 covers the stable 🟢 groups (primitives, transform, material, city, props, buildings, lighting, read-back,
 * scene settings). Characters / textures / particles / etc. are follow-on verb groups on the same pattern.
 */
export class SceneAuthoringAPI {
    constructor(private readonly sm: ShapeManager) {}

    // ── 3D primitives — each returns the new object's id ──────────────
    /** Add a box. Extents are full width/height/depth (default 1³), centred at (x,y,z). */
    addBox(o: Vec3 & { width?: number; height?: number; depth?: number; material?: Partial<Material3D> } = {}): string {
        return this.sm.createBox3D(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.width ?? 1, o.height ?? 1, o.depth ?? 1, o.material).id;
    }
    /** Add a sphere of `radius` (default 0.5). */
    addSphere(o: Vec3 & { radius?: number; segments?: number; material?: Partial<Material3D> } = {}): string {
        return this.sm.createSphere3D(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.radius ?? 0.5, o.segments ?? 16, o.material).id;
    }
    /** Add a cylinder of `radius` × `height` (defaults 0.5 × 1). Set `radiusTop` for a TAPER — a smooth truncated
     *  cone (radiusTop < radius) or a full cone (radiusTop 0). This is a surface of revolution: exact and smooth at
     *  any `radialSegments`, so prefer it over stacked/stepped extrudes for tapered spikes, columns, and horns. */
    addCylinder(o: Vec3 & { radius?: number; height?: number; radiusTop?: number; radialSegments?: number; material?: Partial<Material3D> } = {}): string {
        return this.sm.createCylinder3D(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.radius ?? 0.5, o.height ?? 1, o.radialSegments ?? 16, o.material, o.radiusTop).id;
    }
    /** Add a cone (a cylinder tapering to a point at the top). `radiusTop` > 0 makes a truncated cone / frustum.
     *  Smooth surface of revolution — use this for a clean tapered spike instead of stepped extrusions. */
    addCone(o: Vec3 & { radius?: number; height?: number; radiusTop?: number; radialSegments?: number; material?: Partial<Material3D> } = {}): string {
        return this.sm.createCylinder3D(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.radius ?? 0.5, o.height ?? 1, o.radialSegments ?? 16, o.material, o.radiusTop ?? 0).id;
    }
    /** Add a torus (`radius` ring, `tubeRadius` thickness; defaults 0.5 / 0.2). */
    addTorus(o: Vec3 & { radius?: number; tubeRadius?: number; material?: Partial<Material3D> } = {}): string {
        return this.sm.createTorus3D(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.radius ?? 0.5, o.tubeRadius ?? 0.2, o.material).id;
    }
    /** Add a flat plane (`width` × `height`, default 1 × 1) on the XZ ground. */
    addPlane(o: Vec3 & { width?: number; height?: number; material?: Partial<Material3D> } = {}): string {
        return this.sm.createPlane3D(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.width ?? 1, o.height ?? 1, o.material).id;
    }
    /** Add a SURFACE OF REVOLUTION — spin a 2D `profile` silhouette (array of [radius, y] points, bottom→top) around
     *  the Y axis. This is the exact/smooth way to make vases, columns, goblets, bottles, finials, and tapered spikes
     *  (radius 0 at an end = a point/tip). Far better than stacked extrudes for anything round with a varying radius.
     *  Centred at (x,y,z); `segments` sets tessellation (the profile sets the shape). Returns the new object's id. */
    addRevolve(o: Vec3 & { profile: [number, number][]; segments?: number; material?: Partial<Material3D> }): string {
        return this.sm.createRevolve3D(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.profile, o.segments ?? 24, o.material).id;
    }
    /** Add a TUBE / LOFT — sweep a circular cross-section of varying radius along a `path` spine (array of [x,y,z]
     *  points). The way to make anything that FOLLOWS A CURVE with varying thickness: horns, tentacles, tree
     *  branches, pipes, cables, snakes, worms. `radii` = the tube radius at each path point (a single value = a
     *  constant-thickness tube; taper to 0 at the last point for a horn tip). Rotation-minimizing frames keep it
     *  from twisting. Centred at (x,y,z); `segments` = cross-section sides. Returns the new object's id. */
    addTube(o: Vec3 & { path: [number, number, number][]; radii: number[]; segments?: number; material?: Partial<Material3D> }): string {
        return this.sm.createTube3D(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.path, o.radii, o.segments ?? 12, o.material).id;
    }
    /** Add METABALLS — compose an ORGANIC, blobby, BRANCHING form from `blobs` (spheres/capsules/ellipsoids that
     *  SMOOTHLY FUSE where they overlap). THE way to make creatures, slime, coral, clouds — anything box-modeling
     *  and revolve/tube can't (they branch and merge). Each blob: {shape:'sphere'|'capsule'|'ellipsoid'|'box'|
     *  'torus', a:[x,y,z] centre/segment-start, b?:[x,y,z] capsule end, radius, radii?:[x,y,z] ellipsoid/box,
     *  blend: smooth-fuse radius, op?:'subtract' to carve}. A creature = capsules for body+limbs+neck + spheres for
     *  head/paws, all with blend>0. `resolution` 8..96 (higher = smoother, slower). Returns the new object's id. */
    addMetaballs(o: Vec3 & { blobs: SdfBlob[]; resolution?: number; decimate?: number; material?: Partial<Material3D> }): string {
        return this.sm.createMetaballMesh3D(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.blobs, o.resolution ?? 48, o.material, o.decimate).id;
    }
    /** Add a procedural CREATURE — a smooth quadruped/biped (dog/cat/horse/lizard/generic) built from metaballs.
     *  `species` picks the proportions; any param (bodyLength, legLength, neckLength, headSize, tailLength, …) is
     *  overridable. The easy way to make an animal — far better than box-modeling or hand-placing blobs. Returns id. */
    addCreature(o: Vec3 & Parameters<ShapeManager['createCreature3D']>[0] & { resolution?: number; material?: Partial<Material3D> } = {}): string {
        const { x, y, z, resolution, material, ...params } = o;
        return this.sm.createCreature3D(params, x ?? 0, y ?? 0, z ?? 0, resolution ?? 56, material).id;
    }
    /** The available creature species presets. */
    creatureSpecies(): string[] { return [...CREATURE_SPECIES]; }
    /** DECIMATE a mesh — keep `ratio` (0..1) of its triangles (QEM, curvature-adaptive: flat areas collapse,
     *  detail preserved). Leaner render/memory/save with the same silhouette; ideal for dense metaballs/creatures/
     *  boolean results. Undoable. Drops UVs — re-texture with setSurfaceMaterial or setColor after. Returns true. */
    simplifyMesh(id: string, ratio: number): boolean { return this.sm.simplifyMesh3D(id, ratio); }

    // ── Transform (ABSOLUTE — the engine has no delta setters) ────────
    /** Set an object's absolute world position. Omitted axes default to 0 (NOT preserved). */
    setPosition(id: string, p: Vec3): void { this.sm.setPosition3D(id, p.x ?? 0, p.y ?? 0, p.z ?? 0); }
    /** Set absolute Euler rotation in RADIANS. Omitted axes default to 0. */
    setRotation(id: string, r: Vec3): void { this.sm.setRotation3D(id, r.x ?? 0, r.y ?? 0, r.z ?? 0); }
    /** Set absolute non-uniform scale. Omitted axes default to 1. */
    setScale(id: string, s: Vec3): void { this.sm.setScale3D(id, s.x ?? 1, s.y ?? 1, s.z ?? 1); }

    // ── Material (normalizes the missing setMaterial3D wrapper) ───────
    /** Patch an object's material (diffuse/roughness/metalness/emissive/…). */
    setMaterial(id: string, material: Partial<Material3D>): void { this.sm.scene3d.setMaterial(id, material); }
    /** Convenience: set the diffuse colour (0–1 RGBA) — a shortcut over {@link setMaterial}. */
    setColor(id: string, r: number, g: number, b: number, a = 1): void {
        this.sm.scene3d.setMaterial(id, { diffuse: { r, g, b, a } });
    }
    /** Give an object a PROCEDURAL SURFACE MATERIAL by name (stone/wood/grass/brick/cobble/plank/…) — the way to
     *  "texture" a mesh without an image. `tint` (hex) recolors it; `tileSize` (world units, larger = bigger blocks)
     *  and `weather` ('new'|'worn'|'ancient'|'mossy'|'dirty') tune it. Stone/grass/etc. map in WORLD space so they
     *  work on ANY mesh. List names with {@link surfaceMaterials}. Returns false if the mesh is gone. */
    setSurfaceMaterial(id: string, name: string, opts?: { tint?: string; tileSize?: number; weather?: 'new' | 'worn' | 'ancient' | 'mossy' | 'dirty' }): boolean {
        const tint = opts?.tint ? (() => { const c = hexToRgba(opts.tint!); return [c.r, c.g, c.b] as [number, number, number]; })() : undefined;
        return this.sm.applyGroundMaterial3D(id, { surface: name as never, tint, tileMm: opts?.tileSize != null ? opts.tileSize * 1000 : undefined, weather: opts?.weather });
    }
    /** The available procedural surface-material names (stone family, grass, dirt, wood plank, cobble, …). */
    surfaceMaterials(): string[] { return this.sm.surfaceMaterials3D(); }
    /** Set the render STYLE on an object — 'cel' (toon/hand-painted), 'sketch', 'ink', 'gouraud', 'unlit', or
     *  'default' (PBR). Use 'cel' for a stylized/diorama look. */
    setRenderStyle(id: string, style: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud' | 'unlit'): void {
        this.sm.scene3d.setMaterial(id, { renderStyle: style });
    }
    /** Apply a render style to ALL 3D objects at once (e.g. 'cel' for a whole toon scene). Returns the count changed. */
    setSceneStyle(style: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud' | 'unlit'): number {
        let n = 0;
        for (const { id } of this.sm.getAllMeshesForAnimation3D()) { this.sm.scene3d.setMaterial(id, { renderStyle: style }); n++; }
        return n;
    }

    // ── World / city (normalizes sm.world.* into a verb) ──────────────
    /** Generate (or regenerate) the procedural city from LayoutParams. `draft` = fast reduced build. */
    generateCity(params?: Partial<LayoutParams>, draft = false): void { this.sm.world.generateWorld(params, draft); }

    // ── Creator props (one verb + one schema query covers all ~10) ────
    /** Spawn a procedural creator prop by type. Returns its id, or null if the type is unknown. */
    addProp(typeId: string, params?: Record<string, unknown>, transform?: Partial<ProcTransform>): string | null {
        return this.sm.createCreator3D(typeId, params, transform)?.id ?? null;
    }
    /** The available creator prop types as `{ typeId, label }`. */
    propTypes(): { typeId: string; label: string }[] { return this.sm.creatorTypes3D(); }
    /** The machine-readable param schema for a creator type (drive the tool's JSON Schema from this). */
    propSchema(typeId: string): CreatorParamSchema[] { return this.sm.creatorParamSchema3D(typeId); }

    // ── Buildings ─────────────────────────────────────────────────────
    /** Add a standalone procedural building (11 archetypes; a seed reproduces it). Returns its id. */
    addBuilding(o: Vec3 & { params?: Partial<BuildingParams> } = {}): string {
        return this.sm.createProceduralBuilding3D(o.params, o.x ?? 0, o.y ?? 0, o.z ?? 0).id;
    }

    // ── Lighting ──────────────────────────────────────────────────────
    /** Set the sun: direction (dx,dy,dz) + RGB colour + intensity. */
    setDirectionalLight(dir: Vec3, color: { r: number; g: number; b: number } = { r: 1, g: 1, b: 1 }, intensity = 1): void {
        this.sm.setDirectionalLight3D(dir.x ?? 0, dir.y ?? -1, dir.z ?? 0, color.r, color.g, color.b, intensity);
    }
    /** Set the ambient fill light (RGB + intensity). */
    setAmbientLight(color: { r: number; g: number; b: number }, intensity = 1): void {
        this.sm.setAmbientLight3D(color.r, color.g, color.b, intensity);
    }
    /** Apply bright, even STUDIO lighting (a key light + strong white fill) so content reads clearly. The engine's
     *  default scene lighting is dim (ambient ~0.17), which makes saturated colours and un-lit faces look near-black;
     *  call this whenever a scene looks too dark. */
    setStudioLighting(): void {
        this.sm.setDirectionalLight3D(-0.4, -0.9, -0.5, 1, 1, 1, 1.3);
        this.sm.setAmbientLight3D(1, 1, 1, 0.5);
    }

    // ── Read-back (the closed loop: see what you made, self-correct) ──
    /** Every 3D object in the scene as `{ id, name }`. */
    listObjects(): { id: string; name: string }[] { return this.sm.getAllMeshesForAnimation3D(); }
    /** Every 2D vector shape in the scene as `{ id, name }`. */
    list2DObjects(): { id: string; name: string }[] { return this.sm.getVectorShapes(); }
    /** Render the current 3D view to a PNG `data:` URL (base64) — the visual critic loop: see what you made,
     *  then self-correct. `maxWidth` scales the longest side (aspect preserved). Default 512: image token cost
     *  scales with AREA, so 512 is ~4× cheaper than 1024 and plenty to judge composition — raise it only when
     *  you need to read fine detail. */
    async screenshot(maxWidth = 512): Promise<string> {
        return blobToDataUrl(await this.sm.captureThumbnailBlob(maxWidth));
    }
    /** Delete an object by id. Returns false if it doesn't exist. */
    removeObject(id: string): boolean { return this.sm.deleteMesh3D(id); }
    // DISABLED (2026-08-18): no bulk clearScene() for the AI — wiping the whole scene is a user action (the "New"
    // button), never an AI decision (it could destroy hours of work on a misread "make me X"). See ShapeManager.
    // clearScene(): number { return this.sm.clearScene3D(); }
    /** The currently-selected object ids. */
    getSelection(): string[] { return [...this.sm.getSelected3DIDs()]; }
    /** Replace the selection with `ids`. */
    select(ids: string[]): void { this.sm.setSelected3DIDs(new Set(ids)); }
    /** A one-shot scene readout for a model: all objects + the global scene settings. */
    describeScene(): { objects: { id: string; name: string }[]; settings: ReturnType<ShapeManager['scene3d']['getGlobalScene3DSettings']> } {
        return { objects: this.listObjects(), settings: this.sm.scene3d.getGlobalScene3DSettings() };
    }

    // ── Scene settings snapshot (projection / lighting / fog / ps1 / …) ─
    /** The whole global 3D scene settings object (projection, ps1, lighting, bg, fog, ibl, post, ssao, shadows, grid). */
    getSceneSettings(): ReturnType<ShapeManager['scene3d']['getGlobalScene3DSettings']> {
        return this.sm.scene3d.getGlobalScene3DSettings();
    }
    /** Apply a partial patch of the global scene settings. */
    applySceneSettings(partial: Parameters<ShapeManager['scene3d']['restoreGlobalScene3DSettings']>[0]): void {
        this.sm.scene3d.restoreGlobalScene3DSettings(partial);
    }

    // ── 2D vector shapes (illustration space; each returns the new shape's id) ──
    // The engine's 2D creators take FILL from an ambient colour + returned void; these normalize that — fill/stroke
    // are explicit hex, and the shape id comes back for read-back/edit. NOTE: `fill` is set on the shared ambient
    // shape-colour as a side effect (deterministic: defaults to white when omitted). Coords are 2D document space,
    // NOT 3D world space.
    /** Add a filled rectangle. `fill`/`stroke` are hex (e.g. '#ff0000' / '#rrggbbaa'); `strokeWidth` in px. */
    addRectangle(o: { x?: number; y?: number; width?: number; height?: number; fill?: string; stroke?: string; strokeWidth?: number } = {}): string {
        this.sm.setShapeColor(o.fill ?? '#ffffff');
        return this.sm.createRectangle(o.x ?? 0, o.y ?? 0, o.width ?? 1, o.height ?? 1, hexToRgba(o.stroke ?? '#000000'), o.strokeWidth ?? 1).id;
    }
    /** Add a filled circle of `radius`. */
    addCircle(o: { x?: number; y?: number; radius?: number; fill?: string; stroke?: string; strokeWidth?: number } = {}): string {
        this.sm.setShapeColor(o.fill ?? '#ffffff');
        return this.sm.createCircle(o.x ?? 0, o.y ?? 0, o.radius ?? 0.5, hexToRgba(o.stroke ?? '#000000'), o.strokeWidth ?? 1).id;
    }
    /** Add a filled triangle. */
    addTriangle(o: { x?: number; y?: number; width?: number; height?: number; fill?: string; stroke?: string; strokeWidth?: number } = {}): string {
        this.sm.setShapeColor(o.fill ?? '#ffffff');
        return this.sm.createTriangle(o.x ?? 0, o.y ?? 0, o.width ?? 1, o.height ?? 1, hexToRgba(o.stroke ?? '#000000'), o.strokeWidth ?? 1).id;
    }
    /** Add a stroked line from (x1,y1) to (x2,y2). Lines have no fill. */
    addLine(o: { x1: number; y1: number; x2: number; y2: number; stroke?: string; strokeWidth?: number }): string {
        return this.sm.createLine(o.x1, o.y1, o.x2, o.y2, hexToRgba(o.stroke ?? '#000000'), o.strokeWidth ?? 1).id;
    }

    // ── Characters / text / particles ────────────────────────────────
    /** Add a full procedural character — CLOTHED + HAIRED by DEFAULT. `createFullCharacter3D` only dresses/hairs the
     *  body when those params are passed (no built-in defaults), so a plain "add a character" would otherwise come
     *  out a nude mannequin. This fills a sensible top + bottom + hair when you don't specify them (the façade's job
     *  to normalize that gotcha). Override any slot with explicit params, or pass `clothed: false` for a bare base
     *  body. Returns the body mesh id. */
    async addCharacter(opts: Parameters<ShapeManager['createFullCharacter3D']>[0] & { clothed?: boolean } = {}): Promise<string> {
        const { clothed = true, ...rest } = opts;
        const full = { ...rest } as Parameters<ShapeManager['createFullCharacter3D']>[0];
        if (clothed) {
            if (!full.hair)   full.hair = { ...DEFAULT_HAIR_PARAMS };
            if (!full.top)    full.top = clothingPreset('top', clothingPresetNames('top')[0] ?? '');
            if (!full.bottom) full.bottom = clothingPreset('bottom', clothingPresetNames('bottom')[0] ?? '');
        }
        return (await this.sm.createFullCharacter3D(full)).meshId;
    }
    /** Add an editable 2D text object (HTML-in-canvas). Returns its id. */
    addText(o: { x?: number; y?: number; text?: string } = {}): string {
        return this.sm.createLiveText(o.x ?? 0, o.y ?? 0, { text: o.text ?? '' }).id;
    }
    /** Add a 3D particle emitter (dust/sparks/snow/magic presets, or a custom config). Returns its id. */
    addParticles(o: Vec3 & { preset?: Parameters<ShapeManager['addParticleEmitter3D']>[4]; config?: Parameters<ShapeManager['addParticleEmitter3D']>[3] } = {}): string {
        return this.sm.addParticleEmitter3D(o.x ?? 0, o.y ?? 0, o.z ?? 0, o.config, o.preset);
    }

    // ── Batching (coalesce many ops into one scene-change event) ──────
    /** Open a scene-graph batch: subsequent create/edit ops emit ONE coalesced change event on {@link endBatch}. */
    beginBatch(): void { this.sm.beginSceneGraphBatch3D(); }
    /** Close the batch opened by {@link beginBatch}. */
    endBatch(): void { this.sm.endSceneGraphBatch3D(); }

    // ── Composition helpers (arrays / duplicate) ──────────────────────
    /** Duplicate a 3D object; returns whatever the engine returns (the new id / node). */
    duplicateObject(id: string) { return this.sm.duplicateMesh3D(id); }
    /** GPU-instanced linear array of `count` copies of `sourceId`, spaced by `spacing` (world units). */
    addLinearArray(sourceId: string, count = 3, spacing?: [number, number, number]) {
        return this.sm.createLinearArray3D(sourceId, count, spacing);
    }

    // ── Read-back for a single object ─────────────────────────────────
    /** A lightweight readout of any object by id (2D shape or 3D mesh): id, name, position, visibility. Null if gone. */
    getObject(id: string): { id: string; name: string; x: number; y: number; z: number; visible: boolean } | null {
        const n = this.sm.getNodeById(id) as (null | undefined | { id: string; name?: string; x?: number; y?: number; z?: number; visible?: boolean });
        if (!n) return null;
        return { id: n.id, name: n.name ?? '', x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0, visible: n.visible ?? true };
    }

    // ── Scene bounds / framing (keep authored content inside the user's artboard) ──
    // Two different "dimensions": getSceneBounds is a projection-AGNOSTIC world VOLUME (keep the scene compact /
    // within the existing footprint); getArtboard + isInView answer "is it inside the framed picture" — which is
    // projection-DEPENDENT (ortho = a fixed world rect at any depth; perspective = a frustum that widens with
    // distance), so isInView does the projection math for you and works for both.
    /** World-space AABB over every 3D object: {min,max,center,size,count}. Null if the scene is empty. The volume the
     *  content occupies — use it to place new objects within the existing footprint. */
    getSceneBounds(): { min: [number, number, number]; max: [number, number, number]; center: [number, number, number]; size: [number, number, number]; count: number } | null {
        return this.sm.getSceneBounds3D();
    }
    /** The illustration frame to author within, in WORLD units: {center, upAxis:'y', recommendedScale, min, max,
     *  worldWidth/Height, pixelWidth/Height, projection}. Call this FIRST in illustration mode — place content around
     *  `center`, build vertical things along +Y, size a unit primitive by `recommendedScale`, keep bounds in min..max. */
    getArtboard(): { center: [number, number, number]; upAxis: 'y'; recommendedScale: number; min: [number, number, number]; max: [number, number, number]; worldWidth: number; worldHeight: number; pixelWidth: number; pixelHeight: number; projection: 'perspective' | 'orthographic' } | null {
        return this.sm.getArtboardInfo3D();
    }
    /** Is this object currently inside the rendered frame? Projection-aware (handles ortho AND perspective) — use it
     *  to check an object stays in the picture without doing camera math yourself. */
    isInView(id: string): boolean { return this.sm.isMeshInView3D(id); }
    /** GUARANTEED compose-in-bounds: scale + centre all 3D content to fit the frame (padding < 1 = margin). Build at
     *  any scale/position, then call this once and everything lands centred and framed. Returns false if empty/no frame. */
    fitToFrame(padding = 0.9): boolean { return this.sm.fitContentToArtboard3D(padding); }

    // ══ Mesh editing — the half-edge kernel: turn a box into a gem / greebled panel / organic form ══════════════
    // Ops are INDEX-BASED (face / vertex / half-edge indices) and CPU-pure (no live GPU needed). The blind-caller
    // loop is: makeEditable → listFaces/facesByNormal (pick elements by normal/center) → extrude/inset/bevel/… →
    // screenshot to check. Every read-back + op auto-makes the mesh editable (idempotent) and every op commits
    // immediately (the mesh reflects the edit; all ops are undoable via the engine's 3D command stack).
    //
    // GAPS (not yet in the engine): boolean CSG (union/subtract/intersect) and a displacement/noise modifier.
    // Bevel is edges-only (one chamfer strip per half-edge; no vertex bevel).

    /** Ensure a mesh has its half-edge EditMesh built, and return it (or null if the id isn't a mesh). */
    private _editMesh(id: string) { this.sm.makeEditable3D(id); return this.sm.getEditMesh3D(id); }
    /** number[] → Set for the multi-face ops; empty/omitted → null (the op falls back to the live selection). */
    private _faceSet(faceIndices?: number[]): Set<number> | null {
        return faceIndices && faceIndices.length ? new Set(faceIndices) : null;
    }

    /** Build a mesh's half-edge EditMesh (from its primitive/geometry) so it can be edited. Idempotent — never
     *  clobbers existing edits. Returns false if `id` isn't a mesh. Read-back + ops call this for you. */
    makeEditable(id: string): boolean { return this.sm.makeEditable3D(id); }

    /** Counts + editability for a mesh (auto-makes editable). */
    describeMesh(id: string): { editable: boolean; faceCount: number; vertexCount: number } {
        const em = this._editMesh(id);
        return { editable: !!em, faceCount: em?.faces.length ?? 0, vertexCount: em?.vertices.length ?? 0 };
    }
    /** Every face as `{ index, center, normal, vertexCount }` — THE read-back that lets a blind model pick elements
     *  ("the face whose normal is +Y" = the top). Object-space coords. Auto-makes editable. */
    listFaces(id: string): { index: number; center: [number, number, number]; normal: [number, number, number]; vertexCount: number }[] {
        const em = this._editMesh(id); if (!em) return [];
        const out: { index: number; center: [number, number, number]; normal: [number, number, number]; vertexCount: number }[] = [];
        for (let i = 0; i < em.faces.length; i++) {
            out.push({ index: i, center: em.getFaceCenter(i), normal: em.getFaceNormal(i), vertexCount: em.getFaceVertices(i).length });
        }
        return out;
    }
    /** Every vertex as `{ index, position }` (object space). Auto-makes editable. */
    listVertices(id: string): { index: number; position: [number, number, number] }[] {
        const em = this._editMesh(id); if (!em) return [];
        return em.vertices.map((v, i) => ({ index: i, position: [v.x, v.y, v.z] as [number, number, number] }));
    }
    /** Face indices whose normal aligns with `axis` (dot ≥ threshold, axis auto-normalized). Ergonomic
     *  "select the top/front/side faces" — e.g. axis [0,1,0] = up. Auto-makes editable. */
    facesByNormal(id: string, axis: [number, number, number], threshold = 0.7): number[] {
        const em = this._editMesh(id); if (!em) return [];
        const [ax, ay, az] = axis; const L = Math.hypot(ax, ay, az) || 1;
        const out: number[] = [];
        for (let i = 0; i < em.faces.length; i++) {
            const [nx, ny, nz] = em.getFaceNormal(i);
            if ((nx * ax + ny * ay + nz * az) / L >= threshold) out.push(i);
        }
        return out;
    }

    /** Replace the mesh-edit selection with these face indices. */
    selectFaces(id: string, faceIndices: number[]): void { faceIndices.forEach((f, i) => this.sm.selectFace3D(id, f, i > 0)); }
    /** Replace the mesh-edit selection with these vertex indices. */
    selectVertices(id: string, vertexIndices: number[]): void { vertexIndices.forEach((v, i) => this.sm.selectVertex3D(id, v, i > 0)); }

    /** Extrude faces outward along their normals by `distance`. Omit `faceIndices` to use the live selection. */
    extrudeFaces(id: string, faceIndices: number[] | undefined, distance: number): boolean {
        this.sm.makeEditable3D(id); return this.sm.extrudeFaces3D(id, this._faceSet(faceIndices), distance);
    }
    /** Inset faces toward their centroids by `amount` (0 = none … 1 = collapse to centre). Omit `faceIndices` → selection. */
    insetFaces(id: string, faceIndices: number[] | undefined, amount: number): boolean {
        this.sm.makeEditable3D(id); return this.sm.insetFaces3D(id, this._faceSet(faceIndices), amount);
    }
    /** Delete faces (leaves a hole — pair with {@link fillHole} / {@link bridgeEdgeLoops}). Omit → selection. */
    deleteFaces(id: string, faceIndices?: number[]): boolean {
        this.sm.makeEditable3D(id); return this.sm.deleteFaces3D(id, this._faceSet(faceIndices));
    }
    /** Flip face normals (winding). Omit `faceIndices` → selection. */
    flipFaces(id: string, faceIndices?: number[]): boolean {
        this.sm.makeEditable3D(id); return this.sm.flipFaces3D(id, this._faceSet(faceIndices));
    }
    /** BOOLEAN CSG between two meshes → a NEW mesh. 'union' = merge two solids, 'subtract' = cut B out of A (holes,
     *  hollows, notches), 'intersect' = keep only the overlap. Inputs should be closed solids (primitives, revolves).
     *  By default the two operands are consumed; pass keepOperands:true to keep them. Returns the new mesh id (or null). */
    booleanMesh(idA: string, idB: string, op: 'union' | 'subtract' | 'intersect', opts?: { keepOperands?: boolean }): string | null {
        return this.sm.booleanMesh3D(idA, idB, op, opts);
    }
    /** Split faces off into a NEW mesh node; returns the new node's id (or null). Omit → selection. */
    separateFaces(id: string, faceIndices?: number[]): string | null {
        this.sm.makeEditable3D(id); return this.sm.separateFaces3D(id, this._faceSet(faceIndices));
    }
    /** Subdivide a single face into quads (destructive, local detail). */
    subdivideFace(id: string, faceIndex: number): boolean { this.sm.makeEditable3D(id); return this.sm.subdivideFace3D(id, faceIndex); }
    /** Bevel/chamfer ONE edge (by half-edge index) — a single chamfer strip; `amount` 0..1. */
    bevelEdge(id: string, halfEdgeIndex: number, amount: number): boolean { this.sm.makeEditable3D(id); return this.sm.bevelEdge3D(id, halfEdgeIndex, amount); }
    /** Bevel/chamfer a VERTEX (by index) — cut the corner off into a small cap face; `amount` 0..1 along each edge. */
    bevelVertex(id: string, vertexIndex: number, amount: number): boolean { this.sm.makeEditable3D(id); return this.sm.bevelVertex3D(id, vertexIndex, amount); }
    /** Loop-cut a ring of quads starting at a half-edge; `t` 0..1 = position along the cut. */
    loopCut(id: string, halfEdgeIndex: number, t = 0.5): boolean { this.sm.makeEditable3D(id); return this.sm.loopCut3D(id, halfEdgeIndex, t); }
    /** Move one vertex by an object-space delta (pair with {@link setProportionalEdit} for soft/tapered pulls). */
    moveVertex(id: string, vertexIndex: number, dx: number, dy: number, dz: number): boolean {
        this.sm.makeEditable3D(id); return this.sm.moveVertex3D(id, vertexIndex, dx, dy, dz);
    }
    /** Weld two vertices together (collapse a tip to a point, close a seam). */
    weldVertices(id: string, v1: number, v2: number): boolean { this.sm.makeEditable3D(id); return this.sm.weldVertices3D(id, v1, v2); }
    /** Merge all vertices closer than `threshold` (clean up / collapse). Returns the count removed. */
    mergeByDistance(id: string, threshold: number): number { this.sm.makeEditable3D(id); return this.sm.mergeByDistance3D(id, threshold); }
    /** Fill a boundary hole (give one boundary half-edge of the loop). */
    fillHole(id: string, boundaryHalfEdgeIndex: number): boolean { this.sm.makeEditable3D(id); return this.sm.fillHole3D(id, boundaryHalfEdgeIndex); }
    /** Bridge two equal-length vertex-index loops with a quad strip. */
    bridgeEdgeLoops(id: string, loopA: number[], loopB: number[]): boolean { this.sm.makeEditable3D(id); return this.sm.bridgeEdgeLoops3D(id, loopA, loopB); }
    /** Enable/adjust proportional (soft) editing so {@link moveVertex} drags neighbours within `radius` — the
     *  taper-a-tip-to-a-point tool. `falloff` = smooth | linear | sharp. */
    setProportionalEdit(id: string, enabled: boolean, radius?: number, falloff?: 'smooth' | 'linear' | 'sharp'): void {
        this.sm.makeEditable3D(id); this.sm.meshEdit.setProportionalEdit(id, enabled, radius, falloff);
    }

    // ── Modifiers (non-destructive stack; bake with applyModifier) ─────
    /** Add a Catmull-Clark SUBDIVISION-SURFACE modifier (rounds/smooths the mesh). Returns its stack index. */
    addSubdivisionModifier(id: string, iterations = 1): number { this.sm.makeEditable3D(id); return this.sm.addSubdivisionModifier3D(id, iterations); }
    /** Add a MIRROR modifier across an axis (with plane-clipping/welding). Returns its stack index. */
    addMirrorModifier(id: string, axis: 'x' | 'y' | 'z' = 'x', clipping = true): number { this.sm.makeEditable3D(id); return this.sm.addMirrorModifier3D(id, axis, clipping); }
    /** Add a DISPLACE modifier — push the surface in/out along its normals by a noise field for roughness / relief
     *  (rocks, asteroids, gnarled bark, terrain). `strength` = displacement amount, `frequency` = bump density,
     *  `octaves` = fBm detail layers, `direction` = 'normal' (default) or an axis. Works best AFTER
     *  addSubdivisionModifier (needs vertices to displace). Returns its stack index. */
    addDisplaceModifier(id: string, params?: { strength?: number; frequency?: number; seed?: number; octaves?: number; direction?: 'normal' | 'x' | 'y' | 'z' }): number {
        this.sm.makeEditable3D(id); return this.sm.addDisplaceModifier3D(id, params);
    }
    /** Bake a modifier (by stack index) destructively into the mesh. */
    applyModifier(id: string, index: number): boolean { this.sm.makeEditable3D(id); return this.sm.applyModifier3D(id, index); }

    // ── Environment / reflections (SH-IBL: soft image-based lighting + blurry metal reflections) ──
    /** Set the scene environment map from an equirectangular image (drives ambient IBL + soft metal reflections). */
    setEnvironmentMap(imageData: ImageData, intensity = 1): void { this.sm.setEnvironmentMap3D(imageData, intensity); }
    /** Clear the environment map. */
    clearEnvironmentMap(): void { this.sm.clearEnvironmentMap3D(); }

    // ══ Rigging + animation — give a mesh a skeleton, pose it, and record clips ═════════════════════════════════
    // Workflow: createSkeleton → addBone (build the bone hierarchy) → bindMesh (skin it) → poseBone/setIKTarget →
    // for animation, createClip then at each frame pose the skeleton and recordPose(frame) → playClip. Rotations
    // are EULER DEGREES (the API converts to quaternions for you). Read the rig back with getJoints. A character
    // made via addCharacter already has a skeleton — get it with getSkeletonForMesh.

    /** Create an empty skeleton. Returns its id. Add bones with {@link addBone}, then {@link bindMesh} a mesh to it. */
    createSkeleton(name?: string): string { return this.sm.createEmptySkeleton3D(name); }
    /** Append a bone. `parentIndex` = -1 for the root; otherwise the index returned by a prior addBone. `position`
     *  is the bone head in the skeleton's local space. Returns the new joint index. */
    addBone(skeletonId: string, parentIndex: number, position: [number, number, number], name?: string): number {
        return this.sm.addBone3D(skeletonId, parentIndex, position, name);
    }
    /** Read the rig back: every joint as {index,name,parentIndex,localPosition,tailOffset,isLeaf}. */
    getJoints(skeletonId: string): { index: number; name: string; parentIndex: number; localPosition: [number, number, number]; tailOffset: [number, number, number]; isLeaf: boolean }[] {
        return this.sm.getSkeletonJoints3D(skeletonId);
    }
    /** Skin a mesh to a skeleton (auto-binds vertices by proximity). Returns false if either id is invalid. */
    bindMesh(meshId: string, skeletonId: string): boolean { return this.sm.bindMeshToSkeleton3D(meshId, skeletonId); }
    /** The skeleton id driving a mesh (e.g. a character body from addCharacter), or null. */
    getSkeletonForMesh(meshId: string): string | null { return this.sm.getSkeletonIdForMesh3D(meshId); }

    /** Rotate a bone to an absolute local orientation given as EULER DEGREES (intrinsic XYZ) — converted to a
     *  quaternion internally. e.g. {y: 45} yaws the bone 45°. Returns false if the skeleton is invalid. */
    poseBone(skeletonId: string, jointIndex: number, euler: Vec3): boolean {
        return this.sm.setJointRotation3D(skeletonId, jointIndex, eulerToQuat(euler.x ?? 0, euler.y ?? 0, euler.z ?? 0));
    }
    /** Drive an IK chain's end-effector to a world point (e.g. "put the paw here"). `chainId` names the chain. */
    setIKTarget(skeletonId: string, chainId: string, x: number, y: number, z: number): void {
        this.sm.setIKTarget3D(skeletonId, chainId, x, y, z);
    }

    /** Capture the skeleton's CURRENT pose into the pose library. Returns the pose id. */
    capturePose(skeletonId: string, name: string): string { return this.sm.capturePose3D(skeletonId, name); }
    /** Apply a saved pose (by id) to the skeleton. */
    applyPose(skeletonId: string, poseId: string): void { this.sm.applyPose3D(skeletonId, poseId); }
    /** The saved poses for a skeleton as {id,name}. */
    getPoses(skeletonId: string): { id: string; name: string }[] {
        return this.sm.getPoses3D(skeletonId).map(p => ({ id: p.id, name: p.name }));
    }

    /** Create an animation clip on a skeleton. Returns the clip id. Then pose the skeleton and {@link recordPose}
     *  at each keyframe, and {@link playClip} to run it. */
    createClip(skeletonId: string, name: string, fps = 24, endFrame = 60): string {
        return this.sm.createSkeletonClip3D(skeletonId, name, fps, endFrame);
    }
    /** Snapshot the skeleton's CURRENT pose as a keyframe of `clipId` at `frame` (the AI-friendly path — pose, then
     *  record, no quaternion keyframe math). */
    recordPose(skeletonId: string, clipId: string, frame: number): void {
        this.sm.recordSkeletonPose3D(skeletonId, clipId, frame);
    }
    /** Play a clip (by id) on its skeleton. Returns false if the clip id is unknown. */
    playClip(skeletonId: string, clipId: string): boolean {
        const clip = this.sm.getSkeletonClips3D(skeletonId).find(c => c.id === clipId);
        if (!clip) return false;
        this.sm.playSkeletonClip3D(skeletonId, clip);
        return true;
    }
    /** Toggle procedural idle (subtle breathing/sway) on a character body mesh — makes it feel alive with no keyframes. */
    setIdle(bodyMeshId: string, on: boolean, intensity = 1): void { this.sm.setIdleAnimation3D(bodyMeshId, on, intensity); }
}
