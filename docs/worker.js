// Video Transcriber worker.
//
// Runs in a module Web Worker so model loading and transcription never
// block the page. Loads transformers.js from the CDN on first use, then
// the chosen multilingual Whisper model (onnx-community/whisper-base or
// whisper-small), cached by the browser afterwards. WebGPU when the
// device offers it, WASM otherwise. Audio arrives as a Float32Array of
// 16 kHz mono samples.
//
// Messages in:
//   { id, type: 'load', model }
//   { id, type: 'transcribe', audio }  -> timestamped chunks
//   { id, type: 'translate', audio }   -> English text for one row
// Messages out:
//   { id, ok: true, ... } / { id, ok: false, error } /
//   { id, progress: 'Downloading... 42%' }
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

let transcriberPromise = null;
let loadedModel = '';

async function pickDevice() {
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch (e) { /* fall through to wasm */ }
  return 'wasm';
}

async function getTranscriber(model, onProgress) {
  if (!transcriberPromise || loadedModel !== model) {
    loadedModel = model;
    transcriberPromise = (async () => {
      const device = await pickDevice();
      const dtype = device === 'webgpu'
        ? { encoder_model: 'fp16', decoder_model_merged: 'q4' }
        : 'q8';
      return pipeline('automatic-speech-recognition', model, {
        device,
        dtype,
        progress_callback: (p) => {
          if (!onProgress) return;
          if (p && p.status === 'progress' && typeof p.progress === 'number') {
            onProgress('Downloading... ' + Math.round(p.progress) + '%');
          } else if (p && p.status === 'done') {
            onProgress('Downloaded.');
          } else if (p && p.status === 'initiate') {
            onProgress('Starting download...');
          }
        },
      });
    })();
  }
  return transcriberPromise;
}

self.onmessage = async (event) => {
  const msg = (event && event.data) || {};
  const id = msg.id;
  try {
    if (msg.type === 'load') {
      await getTranscriber(msg.model, (text) => self.postMessage({ id, progress: text }));
      self.postMessage({ id, ok: true });
    } else if (msg.type === 'transcribe') {
      const transcriber = await getTranscriber(msg.model);
      // Language is left unset so Whisper auto-detects per chunk: the
      // videos mix English and Tagalog, and forcing 'tl' would mangle
      // the English parts (and vice versa).
      const out = await transcriber(msg.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      });
      self.postMessage({ id, ok: true, text: (out && out.text) || '', chunks: (out && out.chunks) || [] });
    } else if (msg.type === 'translate') {
      const transcriber = await getTranscriber(msg.model);
      // Whisper's translate task always outputs English, using the same
      // model, so Tagalog gets an English version with no second model.
      const out = await transcriber(msg.audio, { task: 'translate' });
      self.postMessage({ id, ok: true, text: (out && out.text) || '' });
    } else {
      self.postMessage({ id, ok: false, error: 'Unknown message type.' });
    }
  } catch (e) {
    transcriberPromise = null;
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
