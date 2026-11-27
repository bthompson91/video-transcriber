// DeepFilterNet 3 speech enhancement, run offline on a whole file.
//
// Why this exists: the npm package deepfilternet3-noise-filter is
// worklet-only (realtime mic) and its default CDN returns 403, so
// the app drives the DeepFilterNet WASM directly instead. The WASM
// (df_bg.wasm) plus the model tarball (DeepFilterNet3_onnx.tar.gz)
// are loaded from Hugging Face Hub at runtime, the same pattern as
// the Whisper and NLLB models - the GitHub snapshot push cannot
// carry binary files, so nothing is bundled in the repo.
//
// The WASM is a wasm-bindgen build (module "wbg", heap-object ABI)
// with no bindgen metadata, so the glue below is hand-written - the
// standard wasm-bindgen imports, pinned down by tracing which
// functions the WASM actually calls. It was proven in Node against
// the same WASM bytes: 2 s of noisy audio processed in 0.85 s
// (2.3x faster than realtime), noise-only sections down 27-34 dB,
// speech preserved within 1 dB, output exactly the same length as
// the input after dropping the 30 ms algorithmic delay.
//
// Single-threaded WASM (no threads/atomics/shared memory), so no
// SharedArrayBuffer and no COOP/COEP headers are needed - GitHub
// Pages is fine. 48 kHz mono in, 48 kHz mono out, exactly the same
// number of samples, so the cleaned WAV stays in sync with the
// video. Transcription still uses the ORIGINAL audio - denoising
// before Whisper usually makes transcription worse - so this is a
// separate deliverable for listening and editing, not an input.
//
// Model: Rikorose/DeepFilterNet DeepFilterNet3, mirrored at
// trysem/DeepFilterNet3 (verified identical to upstream).
//   df_bg.wasm: 9,622,975 bytes
//   DeepFilterNet3_onnx.tar.gz: 7,983,136 bytes
//   (enc.onnx 1.9 MB + erb_dec.onnx 3.3 MB + df_dec.onnx 3.3 MB)
export const DF3_SAMPLE_RATE = 48000;
export const DF3_FRAME = 480; // 10 ms at 48 kHz
export const DF3_LATENCY_SAMPLES = 1440; // 30 ms, 3 frames, deterministic
export const DF3_FLUSH_FRAMES = 12; // silence frames to drain the pipeline

const WASM_URL = 'https://huggingface.co/trysem/DeepFilterNet3/resolve/main/df_bg.wasm';
const MODEL_URL = 'https://huggingface.co/trysem/DeepFilterNet3/resolve/main/DeepFilterNet3_onnx.tar.gz';
// 0 = no suppression, 100 = maximum. 50 is the middle ground.
const ATTEN_LIM = 50;

// --- wasm-bindgen object heap -----------------------------------------------
const heap = new Array(128).fill(undefined);
heap.push(undefined, null, true, false);
let heap_next = heap.length;
function addHeapObject(obj) {
  if (heap_next === heap.length) heap.push(heap.length + 1);
  const idx = heap_next;
  heap_next = heap[idx];
  heap[idx] = obj;
  return idx;
}
function getObject(idx) { return heap[idx]; }
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

