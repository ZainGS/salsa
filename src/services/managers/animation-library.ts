/**
 * AnimationLibrary — a reusable, cross-skeleton store of authored clips + poses (spec
 * docs/specs/animation-library-and-triggers.md, Phase A). The Godot `AnimationLibrary` model: author a
 * clip once in Armature Mode, PROMOTE it here (lifted out of its skeleton), then APPLY it to any other
 * skeleton via joint-name retargeting (anim-retarget.ts). Skeletons stay self-contained — promote/apply
 * are deep copies (assign-by-value), so nothing about skeleton persistence/undo changes.
 *
 * GPU-free and unit-testable: all scene access goes through an injected `AnimationLibraryHost`. Mirrors
 * Scene3DGrouping's host-interface pattern. The facade (Scene3DManager) builds the host from its own APIs.
 */

import type { SkeletonAnimClip, SkeletonKeyframeTrack, SkeletonPose, AnimRegion } from '../../types/armature-3d';
import {
  type NamedJoint, retargetClipTracks, retargetPoseRotations, clipAnimatedJointNames, clipCompatibility, classifyRig,
} from './anim-retarget';

/** One library entry — a clip (or pose) lifted out of any particular skeleton. */
export interface AnimLibraryEntry {
  id: string;                    // fresh UUID (NEVER the source clip/pose id)
  name: string;                  // unique within the library (promote dedupes → "Walk (2)")
  kind: 'clip' | 'pose';
  clip?: SkeletonAnimClip;       // kind 'clip' — deep copy; tracks still keyed by the SOURCE rig's joint indices
  pose?: SkeletonPose;           // kind 'pose'
  /** Minimal {index,name} snapshot of the SOURCE rig — lets an entry retarget after its skeleton is gone
   *  (the clip/pose tracks reference source indices; this resolves index→name). */
  sourceJoints: NamedJoint[];
  jointManifest: string[];       // distinct joint NAMES the entry animates (compat display)
  sourceRig?: string;            // informational (skeleton name)
  /** Coarse rig classification ('humanoid' | 'generic' | …) — a filter/grouping LABEL, auto-derived from the
   *  source skeleton's joint signature at promote, author-overridable. NOT the compatibility gate: use
   *  `compatibility()`/jointManifest for the precise per-rig check. */
  rigType?: string;
  tags?: string[];               // host filtering, e.g. ['locomotion']
  defaultLoop?: boolean;         // hint for apply/play UIs
}

export interface AnimationLibraryData { version: 1; entries: AnimLibraryEntry[]; }

/** Everything the library needs from the scene (GPU-free surface). */
export interface AnimationLibraryHost {
  /** Resolve a clip id → its clip + the owning skeleton's joints + skeleton name. */
  findClip(clipId: string): { clip: SkeletonAnimClip; joints: NamedJoint[]; rig?: string } | null;
  /** Resolve a pose on a skeleton → pose + that skeleton's joints + skeleton name. */
  findPose(skeletonId: string, poseId: string): { pose: SkeletonPose; joints: NamedJoint[]; rig?: string } | null;
  /** The target skeleton's joints, or null if the id is not a skeleton. */
  skeletonJoints(skeletonId: string): NamedJoint[] | null;
  /** Create a clip on the target skeleton from already-remapped tracks → new clip id ('' = fail). */
  createClip(skeletonId: string, name: string, fps: number, endFrame: number, tracks: SkeletonKeyframeTrack[], region?: AnimRegion): string;
  /** Add a pose (already-remapped rotations) to the target skeleton → new pose id ('' = fail). */
  addPose(skeletonId: string, name: string, rotations: { jointIndex: number; rotation: [number, number, number, number] }[], region?: AnimRegion): string;
}

function uuid(): string {
  try { return (globalThis as { crypto?: { randomUUID?(): string } }).crypto?.randomUUID?.() ?? `al_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; }
  catch { return `al_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; }
}

export class AnimationLibrary {
  private _entries = new Map<string, AnimLibraryEntry>();

  constructor(private readonly host: AnimationLibraryHost) {}

  // ── queries ──────────────────────────────────────────────────────
  list(): AnimLibraryEntry[] { return [...this._entries.values()].map(cloneEntry); }
  get(entryId: string): AnimLibraryEntry | null { const e = this._entries.get(entryId); return e ? cloneEntry(e) : null; }
  get size(): number { return this._entries.size; }

