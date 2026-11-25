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

Phone memory: the Small model plus the converter plus the video can
make Safari reload the tab, losing the picked file. So on a phone
the page defaults to the smaller Base model, skips the frame-rate
check that plays the video, and saves the picked file in IndexedDB
(and the header in localStorage) so a reload restores it. Files
over 400 MB on a phone get a warning; a shorter clip or 1080p
instead of 4K is safer.

## How rows are made

A new row starts when:

- the speaker changes (a sentence ending in `?` is the interviewer's
  question, anything else is the interviewee's answer - Whisper has
  no speaker diarization, so questions are the signal, and every
  INTERVIEW cell is editable to fix a speaker),
- the speaker stops to gather their thoughts (a pause of 0.8s or more
  between Whisper chunks), or
- a row reaches the chosen interval (10 or 30 seconds, default 30).

Questions are bold, with a blank Time Code, as in the template.
Answers carry a HH:MM:SS Time Code. Clip Number is the file name,
on the first row only.

If the text is in Tagalog, an English translation is added after it
in brackets and italic, using Whisper's own translate pass on the
same model - no second model to download. English rows get no
bracket, because the translate pass returns the same English.

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

## Files

- `docs/index.html` - the page and header form
- `docs/app.js` - audio extraction, row grouping, translation, export
- `docs/worker.js` - Whisper in a Web Worker (transformers.js,
  `onnx-community/whisper-base` or `whisper-small`)
- `docs/style.css`

## Publishing

GitHub Pages, source `docs/` on `main`. Videos are 5-10 min
typically; a 5-10 min video takes a few minutes to transcribe in
the browser, depending on the machine and model.
