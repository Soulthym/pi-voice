# Configuration

[← README](../README.md) · [Commands](commands.md) · [Devices](devices-and-ssh.md)

Pi Voice reads `~/.pi/agent/pi-voice.json` by default. Unknown or invalid values fall back to defaults. Commands persist changes atomically; use [`pi-voice.example.json`](../pi-voice.example.json) as a copyable example.

## Settings

| Setting | Default | Valid values and behavior |
| --- | --- | --- |
| `enabled` | `false` | Enables spoken output. Dictation remains separately available. |
| `mode` | `assistant` | `assistant`, `all`, or final-response-only `yield`. |
| `voice` | `af_heart` | A voice ID from the bundled Kokoro catalog. |
| `speed` | `1` | `0.5..2`. |
| `ttsModel` | `onnx-community/Kokoro-82M-v1.0-ONNX` | `kokoro-js`-compatible Hugging Face repository. |
| `ttsDtype` | `q8` | `fp32`, `q8`, or `q4`, if supplied by the repository. |
| `sttModel` | `onnx-community/whisper-tiny.en` | Transformers.js ASR repository. |
| `sttDtype` | `fp32` | `fp32`, `q8`, or `q4`. |
| `sttCandidates` | `3` | Final ASR hypotheses, `1..8`. |
| `alignmentModel` | `onnx-community/wav2vec2-base-960h-ONNX` | Transformers.js CTC repository. |
| `alignmentDtype` | `q8` | `fp32`, `q8`, or `q4`. |
| `editModel` | `current` | `current` or a Pi-registered `provider/model-id`. |
| `output` | `auto` | `auto`, `local`, `tcp://host:port`, or `unix:///absolute/path`. |
| `input` | `auto` | `auto`, `local`, `disabled`, TCP, or Unix endpoint. |
| `talkShortcut` | `alt+m` | Pi key identifier such as `alt+m`, `ctrl+shift+m`, `f5`, or `disabled`. |
| `submitMode` | `review` | `review` or `auto`. |
| `editMode` | `smart` | `smart` or `append`. |
| `playbackHighlight` | `true` | Enables progressive prose/code highlighting. |
| `codeNarration` | `guided` | `guided` synchronized focus or plain `summary`. |
| `codeDescriptionPreprocessConcurrency` | `4` | Parallel model requests, `1..8`. |
| `timingPreprocessConcurrency` | `auto` | `auto` or CPU workers `1..8`. Auto caps at four and considers RAM/CPU. |
| `audioCache` | `true` | Enables content-addressed Opus segment caching. |
| `audioCacheBitrate` | `32` | VBR Opus target in kbps, `12..128`. |

Changing model, dtype, voice, speed, narration dependencies, or cache bitrate changes render identity. Pi Voice rebuilds only affected timing/audio data.

## Voice catalog

| ID | Voice |
| --- | --- |
| `af_heart` | Heart, American female |
| `af_bella` | Bella, American female |
| `af_nicole` | Nicole, American female |
| `af_aoede` | Aoede, American female |
| `af_kore` | Kore, American female |
| `af_sarah` | Sarah, American female |
| `am_michael` | Michael, American male |
| `am_fenrir` | Fenrir, American male |
| `am_puck` | Puck, American male |
| `bf_emma` | Emma, British female |
| `bm_george` | George, British male |
| `bm_fable` | Fable, British male |

Use `/voice voice` for an interactive picker or `/voice voice <id>` directly.

## Automatic and explicit devices

`auto` prefers the device inherited from `pi-voice-ssh`, then the most recently active registered client, then local devices. Explicit `local`, `disabled`, TCP, and Unix values bypass automatic endpoint selection.

`/voice device` is a per-session preference persisted as a non-context-injecting Pi custom entry. It does not change the global JSON endpoint settings. See [Devices and SSH](devices-and-ssh.md).

## Model-assisted features

`editModel` handles:

- final ASR candidate resolution;
- smart spoken editing;
- code and patch descriptions.

`current` follows Pi's active model without assuming a provider or model family. A remote model receives the text needed for that isolated operation; see [Models and privacy](models-and-privacy.md).

## Persistent data

- Model weights: `~/.cache/pi-voice/models`
- Cached Opus: `~/.cache/pi-voice/audio`
- Coordinator state: `~/.cache/pi-voice/coordinator`
- Device registrations: `~/.cache/pi-voice/devices`
- Timing maps, code descriptions, and per-session device choice: non-context-injecting Pi custom session entries

No raw PCM is persisted.
