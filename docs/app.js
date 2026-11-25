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

  async function extractAudio(file) {
    const buf = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(buf);
    } finally {
      try { await ctx.close(); } catch (e) { /* ignore */ }
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

  function speakerName(row) {
    const name = row.speaker === 'interviewer' ? $('fInterviewer').value.trim() : $('fInterviewee').value.trim();
    return name || (row.speaker === 'interviewer' ? 'Interviewer' : 'Interviewee');
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
      whoTd.contentEditable = 'true';
      whoTd.textContent = speakerName(row);
      whoTd.addEventListener('input', () => { row.speakerOverride = whoTd.textContent; });
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
      ['Interviewer', $('fInterviewer').value], ['Interviewee', $('fInterviewee').value],
      ['PA/Sound', $('fPaSound').value], ['HD or SD', $('fHdSd').value],
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

  // Auto-fill what the file itself tells us: Clip Number is the file
  // name, File Format is the extension, HD/SD comes from resolution.
  function autoFillFromFile() {
    if (!file) return;
    $('fClip').value = file.name;
    const ext = file.name.includes('.') ? file.name.split('.').pop().toUpperCase() : '';
    $('fFormat').value = ext;
    const d = new Date(file.lastModified);
    if (!isNaN(d)) $('fDate').value = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
    const preview = $('preview');
    preview.addEventListener('loadedmetadata', () => {
      const w = preview.videoWidth, h = preview.videoHeight;
      const dur = preview.duration;
      $('fileMeta').textContent = (w && h ? w + 'x' + h + ' - ' : '') +
        (isFinite(dur) ? Math.round(dur) + 's - ' : '') +
        (w >= 1280 || h >= 720 ? 'HD' : (w ? 'SD' : ''));
      if (w) $('fHdSd').value = (w >= 1280 || h >= 720) ? 'HD' : 'SD';
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
  $('fInterviewee').addEventListener('input', renderRows);
  $('fClip').addEventListener('input', renderRows);
})();
