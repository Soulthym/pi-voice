# Configuration

[← README](../README.md) · [Commands](commands.md) · [Devices](devices-and-ssh.md)

Pi Voice reads `~/.pi/agent/pi-voice.json` by default. Unknown settings and invalid enumerated/range values fall back to defaults; nonempty voice/model IDs still require compatible assets at runtime. Explicit setting values persist changes atomically; omitting the value queries the effective setting without changing state (see [Commands](commands.md)). Use [`pi-voice.example.json`](../pi-voice.example.json) as a copyable example; it deliberately sets `enabled: true`, unlike the default.

## Settings

| Setting | Default | Valid values and behavior |
| --- | --- | --- |
| `enabled` | `false` | Enables spoken output. Dictation remains separately available. |
| `mode` | `assistant` | `assistant`, `all`, or final-response-only `yield`. |
| `voice` | `af_heart` | A voice ID from the bundled Kokoro catalog. |
| `speed` | `1` | `0.5..2`. |
| `ttsModel` | `onnx-community/Kokoro-82M-v1.0-ONNX` | `kokoro-js`-compatible Hugging Face repository. |
| `ttsDtype` | `q8` | `fp32`, `q8`, or `q4`, if supplied by the repository. |
| `ttsWorkers` | `3` | Playback synthesis/lookahead limit, integer `1..8`; change live with `/voice tts-workers <1..8>`. Not an asset dependency. |
| `sttModel` | `onnx-community/whisper-tiny.en` | Transformers.js ASR repository. |
| `sttDtype` | `fp32` | `fp32`, `q8`, or `q4`. |
| `sttCandidates` | `3` | Live and final ASR hypotheses, `1..8`. |
| `alignmentModel` | `onnx-community/wav2vec2-base-960h-ONNX` | Transformers.js CTC repository. |
| `alignmentDtype` | `q8` | `fp32`, `q8`, or `q4`. |
| `editModel` | `current` | `current` or a Pi-registered `provider/model-id`. |
| `output` | `auto` | `auto`, `local`, `tcp://host:port`, or `unix:///absolute/path`. |
| `input` | `auto` | `auto`, `local`, `disabled`, TCP, or Unix endpoint. |
| `talkShortcut` | `alt+m` | Pi key identifier such as `alt+m`, `ctrl+shift+m`, `f4`, or `disabled`. |
| `scrollToShortcut` | `alt+v` | Re-anchor the current narrated position. `/voice scroll-to` does the same. |
| `scrollBottomShortcut` | `alt+t` | Pin the transcript to its end and resume transcript-end following. `/voice bottom` does the same. |
| `submitMode` | `review` | `review` or `auto`. |
| `editMode` | `smart` | `smart` or `append`. |
| `playbackHighlight` | `true` | Enables progressive prose/code highlighting. |
| `autoScroll` | `true` | Locates the exact rendered spoken word, initially places it at 20% from the top (clamped near transcript ends), follows within the 20–80% band thereafter; manual scrolling overrides following until an explicit follow/navigation action. |
| `codeNarration` | `guided` | `guided` synchronized focus or plain `summary`. |
| `codeDescriptionContext` | `block-only` | `block-only` sends only the concerned fence; `conversation` also sends its resolved historical discussion. |
| `codeDescriptionPreprocessScope` | `since-compaction` | Background preprocessing covers only messages retained by the latest compaction (`all` revisits the entire branch). |
| `codeDescriptionPreprocessBudget` | `25` | Historical backfill requests per session load: `0` disables, a positive integer caps, `unlimited` removes the cap. Live narration and replay never consume it. |
| `codeDescriptionPreprocessConcurrency` | `4` | Parallel model requests, `1..8`. |
| `timingPreprocessConcurrency` | `auto` | `auto` or CPU workers `1..8`. Auto caps at four and considers RAM/CPU. |
| `audioCache` | `true` | Enables content-addressed Opus segment caching. |
| `audioCacheBitrate` | `32` | VBR Opus target in kbps, `12..128`. |

Changing TTS model/dtype, voice, speed, narration dependencies, or cache bitrate changes render identity. Pi Voice rebuilds only affected timing/audio data. Changing `editModel` affects description cache misses, not existing compatible assets; STT/alignment model selection is not part of speech render identity.

