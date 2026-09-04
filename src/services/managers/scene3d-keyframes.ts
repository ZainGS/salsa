/**
 * Scene3DKeyframes — the per-mesh keyframe DATA API, extracted from Scene3DManager.
 *
 * Owns the transform + blend-shape-weight keyframe tracks that live on `Mesh3D.keyframeTracks`: set/remove/clear
 * (each undoable), the read accessors, and the timeline-UI query helpers (which frames have keys, dope-sheet rows).
 * Pure data operations over mesh state — no GPU, no playback loop, no skeleton — so it unit-tests with a mock ctx.
 *
 * Scope note: camera keyframes (a `_cameraKeyframeTracks` field headed for Scene3DCameraViewport), the timeline
 * playback binding, FLA (frame-link, coupled to cloth/ribbon), NLA, and skeleton clip / IK keyframes stay on the
 * manager — those are the coupled seams. Keeping to the mesh-track data core means there is no FLA↔apply seam to
 * cut here. Scene3DManager keeps thin delegating methods so the public API and every caller are unchanged.
 */

import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import {
  Mesh3DKeyframeTracks, TrackName, KeyframeEasing, Keyframe,
  setKeyframe, removeKeyframe, cloneKeyframeValue, cloneKeyframeTracks,
} from '../../types/keyframe-3d';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';

/** Narrow host surface — everything Scene3DKeyframes needs from the parent manager beyond the shared ctx. */
export interface Scene3DKeyframesHost {
  getMesh(id: string): Mesh3D | null;
  getAllMeshes(): Mesh3D[];
  pushUndo(cmd: Command3D): void;
}

export class Scene3DKeyframes {
  constructor(
    private readonly _ctx: ManagerContext,
    private readonly host: Scene3DKeyframesHost,
  ) {}

  setMeshKeyframe(
    meshId: string,
    property: TrackName,
    frame: number,
    value: unknown,
    easing: KeyframeEasing = 'linear',
  ): boolean {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return false;
    if (!mesh.keyframeTracks[property]) (mesh.keyframeTracks as Record<string, unknown>)[property] = [];
    const track = (mesh.keyframeTracks as Record<string, Keyframe<unknown>[]>)[property];

    // Capture before-state for undo
    const existing = track.find((kf) => kf.frame === frame);
    const beforeValue = existing ? cloneKeyframeValue(existing.value) : undefined;
    const beforeEasing: KeyframeEasing | undefined = existing?.easing;

    setKeyframe(track, frame, value, easing);
    mesh.stateDirty = true;

    this.host.pushUndo({
      description: `Set keyframe: ${property} @ ${frame}`,
      undo: () => {
        const t = (mesh.keyframeTracks as Record<string, Keyframe<unknown>[]>)[property];
        if (t) {
          if (beforeValue === undefined) {
            removeKeyframe(t, frame);
          } else {
            setKeyframe(t, frame, cloneKeyframeValue(beforeValue), beforeEasing!);
          }
          mesh.stateDirty = true;
        }
      },
      redo: () => {
        if (!(mesh.keyframeTracks as Record<string, unknown>)[property]) (mesh.keyframeTracks as Record<string, unknown>)[property] = [];
        setKeyframe((mesh.keyframeTracks as Record<string, Keyframe<unknown>[]>)[property], frame, cloneKeyframeValue(value), easing);
        mesh.stateDirty = true;
      },
    });
    return true;
  }

  removeMeshKeyframe(meshId: string, property: TrackName, frame: number): boolean {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return false;
    const track = (mesh.keyframeTracks as Record<string, Keyframe<unknown>[]>)[property];
    if (!track) return false;

    // Capture before removal for undo
    const existing = track.find((kf) => kf.frame === frame);
    if (!existing) return false;
    const savedValue = cloneKeyframeValue(existing.value);
    const savedEasing: KeyframeEasing = existing.easing;

    const removed = removeKeyframe(track, frame);
    if (removed) {
      mesh.stateDirty = true;
      this.host.pushUndo({
        description: `Remove keyframe: ${property} @ ${frame}`,
        undo: () => {
          if (!(mesh.keyframeTracks as Record<string, unknown>)[property]) (mesh.keyframeTracks as Record<string, unknown>)[property] = [];
          setKeyframe((mesh.keyframeTracks as Record<string, Keyframe<unknown>[]>)[property], frame, cloneKeyframeValue(savedValue), savedEasing);
          mesh.stateDirty = true;
        },
        redo: () => {
          const t = (mesh.keyframeTracks as Record<string, Keyframe<unknown>[]>)[property];
          if (t) { removeKeyframe(t, frame); mesh.stateDirty = true; }
        },
      });
    }
    return removed;
  }

  getMeshKeyframeTracks(meshId: string): Mesh3DKeyframeTracks | null {
    return this.host.getMesh(meshId)?.keyframeTracks ?? null;
  }

  clearMeshKeyframeTracks(meshId: string): boolean {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return false;

    // Deep-copy tracks before clearing for undo (typed per-track clone, not a JSON round-trip)
    const savedTracks = cloneKeyframeTracks(mesh.keyframeTracks);
    mesh.keyframeTracks = {};
    mesh.stateDirty = true;

    this.host.pushUndo({
      description: 'Clear keyframe tracks',
      undo: () => {
        mesh.keyframeTracks = cloneKeyframeTracks(savedTracks);
        mesh.stateDirty = true;
      },
      redo: () => {
        mesh.keyframeTracks = {};
        mesh.stateDirty = true;
      },
    });
    return true;
  }

