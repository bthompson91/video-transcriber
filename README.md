# Video Transcriber

In-browser Whisper transcription for video files, producing a
transcription sheet like the template: a header form on top, then a
table with CLIP NUMBER, Time Code, Transcription, INTERVIEW.

No server, no upload. Open the GitHub Pages site, pick a video file,
and the page downloads a multilingual Whisper model once (cached by
the browser afterwards) and transcribes the audio on your device.

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
- HD or SD: from the video resolution (1280 wide or 720 high = HD)
- Date of event: the file's modified date, as a starting point

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
