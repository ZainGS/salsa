/**
 * opfs-fake.ts — a minimal in-memory Origin Private File System for tests.
 *
 * Implements only what document-persistence.ts touches: directory/file handles, createWritable → write/close,
 * getFile → Blob, removeEntry, and async entries()/keys() iteration. Install with `installFakeOPFS()` (stubs
 * `navigator.storage.getDirectory`) so a real save → load round trip can run in Node. TEST-ONLY — not exported
 * from the package.
 */

type Entry = FakeFile | FakeDir;

export class FakeFile {
  readonly kind = 'file' as const;
  data: Blob = new Blob([]);
  constructor(readonly name: string) {}
  async getFile(): Promise<Blob> { return this.data; }
  async createWritable() {
    const parts: BlobPart[] = [];
    return {
      write: async (chunk: BlobPart) => { parts.push(chunk); },
      close: async () => { this.data = new Blob(parts); },
    };
  }
}

export class FakeDir {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, Entry>();
  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    const e = this.children.get(name);
    if (e) { if (e.kind !== 'directory') throw new DOMException('not a directory', 'TypeMismatchError'); return e; }
    if (!opts?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
    const d = new FakeDir(name); this.children.set(name, d); return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    const e = this.children.get(name);
    if (e) { if (e.kind !== 'file') throw new DOMException('not a file', 'TypeMismatchError'); return e; }
    if (!opts?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
    const f = new FakeFile(name); this.children.set(name, f); return f;
  }
  async removeEntry(name: string, _opts?: { recursive?: boolean }): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException(`${name} not found`, 'NotFoundError');
  }
  async *entries(): AsyncGenerator<[string, Entry]> { for (const kv of this.children) yield kv; }
  async *keys(): AsyncGenerator<string> { for (const k of this.children.keys()) yield k; }

  /** Test helper: the file names directly in `path` ('' = this dir), sorted. */
  list(path = ''): string[] {
    let d: FakeDir = this;
    for (const seg of path.split('/').filter(Boolean)) {
      const next = d.children.get(seg);
      if (!next || next.kind !== 'directory') return [];
      d = next;
    }
    return [...d.children.keys()].sort();
  }
}

/** Replace navigator.storage with an in-memory OPFS; returns its root. Pair with vi.unstubAllGlobals(). */
export function installFakeOPFS(stub: (name: string, value: unknown) => void): FakeDir {
  const root = new FakeDir('');
  stub('navigator', { storage: { getDirectory: async () => root } });
  return root;
}
