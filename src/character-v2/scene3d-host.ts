/**
 * The app's CharacterV2Host — Character v2 on Scene3DManager's PUBLIC API only (createRiggedFromResult3D + the usual
 * default-animation / pose / container / undo / character-scale calls). Kept out of shape-manager.ts so that file only
 * gains a namespace. Review fixes (docs/specs/character-v2.md "body-v2@2 review fixes, G4"): stable ids, the rig save,
 * undoable delete / duplicate through the engine's character-provider hook, the Play-aware height, the outline.
 */
import type { Scene3DManager } from '../services/managers/scene3d-manager';
import type { CharacterV2Host } from './character-v2';

export function scene3dCharacterV2Host(s: Scene3DManager): CharacterV2Host {
  return {
    createRigged: (r, x, y, z, name, opts) => s.createRiggedFromResult3D(r, x, y, z, name, opts),
    setupRig: async (_mesh, skel) => {
      // As a new v1 body: the default idle / personality clips + pose library, and the Relaxed stance. (The disabled
      // limb IK chains are seeded by the manager AFTER this, in the character's own frame, from the relaxed pose.)
      s.installDefaultAnimations(skel.id);
      await s.applyBodyPose3D(skel.id, 'Relaxed');
    },
    installDefaults: (skel) => { s.installDefaultAnimations(skel.id); },
    serializeRig: (skel) => s.serializeSkeletonForSave(skel) as Record<string, unknown>,
    createMarker: (name) => s.createCityContainer(name),
    removeMarker: (g) => s.removeFlatColorMeshGroup(g),
    removeCharacter: (mesh, skel) => s.removeRigged3D(mesh, skel),
    detachCharacter: (mesh, skel) => s.detachRigged3D(mesh, skel),
    attachCharacter: (mesh, skel, parent, opts) => s.attachRigged3D(mesh, skel, parent as Parameters<Scene3DManager['attachRigged3D']>[2], opts),
    getRootMeshGroups: () => s.getRootMeshGroups(),
    findGroup: (id) => s.getMeshGroup(id),
    isIdTaken: (id) => !!(s.getMesh(id) || s.getSkeleton(id) || s.getMeshGroup(id)),
    sceneMetresPerUnit: () => s.getSceneMetresPerUnit3D(),
    requestRender: () => s.requestRender3D(),
    pushUndo: (cmd) => s.pushCommand3D(cmd),
    undoTop: () => s.undoDescription3D,
    // Height through the engine's character scale: feet kept, the Play snapshot patched (Stop keeps the new height),
    // the running avatar re-measured / re-framed. Not an undo step of its own (the slider step is).
    setCharacterScale: (mesh, scale) => {
      if (!s.setCharacterScale3D(mesh.id, scale, { undo: false })) { const f = scale / (Math.abs(mesh.scaleY) || 1); mesh.setScale3D(mesh.scaleX * f, mesh.scaleY * f, mesh.scaleZ * f); }
    },
    refreshPlayAvatar: (mesh, restDelta) => { s.refreshPlayerAvatar3D(mesh.id, restDelta); },
    restoreOutline: (mesh, outline, rings) => {
      s.restoreMeshOutline3D(mesh.id, { outline: outline as Parameters<Scene3DManager['restoreMeshOutline3D']>[1]['outline'], outlineRings: rings as Parameters<Scene3DManager['restoreMeshOutline3D']>[1]['outlineRings'] });
    },
    applyCharacterOutline: (mesh) => { s.applyCharacterOutline3D(mesh.id); },
    registerProvider: (p) => { s.registerCharacterProvider3D(p); },
  };
}
