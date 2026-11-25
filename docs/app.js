// Video Transcriber: pick a video, transcribe it in the browser with
// Whisper, show a transcription sheet matching the template.
// Columns: CLIP NUMBER | Time Code | Transcription | INTERVIEW.
// Clip Number is the file name, on the first row only.
// Time Code is HH:MM:SS, blank on question rows, as in the template.
// Questions are bold, interviewer. Answers are the interviewee.
// A new row starts when the speaker changes, when the speaker stops
// to gather their thoughts (a pause between Whisper chunks), or when
// a row reaches the chosen interval (10 or 30 seconds).
// Tagalog rows get an English translation in brackets, italic, after
// the original text.
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

  // Fallback for files the browser itself cannot decode. iOS Safari
  // cannot decode .mts / .m2ts (AVCHD) at all, and some camera
  // formats fail the same way. ffmpeg.wasm converts the file to a
  // 16 kHz mono WAV in the browser (one-time ~30 MB core download,
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
      await ffmpeg.run('-i', inName, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'out.wav');
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
    if (decoded.sampleRate === 16000) return mono;
    const ratio = decoded.sampleRate / 16000;
    const outLen = Math.floor(len / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const frac = pos - j;
      out[i] = mono[j] + ((mono[j + 1] || mono[j]) - mono[j]) * frac;
    }
    return out;
  }

  // Split a chunk's text into sentences. A question sentence ends in ?.
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
      // Question rows have a blank Time Code, as in the template.
      timeTd.textContent = row.isQuestion ? '' : formatTime(row.start);
      const textTd = document.createElement('td');
      textTd.contentEditable = 'true';
      if (row.isQuestion) textTd.classList.add('question');
      textTd.appendChild(document.createTextNode(row.text));
      if (row.translation) {
        textTd.appendChild(document.createTextNode(' '));
        const em = document.createElement('em');
        em.className = 'translation';
        em.textContent = '[' + row.translation + ']';
        textTd.appendChild(em);
      }
      textTd.addEventListener('input', () => { row.text = textTd.childNodes[0] ? textTd.childNodes[0].textContent : textTd.textContent; });
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
  }

  function tableAsText() {
    return rows.map((r) => (r.isQuestion ? '' : formatTime(r.start)) + '\t' + r.text +
      (r.translation ? ' [' + r.translation + ']' : '') + '\t' + (r.speakerOverride || speakerName(r))).join('\n');
  }

  function tableAsHtml() {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const head = [
      ['Story', $('fStory').value], ['Locale/District', $('fLocale').value],
      ['Date of event', $('fDate').value], ['Clip Numbers', $('fClip').value],
      ['File Format', $('fFormat').value], ['Segment', $('fSegment').value],
      ['Camera Op', $('fCameraOp').value], ['Camera Used', $('fCameraUsed').value],
      ['Interviewer', $('fInterviewer').value], ['Interviewees', $('fInterviewees').value],
      ['PA/Sound', $('fPaSound').value], ['Codec', $('fCodec').value],
      ['Frame rate', $('fFrameRate').value], ['Bitrate', $('fBitrate').value],
    ].map(([k, v]) => '<tr><td><b>' + esc(k) + ':</b></td><td>' + esc(v) + '</td></tr>').join('\n');
    const body = rows.map((r, i) =>
      '<tr><td>' + (i === 0 ? esc($('fClip').value) : '') + '</td><td>' + (r.isQuestion ? '' : formatTime(r.start)) + '</td><td>' +
      (r.isQuestion ? '<b>' + esc(r.text) + '</b>' : esc(r.text)) +
      (r.translation ? ' <i>[' + esc(r.translation) + ']</i>' : '') + '</td><td>' +
      esc(r.speakerOverride || speakerName(r)) + '</td></tr>').join('\n');
    return '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Transcription SHEET - ' +
      esc($('fClip').value) + '</title></head><body>\n<h1>Transcription SHEET</h1>\n<table>\n' + head +
      '\n</table>\n<p><i>* For FTP uploads with no timecode, please list shots in order by CLIP NUMBER.</i></p>\n<table>\n<tr><th>CLIP NUMBER</th><th>Time Code</th><th>Transcription</th><th>INTERVIEW</th></tr>\n' +
      body + '\n</table>\n</body></html>\n';
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
      if (samples.length < 2) return null;
      const first = samples[0], last = samples[samples.length - 1];
      const dt = last.mediaTime - first.mediaTime;
      const df = last.presentedFrames - first.presentedFrames;
      if (dt <= 0 || df <= 0) return null;
      return df / dt;
    } catch (e) {
      try { video.pause(); } catch (err) { /* ignore */ }
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
      const fps = await measureFrameRate(preview);
      if (fps) $('fFrameRate').value = fps.toFixed(2).replace(/\.?0+$/, '') + ' fps';
    }, { once: true });
  }

  fileInput.addEventListener('change', () => {
    file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
    $('fileName').textContent = file ? file.name + ' (' + (file.size / 1048576).toFixed(1) + ' MB)' : '';
    $('fileMeta').textContent = '';
    startBtn.disabled = !file;
    if (file) {
      $('videoBox').hidden = false;
      $('preview').src = URL.createObjectURL(file);
      autoFillFromFile();
    }
  });

  startBtn.addEventListener('click', async () => {
    if (!file) return;
    cancelled = false;
    rows = [];
    renderRows();
    startBtn.disabled = true;
    cancelBtn.disabled = false;
    try {
      setStatus('Reading audio from the video...', 2);
      detailEl.textContent = 'This can take a moment for a long file.';
      const audio = await extractAudio(file);
      if (cancelled) return;
      const minutes = (audio.length / 16000 / 60).toFixed(1);
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
          const slice = audio.slice(Math.floor(row.start * 16000), Math.floor(row.end * 16000));
          if (slice.length < 16000) continue;
          const tr = await send('translate', { audio: slice });
          const english = (tr.text || '').trim();
          if (english && !sameText(row.text, english)) row.translation = english;
          renderRows();
        }
      }
      setStatus('Done. ' + rows.length + ' rows.', 100);
      detailEl.textContent = 'Times are HH:MM:SS. Question rows have a blank Time Code, as in the template.';
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

  $('copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(tableAsText());
      setStatus('Copied to clipboard.', 100);
    } catch (e) {
      setStatus('Copy failed - select the table and copy it manually.', 100);
    }
  });
  $('downloadHtml').addEventListener('click', () => {
    download((file ? file.name.replace(/\.[^.]+$/, '') : 'transcript') + '-transcript.html', tableAsHtml(), 'text/html');
  });
  $('downloadTxt').addEventListener('click', () => {
    download((file ? file.name.replace(/\.[^.]+$/, '') : 'transcript') + '-transcript.txt', tableAsText(), 'text/plain');
  });
  $('printBtn').addEventListener('click', () => window.print());
  $('fInterviewer').addEventListener('input', renderRows);
  $('fInterviewees').addEventListener('input', renderRows);
  $('fClip').addEventListener('input', renderRows);
})();
