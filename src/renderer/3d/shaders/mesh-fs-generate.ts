/**
 * THE SPECIALISED MESH FRAGMENT SHADER GENERATOR (docs/specs/shader-split.md §3): merged template + key -> one WGSL
 * module with only that key's features.
 *
 *   1. preprocess (wgsl-preprocess.ts): keep the key's `//#if` blocks, drop the rest + every comment / blank line;
 *   2. tree-shake (wgsl-treeshake.ts): drop every helper, struct, constant and binding fs_main cannot reach.
 *
 * Memoised per canonical key string (a module is generated once per page). The output is WGSL ready for
 * createShaderModule; Pipeline3D wraps it with meshFS() like every other mesh fragment module (tinyMeshFS keeps
 * working as a bisect tool).
 *
 * PRELUDE (f16-ready; shader-split.md "Future: shader-f16"): every module starts with meshFsPrelude(key), the precision
 * aliases hf / hf2 / hf3 / hf4 (+ `enable f16;` for an f16 key). Nothing uses the aliases in phase 1, so the
 * tree-shaker drops them and the output is unchanged; a later phase converts chosen maths to the hf types.
 */

import { MESH3D_FS_TEMPLATE } from './mesh3d-fs-template';
import { preprocessWgsl } from './wgsl-preprocess';
import { treeShakeWgsl } from './wgsl-treeshake';
import { MESH_FS_DEFINES, meshFsDefines, meshFsKeyString, type MeshFsKey } from './mesh-fs-key';

const memo = new Map<string, string>();

/** The precision prelude of key `k`: `enable f16;` + the hf aliases as f16 types, or the same aliases as f32 types
 *  (phase 1: always f32; the 'shader-f16' device feature is not requested). */
export function meshFsPrelude(k: MeshFsKey): string {
  const t = k.f16 ? 'f16' : 'f32';
  return [k.f16 ? 'enable f16;' : '', `alias hf = ${t};`, `alias hf2 = vec2<${t}>;`, `alias hf3 = vec3<${t}>;`, `alias hf4 = vec4<${t}>;`, '']
    .filter((l, i) => i > 0 || l.length > 0).join('\n');
}

/** The WGSL fragment module of key `k` (memoised). Throws if the template or a directive is malformed. */
export function generateMeshFs(k: MeshFsKey): string {
  const ks = meshFsKeyString(k);
  let code = memo.get(ks);
  if (code === undefined) {
    const pre = preprocessWgsl(MESH3D_FS_TEMPLATE, meshFsDefines(k), { known: MESH_FS_DEFINES });
    code = treeShakeWgsl(meshFsPrelude(k) + pre, ['fs_main']) + '\n';
    memo.set(ks, code);
  }
  return code;
}

/** Size of a generated module: bytes, code lines and functions (the fallback picks the smallest compiled superset by
 *  bytes; the size report prints all three). */
export function meshFsSize(code: string): { bytes: number; lines: number; fns: number } {
  return { bytes: code.length, lines: code.split('\n').filter((l) => l.trim().length > 0).length, fns: (code.match(/\bfn\s+[A-Za-z_]/g) ?? []).length };
}
