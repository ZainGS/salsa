// The SceneGraph class holds a root Node that can have child nodes (shapes), creating a tree structure.

import { Node } from '../shapes/base/node';
import { Shape } from '../shapes/base/shape';

export class SceneGraph {
    public root: Node;

    constructor() {
        this.root = new Node(); // Root node with the specified render strategy
    }

    toJSON() {
        return { root: this.root.toJSON() }; // Return as an object, not a string
    }

    findNodeById(id: string): Node | null {
        let result: Node | null = null;

        this.root.forEachDeep((node: Node) => { 
            if ((node as Shape).id === id) {
            result = node;
            }
        });

        return result;
    }
}