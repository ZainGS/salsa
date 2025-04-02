// The SceneGraph class holds a root Node that can have child nodes (shapes), creating a tree structure.

import { Node } from '../shapes/base/node';

export class SceneGraph {
    public root: Node;

    constructor() {
        this.root = new Node(); // Root node with the specified render strategy
    }

    toJSON() {
        return { root: this.root.toJSON() }; // Return as an object, not a string
    }
}