  // ── Blend shape weight keyframes ─────────────────────────────────

  setBlendShapeKeyframe(meshId: string, shapeName: string, frame: number, weight: number, easing: KeyframeEasing = 'linear'): boolean {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return false;
    if (!mesh.keyframeTracks.blendWeights) mesh.keyframeTracks.blendWeights = {};
    if (!mesh.keyframeTracks.blendWeights[shapeName]) mesh.keyframeTracks.blendWeights[shapeName] = [];
    const track = mesh.keyframeTracks.blendWeights[shapeName];

    const existing = track.find(kf => kf.frame === frame);
    const beforeValue = existing?.value;
    const beforeEasing = existing?.easing;

    setKeyframe(track, frame, weight, easing);
    mesh.stateDirty = true;

    this.host.pushUndo({
      description: `Set blend shape keyframe: ${shapeName} @ ${frame}`,
      undo: () => {
        const t = mesh.keyframeTracks.blendWeights?.[shapeName];
        if (t) {
          if (beforeValue === undefined) removeKeyframe(t, frame);
          else setKeyframe(t, frame, beforeValue, beforeEasing!);
          mesh.stateDirty = true;
        }
      },
      redo: () => {
        if (!mesh.keyframeTracks.blendWeights) mesh.keyframeTracks.blendWeights = {};
        if (!mesh.keyframeTracks.blendWeights[shapeName]) mesh.keyframeTracks.blendWeights[shapeName] = [];
        setKeyframe(mesh.keyframeTracks.blendWeights[shapeName], frame, weight, easing);
        mesh.stateDirty = true;
      },
    });
    return true;
  }

  removeBlendShapeKeyframe(meshId: string, shapeName: string, frame: number): boolean {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return false;
    const track = mesh.keyframeTracks.blendWeights?.[shapeName];
    if (!track) return false;

    const existing = track.find(kf => kf.frame === frame);
    if (!existing) return false;
    const savedValue = existing.value;
    const savedEasing = existing.easing;

    const removed = removeKeyframe(track, frame);
    if (removed) {
      mesh.stateDirty = true;
      this.host.pushUndo({
        description: `Remove blend shape keyframe: ${shapeName} @ ${frame}`,
        undo: () => {
          if (!mesh.keyframeTracks.blendWeights) mesh.keyframeTracks.blendWeights = {};
          if (!mesh.keyframeTracks.blendWeights[shapeName]) mesh.keyframeTracks.blendWeights[shapeName] = [];
          setKeyframe(mesh.keyframeTracks.blendWeights[shapeName], frame, savedValue, savedEasing);
          mesh.stateDirty = true;
        },
        redo: () => {
          const t = mesh.keyframeTracks.blendWeights?.[shapeName];
          if (t) { removeKeyframe(t, frame); mesh.stateDirty = true; }
        },
      });
    }
    return removed;
  }

  getBlendShapeKeyframeTracks(meshId: string): Record<string, Keyframe<number>[]> | null {
    const mesh = this.host.getMesh(meshId);
    return mesh?.keyframeTracks.blendWeights ?? null;
  }

  // ── Keyframe query helpers (for timeline UI) ─────────────────────

  /** Returns the set of frame numbers where ANY track on this mesh has a keyframe. Use this to draw per-frame
   *  markers in the animation timeline UI. */
  getMeshKeyframeFrames(meshId: string): number[] {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return [];
    const frames = new Set<number>();
    for (const [key, track] of Object.entries(mesh.keyframeTracks)) {
      if (Array.isArray(track)) {
        for (const kf of track) frames.add(kf.frame);
      } else if (key === 'blendWeights' && track && typeof track === 'object') {
        for (const shapeTrack of Object.values(track as Record<string, Keyframe<number>[]>)) {
          for (const kf of shapeTrack) frames.add(kf.frame);
        }
      }
    }
    return Array.from(frames).sort((a, b) => a - b);
  }

  /** Returns true if the mesh has a keyframe on any track at exactly `frame`. */
  hasMeshKeyframeAtFrame(meshId: string, frame: number): boolean {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return false;
    for (const [key, track] of Object.entries(mesh.keyframeTracks)) {
      if (Array.isArray(track) && track.some(kf => kf.frame === frame)) return true;
      if (key === 'blendWeights' && track && typeof track === 'object') {
        for (const shapeTrack of Object.values(track as Record<string, Keyframe<number>[]>)) {
          if (shapeTrack.some(kf => kf.frame === frame)) return true;
        }
      }
    }
    return false;
  }

  /** Returns a flat list of every Mesh3D in the scene with id and name. Use this to populate the animation panel's
   *  mesh rows — it includes meshes nested inside groups. */
  getAllMeshesForAnimation(): { id: string; name: string }[] {
    return this.host.getAllMeshes().map(m => ({ id: m.id, name: m.name }));
  }

  /** Returns keyframe track data for every mesh in the scene. Use this to build per-mesh dope-sheet rows in the
   *  animation panel. Each entry's `tracks` object has the same shape as getMeshKeyframeTracks(). */
  getAllMeshKeyframeTracks(): { meshId: string; name: string; tracks: Mesh3DKeyframeTracks }[] {
    return this.host.getAllMeshes().map(m => ({
      meshId: m.id,
      name: m.name,
      tracks: m.keyframeTracks,
    }));
  }
}
