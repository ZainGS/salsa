/**
 * Scene3DPrimitives — the CPU mesh-creation surface, extracted from Scene3DManager.
 *
 * Owns the shared `create()` factory (was `Scene3DManager.createMesh`) plus every param-driven primitive builder
 * (box / sphere / plane / cylinder / torus / custom / editable polygon + circle) and OBJ import. These are pure
 * "params → Mesh3D → scene graph" operations: build the mesh, parent it, select it, push one undo entry.
 *
 * Scope note: GPU-texture-coupled GLTF/GLB import (morph targets, texture upload) and the array/city-emit helpers
 * stay on the manager for now — they belong to later extractions (Scene3DImport / Scene3DArrays). This subsystem
 * is deliberately GPU-free so it unit-tests with a mock ctx, like Scene3DModifiers/Scene3DParticles.
 *
 * Dependencies beyond the shared ctx are a narrow host: undo push + the two illustration-viewport hooks the factory
 * consults (default canvas scale + camera re-apply), which will collapse to direct calls once Scene3DCameraViewport
 * is extracted. Scene3DManager keeps thin delegating methods so the public API and every internal caller (ribbon
 * host, slab/sprite helpers) are unchanged.
 */

import { Mesh3D, Mesh3DConfig } from '../../scene-graph/shapes/mesh-3d';
import { Material3D } from '../../renderer/3d/material-3d';
import { MeshGeometry } from '../../renderer/3d/mesh-generators';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { parseOBJ } from '../../renderer/3d/obj-importer';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';

/** Narrow host surface — everything Scene3DPrimitives needs from the parent manager beyond the shared ctx. */
export interface Scene3DPrimitivesHost {
  pushUndo(cmd: Command3D): void;
  /** True while the 3D scene is synced to an illustration canvas (drives auto-scale + camera re-apply on create). */
  isIllustrationSync(): boolean;
  /** Default world-scale for a primitive so it reads ~100px on the illustration canvas at the current zoom. */
  illustrationMeshDefaultScale(): number;
  /** Re-apply the illustration camera (no-op when not illustration-synced). */
  applyIllustrationCamera(): void;
}

export class Scene3DPrimitives {
  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DPrimitivesHost,
  ) {}

  /** The shared mesh factory: build a Mesh3D from a config, parent it under the scene root, select it, and push
   *  a single 'Create mesh' undo entry. Every primitive builder below funnels through here. */
  create(x: number, y: number, z: number, config: Mesh3DConfig): Mesh3D {
    const mesh = new Mesh3D(this.ctx.interactionService, x, y, z, config);

    // In illustration mode 1 world unit = 1 canvas pixel (at zoom=1). Auto-scale primitive meshes so they appear a
    // reasonable size (~100px) on the canvas. Custom geometry (GLTF/OBJ imports) is left at its original scale.
    if (this.host.isIllustrationSync() && config.primitive !== 'custom') {
      const s = this.host.illustrationMeshDefaultScale();
      mesh.setScale3D(s, s, s);
    }

    const parent = this.ctx.sceneGraph.root;
    parent.addChild(mesh);
    this.ctx.emitSceneGraphChanged();
    this.ctx.setSelectedNode(mesh.id);
    this.ctx.webgpuRenderer.getRenderer3D().setSelectedMeshIds(new Set([mesh.id]));

    // If the illustration camera sync params are available, re-apply the camera now. This handles the case where
    // the renderer hasn't been initialized yet (no pan/zoom this session), ensuring it's created with the correct
    // camera position rather than the default (0,0,3) which would frustum-cull canvas-placed meshes.
    if (this.host.isIllustrationSync()) this.host.applyIllustrationCamera();

    this.ctx.scheduleRender();

    this.host.pushUndo({
      description: 'Create mesh',
      undo: () => {
        mesh.parent?.removeChild(mesh);
        this.ctx.emitSceneGraphChanged();
      },
      redo: () => {
        parent.addChild(mesh);
        mesh.gpuDirty = true;
        this.ctx.emitSceneGraphChanged();
      },
    });

    return mesh;
  }

  box(x: number, y: number, z: number, width = 1, height = 1, depth = 1, material?: Partial<Material3D>): Mesh3D {
    return this.create(x, y, z, { primitive: 'box', width, height, depth, material });
  }

  sphere(x: number, y: number, z: number, radius = 0.5, segments = 16, material?: Partial<Material3D>): Mesh3D {
    return this.create(x, y, z, { primitive: 'sphere', radius, widthSegments: segments, heightSegments: Math.max(2, segments * 0.75 | 0), material });
  }

  plane(x: number, y: number, z: number, width = 1, height = 1, material?: Partial<Material3D>): Mesh3D {
    return this.create(x, y, z, { primitive: 'plane', width, height, material });
  }

  cylinder(x: number, y: number, z: number, radius = 0.5, height = 1, radialSegments = 16, material?: Partial<Material3D>): Mesh3D {
    return this.create(x, y, z, { primitive: 'cylinder', radius, height, radialSegments, material });
  }

  torus(x: number, y: number, z: number, radius = 0.5, tubeRadius = 0.2, material?: Partial<Material3D>): Mesh3D {
    return this.create(x, y, z, { primitive: 'torus', radius, tubeRadius, material });
  }

  custom(x: number, y: number, z: number, geometry: MeshGeometry, material?: Partial<Material3D>): Mesh3D {
    return this.create(x, y, z, { primitive: 'custom', geometry, material });
  }

  /** Create an editable polygon mesh from a 2D silhouette in the XZ plane. The mesh is created with an EditMesh
   *  pre-attached — no makeEditable() needed. */
  polygon(x: number, y: number, z: number, points: [number, number][], height = 1, name?: string, material?: Partial<Material3D>): Mesh3D {
    const em = EditMesh.fromPolygon(points, height);
    const geom = em.compile();
    const mesh = this.create(x, y, z, { primitive: 'custom', geometry: geom, material });
    mesh.editMesh = em;
    mesh.vertexColors = geom.vertexColors ?? null;
    if (name) mesh.name = name;
    return mesh;
  }

  /** Create an editable circle (regular n-gon) mesh extruded along Y. Convenience wrapper around polygon(). */
  circle(x: number, y: number, z: number, radius = 0.5, segments = 8, height = 1, name?: string, material?: Partial<Material3D>): Mesh3D {
    const em = EditMesh.fromCircle(radius, segments, height);
    const geom = em.compile();
    const mesh = this.create(x, y, z, { primitive: 'custom', geometry: geom, material });
    mesh.editMesh = em;
    mesh.vertexColors = geom.vertexColors ?? null;
    if (name) mesh.name = name;
    return mesh;
  }

  /** Parse an OBJ string and create a Mesh3D at (x, y, z). Handles missing normals/UVs, quads, and N-gons. */
  importObjMesh(x: number, y: number, z: number, objText: string, material?: Partial<Material3D>): Mesh3D {
    const geometry = parseOBJ(objText);
    return this.create(x, y, z, { primitive: 'custom', geometry, material });
  }

  /** Read a .obj File/Blob and create a Mesh3D at (x, y, z). Suitable for drag-and-drop or file-picker input. */
  async importObjFile(x: number, y: number, z: number, file: File | Blob, material?: Partial<Material3D>): Promise<Mesh3D> {
    const text = await file.text();
    return this.importObjMesh(x, y, z, text, material);
  }
}