  /** Unique-ify a proposed name against the current entries: "Walk" → "Walk (2)" → "Walk (3)". */
  private _uniqueName(base: string): string {
    const taken = new Set([...this._entries.values()].map((e) => e.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) { const c = `${base} (${n})`; if (!taken.has(c)) return c; }
  }

  // ── promote (author → library) ───────────────────────────────────
  /** Lift a clip out of whatever skeleton owns it into the library. Returns the new entry id, or null. */
  addClip(clipId: string, opts: { name?: string; tags?: string[]; rigType?: string } = {}): string | null {
    const entry = this.buildClipEntry(clipId, opts);
    if (!entry) return null;
    entry.name = this._uniqueName(entry.name);   // dedupe only when actually storing in THIS library
    this._entries.set(entry.id, entry);
    return entry.id;
  }

  /** Lift a pose out of a skeleton into the library. Returns the new entry id, or null. */
  addPose(skeletonId: string, poseId: string, opts: { name?: string; tags?: string[]; rigType?: string } = {}): string | null {
    const entry = this.buildPoseEntry(skeletonId, poseId, opts);
    if (!entry) return null;
    entry.name = this._uniqueName(entry.name);
    this._entries.set(entry.id, entry);
    return entry.id;
  }

  /** Build a clip entry OBJECT without storing it — for promoting a clip straight to the global Shared Asset Library
   *  (no doc-library pollution). Fresh ids as always; name is the raw name (the caller/global store owns dedupe). */
  buildClipEntry(clipId: string, opts: { name?: string; tags?: string[]; rigType?: string } = {}): AnimLibraryEntry | null {
    const found = this.host.findClip(clipId);
    if (!found) return null;
    const clip = deepClip(found.clip);
    clip.id = uuid();   // entry's clip gets a fresh id (never the source's)
    return {
      id: uuid(), kind: 'clip',
      name: opts.name?.trim() || found.clip.name || 'Clip',
      clip,
      sourceJoints: found.joints.map((j) => ({ index: j.index, name: j.name })),
      jointManifest: clipAnimatedJointNames(found.clip.tracks, found.joints),
      sourceRig: found.rig,
      rigType: opts.rigType ?? classifyRig(found.joints),
      tags: opts.tags,
      defaultLoop: true,
    };
  }

  /** Build a pose entry OBJECT without storing it (see {@link buildClipEntry}). */
  buildPoseEntry(skeletonId: string, poseId: string, opts: { name?: string; tags?: string[]; rigType?: string } = {}): AnimLibraryEntry | null {
    const found = this.host.findPose(skeletonId, poseId);
    if (!found) return null;
    const pose = deepPose(found.pose);
    pose.id = uuid();
    return {
      id: uuid(), kind: 'pose',
      name: opts.name?.trim() || found.pose.name || 'Pose',
      pose,
      sourceJoints: found.joints.map((j) => ({ index: j.index, name: j.name })),
      jointManifest: found.pose.rotations
        .map((r) => found.joints.find((j) => j.index === r.jointIndex)?.name)
        .filter((n): n is string => !!n),
      sourceRig: found.rig,
      rigType: opts.rigType ?? classifyRig(found.joints),
      tags: opts.tags,
    };
  }

  // ── apply (library → skeleton) ───────────────────────────────────
  /** Instantiate an entry onto a target skeleton via joint-name retarget. Returns the new clip/pose id, or
   *  null when the entry/skeleton is missing OR zero joints matched (nothing to apply). Partial matches
   *  apply and are silently accepted — use {@link compatibility} for a preflight warning. */
  apply(entryId: string, targetSkeletonId: string, opts: { rename?: string } = {}): string | null {
    return this.applyEntry(this._entries.get(entryId), targetSkeletonId, opts);
  }

  /** Apply an entry OBJECT (not necessarily in this doc library — e.g. a payload from the global Shared Asset
   *  Library) onto a target skeleton via joint-name retarget. Same semantics as {@link apply}. */
  applyEntry(entry: AnimLibraryEntry | null | undefined, targetSkeletonId: string, opts: { rename?: string } = {}): string | null {
    const tgtJoints = this.host.skeletonJoints(targetSkeletonId);
    if (!entry || !tgtJoints) return null;

    if (entry.kind === 'clip' && entry.clip) {
      const { data: tracks, matched } = retargetClipTracks(entry.clip.tracks, entry.sourceJoints, tgtJoints);
      if (matched === 0) return null;
      const id = this.host.createClip(
        targetSkeletonId, opts.rename?.trim() || entry.name, entry.clip.fps, entry.clip.endFrame, tracks, entry.clip.region);
      return id || null;
    }
    if (entry.kind === 'pose' && entry.pose) {
      const { data: rotations, matched } = retargetPoseRotations(entry.pose, entry.sourceJoints, tgtJoints);
      if (matched === 0) return null;
      const id = this.host.addPose(targetSkeletonId, opts.rename?.trim() || entry.name, rotations, entry.pose.region);
      return id || null;
    }
    return null;
  }

  /** Preflight: how many of the entry's joints land on the target skeleton (for the UI compat chip). */
  compatibility(entryId: string, targetSkeletonId: string): { matched: number; missing: string[] } | null {
    const entry = this._entries.get(entryId);
    const tgtJoints = this.host.skeletonJoints(targetSkeletonId);
    if (!entry || !tgtJoints) return null;
    const tracks = entry.kind === 'clip' ? (entry.clip?.tracks ?? [])
      : (entry.pose?.rotations ?? []).map((r) => ({ jointIndex: r.jointIndex, channel: 'rotation' as const, keyframes: [] }));
    return clipCompatibility(tracks, entry.sourceJoints, tgtJoints);
  }

  // ── bookkeeping ──────────────────────────────────────────────────
  remove(entryId: string): boolean { return this._entries.delete(entryId); }
  rename(entryId: string, name: string): boolean {
    const e = this._entries.get(entryId); if (!e) return false;
    e.name = this._uniqueName(name.trim() || e.name);
    return true;
  }
  /** Override an entry's rig-type label (author reclassification, e.g. 'creature'). */
  setRigType(entryId: string, rigType: string): boolean {
    const e = this._entries.get(entryId); if (!e) return false;
    e.rigType = rigType.trim() || e.rigType;
    return true;
  }

  // ── persistence ──────────────────────────────────────────────────
  /** Serialize for the document payload (brush-preset pattern). */
  serialize(): AnimationLibraryData { return { version: 1, entries: this.list() }; }

  /** Load entries. `merge=false` (default) replaces; `merge=true` appends with fresh ids + name dedupe.
   *  Ids are ALWAYS re-minted on import so libraries never collide across documents. Returns new ids. */
  load(data: AnimationLibraryData | AnimLibraryEntry[] | string | null | undefined, opts: { merge?: boolean } = {}): string[] {
    let parsed: AnimationLibraryData | AnimLibraryEntry[] | null = null;
    if (typeof data === 'string') { try { parsed = JSON.parse(data); } catch { return []; } }
    else parsed = data ?? null;
    const entries = Array.isArray(parsed) ? parsed : (parsed?.entries ?? []);
    if (!opts.merge) this._entries.clear();
    const ids: string[] = [];
    for (const raw of entries) {
      if (!raw || (raw.kind !== 'clip' && raw.kind !== 'pose')) continue;
      const e = cloneEntry(raw);
      e.id = uuid();                        // fresh id on every import
      e.name = this._uniqueName(e.name || (e.kind === 'clip' ? 'Clip' : 'Pose'));
      if (e.clip) e.clip.id = uuid();
      if (e.pose) e.pose.id = uuid();
      this._entries.set(e.id, e);
      ids.push(e.id);
    }
    return ids;
  }

  /** Document-load reset (stale-registry rule — clear before the incoming doc's library loads). */
  clearForDocumentLoad(): void { this._entries.clear(); }
}

// ── deep-copy helpers (entries never share mutable refs with the scene) ──
function deepClip(c: SkeletonAnimClip): SkeletonAnimClip {
  return {
    ...c,
    tracks: c.tracks.map((t) => ({ ...t, keyframes: t.keyframes.map((kf) => ({ frame: kf.frame, value: [...kf.value] as number[] })) })),
    ikTracks: c.ikTracks ? JSON.parse(JSON.stringify(c.ikTracks)) : undefined,
  };
}
function deepPose(p: SkeletonPose): SkeletonPose {
  return { ...p, rotations: p.rotations.map((r) => ({ jointIndex: r.jointIndex, rotation: [...r.rotation] as [number, number, number, number] })),
    adaptive: p.adaptive ? JSON.parse(JSON.stringify(p.adaptive)) : undefined };
}
function cloneEntry(e: AnimLibraryEntry): AnimLibraryEntry {
  return {
    ...e,
    clip: e.clip ? deepClip(e.clip) : undefined,
    pose: e.pose ? deepPose(e.pose) : undefined,
    sourceJoints: e.sourceJoints.map((j) => ({ index: j.index, name: j.name })),
    jointManifest: [...e.jointManifest],
    tags: e.tags ? [...e.tags] : undefined,
  };
}
