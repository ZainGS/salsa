// The SceneGraph class holds a root Node that can have child nodes (shapes), creating a tree structure.

import { Node } from '../shapes/base/node';
import { Shape } from '../shapes/base/shape';

export class SceneGraph {
    public root: Node;
    /** O(1) lookup map: shape.id → Node */
    private nodeMap: Map<string, Node> = new Map();

    constructor() {
        this.root = new Node(); // Root node with the specified render strategy
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
        // O(1) map lookup, fallback to tree walk if not registered
        const cached = this.nodeMap.get(id);
        if (cached) return cached;

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