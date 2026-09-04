import type { SceneAuthoringAPI } from './scene-authoring-api';

/**
 * Tool-schema generator + dispatcher for {@link SceneAuthoringAPI} — the model-consumable layer (docs/specs/
 * god-object-status-and-mcp.md §5.4). {@link sceneAuthoringTools} returns an Anthropic/MCP-style tool list (name +
 * description + JSON-Schema `input_schema`) you hand a model; {@link runSceneAuthoringTool} executes a returned
 * `tool_use` against a live API instance. Together they're the whole bridge: `tools = sceneAuthoringTools()`, and on
 * each tool_use → `runSceneAuthoringTool(sm.authoring, name, input)`.
 *
 * The tool set is authored declaratively HERE (one place, in sync with the API verbs). Creator-prop params stay
 * schema-driven at runtime via the `propSchema` tool (the model queries it, then calls `addProp`).
 */
export interface ToolDef {
    name: string;
    description: string;
    /** JSON Schema for the tool's arguments (Anthropic `input_schema` shape). */
    input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const num = (description: string) => ({ type: 'number', description });
const str = (description: string) => ({ type: 'string', description });
const hex = (description: string) => ({ type: 'string', description: `${description} (hex, e.g. '#ff8800')` });
const numArr = (description: string) => ({ type: 'array', description, items: { type: 'number' } });
const materialProp = { type: 'object', description: 'Optional material patch (diffuse {r,g,b,a} 0–1, roughness, metalness, emissive…).' };

export function sceneAuthoringTools(): ToolDef[] {
    const obj = (properties: Record<string, unknown>, required?: string[]): ToolDef['input_schema'] =>
        ({ type: 'object', properties, ...(required ? { required } : {}) });

    return [
        // ── 3D primitives ──
        { name: 'addBox', description: 'Add a 3D box (id returned). Extents are full width/height/depth (default 1³), centred at (x,y,z).',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), width: num('full width'), height: num('full height'), depth: num('full depth'), material: materialProp }) },
        { name: 'addSphere', description: 'Add a 3D sphere of `radius` (default 0.5). Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), radius: num('radius'), segments: num('mesh segments'), material: materialProp }) },
        { name: 'addCylinder', description: 'Add a 3D cylinder (radius × height, default 0.5 × 1). Set radiusTop for a smooth TAPER (a truncated cone if radiusTop<radius, a cone if radiusTop 0) — a surface of revolution, exact at any radialSegments, so prefer it over stacked extrudes for tapered spikes/columns/horns. Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), radius: num('bottom radius'), height: num('height'), radiusTop: num('top radius (omit=straight, 0=cone, <radius=taper)'), radialSegments: num('segments'), material: materialProp }) },
        { name: 'addCone', description: 'Add a 3D cone — a cylinder tapering to a point at the top (radiusTop>0 = truncated cone). Smooth surface of revolution; use this for a clean tapered spike instead of stepped extrusions. Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), radius: num('base radius'), height: num('height'), radiusTop: num('top radius (default 0 = sharp point)'), radialSegments: num('segments'), material: materialProp }) },
        { name: 'addTorus', description: 'Add a 3D torus (ring `radius`, `tubeRadius` thickness; default 0.5 / 0.2). Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), radius: num('ring radius'), tubeRadius: num('tube thickness'), material: materialProp }) },
        { name: 'addPlane', description: 'Add a flat 3D plane (width × height, default 1 × 1) on the ground. Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), width: num('width'), height: num('height'), material: materialProp }) },
        { name: 'addRevolve', description: 'Add a SURFACE OF REVOLUTION — spin a 2D profile silhouette around the Y axis. profile = ordered [radius, y] points, bottom→top (radius 0 at an end = a point/tip). The exact, smooth way to make vases, columns, goblets, bottles, finials, tapered spikes — far better than stacked extrudes for anything round with a varying radius. e.g. a spike: [[0.3,-0.5],[0.05,0.3],[0,0.6]]. Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), profile: { type: 'array', description: 'ordered [radius, y] pairs, bottom→top', items: { type: 'array', items: { type: 'number' } } }, segments: num('angular tessellation (default 24)'), material: materialProp }, ['profile']) },
        { name: 'addTube', description: 'Add a TUBE / LOFT — sweep a circular cross-section of varying radius along a path spine. The way to make anything that FOLLOWS A CURVE with varying thickness: horns, tentacles, tree branches, pipes, cables, snakes. path = ordered [x,y,z] points; radii = the tube radius at each point (single value = constant; taper to 0 for a horn tip). e.g. a curved horn: path [[0,0,0],[0.2,0.5,0],[0.5,0.8,0]] radii [0.15,0.08,0]. Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), path: { type: 'array', description: 'ordered [x,y,z] spine points', items: { type: 'array', items: { type: 'number' } } }, radii: numArr('radius at each path point (1 value = constant)'), segments: num('cross-section sides (default 12)'), material: materialProp }, ['path', 'radii']) },
        { name: 'addMetaballs', description: 'Add METABALLS — compose an ORGANIC, blobby, BRANCHING form from primitives that SMOOTHLY FUSE where they overlap. THE way to make creatures/animals, slime, coral, clouds — anything box-modeling and revolve/tube cannot (they branch and merge). blobs = list of {shape:"sphere"|"capsule"|"ellipsoid"|"box"|"torus", a:[x,y,z] centre or capsule-start, b:[x,y,z] capsule-end, radius, radii:[x,y,z] for ellipsoid/box, R for torus, blend: smooth-fuse radius (use ~0.2-0.4), op:"subtract" to carve}. A quadruped ≈ a body capsule + 4 leg capsules + a neck capsule + a head sphere, all blend>0. resolution 8..96 (higher=smoother, slower). Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), blobs: { type: 'array', description: 'SDF blobs (see description)', items: { type: 'object' } }, resolution: num('grid cells/axis 8..96 (default 48)'), decimate: num('keep this fraction of triangles 0..1 (QEM simplify — leaner, same shape); omit for full density'), material: materialProp }, ['blobs']) },
        { name: 'creatureSpecies', description: 'List the creature species presets available to addCreature (dog/cat/horse/lizard/generic).', input_schema: obj({}) },
        { name: 'addCreature', description: 'Add a procedural CREATURE — a smooth quadruped/biped animal built from metaballs. THE easy way to make an animal (a dog, cat, horse, lizard) — far better than box-modeling or hand-placing blobs. Pick `species` for proportions; override any of bodyLength/bodyRadius/legCount(4|2)/legLength/neckLength/headSize/snoutLength/earSize/tailLength/tailCurl/blend. Set rigged:true to also build a bone skeleton + bind it, so the animal can be posed/animated (find its skeleton with getSkeletonForMesh). Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), species: str('dog | cat | horse | lizard | generic'), bodyLength: num('body length'), bodyRadius: num('torso thickness'), legCount: num('4 or 2'), legLength: num('leg length'), neckLength: num('neck length'), headSize: num('head size'), tailLength: num('tail length'), tailCurl: num('tail upward curl 0..1'), earSize: num('ear size (0=none)'), blend: num('overall smoothness'), seed: num('varies the proportions — same species, different individual'), roughness: num('0=smooth; >0 adds skin/scale/fur surface relief'), eyes: { type: 'boolean', description: 'add eyes (default true)' }, rigged: { type: 'boolean', description: 'also rig it (skeleton + bind) for posing/animation' }, decimate: num('keep this fraction of triangles 0..1 (default 0.4 — creatures are dense; lower = leaner). 1 or 0 = full density'), resolution: num('grid res 8..96 (default 56)'), material: materialProp }) },

        // ── Transform (absolute) ──
        { name: 'setPosition', description: 'Set an object\'s ABSOLUTE world position. Omitted axes → 0.',
          input_schema: obj({ id: str('object id'), x: num('x'), y: num('y'), z: num('z') }, ['id']) },
        { name: 'setRotation', description: 'Set ABSOLUTE Euler rotation in RADIANS. Omitted axes → 0.',
          input_schema: obj({ id: str('object id'), x: num('pitch rad'), y: num('yaw rad'), z: num('roll rad') }, ['id']) },
        { name: 'setScale', description: 'Set ABSOLUTE non-uniform scale. Omitted axes → 1.',
          input_schema: obj({ id: str('object id'), x: num('scale x'), y: num('scale y'), z: num('scale z') }, ['id']) },

        // ── Material ──
        { name: 'setMaterial', description: 'Patch an object\'s material.',
          input_schema: obj({ id: str('object id'), material: materialProp }, ['id', 'material']) },
        { name: 'setColor', description: 'Set an object\'s diffuse colour (0–1 RGBA).',
          input_schema: obj({ id: str('object id'), r: num('red 0–1'), g: num('green 0–1'), b: num('blue 0–1'), a: num('alpha 0–1') }, ['id', 'r', 'g', 'b']) },
        { name: 'surfaceMaterials', description: 'List the procedural surface-material names (stone family, grass, dirt, wood plank, cobble, …) available to setSurfaceMaterial.', input_schema: obj({}) },
        { name: 'setSurfaceMaterial', description: 'TEXTURE an object with a PROCEDURAL surface material by name (ashlar/brick/granite/slate/sandstone/grass/dirt/cobble/concrete/plank …) — real surfacing (stone blocks, wood grain, grass) with no image needed. This is how you make things look like stone/wood/grass instead of flat color. tint (hex) recolors; tileSize (world units, larger=bigger blocks) + weather (new|worn|ancient|mossy|dirty) tune it. Works on any mesh (world-mapped).',
          input_schema: obj({ id: str('object id'), name: str('surface name (see surfaceMaterials)'), tint: hex('recolor'), tileSize: num('block/plank size in world units'), weather: str('new|worn|ancient|mossy|dirty') }, ['id', 'name']) },
        { name: 'setRenderStyle', description: 'Set an object\'s render style: cel (toon/hand-painted), sketch, ink, gouraud, unlit, or default (PBR). Use cel for a stylized/diorama look.',
          input_schema: obj({ id: str('object id'), style: str('cel | cel-hd | sketch | ink | gouraud | unlit | default') }, ['id', 'style']) },
        { name: 'setSceneStyle', description: 'Apply a render style to ALL 3D objects at once — e.g. "cel" for a whole toon/hand-painted scene. Returns count changed.',
          input_schema: obj({ style: str('cel | cel-hd | sketch | ink | gouraud | unlit | default') }, ['style']) },

        // ── World / city ──
        { name: 'generateCity', description: 'Generate (or regenerate) the procedural city from LayoutParams (all optional). `draft`=fast preview.',
          input_schema: obj({ params: { type: 'object', description: 'Partial LayoutParams (seed, radius, districts, …).' }, draft: { type: 'boolean', description: 'fast reduced build' } }) },

        // ── Props / buildings ──
        { name: 'listPropTypes', description: 'List the available creator prop types ({typeId,label}).', input_schema: obj({}) },
        { name: 'propSchema', description: 'Get the machine-readable param schema for a creator prop type (call before addProp).',
          input_schema: obj({ typeId: str('creator type id') }, ['typeId']) },
        { name: 'addProp', description: 'Spawn a procedural creator prop by type. Returns its id (null if type unknown).',
          input_schema: obj({ typeId: str('creator type id'), params: { type: 'object', description: 'per-type params (see propSchema)' }, transform: { type: 'object', description: 'optional {x,y,z,ry,scale}' } }, ['typeId']) },
        { name: 'addBuilding', description: 'Add a standalone procedural building (11 archetypes; a seed reproduces it). Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), params: { type: 'object', description: 'Partial BuildingParams (archetype, seed, …).' } }) },

        // ── Lighting ──
        { name: 'setDirectionalLight', description: 'Set the sun: direction + RGB colour + intensity.',
          input_schema: obj({ dir: { type: 'object', description: 'direction {x,y,z}' }, color: { type: 'object', description: 'RGB {r,g,b} 0–1' }, intensity: num('intensity') }) },
        { name: 'setAmbientLight', description: 'Set the ambient fill light (RGB 0–1 + intensity).',
          input_schema: obj({ color: { type: 'object', description: 'RGB {r,g,b} 0–1' }, intensity: num('intensity') }, ['color']) },
        { name: 'setStudioLighting', description: 'Apply bright, even studio lighting (key + strong fill) so content reads clearly — the default scene lighting is dim. Use if a scene looks too dark.', input_schema: obj({}) },

        // ── 2D vector shapes ──
        { name: 'addRectangle', description: 'Add a 2D vector rectangle (illustration space). Returns its id.',
          input_schema: obj({ x: num('2D x'), y: num('2D y'), width: num('width'), height: num('height'), fill: hex('fill'), stroke: hex('stroke'), strokeWidth: num('stroke px') }) },
        { name: 'addCircle', description: 'Add a 2D vector circle of `radius`. Returns its id.',
          input_schema: obj({ x: num('2D x'), y: num('2D y'), radius: num('radius'), fill: hex('fill'), stroke: hex('stroke'), strokeWidth: num('stroke px') }) },
        { name: 'addTriangle', description: 'Add a 2D vector triangle. Returns its id.',
          input_schema: obj({ x: num('2D x'), y: num('2D y'), width: num('width'), height: num('height'), fill: hex('fill'), stroke: hex('stroke'), strokeWidth: num('stroke px') }) },
        { name: 'addLine', description: 'Add a 2D stroked line from (x1,y1) to (x2,y2).',
          input_schema: obj({ x1: num('start x'), y1: num('start y'), x2: num('end x'), y2: num('end y'), stroke: hex('stroke'), strokeWidth: num('stroke px') }, ['x1', 'y1', 'x2', 'y2']) },

        // ── Composition ──
        { name: 'duplicateObject', description: 'Duplicate a 3D object (returns the new id).', input_schema: obj({ id: str('source id') }, ['id']) },
        { name: 'addLinearArray', description: 'GPU-instanced linear array of `count` copies of `sourceId`, spaced by [dx,dy,dz].',
          input_schema: obj({ sourceId: str('source id'), count: num('copies'), spacing: { type: 'array', description: '[dx,dy,dz] world units', items: { type: 'number' } } }, ['sourceId']) },

        // ── Characters / text / particles ──
        { name: 'addCharacter', description: 'Add a full procedural character — CLOTHED + HAIRED by default (basic top/bottom/hair applied automatically). Returns the body mesh id. Override any slot with explicit params, or pass clothed:false for a bare base body.',
          input_schema: obj({ body: { type: 'object', description: 'Partial BodyParams (12 shape multipliers)' }, position: { type: 'array', items: { type: 'number' }, description: '[x,y,z]' }, clothed: { type: 'boolean', description: 'default true; false = nude base body' }, hair: { type: 'object' }, top: { type: 'object' }, bottom: { type: 'object' }, skinTone: str('hex skin colour') }) },
        { name: 'addText', description: 'Add an editable 2D text object. Returns its id.',
          input_schema: obj({ x: num('2D x'), y: num('2D y'), text: str('the text') }) },
        { name: 'addParticles', description: 'Add a 3D particle emitter (preset: dust/sparks/snow/magic, or a custom config). Returns its id.',
          input_schema: obj({ x: num('world x'), y: num('world y'), z: num('world z'), preset: str('dust|sparks|snow|magic'), config: { type: 'object' } }) },

        // ── Batch / transaction ──
        { name: 'applyScenePlan', description: 'Execute a whole list of tool calls in ONE coalesced scene update — emit a full scene, then refine. Returns per-op {tool, result}.',
          input_schema: obj({ ops: { type: 'array', description: 'ordered list of {tool, input}', items: { type: 'object', properties: { tool: str('a tool name'), input: { type: 'object' } }, required: ['tool'] } } }, ['ops']) },

        // ── Read-back (the closed loop) ──
        { name: 'listObjects', description: 'List every 3D object as {id,name}.', input_schema: obj({}) },
        { name: 'list2DObjects', description: 'List every 2D vector shape as {id,name}.', input_schema: obj({}) },
        { name: 'getObject', description: 'Lightweight readout of any object by id: {id,name,x,y,z,visible}. Null if gone.',
          input_schema: obj({ id: str('object id') }, ['id']) },
        { name: 'removeObject', description: 'Delete a 3D object by id.', input_schema: obj({ id: str('object id') }, ['id']) },
        // DISABLED (2026-08-18): NOT exposing a bulk scene-clear to the AI — it could wipe hours of a user's work on
        // a misread "make me X". Clearing is a USER action (the "New" button). Do not re-enable without an undo/confirm gate.
        // { name: 'clearScene', description: 'Remove ALL 3D objects — start fresh…', input_schema: obj({}) },
        { name: 'getSelection', description: 'The currently-selected object ids.', input_schema: obj({}) },
        { name: 'select', description: 'Replace the selection with `ids`.', input_schema: obj({ ids: { type: 'array', items: { type: 'string' }, description: 'object ids' } }, ['ids']) },
        { name: 'describeScene', description: 'One-shot scene readout: all objects + global scene settings (use to self-correct).', input_schema: obj({}) },
        { name: 'getSceneSettings', description: 'The whole global 3D scene settings object.', input_schema: obj({}) },
        { name: 'screenshot', description: 'Render the current 3D view to a PNG data URL, so you can SEE what you made and self-correct. Costs image tokens (scales with area) — screenshot SPARINGLY, after a milestone not every op, and keep the default small.', input_schema: obj({ maxWidth: num('px — scales the longest side, aspect preserved (default 512; raise only to read fine detail)') }) },
        { name: 'getSceneBounds', description: 'World-space bounding volume of ALL objects: {min,max,center,size,count} (or null if empty). Projection-agnostic — use it to place new objects within the existing footprint / keep the scene compact.', input_schema: obj({}) },
        { name: 'getArtboard', description: 'IN ILLUSTRATION MODE CALL THIS FIRST. The frame to author within, in WORLD units: {center, upAxis:"y", recommendedScale, min, max, worldWidth, worldHeight, pixelWidth, pixelHeight, projection}. Place content around center, build vertical things along +Y (NOT z), size a unit primitive by recommendedScale, and keep object bounds inside min..max.', input_schema: obj({}) },
        { name: 'isInView', description: 'Is an object currently inside the rendered frame? Projection-AWARE (handles ortho AND perspective) — check framing without doing camera math.', input_schema: obj({ id: str('object id') }, ['id']) },
        { name: 'fitToFrame', description: 'GUARANTEED compose-in-bounds: scale + center ALL 3D content to fit the frame (padding<1 = margin, default 0.9). Build at any scale/position, then call this ONCE at the end and everything lands centered and framed. Use it whenever you are unsure about scale.', input_schema: obj({ padding: num('0..1 margin (default 0.9)') }) },

        // ── Mesh editing (half-edge kernel — sculpt a box/sphere into a gem, greebled panel, organic form) ──
        // Workflow: describeMesh/listFaces (pick faces by normal/center) → extrudeFaces/insetFaces/bevelEdge/loopCut/
        // moveVertex → screenshot. Ops are INDEX-BASED and idempotently auto-make the mesh editable; all are undoable.
        { name: 'makeEditable', description: 'MESH EDIT: build a mesh\'s editable half-edge form (idempotent; read-back + ops call it for you).',
          input_schema: obj({ id: str('mesh id') }, ['id']) },
        { name: 'describeMesh', description: 'MESH EDIT: face + vertex counts for a mesh (auto-makes it editable). Start here before editing.',
          input_schema: obj({ id: str('mesh id') }, ['id']) },
        { name: 'listFaces', description: 'MESH EDIT: every face as {index,center,normal,vertexCount} (object space). Use normals to pick elements — the face whose normal is [0,1,0] is the top.',
          input_schema: obj({ id: str('mesh id') }, ['id']) },
        { name: 'listVertices', description: 'MESH EDIT: every vertex as {index,position} (object space).',
          input_schema: obj({ id: str('mesh id') }, ['id']) },
        { name: 'facesByNormal', description: 'MESH EDIT: face indices whose normal aligns with `axis` (dot ≥ threshold). Ergonomic "select the top/front/side faces". axis e.g. [0,1,0]=up.',
          input_schema: obj({ id: str('mesh id'), axis: numArr('world axis [x,y,z]'), threshold: num('dot cutoff 0–1 (default 0.7)') }, ['id', 'axis']) },
        { name: 'selectFaces', description: 'MESH EDIT: set the face selection (indices). Ops with omitted faceIndices act on this selection.',
          input_schema: obj({ id: str('mesh id'), faceIndices: numArr('face indices') }, ['id', 'faceIndices']) },
        { name: 'selectVertices', description: 'MESH EDIT: set the vertex selection (indices).',
          input_schema: obj({ id: str('mesh id'), vertexIndices: numArr('vertex indices') }, ['id', 'vertexIndices']) },
        { name: 'extrudeFaces', description: 'MESH EDIT: extrude faces outward along their normals by `distance` (grow panels/greebles/limbs). Omit faceIndices to use the selection.',
          input_schema: obj({ id: str('mesh id'), faceIndices: numArr('face indices (omit → selection)'), distance: num('extrude distance') }, ['id', 'distance']) },
        { name: 'insetFaces', description: 'MESH EDIT: inset faces toward their centres by `amount` (0..1) — makes a border to then extrude/bevel. Omit faceIndices → selection.',
          input_schema: obj({ id: str('mesh id'), faceIndices: numArr('face indices (omit → selection)'), amount: num('inset 0..1') }, ['id', 'amount']) },
        { name: 'subdivideFace', description: 'MESH EDIT: subdivide ONE face into quads (local detail).',
          input_schema: obj({ id: str('mesh id'), faceIndex: num('face index') }, ['id', 'faceIndex']) },
        { name: 'bevelEdge', description: 'MESH EDIT: bevel/chamfer ONE edge (by half-edge index) — a single chamfer strip; catches light on gem/hard edges. amount 0..1.',
          input_schema: obj({ id: str('mesh id'), halfEdgeIndex: num('half-edge index'), amount: num('bevel 0..1') }, ['id', 'halfEdgeIndex', 'amount']) },
        { name: 'bevelVertex', description: 'MESH EDIT: bevel/chamfer a VERTEX (by index) — cut the corner off into a small cap face (rounds off a sharp point). amount 0..1 along each incident edge.',
          input_schema: obj({ id: str('mesh id'), vertexIndex: num('vertex index'), amount: num('bevel 0..1') }, ['id', 'vertexIndex', 'amount']) },
        { name: 'loopCut', description: 'MESH EDIT: loop-cut a ring of quads from a half-edge; t 0..1 = position. Adds an edge loop for more control.',
          input_schema: obj({ id: str('mesh id'), halfEdgeIndex: num('start half-edge'), t: num('position 0..1 (default 0.5)') }, ['id', 'halfEdgeIndex']) },
        { name: 'moveVertex', description: 'MESH EDIT: move one vertex by an object-space delta (dx,dy,dz). Enable proportional edit first for soft/tapered pulls.',
          input_schema: obj({ id: str('mesh id'), vertexIndex: num('vertex index'), dx: num('Δx'), dy: num('Δy'), dz: num('Δz') }, ['id', 'vertexIndex', 'dx', 'dy', 'dz']) },
        { name: 'weldVertices', description: 'MESH EDIT: weld two vertices together (collapse a tip to a point, close a seam).',
          input_schema: obj({ id: str('mesh id'), v1: num('vertex A'), v2: num('vertex B') }, ['id', 'v1', 'v2']) },
        { name: 'mergeByDistance', description: 'MESH EDIT: merge all vertices closer than `threshold` (cleanup). Returns count removed.',
          input_schema: obj({ id: str('mesh id'), threshold: num('distance threshold') }, ['id', 'threshold']) },
        { name: 'deleteFaces', description: 'MESH EDIT: delete faces (leaves a hole — pair with fillHole/bridgeEdgeLoops). Omit faceIndices → selection.',
          input_schema: obj({ id: str('mesh id'), faceIndices: numArr('face indices (omit → selection)') }, ['id']) },
        { name: 'flipFaces', description: 'MESH EDIT: flip face normals (winding). Omit faceIndices → selection.',
          input_schema: obj({ id: str('mesh id'), faceIndices: numArr('face indices (omit → selection)') }, ['id']) },
        { name: 'separateFaces', description: 'MESH EDIT: split faces off into a NEW mesh node (returns new id). Omit faceIndices → selection.',
          input_schema: obj({ id: str('mesh id'), faceIndices: numArr('face indices (omit → selection)') }, ['id']) },
        { name: 'booleanMesh', description: 'MESH EDIT: BOOLEAN CSG between two meshes → a NEW mesh. union = merge two solids; subtract = cut idB out of idA (holes, hollows, notches, punch windows); intersect = keep only the overlap. Inputs should be closed solids (primitives/revolves). Consumes both operands unless keepOperands. Returns the new mesh id.',
          input_schema: obj({ idA: str('mesh A'), idB: str('mesh B'), op: str('union | subtract | intersect'), keepOperands: { type: 'boolean', description: 'keep the two source meshes (default false = consume them)' } }, ['idA', 'idB', 'op']) },
        { name: 'simplifyMesh', description: 'MESH EDIT: DECIMATE a mesh — keep `ratio` (0..1) of its triangles via QEM (curvature-adaptive: flat areas collapse, detail is preserved). Leaner render/memory with the SAME silhouette — ideal for dense metaballs/creatures/boolean results. Undoable. Drops UVs (re-apply setSurfaceMaterial/setColor after). Returns true if it simplified.',
          input_schema: obj({ id: str('mesh id'), ratio: num('fraction of triangles to KEEP, 0..1 (e.g. 0.3 = 30%)') }, ['id', 'ratio']) },
        { name: 'fillHole', description: 'MESH EDIT: fill a boundary hole — give one boundary half-edge of the loop.',
          input_schema: obj({ id: str('mesh id'), boundaryHalfEdgeIndex: num('a boundary half-edge') }, ['id', 'boundaryHalfEdgeIndex']) },
        { name: 'bridgeEdgeLoops', description: 'MESH EDIT: bridge two equal-length vertex-index loops with a quad strip.',
          input_schema: obj({ id: str('mesh id'), loopA: numArr('vertex indices, loop A'), loopB: numArr('vertex indices, loop B') }, ['id', 'loopA', 'loopB']) },
        { name: 'setProportionalEdit', description: 'MESH EDIT: enable soft/proportional editing so moveVertex drags neighbours within `radius` (taper a tip to a point). falloff=smooth|linear|sharp.',
          input_schema: obj({ id: str('mesh id'), enabled: { type: 'boolean', description: 'on/off' }, radius: num('falloff radius'), falloff: str('smooth|linear|sharp') }, ['id', 'enabled']) },
        { name: 'addSubdivisionModifier', description: 'MESH EDIT: add a Catmull-Clark SUBDIVISION-SURFACE modifier (rounds/smooths a boxy mesh into an organic form). Returns stack index.',
          input_schema: obj({ id: str('mesh id'), iterations: num('subdivision levels (default 1)') }, ['id']) },
        { name: 'addMirrorModifier', description: 'MESH EDIT: add a MIRROR modifier across an axis (symmetry). Returns stack index.',
          input_schema: obj({ id: str('mesh id'), axis: str('x|y|z (default x)'), clipping: { type: 'boolean', description: 'weld across the mirror plane' } }, ['id']) },
        { name: 'addDisplaceModifier', description: 'MESH EDIT: add a DISPLACE modifier — push the surface in/out along its normals by a noise field for roughness/relief (rocks, asteroids, gnarled bark, terrain). Works best AFTER addSubdivisionModifier (needs vertices to displace). Returns stack index.',
          input_schema: obj({ id: str('mesh id'), strength: num('displacement amount'), frequency: num('bump density (default 1)'), seed: num('reproducible seed'), octaves: num('fBm detail layers (default 1)'), direction: str("'normal' (default) | x | y | z") }, ['id']) },
        { name: 'applyModifier', description: 'MESH EDIT: bake a modifier (by stack index) destructively into the mesh.',
          input_schema: obj({ id: str('mesh id'), index: num('modifier stack index') }, ['id', 'index']) },

        // ── Rigging + animation (skeleton → skin → pose → clip). Rotations are EULER DEGREES. ──
        { name: 'createSkeleton', description: 'RIG: create an empty skeleton (returns its id). Then addBone to build the hierarchy and bindMesh to skin a mesh.',
          input_schema: obj({ name: str('optional name') }) },
        { name: 'addBone', description: 'RIG: append a bone. parentIndex=-1 for the root, else a prior addBone index. position=[x,y,z] bone head in local space. Returns the joint index.',
          input_schema: obj({ skeletonId: str('skeleton id'), parentIndex: num('parent joint index (-1=root)'), position: numArr('[x,y,z] bone head'), name: str('optional bone name') }, ['skeletonId', 'parentIndex', 'position']) },
        { name: 'getJoints', description: 'RIG: read the rig back — every joint as {index,name,parentIndex,localPosition,tailOffset,isLeaf}.',
          input_schema: obj({ skeletonId: str('skeleton id') }, ['skeletonId']) },
        { name: 'bindMesh', description: 'RIG: skin a mesh to a skeleton (binds vertices by proximity). Do this AFTER the bones are placed.',
          input_schema: obj({ meshId: str('mesh id'), skeletonId: str('skeleton id') }, ['meshId', 'skeletonId']) },
        { name: 'getSkeletonForMesh', description: 'RIG: the skeleton id driving a mesh (e.g. an addCharacter body), or null.',
          input_schema: obj({ meshId: str('mesh id') }, ['meshId']) },
        { name: 'poseBone', description: 'POSE: rotate a bone to an absolute local orientation in EULER DEGREES {x,y,z} (converted to a quaternion for you). e.g. {y:45} yaws 45°.',
          input_schema: obj({ skeletonId: str('skeleton id'), jointIndex: num('joint index'), x: num('pitch°'), y: num('yaw°'), z: num('roll°') }, ['skeletonId', 'jointIndex']) },
        { name: 'setIKTarget', description: 'POSE: drive an IK chain end-effector to a world point ("put the paw here"). chainId names the chain.',
          input_schema: obj({ skeletonId: str('skeleton id'), chainId: str('IK chain id'), x: num('world x'), y: num('world y'), z: num('world z') }, ['skeletonId', 'chainId', 'x', 'y', 'z']) },
        { name: 'capturePose', description: 'POSE: save the skeleton\'s CURRENT pose to the pose library (returns pose id).',
          input_schema: obj({ skeletonId: str('skeleton id'), name: str('pose name') }, ['skeletonId', 'name']) },
        { name: 'applyPose', description: 'POSE: apply a saved pose (by id) to the skeleton.',
          input_schema: obj({ skeletonId: str('skeleton id'), poseId: str('pose id') }, ['skeletonId', 'poseId']) },
        { name: 'getPoses', description: 'POSE: list saved poses for a skeleton as {id,name}.',
          input_schema: obj({ skeletonId: str('skeleton id') }, ['skeletonId']) },
        { name: 'createClip', description: 'ANIM: create an animation clip on a skeleton (returns clip id). Then pose the skeleton + recordPose at each keyframe, and playClip.',
          input_schema: obj({ skeletonId: str('skeleton id'), name: str('clip name'), fps: num('frames/sec (default 24)'), endFrame: num('last frame (default 60)') }, ['skeletonId', 'name']) },
        { name: 'recordPose', description: 'ANIM: snapshot the skeleton\'s CURRENT pose as a keyframe of a clip at `frame` (the easy path — pose, then record).',
          input_schema: obj({ skeletonId: str('skeleton id'), clipId: str('clip id'), frame: num('frame number') }, ['skeletonId', 'clipId', 'frame']) },
        { name: 'playClip', description: 'ANIM: play a clip (by id) on its skeleton.',
          input_schema: obj({ skeletonId: str('skeleton id'), clipId: str('clip id') }, ['skeletonId', 'clipId']) },
        { name: 'setIdle', description: 'ANIM: toggle procedural idle (subtle breathing/sway) on a character body mesh — feels alive, no keyframes.',
          input_schema: obj({ bodyMeshId: str('body mesh id'), on: { type: 'boolean', description: 'on/off' }, intensity: num('0..1+ (default 1)') }, ['bodyMeshId', 'on']) },
    ];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyInput = Record<string, any>;

/**
 * Execute a model-emitted tool call against a live {@link SceneAuthoringAPI}. Returns the verb's result (an id, a
 * readout object, a data URL, …) to feed back to the model. Throws on an unknown tool name.
 */
export function runSceneAuthoringTool(api: SceneAuthoringAPI, name: string, input: AnyInput = {}): unknown {
    switch (name) {
        // primitives
        case 'addBox':      return api.addBox(input);
        case 'addSphere':   return api.addSphere(input);
        case 'addCylinder': return api.addCylinder(input);
        case 'addCone':     return api.addCone(input);
        case 'addTorus':    return api.addTorus(input);
        case 'addPlane':    return api.addPlane(input);
        case 'addRevolve':  return api.addRevolve(input as { profile: [number, number][] });
        case 'addTube':     return api.addTube(input as { path: [number, number, number][]; radii: number[] });
        case 'addMetaballs': return api.addMetaballs(input as { blobs: import('../scene-graph/shapes/sdf-mesh').SdfBlob[] });
        case 'creatureSpecies': return api.creatureSpecies();
        case 'addCreature': return api.addCreature(input);
        // transform
        case 'setPosition': return api.setPosition(input.id, input);
        case 'setRotation': return api.setRotation(input.id, input);
        case 'setScale':    return api.setScale(input.id, input);
        // material
        case 'setMaterial': return api.setMaterial(input.id, input.material);
        case 'setColor':    return api.setColor(input.id, input.r, input.g, input.b, input.a ?? 1);
        case 'surfaceMaterials':   return api.surfaceMaterials();
        case 'setSurfaceMaterial': return api.setSurfaceMaterial(input.id, input.name, { tint: input.tint, tileSize: input.tileSize, weather: input.weather });
        case 'setRenderStyle':     return api.setRenderStyle(input.id, input.style);
        case 'setSceneStyle':      return api.setSceneStyle(input.style);
        // world
        case 'generateCity': return api.generateCity(input.params, input.draft ?? false);
        // props / buildings
        case 'listPropTypes': return api.propTypes();
        case 'propSchema':    return api.propSchema(input.typeId);
        case 'addProp':       return api.addProp(input.typeId, input.params, input.transform);
        case 'addBuilding':   return api.addBuilding(input);
        // lighting
        case 'setDirectionalLight': return api.setDirectionalLight(input.dir ?? {}, input.color, input.intensity);
        case 'setAmbientLight':     return api.setAmbientLight(input.color, input.intensity);
        // 2D vector
        case 'addRectangle': return api.addRectangle(input);
        case 'addCircle':    return api.addCircle(input);
        case 'addTriangle':  return api.addTriangle(input);
        case 'addLine':      return api.addLine(input as { x1: number; y1: number; x2: number; y2: number });
        // characters / text / particles
        case 'addCharacter': return api.addCharacter(input);
        case 'addText':      return api.addText(input);
        case 'addParticles': return api.addParticles(input);
        // batch / transaction — run a whole plan in one coalesced scene update. ASYNC: await each op so
        // async verbs (addCharacter/screenshot/stamp) complete BEFORE endBatch closes the coalesced update.
        case 'applyScenePlan': {
            const ops = (input.ops ?? []) as { tool: string; input?: AnyInput }[];
            return (async () => {
                api.beginBatch();
                try {
                    const out: { tool: string; result: unknown }[] = [];
                    for (const op of ops) {
                        if (op.tool === 'applyScenePlan') { out.push({ tool: op.tool, result: { error: 'nested applyScenePlan is not allowed' } }); continue; }
                        let r = runSceneAuthoringTool(api, op.tool, op.input ?? {});
                        if (r instanceof Promise) r = await r;
                        out.push({ tool: op.tool, result: r });
                    }
                    return out;
                } finally { api.endBatch(); }
            })();
        }
        // composition
        case 'duplicateObject': return api.duplicateObject(input.id);
        case 'addLinearArray':  return api.addLinearArray(input.sourceId, input.count, input.spacing);
        // read-back
        case 'listObjects':    return api.listObjects();
        case 'list2DObjects':  return api.list2DObjects();
        case 'getObject':      return api.getObject(input.id);
        case 'removeObject':   return api.removeObject(input.id);
        // case 'clearScene': DISABLED (2026-08-18) — no AI bulk-clear (could wipe a user's work). See API/ShapeManager.
        case 'setStudioLighting': return api.setStudioLighting();
        case 'getSelection':   return api.getSelection();
        case 'select':         return api.select(input.ids ?? []);
        case 'describeScene':  return api.describeScene();
        case 'getSceneSettings': return api.getSceneSettings();
        case 'screenshot':     return api.screenshot(input.maxWidth);
        // scene bounds / framing
        case 'getSceneBounds': return api.getSceneBounds();
        case 'getArtboard':    return api.getArtboard();
        case 'isInView':       return api.isInView(input.id);
        case 'fitToFrame':     return api.fitToFrame(input.padding ?? 0.9);
        // mesh editing (half-edge kernel)
        case 'describeMesh':    return api.describeMesh(input.id);
        case 'listFaces':       return api.listFaces(input.id);
        case 'listVertices':    return api.listVertices(input.id);
        case 'facesByNormal':   return api.facesByNormal(input.id, input.axis, input.threshold ?? 0.7);
        case 'selectFaces':     return api.selectFaces(input.id, input.faceIndices ?? []);
        case 'selectVertices':  return api.selectVertices(input.id, input.vertexIndices ?? []);
        case 'extrudeFaces':    return api.extrudeFaces(input.id, input.faceIndices, input.distance);
        case 'insetFaces':      return api.insetFaces(input.id, input.faceIndices, input.amount);
        case 'subdivideFace':   return api.subdivideFace(input.id, input.faceIndex);
        case 'bevelEdge':       return api.bevelEdge(input.id, input.halfEdgeIndex, input.amount);
        case 'bevelVertex':     return api.bevelVertex(input.id, input.vertexIndex, input.amount);
        case 'loopCut':         return api.loopCut(input.id, input.halfEdgeIndex, input.t ?? 0.5);
        case 'moveVertex':      return api.moveVertex(input.id, input.vertexIndex, input.dx, input.dy, input.dz);
        case 'weldVertices':    return api.weldVertices(input.id, input.v1, input.v2);
        case 'mergeByDistance': return api.mergeByDistance(input.id, input.threshold);
        case 'deleteFaces':     return api.deleteFaces(input.id, input.faceIndices);
        case 'flipFaces':       return api.flipFaces(input.id, input.faceIndices);
        case 'separateFaces':   return api.separateFaces(input.id, input.faceIndices);
        case 'booleanMesh':     return api.booleanMesh(input.idA, input.idB, input.op, { keepOperands: input.keepOperands });
        case 'simplifyMesh':    return api.simplifyMesh(input.id, input.ratio);
        case 'fillHole':        return api.fillHole(input.id, input.boundaryHalfEdgeIndex);
        case 'bridgeEdgeLoops': return api.bridgeEdgeLoops(input.id, input.loopA, input.loopB);
        case 'setProportionalEdit': return api.setProportionalEdit(input.id, input.enabled, input.radius, input.falloff);
        case 'addSubdivisionModifier': return api.addSubdivisionModifier(input.id, input.iterations ?? 1);
        case 'addMirrorModifier': return api.addMirrorModifier(input.id, input.axis ?? 'x', input.clipping ?? true);
        case 'addDisplaceModifier': return api.addDisplaceModifier(input.id, { strength: input.strength, frequency: input.frequency, seed: input.seed, octaves: input.octaves, direction: input.direction });
        case 'applyModifier':   return api.applyModifier(input.id, input.index);
        case 'makeEditable':    return api.makeEditable(input.id);
        // rigging + animation
        case 'createSkeleton':     return api.createSkeleton(input.name);
        case 'addBone':            return api.addBone(input.skeletonId, input.parentIndex, input.position, input.name);
        case 'getJoints':          return api.getJoints(input.skeletonId);
        case 'bindMesh':           return api.bindMesh(input.meshId, input.skeletonId);
        case 'getSkeletonForMesh': return api.getSkeletonForMesh(input.meshId);
        case 'poseBone':           return api.poseBone(input.skeletonId, input.jointIndex, { x: input.x, y: input.y, z: input.z });
        case 'setIKTarget':        return api.setIKTarget(input.skeletonId, input.chainId, input.x, input.y, input.z);
        case 'capturePose':        return api.capturePose(input.skeletonId, input.name);
        case 'applyPose':          return api.applyPose(input.skeletonId, input.poseId);
        case 'getPoses':           return api.getPoses(input.skeletonId);
        case 'createClip':         return api.createClip(input.skeletonId, input.name, input.fps ?? 24, input.endFrame ?? 60);
        case 'recordPose':         return api.recordPose(input.skeletonId, input.clipId, input.frame);
        case 'playClip':           return api.playClip(input.skeletonId, input.clipId);
        case 'setIdle':            return api.setIdle(input.bodyMeshId, input.on, input.intensity ?? 1);
        default: throw new Error(`Unknown scene-authoring tool: ${name}`);
    }
}
