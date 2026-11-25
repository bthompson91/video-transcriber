# Video Transcriber

In-browser Whisper transcription for video files, producing a
transcription sheet like the template: a header form on top, then a
table with CLIP NUMBER, Time Code, Transcription, INTERVIEW.

No server, no upload. Open the GitHub Pages site, pick a video file,
and the page downloads a multilingual Whisper model once (cached by
the browser afterwards) and transcribes the audio on your device.

Phone decoding: iOS Safari cannot decode .mts / .m2ts (AVCHD) and
chokes on some iPhone-recorded .mov files too, so if the browser's
own decoder fails, the page falls back to ffmpeg.wasm to convert the
file to a 16 kHz mono WAV in the browser first. It uses the
single-threaded core (@ffmpeg/core-st 0.11.1, with mainName 'main'):
the normal core needs SharedArrayBuffer, which needs cross-origin
isolation headers that GitHub Pages does not send. One-time ~30 MB
core download, cached afterwards. The file still never leaves the
device.

Phone memory: the Turbo model plus the converter plus the video can
make Safari reload the tab, losing the picked file. So on a phone
the page skips the frame-rate check that plays the video, and saves
the picked file in IndexedDB (and the header in localStorage) so a
reload restores it. Files over 400 MB on a phone get a warning; a
shorter clip or 1080p instead of 4K is safer.

## How rows are made

A new row starts when:

- the speaker changes (a sentence ending in `?` is the interviewer's
  question, anything else is the interviewee's answer - Whisper has
  no speaker diarization, so questions are the signal, and every
  INTERVIEW cell is editable to fix a speaker),
- the speaker stops to gather their thoughts (a pause of 0.8s or more
  between Whisper chunks), or
- a row reaches the chosen interval (10 or 30 seconds, default 10).

Questions are bold. Every row carries a HH:MM:SS Time Code,
questions included. Clip Number is the file name, on the first
row only.

If the text is in Tagalog, an English translation is added after it
in brackets and italic, using Whisper's own translate pass on the
same model - no second model to download. English rows get no
bracket, because the translate pass returns the same English.

The first pass transcribes only: it is told the language is
Tagalog (`tl`), so Tagalog speech comes out as Tagalog text.
transformers.js defaults the language to English when none is
given, and Whisper told the language is English will output
English for Tagalog audio - translating on the transcribe pass
instead of transcribing it. The English version comes only from
the separate translate pass.

## Layout

Two columns on a wide screen: controls, video and the header form
on the left, the transcript on the right. On a phone it stacks.
On a wide screen the page itself does not scroll: the left side
and the transcript are each their own scrollable frame, so you
can scroll one without losing your place in the other. The video
is not pinned; it scrolls with the left frame. Click a Time Code
in the transcript to jump the video to that point and play from
there. Dark mode follows the device setting
(`prefers-color-scheme`); it is dark blue, not brown.

## Downloads

Two download options, both named after the video file:

- Word (.docx): the full sheet - title, header form, then the
  CLIP NUMBER / Time Code / Transcription / INTERVIEW table.
  Questions bold, translations in brackets and italic. Built in
  the browser with the docx library (loaded on demand from a CDN).
- SRT (.srt): one subtitle per row, timed from when its speech
  starts to when it ends, with a translation on a second line
  when there is one.

`IMG_3436.MOV` downloads as `IMG_3436.docx` and `IMG_3436.srt`.

## Header form

The top half is filled in by hand, except what the page can work
out from the file:

- Clip Numbers: the file name
- File Format: the file extension
- Codec: read from the MP4/MOV header where possible (H.264, H.265,
  AV1...); .mts is H.264 / AVCHD
- Frame rate: measured from the preview video (the browser exposes
  no frame rate directly)
- Bitrate: file size divided by duration
- Date of event: the file's modified date, as a starting point

There can be several interviewees in one file: list them comma
separated in the header form, and pick the speaker on each row from
its INTERVIEW dropdown. Questions default to the interviewer,
answers default to the first interviewee. Whisper cannot tell
interviewees apart, so the dropdown is the way to fix it.

## Models

Small, Large v3 Turbo (all multilingual, `onnx-community` builds).
Large v3 Turbo is the default and the best accuracy, and needs
WebGPU; Small is the lighter option and still good on Tagalog.
Tiny and Base are not offered: in testing they hallucinate and
produce poor transcripts. English-only `.en` models are not
offered: they cannot do Tagalog.

## Files

- `docs/index.html` - the page and header form
- `docs/app.js` - audio extraction, row grouping, translation, export
- `docs/worker.js` - Whisper in a Web Worker (transformers.js,
  `onnx-community/whisper-small` or `whisper-large-v3-turbo`)
- `docs/style.css`

## Publishing

GitHub Pages, source `docs/` on `main`. Videos are 5-10 min
typically; a 5-10 min video takes a few minutes to transcribe in
the browser, depending on the machine and model.
