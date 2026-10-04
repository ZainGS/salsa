import { describe, it, expect } from 'vitest';
import { RenderListIndex, fullRescan, RL_2D, RL_3D, RL_SKELETON, type RenderListNode } from './render-list-index';

// A minimal scene node: kind decides the list (as the renderer's classify does by class).
type Kind = 'group' | 'shape' | 'mesh' | 'skel' | 'none';
interface TNode extends RenderListNode { id: number; kind: Kind; children: TNode[]; parent: TNode | null }
let nextId = 1;
const mk = (kind: Kind, zIndex = 0): TNode => ({ id: nextId++, kind, zIndex, children: [], parent: null, _rlGen: 0, _rlPos: 0 });
const add = (p: TNode, c: TNode, at = p.children.length): void => { c.parent = p; p.children.splice(at, 0, c); };
const remove = (c: TNode): void => { const p = c.parent!; p.children.splice(p.children.indexOf(c), 1); c.parent = null; };
const classify = (n: TNode): number => n.kind === 'shape' ? RL_2D : n.kind === 'mesh' ? RL_3D : n.kind === 'skel' ? RL_SKELETON : n.kind === 'group' ? RL_2D : 0;

// Deterministic PRNG.
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function allNodes(root: TNode): TNode[] { const out: TNode[] = []; const v = (n: TNode) => { out.push(n); n.children.forEach(v); }; v(root); return out; }

function randomTree(r: () => number, n: number): TNode {
  const root = mk('none');
  const nodes = [root];
  for (let i = 0; i < n; i++) {
    const k: Kind = r() < 0.15 ? 'group' : r() < 0.7 ? 'mesh' : r() < 0.95 ? 'shape' : 'skel';
    const node = mk(k, Math.floor(r() * 20));   // many zIndex ties (like the city)
    const parents = nodes.filter((x) => x.kind === 'group' || x.kind === 'none');
    add(parents[Math.floor(r() * parents.length)], node);
    nodes.push(node);
  }
  return root;
}

const ids = (a: TNode[]) => a.map((n) => n.id);
function expectMatches(idx: RenderListIndex<TNode>, root: TNode): void {
  expect(ids(idx.flat2D)).toEqual(ids(fullRescan(root, classify, RL_2D)));
  expect(ids(idx.flat3D)).toEqual(ids(fullRescan(root, classify, RL_3D)));
  expect(ids(idx.skeletons)).toEqual(ids(allNodes(root).filter((n) => n.kind === 'skel')));
}

describe('RenderListIndex (step 2 incremental render list)', () => {
  it('a first walk equals the full rescan (preorder + stable zIndex sort)', () => {
    const root = randomTree(rng(1), 400);
    const idx = new RenderListIndex<TNode>(classify);
    idx.walk(root);
    expectMatches(idx, root);
  });

  it('adds, removes and reparents stay identical to the full rescan, and take the merge path', () => {
    const r = rng(7);
    const root = randomTree(r, 2000);
    const idx = new RenderListIndex<TNode>(classify);
    idx.walk(root);
    for (let step = 0; step < 60; step++) {
      const nodes = allNodes(root).slice(1);
      const op = r();
      if (op < 0.4) {               // add a few nodes (a crowd cell: a group with meshes)
        const g = mk('group', Math.floor(r() * 20));
        for (let i = 0; i < 1 + Math.floor(r() * 8); i++) add(g, mk(r() < 0.8 ? 'mesh' : 'shape', Math.floor(r() * 20)));
        const parents = [root, ...nodes.filter((x) => x.kind === 'group')];
        const p = parents[Math.floor(r() * parents.length)];
        add(p, g, Math.floor(r() * (p.children.length + 1)));
      } else if (op < 0.75) {       // remove a node (with its subtree)
        remove(nodes[Math.floor(r() * nodes.length)]);
      } else {                      // reparent a node to another group
        const n = nodes[Math.floor(r() * nodes.length)];
        const targets = [root, ...nodes.filter((x) => x.kind === 'group' && !allNodes(n).includes(x))];
        remove(n);
        const p = targets[Math.floor(r() * targets.length)];
        add(p, n, Math.floor(r() * (p.children.length + 1)));
      }
      idx.walk(root);
      expectMatches(idx, root);
    }
    expect(idx.stats.merged).toBeGreaterThan(idx.stats.fullSorts);
  });

  it('a zIndex edit between walks falls back to the full sort and still matches', () => {
    const root = randomTree(rng(3), 500);
    const idx = new RenderListIndex<TNode>(classify);
    idx.walk(root);
    const meshes = allNodes(root).filter((n) => n.kind === 'mesh');
    meshes[3].zIndex = 99; meshes[10].zIndex = -5;
    const full0 = idx.stats.fullSorts;
    idx.walk(root);
    expectMatches(idx, root);
    expect(idx.stats.fullSorts).toBeGreaterThan(full0);
  });

  it('a list re-sorted in place between walks (the renderer\'s zIndex repair) is still handled', () => {
    const root = randomTree(rng(11), 300);
    const idx = new RenderListIndex<TNode>(classify);
    idx.walk(root);
    const m = allNodes(root).filter((n) => n.kind === 'mesh');
    m[0].zIndex = 50;
    idx.flat3D.sort((a, b) => a.zIndex - b.zIndex);   // like rebuildRenderListIfNeeded's repair
    add(root, mk('mesh', 2));
    idx.walk(root);
    expectMatches(idx, root);
  });

  it('a node reached twice in one walk takes the full sort (no dedup — the old flat list kept both)', () => {
    const root = mk('none');
    const g1 = mk('group'), g2 = mk('group'), shared = mk('mesh', 1);
    add(root, g1); add(root, g2); add(g1, shared); g2.children.push(shared);
    const idx = new RenderListIndex<TNode>(classify);
    idx.walk(root); idx.walk(root);
    expect(ids(idx.flat3D)).toEqual(ids(fullRescan(root, classify, RL_3D)));
    expect(idx.flat3D.length).toBe(2);
  });

  it('incremental=false always re-sorts (the A/B reference) with the same result', () => {
    const r = rng(5);
    const root = randomTree(r, 800);
    const a = new RenderListIndex<TNode>(classify), b = new RenderListIndex<TNode>(classify);
    b.incremental = false;
    for (let i = 0; i < 10; i++) {
      add(root, mk('mesh', Math.floor(r() * 20)), 0);
      a.walk(root); b.walk(root);
      expect(ids(a.flat3D)).toEqual(ids(b.flat3D));
      expect(ids(a.flat2D)).toEqual(ids(b.flat2D));
    }
    expect(b.stats.merged).toBe(0);
  });

  it('inherits renderBelowRaster for the 3D list flag', () => {
    const root = mk('none');
    const panel = mk('group'); panel.renderBelowRaster = true;
    add(root, panel); add(panel, mk('mesh'));
    const idx = new RenderListIndex<TNode>(classify);
    idx.walk(root);
    expect(idx.any3DBelowRaster).toBe(true);
    remove(panel); add(root, mk('mesh'));
    idx.walk(root);
    expect(idx.any3DBelowRaster).toBe(false);
  });

  it('two indexes over the same nodes do not confuse each other', () => {
    const root = randomTree(rng(9), 300);
    const a = new RenderListIndex<TNode>(classify), b = new RenderListIndex<TNode>(classify);
    a.walk(root); b.walk(root);
    add(root, mk('mesh', 3));
    a.walk(root);
    remove(root.children[0]);
    b.walk(root); a.walk(root);
    expectMatches(a, root); expectMatches(b, root);
  });
});
