# pi-voice

A bidirectional phone voice-mode extension for the [Pi coding agent](https://github.com/earendil-works/pi), modeled after Oh My Pi's Kokoro vocalizer.

- **Desktop → phone:** Pi runs Kokoro-82M locally and streams assistant speech through an SSH reverse tunnel to `mpv` in Termux.
- **Phone → desktop:** The configured shortcut streams Ogg/Opus from the Termux microphone through a second reverse tunnel. Desktop-side voice activity detection stops on natural silence, Whisper transcribes locally, and Pi places the result in the prompt editor for review.

Both tunnel endpoints bind only to loopback, and phone audio stays inside the encrypted SSH connection. The audio connection is full-duplex: the phone returns only `mpv` playback timestamps, not microphone data. Kokoro synthesis, Whisper transcription, and Wav2Vec2 alignment run locally on the desktop. Final ASR hypotheses are resolved against a bounded excerpt of the current session by Pi's configured editing model in both `append` and `smart` modes. The same model describes fenced code and patches for speech. If that model is remote, ASR hypotheses, existing drafts, recent session text, and fenced code being described are sent to its provider. Pin `editModel` to a local Pi-registered model to keep these requests local.

## Features

- Speaks assistant output while it streams.
- Runs `onnx-community/Kokoro-82M-v1.0-ONNX` locally with q8 weights.
- Keeps ONNX inference in child processes so Pi's TUI remains responsive. Phone playback and alignment events bypass the synthesis loop, so Kokoro cannot delay highlighting updates.
- Speaks `text`-like fenced blocks directly and applies the same sentence background and word-by-word playback progression used for normal prose. Markdown tables are narrated cell by cell: each `|` ends a spoken sentence, separator cells stay silent, and highlighting advances through the rendered row. In guided mode, code and patches stay visible but dim while a model-generated walkthrough reveals related line groups and bolds exact ranges in sync with narration. JavaScript and TypeScript fences use exact Tree-sitter syntax-node targets instead of model-guessed columns.
- Starts each code-description request as soon as its closing fence streams, using already queued speech as lead time while preserving spoken order; falls back to a local structural description if the request fails. Generated narrations are content-addressed and persisted as context-free Pi session entries, so replaying unchanged code does not spend more model tokens. Each narration is always shown in a bordered callout directly below its code block—even when voice mode is disabled—with the same dim/current/revealed playback progression as prose when spoken. Opening or loading a session schedules missing code descriptions newest-first; live narration and the written callout share the same in-flight request. A below-editor progress widget reports cumulative persisted progress, such as `Code descriptions: 24/61 processed`, so reloads visibly resume instead of restarting at one.
- Omits tables and most other Markdown noise from speech.
- Starts with a short first segment, then synthesizes bounded sentence/clause segments.
- Cancels queued speech when you send another prompt.
- Supports server-local playback or raw PCM over TCP/SSH.
- Slightly dims unread assistant prose, gives the currently spoken sentence or clause a subtle background, and restores each word as it is heard, using fast local CTC forced alignment plus live `mpv` playback-position feedback from the phone.
- Shows a classic playback timeline below the editor with play/pause/idle state, the current phone position, total narrated duration, and selected-message index. A `~` marks fallback clock estimates.
- Streams phone microphone audio in near real time and stops automatically after natural silence.
- Shows a revisable Whisper preview directly in Pi's editor while you speak.
- Supports a second `Alt+M` as a manual stop for long pauses or noisy environments.
- Leaves reviewed dictation in the editor by default; press Enter after correcting or extending it.
- Generates multiple final hypotheses with the same ASR model and lets any configured Pi model resolve technical ambiguities from recent context.
- Resolves candidates in both edit modes; `smart` additionally applies spoken corrections to the existing draft.

With voice mode enabled, model warm-up starts in the background when the extension loads. Kokoro setup downloads approximately 100 MB from Hugging Face. The first microphone transcription downloads approximately 150 MB of Whisper weights, and spoken-word alignment downloads approximately 100 MB of q8 Wav2Vec2 weights. Later synthesis, transcription, and alignment are local.

## Highlighting and worker architecture

The two recognition models have separate roles:

- **Whisper** transcribes microphone recordings and generates final dictation candidates.
- **Wav2Vec2 CTC** force-aligns known Kokoro text to synthesized audio; it is not used for microphone dictation.

For every spoken segment, Pi retains its source-text range and timing metadata, but not its PCM audio. Completed timing maps are persisted as Pi custom session entries, which are excluded from model context, so approximate seeking survives reloads and session resumes. When Pi opens or loads a session, missing timing annotations for speech-eligible assistant prose are scheduled newest-first for silent, low-priority Kokoro preprocessing. The same progress widget reports cumulative timing progress, such as `Speech timing: 18/61 processed`. Thinking content, tool results, and pure edit/tool-call messages are not scheduled; `yield` mode indexes only final responses. Normal speech and microphone actions preempt this work; unfinished indexing resumes after a later turn. Wav2Vec2 supplies word timestamps, while the Termux audio session queries `mpv` for the position actually being played. The active sentence or clause receives a continuous subtle background, including inter-word whitespace. Words already reached by playback return to the normal foreground; later prose remains dim.

The segment background depends only on PCM boundaries and `mpv` position, so it remains reliable if word alignment is late or fails. Word progression falls back to duration-weighted estimates when necessary. Synthesis never waits for alignment and no artificial playback delay is added.

Kokoro synthesis and microphone Whisper inference share the main voice worker. Wav2Vec2 runs in a dedicated alignment worker, and each TCP utterance uses a lightweight playback helper. Alignment and playback helpers write progress events directly to Pi instead of routing them through the potentially busy Kokoro loop. This keeps highlighting responsive while the next segment is being synthesized. Prose styling leaves fence syntax and link destinations untouched; guided code styling uses terminal intensity markers only inside validated fence bodies.

## Server installation

```bash
git clone https://github.com/Soulthym/pi-voice.git
cd pi-voice
npm install
pi install .
```

Configuration is stored in `~/.pi/agent/pi-voice.json`. For the bundled Termux bridge:

```json
{
  "enabled": true,
  "mode": "assistant",
  "voice": "af_heart",
  "speed": 1,
  "ttsModel": "onnx-community/Kokoro-82M-v1.0-ONNX",
  "ttsDtype": "q8",
  "sttModel": "onnx-community/whisper-tiny.en",
  "sttDtype": "fp32",
  "sttCandidates": 3,
  "alignmentModel": "onnx-community/wav2vec2-base-960h-ONNX",
  "alignmentDtype": "q8",
  "editModel": "current",
  "output": "tcp://127.0.0.1:8765",
  "input": "tcp://127.0.0.1:8766",
  "talkShortcut": "alt+m",
  "submitMode": "review",
  "editMode": "smart",
  "playbackHighlight": true,
  "codeNarration": "guided"
}
```

## Termux setup

Install Termux and the **Termux:API Android app from the same source** (normally F-Droid), then in Termux:

```bash
pkg update
pkg install git openssh mpv socat termux-api
git clone https://github.com/Soulthym/pi-voice.git
cd pi-voice
mkdir -p "$HOME/.local/bin"
install -m755 termux/pi-voice-* "$HOME/.local/bin/"
```

Repeat the `install` command and restart `pi-voice-ssh` after upgrading; playback highlighting requires the current `pi-voice-audio-session` bridge.

Ensure `~/.local/bin` is included in Termux's `PATH`. For Bash:

```bash
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
export PATH="$HOME/.local/bin:$PATH"
```

Grant microphone permission with a short test recording:

```bash
rm -f "$HOME/pi-voice-test.ogg"; timeout 2s termux-microphone-record -f "$HOME/pi-voice-test.ogg" -l 5 -e opus
```

Speak for five seconds. Some Android 15 builds leave the API client waiting even though recording works; the timeout is intentional and Android continues recording to its five-second limit.

Connect using the wrapper instead of plain `ssh`:

```bash
pi-voice-ssh YOUR_DESKTOP
```

Then start `pi` in the remote shell. The wrapper starts the phone bridge and creates:

```text
server 127.0.0.1:8765 → SSH → phone audio player
server 127.0.0.1:8766 → SSH → phone microphone recorder
```

If SSH reports that remote forwarding failed, ensure `AllowTcpForwarding yes` is enabled in the desktop's SSH server configuration.

### Optional one-tap voice control key row

Sticky `Alt` combinations in Termux's extra-key row are inconvenient for controls that may be pressed repeatedly. Termux can instead expose dedicated function keys, which pass cleanly through SSH and are unbound by Pi by default. Replace the final `]]` of `extra-keys` in `~/.termux/termux.properties` with this third-row suffix:

```properties
  ], [\
    {key: 'F5',  display: '🎙'},\
    {key: 'F6',  display: '⏮'},\
    {key: 'F7',  display: '↶10'},\
    {key: 'F8',  display: '⏯'},\
    {key: 'F9',  display: '10↷'},\
    {key: 'F10', display: '⏭'},\
    {key: 'F11', display: '↺'}\
  ]]
```

The symmetric layout is phone voice input, previous assistant message, rewind 10 seconds, pause/resume, forward 10 seconds, next assistant message, and restart the selected message. Pause occupies the center key. Pi Voice registers all seven shortcuts; `F5` remains a one-tap alternative alongside the configured microphone shortcut (`Alt+M` by default). Run `termux-reload-settings` after editing the file.

## Usage

- Press the configured microphone shortcut (**Alt+M** by default) or **F5** and speak for as long as needed. Recording stops automatically after about 1.35 seconds of silence.
- Press **F6**/**F10** to regenerate the previous/next completed assistant message, or **F11** to restart the selected message. Navigation is available while Pi is idle and restores message text from session history after `/reload` or session resume.
- Press **F7**/**F9** to move approximately 10 seconds backward/forward using recorded segment-to-source timing checkpoints. Press **F8** to pause and regenerate from the nearest checkpoint when resuming. The timeline's authoritative position variable is updated from the phone's live `mpv` clock and is also used by these controls. Timing is persisted in Pi's session after playback or silent preprocessing completes; PCM audio is never cached. Consequently, seeks are approximate and replay invokes Kokoro again. Missing historical annotations are generated silently when a session loads, without playing audio through the phone. The background indexer uses local structural text for code blocks to avoid historical `editModel` calls; when fenced code is actually replayed, its persisted narration is reused if one was generated previously.
- Press the shortcut again to stop manually. Pi displays a live, revisable transcript in the prompt editor.
- In the default `review` submit mode, correct or extend the final prompt and press Enter yourself.
- Final transcription requests up to `sttCandidates` hypotheses from the same ASR model. The configured editing model resolves them using the existing draft and a bounded, text-only excerpt of recent session context. This isolated request does not enter conversation history.
- With `editMode: "smart"`, text that is already in the editor when recording starts becomes the existing draft. Another dictation can continue or revise it naturally: “Actually replace port 8000 with 8080,” “scratch the last sentence,” or “make the second paragraph shorter.” Start recording only after placing the text to revise in the editor. With an empty editor there is nothing to revise, so Pi resolves the new utterance as fresh dictation. In `append`, the model still resolves ASR ambiguity but preserves correction phrases literally instead of executing them.
- Fences tagged `text`, `txt`, `plain`, `plaintext`, `md`, `markdown`, or `mdown` are read as prose. Other fenced blocks are sent to `editModel`. In `guided` mode it returns compact `operations|speech` records: `L+`/`L-` maintain independent bright line groups and `B+`/`B-` maintain independent bold ranges. For JavaScript, JSX, TypeScript, and TSX, `web-tree-sitter` assigns compact handles to statements and expressions and resolves the model's choices back to exact source ranges. Unsupported languages retain the coordinate protocol. Everything else stays dim until narration ends, when the complete original block returns to normal. Requests still begin as soon as closing fences arrive and preserve spoken order.
- Assistant speech automatically plays through the phone. While it plays, unread prose is dimmed, the current speech segment gets a subtle continuous background, and words return to normal near their actual playback time.
- A configurable Wav2Vec2 CTC model aligns clean Kokoro audio in a separate worker whose events flow directly to Pi, independently of ongoing synthesis. When voice mode is enabled, Kokoro and the aligner warm concurrently in the background and remain resident in RAM until Pi exits or reloads. If alignment is late or unavailable, duration-weighted word timing is used; if phone feedback is unavailable, the desktop playback clock is estimated.
- `Ctrl+Shift+V` toggles spoken output.

Commands:

```text
/voice status
/voice on|off|toggle|stop
/voice setup
/voice test [optional text]
/voice talk
/voice mode assistant|all|yield
/voice voice [voice id]
/voice speed <0.5..2>
/voice tts-model <huggingface-repo>
/voice tts-dtype fp32|q8|q4
/voice stt-model <huggingface-repo>
/voice stt-dtype fp32|q8|q4
/voice stt-candidates <1..8>
/voice alignment-model <huggingface-repo>
/voice alignment-dtype fp32|q8|q4
/voice edit-model current|provider/model-id
/voice highlight on|off
/voice code-narration guided|summary
/voice timing
/voice output local|tcp://host:port
/voice input disabled|tcp://host:port
/voice shortcut <key|disabled>
/voice submit review|auto
/voice edit smart|append
```

`/voice timing` reports segment-metadata-to-background and background-to-redraw latency for the most recent narrated response without logging its text. It is intended for diagnosing delayed phone feedback or TUI rendering. Shortcut names use Pi's key format, such as `alt+m`, `ctrl+shift+m`, or `f8`. Run `/reload` after changing the shortcut. `review` leaves dictation in the editor for confirmation; `auto` immediately submits it. `smart` applies subsequent dictation to the existing draft; `append` only appends the model-resolved utterance and does not execute spoken corrections.

## Models

- `ttsModel` must be a `kokoro-js`-compatible Kokoro ONNX repository. Kokoro is a speech-synthesis model only; it cannot perform speech-to-text.
- `sttModel` must be a Transformers.js-compatible automatic-speech-recognition repository. Tested defaults use Whisper ONNX models from `onnx-community`.
- `alignmentModel` must be a Transformers.js-compatible English CTC acoustic model. The default `onnx-community/wav2vec2-base-960h-ONNX` is an Apache-2.0 conversion of `facebook/wav2vec2-base-960h`; its q8 weights are approximately 100 MB. Unsupported architectures fall back to duration-weighted timing.
- `sttCandidates` defaults to 3. Live previews remain single-pass; only final Whisper transcription generates alternatives. Candidate 1 is deterministic and additional candidates are low-temperature samples because Transformers.js 3.x does not expose multiple beam-search outputs. Duplicate hypotheses are removed, so fewer than the requested count may be returned. Other ASR architectures may return only one candidate.
- `editModel: "current"` follows whichever model is active in Pi, without assuming a particular model family. Set `provider/model-id` to pin candidate resolution, smart editing, and fenced-code narration to another model registered and authenticated in Pi.
- `codeNarration: "guided"` requests synchronized line and bold groups using a compact line-record protocol. `summary` preserves the previous plain spoken description with no code dimming. Invalid guided plans safely fall back to the plain local structural description and leave code visible.
- Model and precision changes apply on the next synthesis, transcription, or alignment. Missing weights download lazily into the configured cache.
- A repository must actually provide the selected `fp32`, `q8`, or `q4` ONNX variant. If loading fails, choose a precision shipped by that repository.

Suggested STT repositories, from lighter to heavier, include `onnx-community/whisper-tiny.en`, `onnx-community/whisper-base.en`, and `onnx-community/whisper-small.en`. Remove `.en` for multilingual recognition.

Modes:

- `assistant`: speak assistant text as it streams (default)
- `all`: speak assistant text and thinking
- `yield`: speak completed assistant output only

## Environment overrides

- `PI_VOICE_CONFIG`: alternate server config path
- `PI_VOICE_CACHE_DIR`: alternate model cache (default `~/.cache/pi-voice/models`)
- `PI_VOICE_PLAYER`: alternate `pw-play`-compatible local player executable
- `PI_VOICE_AUDIO_PORT`: phone audio-listener port (default `8765`)
- `PI_VOICE_CONTROL_PORT`: phone microphone-control port (default `8766`)
- `PI_VOICE_MAX_RECORD_SECONDS`: safety limit for one phone recording (default `120`; export it in Termux before running `pi-voice-ssh`)

See `THIRD_PARTY_NOTICES.md` for attribution and model/runtime licensing.
