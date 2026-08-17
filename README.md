# pi-voice

A bidirectional phone voice-mode extension for the [Pi coding agent](https://github.com/earendil-works/pi), modeled after Oh My Pi's Kokoro vocalizer.

- **Desktop → phone:** Pi runs Kokoro-82M locally and streams assistant speech through an SSH reverse tunnel to `mpv` in Termux.
- **Phone → desktop:** The configured shortcut streams Ogg/Opus from the Termux microphone through a second reverse tunnel. Desktop-side voice activity detection stops on natural silence, Whisper transcribes locally, and Pi places the result in the prompt editor for review.

Both tunnel endpoints bind only to loopback, and phone audio stays inside the encrypted SSH connection. Kokoro synthesis and Whisper transcription run locally on the desktop. In `smart` edit mode, revisions use Pi's currently selected model: if that model is remote, the existing draft and new dictation are sent to its provider. Use `/voice edit append` to keep prompt editing entirely local.

## Features

- Speaks assistant output while it streams.
- Runs `onnx-community/Kokoro-82M-v1.0-ONNX` locally with q8 weights.
- Keeps ONNX inference in a child process so Pi's TUI remains responsive.
- Omits fenced code, tables, and most Markdown noise from speech.
- Starts with a short first segment, then synthesizes bounded sentence/clause segments.
- Cancels queued speech when you send another prompt.
- Supports server-local playback or raw PCM over TCP/SSH.
- Streams phone microphone audio in near real time and stops automatically after natural silence.
- Shows a revisable Whisper preview directly in Pi's editor while you speak.
- Supports a second `Alt+M` as a manual stop for long pauses or noisy environments.
- Leaves reviewed dictation in the editor by default; press Enter after correcting or extending it.
- Uses Pi's currently selected model for isolated spoken edits to an existing draft; switching Pi to a local model automatically makes editing local.

Kokoro setup downloads approximately 100 MB from Hugging Face. The first microphone transcription downloads approximately 150 MB of Whisper weights. Later synthesis and transcription are local.

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
  "editModel": "current",
  "output": "tcp://127.0.0.1:8765",
  "input": "tcp://127.0.0.1:8766",
  "talkShortcut": "alt+m",
  "submitMode": "review",
  "editMode": "smart"
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
- With `editMode: "smart"`, another dictation can continue the draft or revise it naturally: “Actually replace port 8000 with 8080,” “scratch the last sentence,” or “make the second paragraph shorter.” The edit uses Pi's current model in an isolated request and does not enter conversation history. Switching Pi's active model changes the editing model automatically.
- Assistant speech automatically plays through the phone.
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
/voice edit-model current|provider/model-id
/voice output local|tcp://host:port
/voice input disabled|tcp://host:port
/voice shortcut <key|disabled>
/voice submit review|auto
/voice edit smart|append
```

Shortcut names use Pi's key format, such as `alt+m`, `ctrl+shift+m`, or `f8`. Run `/reload` after changing the shortcut. `review` leaves dictation in the editor for confirmation; `auto` immediately submits it. `smart` applies subsequent dictation to the existing draft; `append` disables model-assisted edits.

## Models

- `ttsModel` must be a `kokoro-js`-compatible Kokoro ONNX repository. Kokoro is a speech-synthesis model only; it cannot perform speech-to-text.
- `sttModel` must be a Transformers.js-compatible automatic-speech-recognition repository. Tested defaults use Whisper ONNX models from `onnx-community`.
- `editModel: "current"` follows whichever model is active in Pi. Set `provider/model-id` to pin editing to another model registered and authenticated in Pi.
- Model and precision changes apply on the next synthesis or transcription. Missing weights download lazily into the configured cache.
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
