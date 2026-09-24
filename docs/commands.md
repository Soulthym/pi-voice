# Command reference

[← README](../README.md) · [Usage](usage.md) · [Configuration](configuration.md)

Bare `/voice` is an alias for `/voice status`.

Every value-setting command below accepts an omitted value to report its **current effective value**, without saving configuration, starting/reconfiguring workers, changing playback/ownership/transcript following, resetting budgets, or calling a provider. Brackets mark optional values. Explicit values retain their normal validation and setting behavior.

Automatic input/output and device queries show the resolved route (including an active device pin); `edit-model current` shows Pi's current model or `unavailable`. `timing-preprocess` shows the currently resolved limit and, when running, the active batch limit. `shortcut` shows the loaded binding (and F4 alias), plus any configured change awaiting `/reload`. `code-budget` retains its scope/allowance/usage report.

Action commands (`on`, `off`, `toggle`, `stop`, `setup`, `test`, `talk`, `attention`, `reconnect`, `scroll-to`, `bottom`, and `code-retry`) retain their intentional behavior; they are not setting queries. `status`, `timing` and `help` are read-only reports.

## Runtime and input

| Command | Effect |
| --- | --- |
| `/voice status` | Groups mode, playback, models, device, cache, preprocessing and editing settings. |
| `/voice help` | Lists controls and commands, including the Termux action symbols. |
| `/voice on` | Enables spoken output. |
| `/voice off` | Disables and stops spoken output; dictation remains available. |
| `/voice toggle` | Toggles spoken output. |
| `/voice stop` | Hard-cancels speech, dictation processing and queued attention; retains ownership until device stop is confirmed. |
| `/voice setup` | Explicitly warms Kokoro and Wav2Vec2 alignment. Whisper still loads on first transcription. |
| `/voice test [text]` | Speaks test text or a default readiness phrase. |
| `/voice talk` | Starts/stops microphone dictation. |
| `/voice attention` | Explicitly attend the oldest eligible waiting session using the origin session's sticky manual pin (fresh attachment identity in auto mode); replay this project if current/none waiting. Requires enabled voice. F5 remains own-project replay. |
| `/voice timing` | Shows selected timing quality and recent audio-to-highlight/highlight-to-render diagnostic latency. |

## Speech and narration

```text
/voice mode [assistant|all|yield]
/voice voice [voice-id]
/voice speed [0.5..2]
/voice tts-workers [1..8]
/voice tts-worker [1..8]
/voice highlight [on|off]
/voice autoscroll [on|off]
/voice code-narration [guided|summary]
```