For playback concurrency, a valid persisted `ttsWorkers` wins over legacy `PI_VOICE_TTS_WORKERS`; if absent/invalid, a valid environment value is used, then `3`. Saving settings persists the effective value, so later environment changes no longer override it. Runtime changes apply to this Pi session immediately and future sessions on load, not other already-running sessions.

The three shortcut settings are registered when the extension loads, so edit their JSON values and run `/reload`. The old `ctrl+e` and `alt+end` bottom defaults are migrated because Pi reserves Ctrl+E for editor line-end and compact Termux keyboards may have no End key. The current defaults avoid Ctrl, Shift, and an End key.

The device picker uses fixed **Alt+D** and `/voice devices`; there is no new JSON setting. Alt+D deliberately overrides Pi's default forward-delete-word (Alt+Delete remains). A loaded voice shortcut already using Alt+D wins instead, with a warning; Pi also diagnoses its own/custom-extension conflicts. See [picker controls](usage.md#device-picker). Open/cancel never saves settings; choosing persists only the session pin and leaves endpoint overrides unchanged.

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

Use `/voice voice` to report the current voice, or `/voice voice <id>` to set it. Argument completion lists available voices.

## Automatic and explicit devices

`auto` uses the session's saved current-connection pin. New sessions resolve fresh attachment identity; ambiguous or unavailable identity fails closed, never falling back to the newest registered client or host audio. Genuinely local connections can pin local I/O. Explicit `local`, `disabled`, TCP, and Unix values bypass automatic endpoint selection.

`/voice device <exact-id>`, `/voice device "unique name"`, `next`, `prev`, and `local` set a sticky per-session selection persisted in the existing non-context-injecting Pi custom entry. Reload and ordinary controls retain that manual mode; successful `/voice reconnect` or `/voice device auto` returns to automatic attachment adoption. Failed handoff retains the old pin/mode. `/voice device` lists candidates and the effective selection read-only. Names are labels, not credentials. These commands do not change global JSON settings: explicit per-direction endpoint overrides keep precedence, and custom endpoints are not mapped to a guessed host. See [Devices and SSH](devices-and-ssh.md).

## Model-assisted features

`editModel` handles:

- final ASR candidate resolution;
- smart spoken editing;
- code and patch descriptions.

`current` follows Pi's active model without assuming a provider or model family.

For the best discussion-aware code narration, set `codeDescriptionContext` to `conversation`. This allows `editModel` to receive Pi's resolved provider-compatible history through the next fence opening or containing message end, potentially including images, compaction summaries, tool calls, and tool results. Conversation mode also sends the available effective system prompt and active tool schemas to the selected narrator. Using `editModel: "current"` can make the normal request prefix provider-cache eligible. Keep the privacy-safe `block-only` default if that context should not be sent to a remote provider. See [Models and privacy](models-and-privacy.md).

## Preprocessing scope and budget

Background description work is split from live work:

- **Live descriptions** for newly completed messages always run on demand and never consume budget.
- **Historical backfill** (startup catch-up after reload, compaction, or dependency changes) is bounded twice:
  - `codeDescriptionPreprocessScope`: `since-compaction` processes only messages the latest compaction retained; sessions without compaction process everything.
  - `codeDescriptionPreprocessBudget`: maximum backfill model requests per session load. Cache hits, coalesced requests, preflight failures and live/replay requests are free; failed provider attempts still count.
- When the budget is exhausted, remaining blocks stay missing and Pi Voice notifies once. `/voice code-budget unlimited` (or a number) authorizes a fresh allowance for the current session only and resumes skipped blocks; ordinary sweeps and unrelated settings never replenish it; `/voice code-budget` reports scope, allowance, and usage.

## Persistent data

- Model weights: `~/.cache/pi-voice/models`
- Cached Opus: `~/.cache/pi-voice/audio`
- Coordinator state: `~/.cache/pi-voice/coordinator`
- Device registrations: `~/.cache/pi-voice/devices`
- Timing maps, code descriptions, and per-session device choice: non-context-injecting Pi custom session entries

No raw PCM is persisted.
