/**
 * Removing a vector layer WITH its content, as one undoable step — and recovering content a removal orphaned.
 *
 * UI review 2026-10-07 #2: the Layers panel's vector-layer ✕ used to delete the layer's ephemera placements and the
 * layer entry but never touched the layer's shapes. They stayed drawn and saved, tagged with a layer id that no longer
 * existed, so no layer could select or delete them — and nothing was recorded for Ctrl+Z.
 *
 * Now the layer entry, every 2D shape tagged with it and its placements leave together, and one command on the 2D
 * object undo stack (the stack the engine's Ctrl+Z consumes first) puts back the layer at its old stack index, the very
 * same shape objects at their old sibling index (so draw order is exact) and the placement list. Documents saved while
 * the bug was live are repaired on load by {@link recoverOrphanedVectorContent}: each missing layer id comes back as a
 * "Recovered shapes" vector layer with the SAME id, so the shapes and placements are reachable again unchanged.
 *
 * Pure over the small interfaces below (no renderer / DOM), so it is unit-tested with a real scene graph.
 */
import type { Node } from '../scene-graph/shapes/base/node';
import type { EphemeraPlacement } from './ephemera/ephemera-types';

/** The layer-stack calls the removal needs (RasterLayerManager satisfies it). */
export interface VectorLayerStack<E = unknown> {
    takeVectorLayer(id: string): { index: number; entry: E } | null;
    reinsertVectorLayer(snap: { index: number; entry: E }): void;
    getLayers(): Array<{ id: string }>;
    addVectorLayerWithId(id: string, name: string, opts?: { visible?: boolean }): void;
}

/** The placement registry calls (EphemeraService satisfies it). */
export interface VectorLayerPlacements {
    takePlacementsForLayer(layerId: string): EphemeraPlacement[];
    restorePlacementsForLayer(layerId: string, list: EphemeraPlacement[]): void;
    getAllPlacements(): Map<string, EphemeraPlacement[]>;
}

export interface VectorLayerRemovalDeps {
    root: Node;
    layers: VectorLayerStack;
    placements: VectorLayerPlacements;
    /** Which nodes belong to the vector-layer system (2D shapes; 3D nodes are excluded). */
    isVectorNode(n: Node): boolean;
    /** A node subtree left / re-entered the scene graph (GPU cache release, eraser registry, selection). */
    onDetached?(n: Node): void;
    onAttached?(n: Node): void;
    getActiveVectorLayerId(): string | null;
    setActiveVectorLayer(id: string | null): void;
    /** Something changed for `layerId`: redraw the overlay, emit scene-graph changed, schedule a render. */
    changed(layerId: string): void;
    /** The undo stack the command goes onto (null = not undoable, e.g. a headless caller). */
    undo: { pushCommand(cmd: { description: string; undo(): void; redo(): void }): void } | null;
}

interface DetachedNode { node: Node; parent: Node; index: number }
interface RemovedState { layer: { index: number; entry: unknown }; nodes: DetachedNode[]; placements: EphemeraPlacement[] }

/** Top-most nodes tagged `layerId` (a tagged node inside a tagged group goes with its group), in preorder. */
function collectLayerNodes(root: Node, layerId: string, isVectorNode: (n: Node) => boolean): DetachedNode[] {
    const out: DetachedNode[] = [];
    const visit = (parent: Node): void => {
        parent.children.forEach((child, index) => {
            if (child.layerId === layerId && isVectorNode(child)) out.push({ node: child, parent, index });
            else visit(child);
        });
    };
    visit(root);
    return out;
}

function detach(deps: VectorLayerRemovalDeps, layerId: string): RemovedState | null {
    const nodes = collectLayerNodes(deps.root, layerId, deps.isVectorNode);
    const layer = deps.layers.takeVectorLayer(layerId);
    if (!layer) return null;
    if (deps.getActiveVectorLayerId() === layerId) deps.setActiveVectorLayer(null);
    // Highest index first per parent, so the recorded indices of the siblings still to go stay valid.
    for (let i = nodes.length - 1; i >= 0; i--) {
        const { node, parent } = nodes[i];
        parent.removeChild(node);
        deps.onDetached?.(node);
    }
    const placements = deps.placements.takePlacementsForLayer(layerId);
    deps.changed(layerId);
    return { layer, nodes, placements };
}

function reattach(deps: VectorLayerRemovalDeps, layerId: string, st: RemovedState): void {
    deps.layers.reinsertVectorLayer(st.layer);
    // Lowest index first per parent: each node lands exactly where it was once its lower siblings are back.
    for (const { node, parent, index } of st.nodes) {
        if (node.parent) continue;
        parent.addChild(node);
        const kids = parent.children;
        kids.splice(kids.indexOf(node), 1);
        kids.splice(Math.min(index, kids.length), 0, node);
        deps.onAttached?.(node);
    }
    deps.placements.restorePlacementsForLayer(layerId, st.placements);
    deps.changed(layerId);
}

/**
 * Remove vector layer `layerId` together with its shapes and ephemera placements, as ONE undo step.
 * Returns false (and changes nothing) when `layerId` is not a vector layer.
 */
export function removeVectorLayerWithContent(deps: VectorLayerRemovalDeps, layerId: string): boolean {
    let state = detach(deps, layerId);
    if (!state) return false;
    deps.undo?.pushCommand({
        description: 'Remove vector layer',
        undo: () => { if (state) reattach(deps, layerId, state); },
        redo: () => { state = detach(deps, layerId) ?? state; },
    });
    return true;
}

/**
 * Load-time repair: every vector shape / placement whose layer id names NO layer in the stack gets a vector layer
 * back under that same id, named "Recovered shapes" (numbered when there are several). Ids that name a layer of
 * another kind are left alone. Returns the recovered ids (empty = nothing was orphaned).
 */
export function recoverOrphanedVectorContent(
    deps: Pick<VectorLayerRemovalDeps, 'root' | 'layers' | 'placements' | 'isVectorNode'>,
    name = 'Recovered shapes',
): string[] {
    const known = new Set(deps.layers.getLayers().map(l => l.id));
    const orphanIds: string[] = [];
    const note = (id: string | undefined): void => {
        if (id && !known.has(id) && !orphanIds.includes(id)) orphanIds.push(id);
    };
    const visit = (parent: Node): void => {
        for (const child of parent.children) {
            if (child.layerId !== undefined && deps.isVectorNode(child)) note(child.layerId);
            visit(child);
        }
    };
    visit(deps.root);
    for (const [layerId, list] of deps.placements.getAllPlacements()) if (list.length) note(layerId);
    orphanIds.forEach((id, i) => deps.layers.addVectorLayerWithId(id, orphanIds.length > 1 ? `${name} ${i + 1}` : name, { visible: true }));
    return orphanIds;
}
