let wasm;

let cachedUint8Memory0 = null;

function getUint8Memory0() {
    if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {
        cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8Memory0;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8Memory0().subarray(ptr / 1, ptr / 1 + len);
}

const heap = new Array(128).fill(undefined);

heap.push(undefined, null, true, false);

function getObject(idx) { return heap[idx]; }

let heap_next = heap.length;

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let WASM_VECTOR_LEN = 0;

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8Memory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}
/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function floyd_steinberg(pixels, width, height, levels) {
    var ptr0 = passArray8ToWasm0(pixels, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.floyd_steinberg(ptr0, len0, addHeapObject(pixels), width, height, levels);
}

/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function atkinson(pixels, width, height, levels) {
    var ptr0 = passArray8ToWasm0(pixels, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.atkinson(ptr0, len0, addHeapObject(pixels), width, height, levels);
}

/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function jarvis_judice_ninke(pixels, width, height, levels) {
    var ptr0 = passArray8ToWasm0(pixels, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.jarvis_judice_ninke(ptr0, len0, addHeapObject(pixels), width, height, levels);
}

/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function stucki(pixels, width, height, levels) {
    var ptr0 = passArray8ToWasm0(pixels, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.stucki(ptr0, len0, addHeapObject(pixels), width, height, levels);
}

/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function sierra(pixels, width, height, levels) {
    var ptr0 = passArray8ToWasm0(pixels, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.sierra(ptr0, len0, addHeapObject(pixels), width, height, levels);
}

/**
* @param {Uint8Array} pixels
* @param {number} width
* @param {number} height
* @param {number} levels
*/
export function sierra_lite(pixels, width, height, levels) {
    var ptr0 = passArray8ToWasm0(pixels, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.sierra_lite(ptr0, len0, addHeapObject(pixels), width, height, levels);
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbindgen_copy_to_typed_array = function(arg0, arg1, arg2) {
        new Uint8Array(getObject(arg2).buffer, getObject(arg2).byteOffset, getObject(arg2).byteLength).set(getArrayU8FromWasm0(arg0, arg1));
    };
    imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
        takeObject(arg0);
    };

    return imports;
}

function __wbg_init_memory(imports, maybe_memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedUint8Memory0 = null;


    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(input) {
    if (wasm !== undefined) return wasm;

    if (typeof input === 'undefined') {
        input = new URL('wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof input === 'string' || (typeof Request === 'function' && input instanceof Request) || (typeof URL === 'function' && input instanceof URL)) {
        input = fetch(input);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await input, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync }
export default __wbg_init;
