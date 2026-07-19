// The SceneGraph class holds a root Node that can have child nodes (shapes), creating a tree structure.

import { Node } from '../shapes/base/node';
import { Shape } from '../shapes/base/shape';

export class SceneGraph {
    public root: Node;
    /** O(1) lookup map: shape.id → Node */
    private nodeMap: Map<string, Node> = new Map();

    constructor() {
        this.root = new Node(); // Root node with the specified render strategy
        // §3.5: attach this graph as the root's node registry so Node.addChild/removeChild
        // keep the id→node map warm (register on attach, unregister on detach) and
        // findNodeById stays O(1) instead of degrading to a full-tree walk.
        this.root._nodeRegistry = this;
    }

    /** Register a node in the lookup map (call when adding to the tree) */
    public registerNode(node: Node): void {
        if ((node as Shape).id) {
            this.nodeMap.set((node as Shape).id, node);
        }
    }

    /** Unregister a node from the lookup map (call when removing from the tree) */
    public unregisterNode(node: Node): void {
        if ((node as Shape).id) {
            this.nodeMap.delete((node as Shape).id);
        }
    }

    toJSON() {
        return { root: this.root.toJSON() }; // Return as an object, not a string
    }

    findNodeById(id: string): Node | null {
        // O(1) map lookup, fallback to tree walk if not registered.
        // Validate the cached entry's id still matches the key — setId() after
        // registration would otherwise serve a stale mapping (walk fallback re-finds).
        const cached = this.nodeMap.get(id);
        if (cached && (cached as Shape).id === id) return cached;

        let result: Node | null = null;
        this.root.forEachDeep((node: Node) => { 
            if ((node as Shape).id === id) {
                result = node;
                this.nodeMap.set(id, node); // cache for future lookups
            }
        });

        return result;
    }
}