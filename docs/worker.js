// Video Transcriber worker.
//
// Runs in a module Web Worker so model loading and transcription never
// block the page. Loads transformers.js from the CDN on first use, then
// the chosen multilingual Whisper model (onnx-community/whisper-small or
// whisper-large-v3-turbo), cached by the browser afterwards. WebGPU when the
// device offers it, WASM otherwise. Audio arrives as a Float32Array of
// 16 kHz mono samples.
//
// Translation is a separate local text model, not Whisper: Meta's
// NLLB-200 distilled 600M (Xenova/nllb-200-distilled-600M, ONNX,
// int8 quantized, ~895 MB), loaded from Hugging Face Hub. It takes
// the transcribed Tagalog text and translates it, so it cannot loop
// the way Whisper's translate pass did. It replaced the smaller
// opus-mt-tl-en model, which mangled Taglish and English loanwords
// ("You're a guy.", "birthday boy"). NLLB handles code-switched
// spoken Tagalog correctly.
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
// (Xenova/nllb-200-distilled-600M), loaded by repo id like the
// Whisper models. dtype 'q8' loads the int8 quantized ONNX files
// (encoder ~419 MB + merged decoder ~475 MB, ~895 MB total - the
// q4 files are actually bigger, ~2.3 GB, because NLLB's huge
// embedding matrix barely quantizes). Loaded lazily, only when
// translation is turned on, so the download only happens if the
// user asks for it. Forced to WASM, not WebGPU: WebGPU translation
// crashes in transformers.js (issues #1380, #1518).
async function getTranslator(onProgress) {
  if (!translatorPromise) {
    translatorPromise = (async () => {
      // WASM, not WebGPU: WebGPU translation crashes in
      // transformers.js, and NLLB is a 600M encoder-decoder, so
      // this runs on CPU/WASM by design.
      return pipeline('translation', 'Xenova/nllb-200-distilled-600M', {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: (p) => {
          if (!onProgress) return;
          if (p && p.status === 'progress' && typeof p.progress === 'number') {
            onProgress('Downloading the translation model (~900 MB, one-time)... ' + Math.round(p.progress) + '%');
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
      // A text model, not Whisper: NLLB-200 translates the
      // transcribed Tagalog text to English. No audio, so it cannot
      // loop the way Whisper's translate pass did. NLLB needs the
      // source and target languages on every call: Tagalog is
      // 'tgl_Latn', English is 'eng_Latn'. The translation pipeline
      // returns [{ translation_text: '...' }].
      const out = await translator(msg.text || '', { src_lang: 'tgl_Latn', tgt_lang: 'eng_Latn' });
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
