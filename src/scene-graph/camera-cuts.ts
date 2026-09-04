/**
 * Camera cut/shot track for the cinematic-camera system (docs/specs/cinematic-cameras.md §3).
 *
 * A document-level list of cuts — "at frame F, cut to camera C". Step-interpolated → hard cuts (crossfades are a
 * later phase). Pure / unit-testable; the Scene3DManager holds the array + drives the render camera off it in
 * preview mode.
 */

export interface CameraCut { frame: number; cameraId: string; }

/**
 * The active camera at `frame` = the cut with the LARGEST frame ≤ `frame` (step). Returns null before the first
 * cut — the caller then falls back to the edit camera / the legacy single-camera track.
 */
export function activeCameraAt(cuts: readonly CameraCut[], frame: number): string | null {
  let active: string | null = null, best = -Infinity;
  for (const c of cuts) if (c.frame <= frame && c.frame > best) { best = c.frame; active = c.cameraId; }
  return active;
}

/** Add or REPLACE the cut at `frame` (one cut per frame), returning a new frame-sorted array. */
export function setCut(cuts: readonly CameraCut[], frame: number, cameraId: string): CameraCut[] {
  const out = cuts.filter(c => c.frame !== frame);
  out.push({ frame, cameraId });
  out.sort((a, b) => a.frame - b.frame);
  return out;
}

/** Remove the cut at `frame` (if any). New array. */
export function removeCut(cuts: readonly CameraCut[], frame: number): CameraCut[] {
  return cuts.filter(c => c.frame !== frame);
}

/** Drop every cut that references a deleted camera — call when a CameraNode is removed so the track stays valid. */
export function pruneCuts(cuts: readonly CameraCut[], cameraId: string): CameraCut[] {
  return cuts.filter(c => c.cameraId !== cameraId);
}
