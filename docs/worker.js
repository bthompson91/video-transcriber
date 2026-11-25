// Video Transcriber worker.
//
// Runs in a module Web Worker so model loading and transcription never
// block the page. Loads transformers.js from the CDN on first use, then
// the chosen multilingual Whisper model (onnx-community/whisper-small or
// whisper-large-v3-turbo), cached by the browser afterwards. WebGPU when the
// device offers it, WASM otherwise. Audio arrives as a Float32Array of
// 16 kHz mono samples.
//
// Translation is a separate local text model, not Whisper: the
// bundled opus-mt-tl-en (Helsinki-NLP, Tagalog to English, ONNX,
// int8 quantized, ~133 MB) on Hugging Face Hub as
// brendo91/opus-mt-tl-en-onnx. It takes the transcribed Tagalog
// text and translates it, so it cannot loop the way Whisper's
// translate pass did.
//
// Messages in:
//   { id, type: 'load', model }
//   { id, type: 'transcribe', audio }  -> timestamped chunks
//   { id, type: 'translate', text }    -> English text for one row
// Messages out:
//   { id, ok: true, ... } / { id, ok: false, error } /
//   { id, progress: 'Downloading... 42%' }
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

let transcriberPromise = null;
let loadedModel = '';
let translatorPromise = null;

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

// The translation model lives on Hugging Face Hub
// (brendo91/opus-mt-tl-en-onnx), loaded by repo id like the Whisper
// models. dtype 'q8' loads the int8 quantized ONNX files (the
// compressed versions). Loaded lazily, only when translation is
// turned on, so the ~133 MB download only happens if the user asks
// for it.
async function getTranslator(onProgress) {
  if (!translatorPromise) {
    translatorPromise = (async () => {
      const device = await pickDevice();
      return pipeline('translation', 'brendo91/opus-mt-tl-en-onnx', {
        device,
        dtype: 'q8',
        progress_callback: (p) => {
          if (!onProgress) return;
          if (p && p.status === 'progress' && typeof p.progress === 'number') {
            onProgress('Downloading the translation model... ' + Math.round(p.progress) + '%');
          } else if (p && p.status === 'done') {
            onProgress('Translation model downloaded.');
          } else if (p && p.status === 'initiate') {
            onProgress('Starting the translation model download...');
          }
        },
      });
    })();
  }
  return translatorPromise;
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
      // Language is set to Tagalog, not left to the default.
      // transformers.js defaults the language to English when none
      // is given, and Whisper told the language is English will
      // output English for Tagalog audio - translating on the
      // transcribe pass instead of transcribing it. Setting 'tl'
      // makes the first pass transcribe the Tagalog as Tagalog.
      // The English translation is a separate step (the translate
      // task), not this pass. The task is transcribe, explicitly.
      const out = await transcriber(msg.audio, {
        task: 'transcribe',
        language: 'tl',
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      });
      self.postMessage({ id, ok: true, text: (out && out.text) || '', chunks: (out && out.chunks) || [] });
    } else if (msg.type === 'translate') {
      const translator = await getTranslator((text) => self.postMessage({ id, progress: text }));
      // A text model, not Whisper: it takes the transcribed Tagalog
      // text and translates it to English. No audio, so it cannot
      // loop the way Whisper's translate pass did. The translation
      // pipeline returns [{ translation_text: '...' }].
      const out = await translator(msg.text || '');
      let text = '';
      if (Array.isArray(out) && out[0]) {
        text = out[0].translation_text || out[0].text || '';
      } else if (typeof out === 'string') {
        text = out;
      } else if (out && typeof out === 'object') {
        text = out.translation_text || out.text || '';
      }
      self.postMessage({ id, ok: true, text });
    } else {
      self.postMessage({ id, ok: false, error: 'Unknown message type.' });
    }
  } catch (e) {
    transcriberPromise = null;
    translatorPromise = null;
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
