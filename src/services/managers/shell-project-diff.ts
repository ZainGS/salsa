/**
 * shell-project-diff.ts — "did the project list actually change?" for the Shell's project cache.
 *
 * ShellUIManager refreshes the list from the host store on several occasions (mount, after a save, after the mode
 * cross-fade). A refresh that returns what the cache already holds must not emit a change: every emit rebuilds the
 * Shell model, re-requests the thumbnails and re-enters the host's change handlers.
 */
import type { ProjectEntry } from '../persistence/shell-storage';

/** True when both lists hold the same entries in the same order (every ProjectEntry field compared). */
export function sameProjectList(a: readonly ProjectEntry[], b: readonly ProjectEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x.id !== y.id || x.name !== y.name || x.lastModified !== y.lastModified
      || (x.kind ?? 'illustration') !== (y.kind ?? 'illustration')
      || x.sizeBytes !== y.sizeBytes || x.opfsPath !== y.opfsPath
      || x.thumbnailDataUrl !== y.thumbnailDataUrl) return false;
  }
  return true;
}

/** The entries shown in a dashboard (untagged = 'illustration'). */
export function projectsOfKind(all: readonly ProjectEntry[], kind: 'illustration' | 'packaging'): ProjectEntry[] {
  return all.filter(p => (p.kind ?? 'illustration') === kind);
}
