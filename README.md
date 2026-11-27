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
file to a 48 kHz mono WAV in the browser first. It uses the
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

If the text is in Tagalog and the Translate box is ticked, an
English translation is added after it in brackets and italic,
using a local text model, not Whisper: Meta's NLLB-200 distilled
600M (Xenova/nllb-200-distilled-600M, ONNX int8 quantized,
~900 MB), loaded from Hugging Face Hub. It translates the
transcribed text, so it cannot loop the way Whisper's translate
pass did (that pass once filled a bracket with "I think" repeated
hundreds of times). NLLB replaced the smaller opus-mt-tl-en model,
which mangled Taglish and English loanwords. Translation is off by
default and the model only downloads when you tick the box, cached
afterwards. English rows get no bracket, because the model returns
the same English.

Every Transcription cell is editable on the page: click the text
or the translation in brackets and type, or pick a different
speaker from the INTERVIEW dropdown. Edits write straight back
to the row, and the Word and SRT downloads are built from the
rows, so the downloaded files are the edited version. Clearing
the bracket translation removes it from the downloads for that
row.

The first pass transcribes only: it is told the language is
Tagalog (`tl`), so Tagalog speech comes out as Tagalog text.
transformers.js defaults the language to English when none is
given, and Whisper told the language is English will output
English for Tagalog audio - translating on the transcribe pass
instead of transcribing it. The English version comes only from
the separate text translation model, which translates the
transcribed text, not the audio.

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

Four download options, all named after the video file:

- Word (.docx): the full sheet - title, header form, then the
  CLIP NUMBER / Time Code / Transcription / INTERVIEW table.
  Questions bold, translations in brackets and italic. Built in
  the browser with the docx library (loaded on demand from a CDN).
- SRT (.srt): one subtitle per row, timed from when its speech
  starts to when it ends, with a translation on a second line
  when there is one.
- English subtitles (.en.srt): the translations only, one subtitle
  per translated row, plain English text with no brackets - use it
  as the English subtitle track for the video. Rows with no
  translation are skipped. Edited translations come through here
  too.
- Cleaned audio (.wav): the video's audio with background noise
  reduced and speech boosted, full length and in sync with the
  video, for listening or laying back under the video in an
  editor. Only made when the Clean up audio box is ticked.

`IMG_3436.MOV` downloads as `IMG_3436.docx`, `IMG_3436.srt`,
`IMG_3436.en.srt` for the translation subtitles, and
`IMG_3436-clean.wav` for the cleaned audio.

## Audio preparation and cleanup

What Whisper hears is the video audio downmixed to mono, resampled
to 16 kHz, high-pass filtered at 80 Hz (removes rumble - HVAC,
traffic, handling noise - below the speech range) and peak
normalised to -1 dBFS, with the boost capped at +20 dB so
near-silent audio does not get its noise floor amplified. That is
the preprocessing that reliably helps transcription.

Denoising is deliberately not on the transcription path:
enhancement before Whisper usually makes transcription worse
(Whisper is trained on noisy audio; denoisers strip speech
harmonics along with the noise). So cleanup is a separate
deliverable. Tick Clean up audio and the page runs DeepFilterNet 3
on the original 48 kHz mono audio after transcription, then offers
the cleaned .wav: full length, 48 kHz mono, exactly the same
number of samples as the source, so it lines up with the video,
peak-normalised so the speech is louder. DeepFilterNet 3
(~8 MB of models plus a ~10 MB WASM runtime) runs entirely in the
browser, on your device, and only downloads when the box is
ticked. A 15 s clip cleans in a few seconds; a 10 min file takes
a few minutes.

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

Translation uses a separate local text model: Meta's NLLB-200
distilled 600M (Xenova/nllb-200-distilled-600M, ONNX int8
quantized, encoder ~419 MB + merged decoder ~475 MB, ~900 MB
total). It loads from Hugging Face Hub, like the Whisper models,
only when the Translate box is ticked. The q4 files are not used:
they are ~2.3 GB total, bigger than int8, because NLLB's huge
256k-vocab embedding matrix barely quantizes. Translation runs on
WASM, not WebGPU, because WebGPU translation crashes in
transformers.js.

Cleanup uses DeepFilterNet 3 (Rikorose/DeepFilterNet, mirrored at
trysem/DeepFilterNet3 on Hugging Face Hub): the WASM runtime
(df_bg.wasm, ~10 MB) and the model tarball
(DeepFilterNet3_onnx.tar.gz, ~8 MB: enc, erb_dec and df_dec ONNX
graphs) load from Hugging Face only when the Clean up audio box is
ticked. The app drives the WASM directly, frame by frame (480
samples = 10 ms), with ~120 lines of hand-written wasm-bindgen
glue in `docs/df3.js` - the npm package for it is worklet-only
(realtime mic) and its default CDN is dead, so it is not used.
Single-threaded WASM, no SharedArrayBuffer needed. The model's
30 ms algorithmic delay is removed from the front of the output,
so the cleaned audio is exactly the input length.

## Files

- `docs/index.html` - the page and header form
- `docs/app.js` - audio extraction, transcription-path prep
  (high-pass + normalisation), row grouping, translation, export
- `docs/worker.js` - Whisper in a Web Worker (transformers.js,
  `onnx-community/whisper-small` or `whisper-large-v3-turbo`), the
  local translation model (NLLB-200 distilled 600M, from
  Hugging Face Hub), and the DeepFilterNet cleanup
- `docs/df3.js` - DeepFilterNet 3 WASM glue and offline
  file-cleaning (48 kHz mono in, same-length 48 kHz mono out)
- `docs/style.css`

## Publishing

GitHub Pages, source `docs/` on `main`. Videos are 5-10 min
typically; a 5-10 min video takes a few minutes to transcribe in
the browser, depending on the machine and model.
