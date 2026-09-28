/* tslint:disable */
/* eslint-disable */
/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function floyd_steinberg(pixels: Uint8Array, width: number, height: number, levels: number): void;
/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function atkinson(pixels: Uint8Array, width: number, height: number, levels: number): void;
/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function jarvis_judice_ninke(pixels: Uint8Array, width: number, height: number, levels: number): void;
/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function stucki(pixels: Uint8Array, width: number, height: number, levels: number): void;
/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function sierra(pixels: Uint8Array, width: number, height: number, levels: number): void;
/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function sierra_lite(pixels: Uint8Array, width: number, height: number, levels: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly floyd_steinberg: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly atkinson: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly jarvis_judice_ninke: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly stucki: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly sierra: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly sierra_lite: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {SyncInitInput} module
*
* @returns {InitOutput}
*/
export function initSync(module: SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;