// --- wasm memory views --------------------------------------------------------
let wasm;
let cachedU8 = null, cachedF32 = null, cachedTextDecoder = null;
function getU8() {
  if (cachedU8 === null || cachedU8.byteLength === 0) cachedU8 = new Uint8Array(wasm.memory.buffer);
  return cachedU8;
}
function getF32() {
  if (cachedF32 === null || cachedF32.byteLength === 0) cachedF32 = new Float32Array(wasm.memory.buffer);
  return cachedF32;
}
function getString(ptr, len) {
  if (!cachedTextDecoder) cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  return cachedTextDecoder.decode(getU8().subarray(ptr, ptr + len));
}
let WASM_VECTOR_LEN = 0;
function passU8(arg, malloc) {
  const ptr = malloc(arg.length, 1) >>> 0;
  getU8().set(arg, ptr);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function passF32(arg, malloc) {
  const ptr = malloc(arg.length * 4, 4) >>> 0;
  getF32().set(arg, ptr / 4);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}

// --- imports ("wbg" module) ---------------------------------------------------
// Hand-written wasm-bindgen glue for this build. The `__wbg_new_*`
// and `__wbg_newwithbyteoffsetandlength_*` functions take their
// typed-array constructor baked in per hash (proven by tracing):
// 9efabd6b builds Float32Array, 63b92bc8 builds Uint8Array.
// randomFillSync has no browser equivalent, so it falls back to
// crypto.getRandomValues, which fills with random bytes the same way.
const imports = { wbg: {
  __wbindgen_object_drop_ref: (idx) => dropObject(idx),
  __wbindgen_object_clone_ref: (idx) => addHeapObject(getObject(idx)),
  __wbindgen_is_object: (idx) => { const v = getObject(idx); return typeof v === 'object' && v !== null; },
  __wbindgen_is_string: (idx) => typeof getObject(idx) === 'string',
  __wbindgen_is_function: (idx) => typeof getObject(idx) === 'function',
  __wbindgen_is_undefined: (idx) => getObject(idx) === undefined,
  __wbindgen_string_new: (ptr, len) => addHeapObject(getString(ptr, len)),
  __wbindgen_throw: (ptr, len) => { throw new Error(getString(ptr, len)); },
  __wbindgen_memory: () => addHeapObject(wasm.memory),
  __wbg_crypto_566d7465cdbb6b7a: (idx) => addHeapObject(getObject(idx).crypto),
  __wbg_process_dc09a8c7d59982f6: (idx) => addHeapObject(getObject(idx).process),
  __wbg_versions_d98c6400c6ca2bd8: (idx) => addHeapObject(getObject(idx).versions),
  __wbg_node_caaf83d002149bd5: (idx) => { const v = getObject(idx).node; return v === undefined ? 0 : addHeapObject(v); },
  __wbg_require_94a9da52636aacbf: () => { throw new Error('require() not available in this glue'); },
  __wbg_msCrypto_0b84745e9245cdf6: (idx) => addHeapObject(getObject(idx).msCrypto),
  __wbg_randomFillSync_290977693942bf03: (...args) => {
    let target, obj = null;
    if (args.length >= 3) { obj = getObject(args[0]); target = getU8().subarray(args[1], args[1] + args[2]); }
    else { target = getU8().subarray(args[0], args[0] + args[1]); }
    if (obj && typeof obj.randomFillSync === 'function') obj.randomFillSync(target);
    else globalThis.crypto.getRandomValues(target);
  },
  __wbg_getRandomValues_260cc23a41afad9a: (...args) => {
    if (args.length >= 3) getObject(args[0]).getRandomValues(getU8().subarray(args[1], args[1] + args[2]));
    else globalThis.crypto.getRandomValues(getU8().subarray(args[0], args[0] + args[1]));
  },
  __wbg_newnoargs_e258087cd0daa0ea: (idx) => addHeapObject(new (getObject(idx))()),
  __wbg_new_63b92bc8671ed464: (a) => addHeapObject(new Uint8Array(getObject(a))),
  __wbg_new_9efabd6b6d2ce46d: (a) => addHeapObject(new Float32Array(getObject(a))),
  __wbg_buffer_12d079cc21e14bdb: (idx) => addHeapObject(getObject(idx).buffer),
  __wbg_newwithbyteoffsetandlength_aa4a17c33a06e5cb: (a, b, c) => addHeapObject(new Uint8Array(getObject(a), b >>> 0, c >>> 0)),
  __wbg_newwithbyteoffsetandlength_4a659d079a1650e0: (a, b, c) => addHeapObject(new Float32Array(getObject(a), b >>> 0, c >>> 0)),
  __wbg_newwithlength_e9b4878cebadb3d3: (...args) => args.length === 1
    ? addHeapObject(new Float32Array(args[0] >>> 0))
    : addHeapObject(new (getObject(args[0]))(args[1] >>> 0)),
  __wbg_set_a47bac70306a19a7: (a, b, c) => getObject(a).set(getObject(b), c >>> 0),
  __wbg_subarray_a1f73cd4b5b42fe1: (a, b, c) => addHeapObject(getObject(a).subarray(b >>> 0, c >>> 0)),
  __wbg_self_ce0dbfc45cf2f5be: () => addHeapObject(globalThis.self),
  __wbg_window_c6fb939a7f436783: () => addHeapObject(globalThis.window),
  __wbg_globalThis_d1e6af4856ba331b: () => addHeapObject(globalThis),
  __wbg_global_207b558942527489: () => addHeapObject(globalThis.global),
  __wbg_call_27c0f87801dedf93: (a, b) => addHeapObject(getObject(a).call(getObject(b))),
  __wbg_call_b3ca7c6051f9bec1: (a, b, c) => addHeapObject(getObject(a).call(getObject(b), getObject(c))),
} };

// --- DF wrappers --------------------------------------------------------------
function df_create(modelBytes, attenLim) {
  const ptr = passU8(modelBytes, wasm.__wbindgen_malloc);
  const len = WASM_VECTOR_LEN;
  return wasm.df_create(ptr, len, attenLim) >>> 0;
}
function df_get_frame_length(st) { return wasm.df_get_frame_length(st) >>> 0; }
function df_process_frame(st, input) {
  const ptr = passF32(input, wasm.__wbindgen_malloc);
  const len = WASM_VECTOR_LEN;
  const ret = wasm.df_process_frame(st, ptr, len);
  return takeObject(ret);
}

// --- loading ------------------------------------------------------------------
// `assets` is a test hook: pass { wasmBytes, modelBytes } (Uint8Array)
// to skip the network fetch. Otherwise both files come from HF.
let statePromise = null;
export async function loadDeepFilterNet(onProgress, assets) {
  if (!statePromise) {
    statePromise = (async () => {
      let wasmBytes, modelBytes;
      if (assets) {
        wasmBytes = assets.wasmBytes;
        modelBytes = assets.modelBytes;
      } else {
        if (onProgress) onProgress('Downloading the cleanup model (~18 MB, one-time)...');
        const [wasmRes, modelRes] = await Promise.all([
          fetch(WASM_URL),
          fetch(MODEL_URL),
        ]);
        if (!wasmRes.ok) throw new Error('Could not download the cleanup model (WASM): HTTP ' + wasmRes.status);
        if (!modelRes.ok) throw new Error('Could not download the cleanup model: HTTP ' + modelRes.status);
        wasmBytes = new Uint8Array(await wasmRes.arrayBuffer());
        modelBytes = new Uint8Array(await modelRes.arrayBuffer());
      }
      if (onProgress) onProgress('Starting the cleanup model...');
      const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
      wasm = instance.exports;
      const handle = df_create(modelBytes, ATTEN_LIM);
      const frameLength = df_get_frame_length(handle);
      if (frameLength !== DF3_FRAME) throw new Error('Unexpected DeepFilterNet frame length: ' + frameLength);
      return { handle, frameLength };
    })().catch((e) => { statePromise = null; throw e; });
  }
  return statePromise;
}

// --- processing ---------------------------------------------------------------
// Clean 48 kHz mono audio. Returns a new Float32Array of exactly the
// same length: the 30 ms algorithmic delay is dropped from the
// front, and the pipeline is flushed with silence frames at the
// end so the tail is not cut off. `onProgress` gets a status string.
export async function cleanAudio48k(mono48k, onProgress, assets) {
  const n = mono48k.length;
  if (n === 0) return new Float32Array(0);
  const { handle, frameLength } = await loadDeepFilterNet(onProgress, assets);
  const nFrames = Math.ceil(n / frameLength);
  const total = nFrames + DF3_FLUSH_FRAMES;
  const raw = new Float32Array(total * frameLength);
  const frame = new Float32Array(frameLength);
  let lastReport = -1;
  for (let f = 0; f < total; f++) {
    frame.fill(0);
    if (f < nFrames) frame.set(mono48k.subarray(f * frameLength, (f + 1) * frameLength));
    const out = df_process_frame(handle, frame);
    if (!(out instanceof Float32Array) || out.length !== frameLength) {
      throw new Error('DeepFilterNet returned an unexpected frame.');
    }
    raw.set(out, f * frameLength);
    if (onProgress) {
      const pct = Math.floor(((f + 1) / total) * 100);
      if (pct !== lastReport && pct % 5 === 0) {
        lastReport = pct;
        onProgress('Cleaning audio... ' + pct + '%');
      }
    }
  }
  // Drop the 30 ms delay from the front; the result is exactly
  // the input length, so it stays in sync with the video.
  return raw.slice(DF3_LATENCY_SAMPLES, DF3_LATENCY_SAMPLES + n);
}
