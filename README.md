# pi-voice

A bidirectional phone voice-mode extension for the [Pi coding agent](https://github.com/earendil-works/pi), modeled after Oh My Pi's Kokoro vocalizer.

- **Desktop → phone:** Pi runs Kokoro-82M locally and streams assistant speech through an SSH reverse tunnel to `mpv` in Termux.
- **Phone → desktop:** The configured shortcut streams Ogg/Opus from the Termux microphone through a second reverse tunnel. Desktop-side voice activity detection stops on natural silence, Whisper transcribes locally, and Pi places the result in the prompt editor for review.

Both tunnel endpoints bind only to loopback, and phone audio stays inside the encrypted SSH connection. The audio connection is full-duplex: the phone returns only `mpv` playback timestamps, not microphone data. Kokoro synthesis, Whisper transcription, and Wav2Vec2 alignment run locally on the desktop. Final ASR hypotheses are resolved against a bounded excerpt of the current session by Pi's configured editing model in both `append` and `smart` modes. The same model describes fenced code and patches for speech. If that model is remote, ASR hypotheses, existing drafts, recent session text, and fenced code being described are sent to its provider. Pin `editModel` to a local Pi-registered model to keep these requests local.

## Features

- Speaks assistant output while it streams.
- Runs `onnx-community/Kokoro-82M-v1.0-ONNX` locally with q8 weights.
- Keeps ONNX inference in a child process so Pi's TUI remains responsive.
- Speaks `text`-like fenced blocks directly and narrates concise model-generated descriptions of code and patches instead of silently skipping them.
- Starts each code-description request as soon as its closing fence streams, using already queued speech as lead time while preserving spoken order; falls back to a local structural description if the request fails.
- Omits tables and most other Markdown noise from speech.
- Starts with a short first segment, then synthesizes bounded sentence/clause segments.
- Cancels queued speech when you send another prompt.
- Supports server-local playback or raw PCM over TCP/SSH.
- Slightly dims unread assistant prose, gives the currently spoken sentence or clause a subtle background, and restores each word as it is heard, using fast local CTC forced alignment plus live `mpv` playback-position feedback from the phone.
- Streams phone microphone audio in near real time and stops automatically after natural silence.
- Shows a revisable Whisper preview directly in Pi's editor while you speak.
- Supports a second `Alt+M` as a manual stop for long pauses or noisy environments.
- Leaves reviewed dictation in the editor by default; press Enter after correcting or extending it.
- Generates multiple final hypotheses with the same ASR model and lets any configured Pi model resolve technical ambiguities from recent context.
- Resolves candidates in both edit modes; `smart` additionally applies spoken corrections to the existing draft.

With voice mode enabled, model warm-up starts in the background when the extension loads. Kokoro setup downloads approximately 100 MB from Hugging Face. The first microphone transcription downloads approximately 150 MB of Whisper weights, and spoken-word alignment downloads approximately 100 MB of q8 Wav2Vec2 weights. Later synthesis, transcription, and alignment are local.

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
  "playbackHighlight": true
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

## Usage

- Press the configured microphone shortcut (**Alt+M** by default) and speak for as long as needed. Recording stops automatically after about 1.35 seconds of silence.
- Press the shortcut again to stop manually. Pi displays a live, revisable transcript in the prompt editor.
- In the default `review` submit mode, correct or extend the final prompt and press Enter yourself.
- Final transcription requests up to `sttCandidates` hypotheses from the same ASR model. The configured editing model resolves them using the existing draft and a bounded, text-only excerpt of recent session context. This isolated request does not enter conversation history.
- With `editMode: "smart"`, text that is already in the editor when recording starts becomes the existing draft. Another dictation can continue or revise it naturally: “Actually replace port 8000 with 8080,” “scratch the last sentence,” or “make the second paragraph shorter.” Start recording only after placing the text to revise in the editor. With an empty editor there is nothing to revise, so Pi resolves the new utterance as fresh dictation. In `append`, the model still resolves ASR ambiguity but preserves correction phrases literally instead of executing them.
- Fences tagged `text`, `txt`, `plain`, `plaintext`, `md`, `markdown`, or `mdown` are read as prose. Other fenced blocks are sent to `editModel` for a short semantic description. Descriptions remain at the block's position in the spoken response, while requests begin early enough to overlap preceding queued TTS whenever possible.
- Assistant speech automatically plays through the phone. While it plays, unread prose is dimmed, the current speech segment gets a subtle background, and words return to normal near their actual playback time. Fenced code remains normally styled because it is narrated as a semantic block rather than word-for-word.
- A configurable Wav2Vec2 CTC model aligns clean Kokoro audio in a separate worker. When voice mode is enabled, Kokoro and the aligner warm concurrently in the background and remain resident in RAM until Pi exits or reloads. Each audio segment waits for forced alignment before playback, with a five-second safety timeout that falls back to duration-weighted timing. Later waits normally remain hidden behind preceding playback, while synthesis continues through the ahead-of-playback pipeline. If alignment is late or unavailable, duration-weighted word timing is used; if phone feedback is unavailable, the desktop playback clock is estimated.
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
/voice output local|tcp://host:port
/voice input disabled|tcp://host:port
/voice shortcut <key|disabled>
/voice submit review|auto
/voice edit smart|append
```

Shortcut names use Pi's key format, such as `alt+m`, `ctrl+shift+m`, or `f8`. Run `/reload` after changing the shortcut. `review` leaves dictation in the editor for confirmation; `auto` immediately submits it. `smart` applies subsequent dictation to the existing draft; `append` only appends the model-resolved utterance and does not execute spoken corrections.

## Models

- `ttsModel` must be a `kokoro-js`-compatible Kokoro ONNX repository. Kokoro is a speech-synthesis model only; it cannot perform speech-to-text.
- `sttModel` must be a Transformers.js-compatible automatic-speech-recognition repository. Tested defaults use Whisper ONNX models from `onnx-community`.
- `alignmentModel` must be a Transformers.js-compatible English CTC acoustic model. The default `onnx-community/wav2vec2-base-960h-ONNX` is an Apache-2.0 conversion of `facebook/wav2vec2-base-960h`; its q8 weights are approximately 100 MB. Unsupported architectures fall back to duration-weighted timing.
- `sttCandidates` defaults to 3. Live previews remain single-pass; only final Whisper transcription generates alternatives. Candidate 1 is deterministic and additional candidates are low-temperature samples because Transformers.js 3.x does not expose multiple beam-search outputs. Duplicate hypotheses are removed, so fewer than the requested count may be returned. Other ASR architectures may return only one candidate.
- `editModel: "current"` follows whichever model is active in Pi, without assuming a particular model family. Set `provider/model-id` to pin candidate resolution, smart editing, and fenced-code descriptions to another model registered and authenticated in Pi.
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