`voice` without an ID reports the current voice instead of opening a picker; use argument completion or the [voice catalog](configuration.md#voice-catalog) to choose an explicit ID.

`assistant` streams normal assistant text. `all` includes thinking. `yield` waits for the completed final response. `guided` code narration synchronizes line/bold focus; `summary` shows and speaks a plain description. `autoscroll` persists the exact-word TUI follow setting; it defaults to `on`.

`tts-workers` without an argument reports the effective current concurrency without changing config or runtime state. `tts-worker` is an alias for both querying and setting it.

`tts-workers` with an argument persists playback synthesis concurrency (default 3) and applies immediately without restarting Pi. Lowering it bounds new lookahead immediately; already-started sentences finish and play in order, and excess model workers retire when idle. Increasing it fills the larger lookahead lazily. It does not stop/resume audio, release ownership, invalidate assets, or change separate timing/description preprocessing limits. `/voice status` shows `tts-workers`.

## Models

```text
/voice tts-model [huggingface-repo]
/voice tts-dtype [fp32|q8|q4]
/voice stt-model [huggingface-repo]
/voice stt-dtype [fp32|q8|q4]
/voice stt-candidates [1..8]
/voice alignment-model [huggingface-repo]
/voice alignment-dtype [fp32|q8|q4]
/voice edit-model [current|provider/model-id]
```

Weights download lazily. A selected dtype must exist in that repository.

## Dictation behavior

```text
/voice shortcut [key|disabled]
/voice submit [review|auto]
/voice edit [smart|append]
/voice input [auto|local|disabled|tcp://host:port|unix:///path]
```

Shortcut names follow Pi's format, for example `alt+m`, `ctrl+shift+m`, or `f8`. Run `/reload` after changing the shortcut because extension shortcuts are registered during loading. Setting it to `disabled` also disables the automatic F4 microphone alias, not F5 replay. Custom shortcuts (including `f11`) retain existing collision rules.

`review` leaves recognized text in the editor; `auto` submits it. `smart` may apply spoken edits to the original draft; `append` resolves ASR ambiguity but keeps correction phrases literal.

## Output and devices

```text
/voice devices
/voice device [auto|local|next|prev|<exact-device-id>|"unique device name"]
/voice reconnect
/voice output [auto|local|tcp://host:port|unix:///path]
```

`devices` opens the same native picker as Alt+S or the existing badge click; click an option or use arrows/Enter/Escape to select/cancel; the overlay preserves an underlying select/confirm prompt. Opening/cancelling is read-only; only choosing runs the explicit safe transition. See [mouse support and shortcut conflicts](usage.md#device-picker).

`device` without a value lists registered candidates and the current selection, read-only and without readiness probes. Exact IDs or unique exact names select a **sticky session pin**, preserved by reload and ordinary controls; ambiguous names report IDs. Quotes preserve spaces. `next`/`prev` wrap in stable ID order over valid, apparently available registrations, excluding unregistered local/legacy entries. Zero candidates changes nothing; one selects itself; missing current selects first/last respectively.

Selection waits for actual old-player/recorder stop, finalizes recording into the draft without submission or overwriting manual edits, and preserves existing playback paused at its cursor. Idle/input-only selection does not pause a future automatic response. It does not start the new device. Failed handoff retains the old selection and ownership. F8 resumes; F5 replays. The headphone badge `[🎧:device]` (name or short ID) appears once at the right end of the first VoiceUI line, including idle status, not in Pi's footer. Supported fullscreen badge clicks or Alt+S open the picker. Playback uses the compact phases and separate chronological `● live` indicator described in [status](usage.md#highlighting-and-status); `/voice bottom` does not make playback live.

`/voice reconnect` and `/voice device auto` return to auto mode after successful fresh-attachment adoption; failure leaves the old pin/mode. Only in auto mode can ordinary replay/resume repin (non-`auto` output bypasses ordinary adoption). `input`/`output` explicit local/disabled/custom settings retain precedence and are never rewritten by device selection. Anyone sharing the terminal may issue this command; names are not authentication and no key sender is identified. See [Devices and SSH](devices-and-ssh.md).

## Timeline, preprocessing, and cache

```text
/voice code-preprocess [1..8]
/voice scroll-to
/voice bottom
/voice code-budget [unlimited|<n>]
/voice code-retry current
/voice code-retry historical [all|<message-id>]
/voice timing-preprocess [auto|<1..8>]
/voice audio-cache [on|off]
/voice audio-bitrate [12..128]
```

`scroll-to` re-anchors the current narrated position at 20% without changing play/pause state; its default shortcut is `Alt+V`. `bottom` pins the transcript to its end and restores normal transcript-end following, including while narration remains active; its default shortcut is `Alt+T`.

`code-budget` reports or explicitly resets the session-only historical backfill allowance (`scope` and default budget come from the config) and resumes skipped blocks. `code-retry current` retries recoverable omitted descriptions on the selected playback message when it remains in the configured historical scope. `code-retry historical` opens a picker; pass `all` or a message-ID substring to select non-interactively. Retries still respect the session backfill allowance. Richer regeneration selection is not implemented; this basic picker and these explicit retry commands are the available controls.

Code concurrency controls parallel `editModel` requests and is explicit. Timing `auto` derives a CPU worker limit from available RAM and CPU, capped at four. Disabling audio caching does not delete existing Opus files.
