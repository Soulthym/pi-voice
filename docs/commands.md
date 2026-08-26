# Command reference

[← README](../README.md) · [Usage](usage.md) · [Configuration](configuration.md)

Bare `/voice` is an alias for `/voice status`.

## Runtime and input

| Command | Effect |
| --- | --- |
| `/voice status` | Shows active mode, models, device, cache, preprocessing, shortcut, and editing settings. |
| `/voice on` | Enables spoken output. |
| `/voice off` | Disables and stops spoken output; dictation remains available. |
| `/voice toggle` | Toggles spoken output. |
| `/voice stop` | Cancels speech and requests stop for an active recording. |
| `/voice setup` | Explicitly warms Kokoro and Wav2Vec2 alignment. Whisper still loads on first transcription. |
| `/voice test [text]` | Speaks test text or a default readiness phrase. |
| `/voice talk` | Starts/stops microphone dictation. |
| `/voice attention` | Plays this session's waiting response or requests playback from the oldest waiting project. |
| `/voice timing` | Reports recent audio-to-highlight and highlight-to-render diagnostic latency. |

## Speech and narration

```text
/voice mode assistant|all|yield
/voice voice [voice-id]
/voice speed <0.5..2>
/voice highlight on|off
/voice autoscroll on|off
/voice code-narration guided|summary
```

`assistant` streams normal assistant text. `all` includes thinking. `yield` waits for the completed final response. `guided` code narration synchronizes line/bold focus; `summary` shows and speaks a plain description. `autoscroll` persists the exact-word TUI follow setting; it defaults to `on`.

## Models

```text
/voice tts-model <huggingface-repo>
/voice tts-dtype fp32|q8|q4
/voice stt-model <huggingface-repo>
/voice stt-dtype fp32|q8|q4
/voice stt-candidates <1..8>
/voice alignment-model <huggingface-repo>
/voice alignment-dtype fp32|q8|q4
/voice edit-model current|provider/model-id
```

Weights download lazily. A selected dtype must exist in that repository.

## Dictation behavior

```text
/voice shortcut <key|disabled>
/voice submit review|auto
/voice edit smart|append
/voice input auto|local|disabled|tcp://host:port|unix:///path
```

Shortcut names follow Pi's format, for example `alt+m`, `ctrl+shift+m`, or `f8`. Run `/reload` after changing the shortcut because extension shortcuts are registered during loading. Setting it to `disabled` also disables F5.

`review` leaves recognized text in the editor; `auto` submits it. `smart` may apply spoken edits to the original draft; `append` resolves ASR ambiguity but keeps correction phrases literal.

## Output and devices

```text
/voice device auto|local|<connected-device-id>
/voice output auto|local|tcp://host:port|unix:///path
```

`device` stores a per-session routing preference. `output` controls the global endpoint policy. Output-producing controls automatically claim the current session's selected device.

## Preprocessing and cache

```text
/voice code-preprocess <1..8>
/voice scroll-to
/voice bottom
/voice code-budget [unlimited|<n>]
/voice timing-preprocess auto|<1..8>
/voice audio-cache on|off
/voice audio-bitrate <12..128>
```

`scroll-to` re-anchors the current narrated position at 20% without changing play/pause state; its default shortcut is `Alt+V`. `bottom` pins the transcript to its end and restores normal transcript-end following, including while narration remains active; its default shortcut is `Alt+T`.

`code-budget` reports or raises the session-only historical backfill allowance (`scope` and default budget come from the config) and resumes skipped blocks.

Code concurrency controls parallel `editModel` requests and is explicit. Timing `auto` derives a CPU worker limit from available RAM and CPU, capped at four. Disabling audio caching does not delete existing Opus files.
