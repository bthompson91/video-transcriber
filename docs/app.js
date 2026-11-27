// Video Transcriber: pick a video, transcribe it in the browser with
// Whisper, show a transcription sheet matching the template.
// Columns: CLIP NUMBER | Time Code | Transcription | INTERVIEW.
// Clip Number is the file name, on the first row only.
// Time Code is HH:MM:SS on every row, questions included.
// Questions are bold, interviewer. Answers are the interviewee.
// A new row starts when the speaker changes, when the speaker stops
// to gather their thoughts (a pause between Whisper chunks), or when
// a row reaches the chosen interval (10 or 30 seconds).
// Tagalog rows get an English translation in brackets, italic, after
// the original text. The Transcription text and the bracket
// translation are both editable on the page, and the downloads are
// built from the rows, so the downloaded Word and SRT files are the
// edited version.
(() => {
  const $ = (id) => document.getElementById(id);
  const fileInput = $('file'), startBtn = $('start'), cancelBtn = $('cancel');
  const statusBox = $('statusBox'), statusEl = $('status'), progressEl = $('progress');
  const detailEl = $('detail'), tbody = $('tbody'), resultBox = $('resultBox');

  let file = null;
  let worker = null;
  let nextId = 0;
  let cancelled = false;
  const pending = new Map();
  let rows = [];

  // Phones run out of memory easily here: the Whisper Turbo model,
  // the converter and the video file together can make Safari reload
  // the tab, which clears the picked file. So on a phone the
  // frame-rate check (which plays the video) is skipped, and the
  // picked file is saved on the device so a reload restores it
  // instead of losing it.
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isMobile = isIOS || /Android/i.test(navigator.userAgent);
  if (isMobile) {
    $('mobileNote').hidden = false;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('video-transcriber', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Save the picked file on the device. If Safari reloads the page,
  // it is restored on load. Failures are silent: no save just means
  // no restore, transcription still works.
  async function saveFileOnDevice(f) {
    try {
      const db = await openDb();
      await new Promise((res, rej) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put(f, 'lastVideo');
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* ignore */ }
  }

  async function loadSavedFile() {
    try {
      const db = await openDb();
      return await new Promise((res, rej) => {
        const tx = db.transaction('files', 'readonly');
        const rq = tx.objectStore('files').get('lastVideo');
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => rej(rq.error);
      });
    } catch (e) { return null; }
  }

  // Header fields survive a reload too, in localStorage.
  const headerIds = ['fStory', 'fLocale', 'fDate', 'fClip', 'fFormat', 'fSegment', 'fCameraOp', 'fCameraUsed', 'fCrew', 'fInterviewer', 'fInterviewees', 'fPaSound', 'fCodec', 'fFrameRate', 'fBitrate'];
  function saveHeader() {
    try {
      const data = {};
      for (const id of headerIds) data[id] = $(id).value;
      localStorage.setItem('vt-header', JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }
  function restoreHeader() {
    try {
      const data = JSON.parse(localStorage.getItem('vt-header') || '{}');
      for (const id of headerIds) if (typeof data[id] === 'string') $(id).value = data[id];
    } catch (e) { /* ignore */ }
  }

  function setStatus(text, pct) {
    statusBox.hidden = false;
    statusEl.textContent = text;
    if (typeof pct === 'number') progressEl.value = pct;
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = (event) => {
      const msg = (event && event.data) || {};
      const entry = pending.get(msg.id);
      if (!entry) return;
      if (typeof msg.progress === 'string') {
        setStatus(msg.progress, progressEl.value);
        return;
      }
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg);
      else entry.reject(new Error(msg.error || 'Whisper failed.'));
    };
    worker.onerror = () => {
      const err = new Error('Whisper worker failed to load.');
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
      worker = null;
    };
    return worker;
  }

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      const w = ensureWorker();
      if (payload && payload.audio) {
        w.postMessage({ id, type, model: $('model').value, audio: payload.audio }, [payload.audio.buffer]);
      } else if (payload && typeof payload.text === 'string') {
        w.postMessage({ id, type, model: $('model').value, text: payload.text });
      } else {
        w.postMessage({ id, type, model: $('model').value });
      }
    });
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  // Paste as plain text, newlines as spaces: pasting formatted HTML
  // into a row would smuggle markup into the Word and SRT downloads.
  function pastePlain(e) {
    e.preventDefault();
    const data = e.clipboardData || window.clipboardData;
    const text = data ? data.getData('text/plain').replace(/\s*\n\s*/g, ' ') : '';
    document.execCommand('insertText', false, text);
  }

  // Enter commits the edit instead of adding a line break inside
  // the cell, which would end up as a stray newline in the downloads.
  function commitOnEnter(e) {
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
  }

  // Fallback for files the browser itself cannot decode. iOS Safari
  // cannot decode .mts / .m2ts (AVCHD) at all, and some camera
  // formats fail the same way. ffmpeg.wasm converts the file to a
  // 48 kHz mono WAV in the browser (one-time ~30 MB core download,
  // cached afterwards), which the browser can always decode. The
  // file never leaves the device.
  let ffmpegPromise = null;
  function loadFfmpeg() {
    if (ffmpegPromise) return ffmpegPromise;
    ffmpegPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js';
      script.onload = async () => {
        try {
          // core-st is the single-threaded build. The normal core
          // needs SharedArrayBuffer, which needs cross-origin
          // isolation headers that GitHub Pages does not send, so it
          // fails with "Can't find variable: SharedArrayBuffer".
          // core-st runs without it, a bit slower. It also does not
          // export proxy_main (the multi-thread entry point), only
          // main, so mainName must be set or it fails with
          // "Cannot call unknown function proxy_main".
          const ffmpeg = window.FFmpeg.createFFmpeg({
            corePath: 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js',
            mainName: 'main',
            log: false,
          });
          setStatus('Loading the file converter (one-time download)...', progressEl.value);
          await ffmpeg.load();
          resolve(ffmpeg);
        } catch (e) { reject(e); }
      };
      script.onerror = () => reject(new Error('Could not load the file converter.'));
      document.head.appendChild(script);
    });
    return ffmpegPromise;
  }

  async function extractAudioViaFfmpeg(file) {
    const ffmpeg = await loadFfmpeg();
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : 'mp4';
    const inName = 'input.' + ext.replace(/[^a-z0-9]/g, '');
    setStatus('Converting the file so it can be read...', progressEl.value);
    detailEl.textContent = 'This can take a minute on a phone for a long file.';
    ffmpeg.FS('writeFile', inName, new Uint8Array(await file.arrayBuffer()));
    try {
      await ffmpeg.run('-i', inName, '-vn', '-ac', '1', '-ar', '48000', '-f', 'wav', 'out.wav');
      const wav = ffmpeg.FS('readFile', 'out.wav');
      return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    } finally {
      try { ffmpeg.FS('unlink', inName); } catch (e) { /* ignore */ }
      try { ffmpeg.FS('unlink', 'out.wav'); } catch (e) { /* ignore */ }
    }
  }

  async function decodeBuffer(buf) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      return await ctx.decodeAudioData(buf);
    } finally {
      try { await ctx.close(); } catch (e) { /* ignore */ }
    }
  }

  async function extractAudio(file) {
    let decoded;
    try {
      decoded = await decodeBuffer(await file.arrayBuffer());
    } catch (e) {
      // The browser could not decode this file (on a phone this is
      // usually .mts or another camera format). Convert it first.
      setStatus('Your browser could not read this file directly, converting it...', progressEl.value);
      const wavBuf = await extractAudioViaFfmpeg(file);
      decoded = await decodeBuffer(wavBuf);
    }
    const len = decoded.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
    // Full-rate mono for the DeepFilterNet cleanup (48 kHz native),
    // from which the 16 kHz Whisper feed is derived. Same length as
    // the video audio, so the cleaned WAV stays in sync with it.
    const mono48k = resampleLinear(mono, decoded.sampleRate, 48000);
    return { mono48k, seconds: mono48k.length / 48000 };
  }

  // Resample mono audio by linear interpolation. Used both ways:
  // full-rate audio down to 16 kHz for Whisper, and any decoded
  // rate up to 48 kHz for the DeepFilterNet cleanup.
  function resampleLinear(mono, fromRate, toRate) {
    if (fromRate === toRate) return mono;
    const ratio = fromRate / toRate;
    const outLen = Math.floor(mono.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const frac = pos - j;
      out[i] = mono[j] + ((mono[j + 1] || mono[j]) - mono[j]) * frac;
    }
    return out;
  }

  // High-pass filter (2nd-order Butterworth, 80 Hz) for the audio
  // Whisper hears. Speech energy starts around 85 Hz, so everything
  // below 80 Hz is rumble - HVAC, traffic, handling noise. Removing
  // it costs nothing.
  function highPass80(samples, sampleRate) {
    const q = 1 / Math.SQRT2;
    const w0 = 2 * Math.PI * 80 / sampleRate;
    const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
    const b0 = (1 + cos) / 2, b1 = -(1 + cos), b2 = (1 + cos) / 2;
    const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
    const out = new Float32Array(samples.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const x0 = samples[i];
      const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      out[i] = y0;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return out;
  }

  // Peak normalisation: bring the loudest sample to -1 dBFS, with
  // the boost capped at +20 dB so near-silent audio does not get
  // its noise floor amplified absurdly. Quiet or distant speech
  // comes up to a consistent level, which is the preprocessing step
  // that reliably helps transcription.
  function peakNormalise(samples, target, maxGain) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    if (peak <= 0) return samples;
    const gain = Math.min(target / peak, maxGain);
    if (gain === 1) return samples;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
    return out;
  }

  // The feed Whisper hears: 16 kHz mono, high-passed at 80 Hz and
  // peak-normalised. Denoising is deliberately NOT on this path:
  // enhancement before Whisper usually makes transcription worse,
  // so the cleaned audio is a separate download instead.
  function prepareForTranscription(mono48k) {
    const mono16k = resampleLinear(mono48k, 48000, 16000);
    return peakNormalise(highPass80(mono16k, 16000), 0.89125, 10);
  }

  // 16-bit PCM WAV, mono. The cleaned audio is written at 48 kHz
  // and exactly the same length as the source, so it lines up with
  // the video when laid back under it.
  function encodeWav(mono, sampleRate) {
    const n = mono.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    writeStr(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, mono[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // DeepFilterNet cleanup, via the worker: takes 48 kHz mono,
  // returns 48 kHz mono of exactly the same length, then boosted
  // to a consistent level for listening and editing.
  let cleanedAudio = null;
  async function cleanAudio(mono48k) {
    const out = await send('clean', { audio: mono48k.slice() });
    return peakNormalise(out.audio, 0.89125, 10);
  }
  function splitSentences(text) {
    return (text || '').split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
  }

  // Group Whisper chunks into sheet rows. Each unit is one sentence
  // from one chunk. A new row starts when:
  //  - the speaker changes (question sentence = interviewer, anything
  //    else = interviewee; Whisper has no diarization, so a sentence
  //    ending in ? is the interviewer's question),
  //  - there is a pause before this unit (thought break: the speaker
  //    stopped to gather their thoughts), or
  //  - the current row has reached the chosen interval.
  // A pause is a gap of 0.8s or more between the previous unit's end
  // and this unit's start. Short gaps inside one flowing thought stay
  // in the same row.
  function groupRows(chunks, intervalSeconds) {
    const rows = [];
    let cur = null;
    let prevEnd = null;
    for (const chunk of chunks) {
      const sentences = splitSentences(chunk.text);
      if (!sentences.length) continue;
      const chunkStart = chunk.timestamp && typeof chunk.timestamp[0] === 'number' ? chunk.timestamp[0] : (prevEnd || 0);
      const chunkEnd = chunk.timestamp && typeof chunk.timestamp[1] === 'number' ? chunk.timestamp[1] : chunkStart;
      const span = Math.max(0.1, chunkEnd - chunkStart);
      sentences.forEach((sentence, i) => {
        const start = chunkStart + (span * i) / sentences.length;
        const end = chunkStart + (span * (i + 1)) / sentences.length;
        const isQuestion = /\?\s*$/.test(sentence);
        const speaker = isQuestion ? 'interviewer' : 'interviewee';
        const pauseBreak = prevEnd !== null && (start - prevEnd >= 0.8);
        const speakerChange = cur && cur.speaker !== speaker;
        const overInterval = cur && (end - cur.start >= intervalSeconds);
        if (!cur || speakerChange || pauseBreak || overInterval) {
          cur = { start, end, text: sentence, speaker, isQuestion };
          rows.push(cur);
        } else {
          cur.text = (cur.text + ' ' + sentence).trim();
          cur.end = Math.max(cur.end, end);
          cur.isQuestion = cur.isQuestion || isQuestion;
        }
        prevEnd = end;
      });
      prevEnd = Math.max(prevEnd === null ? 0 : prevEnd, chunkEnd);
    }
    return rows;
  }

  function words(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
  }

  // True when the translation is basically the same English text as
  // the original, so there is nothing to show in brackets. Whisper's
  // translate pass on English speech returns near-identical English.
  function sameText(a, b) {
    const wa = words(a), wb = words(b);
    if (!wa.length || !wb.length) return true;
    const setB = new Set(wb);
    const shared = wa.filter((w) => setB.has(w)).length;
    return shared / Math.max(wa.length, wb.length) > 0.85;
  }

  // Interviewees, comma separated in the header form. There can be
  // several in one file, so answers are not pinned to one name.
  function interviewees() {
    return $('fInterviewees').value.split(',').map((s) => s.trim()).filter(Boolean);
  }

  function speakerOptions() {
    const opts = [];
    const interviewer = $('fInterviewer').value.trim();
    opts.push(interviewer || 'Interviewer');
    for (const name of interviewees()) opts.push(name);
    if (!interviewees().length) opts.push('Interviewee');
    return opts;
  }

  // Default speaker for a row: questions are the interviewer, answers
  // are the first interviewee. Whisper cannot tell interviewees apart,
  // so the per-row dropdown is how you fix it when they take turns.
  function speakerName(row) {
    if (row.speakerOverride) return row.speakerOverride;
    if (row.speaker === 'interviewer') return $('fInterviewer').value.trim() || 'Interviewer';
    const list = interviewees();
    return list.length ? list[0] : 'Interviewee';
  }

  function renderRows() {
    tbody.innerHTML = '';
    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      const clipTd = document.createElement('td');
      clipTd.textContent = i === 0 ? $('fClip').value.trim() : '';
      const timeTd = document.createElement('td');
      timeTd.className = 'time';
      timeTd.textContent = formatTime(row.start);
      timeTd.title = 'Jump to this point in the video';
      timeTd.addEventListener('click', () => {
        const preview = $('preview');
        if (!preview || !preview.src) return;
        preview.currentTime = row.start;
        preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        preview.play().catch(() => { /* the seek still lands even if play is blocked */ });
      });
      const textTd = document.createElement('td');
      if (row.isQuestion) textTd.classList.add('question');
      // The transcription and its bracket translation are separate
      // editable pieces, each writing straight back to the row on
      // every keystroke, so the Word and SRT downloads - which are
      // built from the rows - always get the edited version.
      // The old code made the whole cell one editable blob and only
      // read back its first child node, so edits to the translation
      // in brackets were silently lost on the next re-render and
      // never reached a download.
      const textSpan = document.createElement('span');
      textSpan.contentEditable = 'true';
      textSpan.className = 'editable';
      textSpan.textContent = row.text;
      textSpan.addEventListener('input', () => { row.text = textSpan.textContent; });
      textSpan.addEventListener('keydown', commitOnEnter);
      textSpan.addEventListener('paste', pastePlain);
      textTd.appendChild(textSpan);
      if (row.translation) {
        textTd.appendChild(document.createTextNode(' '));
        const em = document.createElement('em');
        em.className = 'translation editable';
        em.contentEditable = 'true';
        em.textContent = '[' + row.translation + ']';
        em.addEventListener('input', () => {
          // The brackets are decoration: store the text inside them.
          // Clearing the bracket text removes the translation, so
          // the downloads stop showing one for this row.
          row.translation = em.textContent.replace(/^\s*\[/, '').replace(/\]\s*$/, '').trim();
        });
        em.addEventListener('keydown', commitOnEnter);
        em.addEventListener('paste', pastePlain);
        textTd.appendChild(em);
      }
      const whoTd = document.createElement('td');
      const select = document.createElement('select');
      for (const name of speakerOptions()) {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        select.appendChild(opt);
      }
      // Keep a previous pick even if the name is no longer in the
      // header list (e.g. it was typed on the row itself).
      const current = speakerName(row);
      if (!speakerOptions().includes(current)) {
        const opt = document.createElement('option');
        opt.value = current; opt.textContent = current;
        select.appendChild(opt);
      }
      select.value = current;
      select.addEventListener('change', () => { row.speakerOverride = select.value; });
      whoTd.appendChild(select);
      tr.appendChild(clipTd);
      tr.appendChild(timeTd);
      tr.appendChild(textTd);
      tr.appendChild(whoTd);
      tbody.appendChild(tr);
    });
    resultBox.hidden = rows.length === 0;
    // The English-subtitles download only makes sense once at
    // least one row has a translation, so it stays greyed out
    // until then.
    $('downloadTranslationSrt').disabled = !rows.some((r) => r.translation);
  }

  // Downloads take the video's own file name, just a different
  // extension: IMG_3436.MOV -> IMG_3436.docx / IMG_3436.srt.
  function baseName() {
    if (!file) return 'transcript';
    return file.name.replace(/\.[^.]+$/, '') || 'transcript';
  }

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // SRT timestamps are HH:MM:SS,mmm. Each row is one subtitle, from
  // when its speech starts to when it ends (at least half a second
  // on screen). A translation, when there is one, goes on a second
  // line in brackets, as in the sheet.
  function srtTime(seconds) {
    const ms = Math.max(0, Math.round((seconds || 0) * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000), rem = ms % 1000;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0') + ',' + String(rem).padStart(3, '0');
  }

  function rowsToSrt() {
    return rows.map((r, i) => {
      const start = srtTime(r.start);
      const end = srtTime(Math.max(r.end, r.start + 0.5));
      let text = r.text;
      if (r.translation) text += '\n[' + r.translation + ']';
      return (i + 1) + '\n' + start + ' --> ' + end + '\n' + text;
    }).join('\n\n') + '\n';
  }

  // Translation-only SRT, for use as English subtitles: one
  // subtitle per translated row, plain English text, no brackets.
  // Rows with no translation are skipped, and numbering runs over
  // the subtitles that are actually in the file. It is built from
  // the rows, so edited translations come through here too.
  function rowsToTranslationSrt() {
    return rows.filter((r) => r.translation).map((r, i) => {
      const start = srtTime(r.start);
      const end = srtTime(Math.max(r.end, r.start + 0.5));
      return (i + 1) + '\n' + start + ' --> ' + end + '\n' + r.translation.trim();
    }).join('\n\n') + '\n';
  }

  // Word download, built in the browser with the docx library
  // (loaded on demand from a CDN, cached afterwards, the same way
  // the ffmpeg converter loads). Same sheet as the page: title,
  // header form, then the CLIP NUMBER / Time Code / Transcription /
  // INTERVIEW table. Questions are bold, translations are in
  // brackets and italic after the original. Nothing else in the
  // document: no notes, no FTP line.
  let docxPromise = null;
  function loadDocxLib() {
    if (docxPromise) return docxPromise;
    docxPromise = new Promise((resolve, reject) => {
      if (window.docx) { resolve(window.docx); return; }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js';
      script.onload = () => (window.docx ? resolve(window.docx) : reject(new Error('Could not load the Word writer.')));
      script.onerror = () => reject(new Error('Could not load the Word writer.'));
      document.head.appendChild(script);
    });
    return docxPromise;
  }

  async function downloadDocx() {
    if (!rows.length) return;
    setStatus('Building the Word document...', 100);
    try {
      const docx = await loadDocxLib();
      const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel } = docx;
      const headerFields = [
        ['Story', $('fStory').value], ['Local Congregation', $('fLocale').value],
        ['Date of event', $('fDate').value], ['Clip Numbers', $('fClip').value],
        ['File Format', $('fFormat').value], ['Segment', $('fSegment').value],
        ['Camera Op', $('fCameraOp').value], ['Camera Used', $('fCameraUsed').value],
        ['Crew Names & E-mail', $('fCrew').value], ['Interviewer', $('fInterviewer').value],
        ['Interviewees', $('fInterviewees').value], ['PA/Sound', $('fPaSound').value],
        ['Codec', $('fCodec').value], ['Frame rate', $('fFrameRate').value],
        ['Bitrate', $('fBitrate').value],
      ];
      const headerParas = headerFields.map(([k, v]) =>
        new Paragraph({ children: [new TextRun({ text: k + ': ', bold: true }), new TextRun(v || '')] }));
      const widths = [18, 12, 50, 20];
      const headRow = new TableRow({ children: ['CLIP NUMBER', 'Time Code', 'Transcription', 'INTERVIEW'].map((t, i) =>
        new TableCell({ width: { size: widths[i], type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })] })) });
      const bodyRows = rows.map((r, i) => {
        const textRuns = [new TextRun({ text: r.text, bold: !!r.isQuestion })];
        if (r.translation) textRuns.push(new TextRun({ text: ' [' + r.translation + ']', italics: true }));
        return new TableRow({ children: [
          new TableCell({ width: { size: widths[0], type: WidthType.PERCENTAGE }, children: [new Paragraph(i === 0 ? $('fClip').value : '')] }),
          new TableCell({ width: { size: widths[1], type: WidthType.PERCENTAGE }, children: [new Paragraph(formatTime(r.start))] }),
          new TableCell({ width: { size: widths[2], type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: textRuns })] }),
          new TableCell({ width: { size: widths[3], type: WidthType.PERCENTAGE }, children: [new Paragraph(r.speakerOverride || speakerName(r))] }),
        ] });
      });
      const doc = new Document({ sections: [{ children: [
        new Paragraph({ text: 'Transcription Sheet', heading: HeadingLevel.TITLE }),
        ...headerParas,
        new Paragraph({ text: '' }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headRow, ...bodyRows] }),
      ] }] });
      const blob = await Packer.toBlob(doc);
      downloadBlob(baseName() + '.docx', blob);
      setStatus('Word document downloaded.', 100);
    } catch (e) {
      setStatus('Failed: ' + (e && e.message ? e.message : e), 100);
    }
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Read a video codec fourcc out of an MP4/MOV file (the stsd box),
  // e.g. avc1 = H.264, hvc1 = H.265. Returns null when it cannot be
  // read, so the field stays editable instead of guessing.
  function parseMp4Codec(buf) {
    const bytes = new Uint8Array(buf);
    const text = new TextDecoder('latin1').decode(bytes);
    const at = text.indexOf('stsd');
    if (at < 0) return null;
    const fourcc = text.slice(at + 4, at + 12).replace(/[^a-z0-9]/gi, '');
    const map = { avc1: 'H.264 / AVC', avc3: 'H.264 / AVC', hvc1: 'H.265 / HEVC', hev1: 'H.265 / HEVC', av01: 'AV1', mp4v: 'MPEG-4', h264: 'H.264 / AVC' };
    return map[fourcc] || null;
  }

  // Measure frame rate by counting presented frames against media
  // time while the preview plays muted. The browser exposes no frame
  // rate directly, so this is a short measurement, not a file header
  // read. Returns null when it cannot be measured.
  async function measureFrameRate(video) {
    if (typeof video.requestVideoFrameCallback !== 'function') return null;
    try {
      video.muted = true;
      video.playbackRate = 2;
      await video.play();
      const samples = await new Promise((resolve) => {
        const got = [];
        const timeout = setTimeout(() => resolve(got), 3000);
        const cb = (now, meta) => {
          got.push(meta);
          if (got.length >= 2 && meta.mediaTime - got[0].mediaTime >= 1) {
            clearTimeout(timeout);
            resolve(got);
          } else {
            video.requestVideoFrameCallback(cb);
          }
        };
        video.requestVideoFrameCallback(cb);
      });
      video.pause();
      video.currentTime = 0;
      // The measurement plays at 2x speed; put it back to normal or
      // the video plays fast when the user presses play.
      video.playbackRate = 1;
      if (samples.length < 2) return null;
      const first = samples[0], last = samples[samples.length - 1];
      const dt = last.mediaTime - first.mediaTime;
      const df = last.presentedFrames - first.presentedFrames;
      if (dt <= 0 || df <= 0) return null;
      return df / dt;
    } catch (e) {
      try { video.pause(); } catch (err) { /* ignore */ }
      try { video.playbackRate = 1; } catch (err) { /* ignore */ }
      return null;
    }
  }

  // Auto-fill what the file itself tells us: Clip Number is the file
  // name, File Format is the extension, Codec from the file header
  // where readable, Bitrate from file size / duration, Frame rate
  // measured from the preview. All three stay editable.
  async function autoFillFromFile() {
    if (!file) return;
    $('fClip').value = file.name;
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    $('fFormat').value = ext.toUpperCase();
    const d = new Date(file.lastModified);
    if (!isNaN(d)) $('fDate').value = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
    const preview = $('preview');
    preview.addEventListener('loadedmetadata', async () => {
      const w = preview.videoWidth, h = preview.videoHeight;
      const dur = preview.duration;
      let meta = (w && h ? w + 'x' + h + ' - ' : '') + (isFinite(dur) ? Math.round(dur) + 's' : '');
      $('fileMeta').textContent = meta;
      if (isFinite(dur) && dur > 0) {
        $('fBitrate').value = ((file.size * 8) / dur / 1000000).toFixed(1) + ' Mbps';
      }
      if (ext === 'mts' || ext === 'm2ts') {
        // AVCHD transport stream; the browser cannot read its codec
        // header, and H.264 is the standard codec for it.
        $('fCodec').value = 'H.264 / AVCHD';
      } else if (ext === 'mp4' || ext === 'mov' || ext === 'm4v') {
        try {
          const head = await file.slice(0, 1024 * 1024).arrayBuffer();
          $('fCodec').value = parseMp4Codec(head) || '';
        } catch (e) { /* leave editable */ }
      } else if (ext === 'webm') {
        $('fCodec').value = 'WebM (VP8 / VP9 / AV1)';
      }
      // On iOS, playing the video to measure frame rate costs memory
      // and jumps to fullscreen without playsinline; leave the field
      // editable instead.
      const fps = isIOS ? null : await measureFrameRate(preview);
      if (fps) $('fFrameRate').value = fps.toFixed(2).replace(/\.?0+$/, '') + ' fps';
    }, { once: true });
  }

  function pickFile(f, restored) {
    file = f;
    $('fileName').textContent = file ? file.name + ' (' + (file.size / 1048576).toFixed(1) + ' MB)' : '';
    $('fileMeta').textContent = restored ? 'Restored after a reload.' : '';
    startBtn.disabled = !file;
    if (file) {
      if (isMobile && file.size > 400 * 1024 * 1024) {
        detailEl.textContent = 'That file is over 400 MB. A phone may run out of memory on it; a shorter clip, or 1080p instead of 4K, is safer.';
        statusBox.hidden = false;
      }
      $('videoBox').hidden = false;
      $('preview').src = URL.createObjectURL(file);
      autoFillFromFile();
      if (!restored) saveFileOnDevice(file);
    }
  }

  fileInput.addEventListener('change', () => {
    pickFile(fileInput.files && fileInput.files[0] ? fileInput.files[0] : null, false);
  });

  // Restore the header and the last picked file after a reload.
  restoreHeader();
  for (const id of headerIds) $(id).addEventListener('input', saveHeader);
  loadSavedFile().then((saved) => {
    if (saved && saved.name) pickFile(saved, true);
  });

  startBtn.addEventListener('click', async () => {
    if (!file) return;
    cancelled = false;
    rows = [];
    cleanedAudio = null;
    $('downloadCleaned').disabled = true;
    renderRows();
    startBtn.disabled = true;
    cancelBtn.disabled = false;
    try {
      setStatus('Reading audio from the video...', 2);
      detailEl.textContent = 'This can take a moment for a long file.';
      const extracted = await extractAudio(file);
      if (cancelled) return;
      // The 16 kHz feed Whisper hears: high-passed at 80 Hz and
      // peak-normalised. The full-rate audio is kept for cleanup.
      const audio = prepareForTranscription(extracted.mono48k);
      const minutes = (extracted.seconds / 60).toFixed(1);
      setStatus('Downloading the Whisper model...', 5);
      detailEl.textContent = 'First use downloads the model; afterwards the browser caches it.';
      await send('load');
      if (cancelled) return;
      setStatus('Transcribing ' + minutes + ' min of audio...', 10);
      detailEl.textContent = 'Running on your device. A 5-10 min video takes a few minutes.';
      const out = await send('transcribe', { audio: audio.slice() });
      if (cancelled) return;
      rows = groupRows(out.chunks || [], parseInt($('interval').value, 10) || 30);
      if (!rows.length && out.text) rows = [{ start: 0, end: audio.length / 16000, text: out.text.trim(), speaker: 'interviewee', isQuestion: false }];
      renderRows();
      if ($('translate').checked && rows.length) {
        for (let i = 0; i < rows.length; i++) {
          if (cancelled) return;
          setStatus('Translating row ' + (i + 1) + ' of ' + rows.length + '...', 70 + Math.round((i / rows.length) * 28));
          const row = rows[i];
          // A local text model (NLLB-200 distilled 600M), not
          // Whisper: it translates the transcribed Tagalog text.
          // The first use downloads the model (~900 MB, cached after).
          const tr = await send('translate', { text: row.text });
          const english = (tr.text || '').trim();
          if (english && !sameText(row.text, english)) row.translation = english;
          renderRows();
        }
      }
      setStatus('Done. ' + rows.length + ' rows.', 100);
      detailEl.textContent = 'Times are HH:MM:SS on every row.';
      if ($('cleanAudio').checked) {
        // Cleanup runs last and on the original full-rate audio, not
        // on the Whisper feed: denoising before transcription usually
        // makes it worse, so the cleaned audio is a separate
        // deliverable for listening and editing, not an input.
        setStatus('Cleaning up the audio...', 95);
        detailEl.textContent = 'DeepFilterNet 3, running on your device. First use downloads the model (~8 MB).';
        cleanedAudio = await cleanAudio(extracted.mono48k);
        if (cancelled) return;
        $('downloadCleaned').disabled = false;
        setStatus('Done. ' + rows.length + ' rows, cleaned audio ready.', 100);
        detailEl.textContent = 'Times are HH:MM:SS on every row.';
      }
    } catch (e) {
      if (!cancelled) setStatus('Failed: ' + (e && e.message ? e.message : e), progressEl.value);
    } finally {
      startBtn.disabled = !file;
      cancelBtn.disabled = true;
    }
  });

  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
    pending.clear();
    setStatus('Cancelled.', progressEl.value);
    startBtn.disabled = !file;
    cancelBtn.disabled = true;
  });

  $('downloadDocx').addEventListener('click', downloadDocx);
  $('downloadSrt').addEventListener('click', () => {
    if (!rows.length) return;
    download(baseName() + '.srt', rowsToSrt(), 'text/plain');
  });
  // Translation-only subtitles, named <video>.en.srt so players
  // pick it up as the English subtitle track next to the video.
  $('downloadTranslationSrt').addEventListener('click', () => {
    if (!rows.length) return;
    if (!rows.some((r) => r.translation)) {
      setStatus('No translations yet. Tick Translate before transcribing.', progressEl.value);
      return;
    }
    download(baseName() + '.en.srt', rowsToTranslationSrt(), 'text/plain');
  });
  // Cleaned audio: full-length 48 kHz mono WAV, same length as the
  // video audio, so it lines up with the video when laid back
  // under it in an editor.
  $('downloadCleaned').addEventListener('click', () => {
    if (!cleanedAudio) return;
    downloadBlob(baseName() + '-clean.wav', encodeWav(cleanedAudio, 48000));
  });
  $('fInterviewer').addEventListener('input', renderRows);
  $('fInterviewees').addEventListener('input', renderRows);
  $('fClip').addEventListener('input', renderRows);
})();
