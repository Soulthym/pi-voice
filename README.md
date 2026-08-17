# pi-voice

A bidirectional phone voice-mode extension for the [Pi coding agent](https://github.com/earendil-works/pi), modeled after Oh My Pi's Kokoro vocalizer.

- **Desktop → phone:** Pi runs Kokoro-82M locally and streams assistant speech through an SSH reverse tunnel to `mpv` in Termux.
- **Phone → desktop:** `Alt+M` streams Ogg/Opus from the Termux microphone through a second reverse tunnel. Desktop-side voice activity detection stops on natural silence, Whisper transcribes locally, and Pi submits the result.

Both tunnel endpoints bind only to loopback. Audio and transcripts remain inside the encrypted SSH connection.

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

Kokoro setup downloads approximately 100 MB from Hugging Face. The first microphone transcription downloads approximately 150 MB of Whisper weights. Later synthesis and transcription are local.

## Server installation

```bash
cd ~/code/pi/pi-voice
npm install
pi install ~/code/pi/pi-voice
```

Configuration is stored in `~/.pi/agent/pi-voice.json`. For the bundled Termux bridge:

```json
{
  "enabled": true,
  "mode": "assistant",
  "voice": "af_heart",
  "speed": 1,
  "output": "tcp://127.0.0.1:8765",
  "input": "tcp://127.0.0.1:8766",
  "talkShortcut": "alt+m",
  "submitMode": "review"
}
```

## Termux setup

Install Termux and the **Termux:API Android app from the same source** (normally F-Droid), then in Termux:

```bash
pkg update
pkg install openssh mpv socat termux-api
mkdir -p ~/bin/pi-voice
scp YOUR_DESKTOP:~/code/pi/pi-voice/termux/pi-voice-* ~/bin/pi-voice/
chmod +x ~/bin/pi-voice/pi-voice-*
```

Grant microphone permission with a short test recording:

```bash
timeout 2s termux-microphone-record -f "$HOME/pi-voice-test.m4a" -l 5
```

Speak for five seconds. Some Android 15 builds leave the API client waiting even though recording works; the timeout is intentional.

Connect using the wrapper instead of plain `ssh`:

```bash
~/bin/pi-voice/pi-voice-ssh YOUR_DESKTOP
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
- In the default `review` submit mode, correct or extend the final prompt and press Enter yourself. Starting another dictation appends to the existing editor text.
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
/voice output local|tcp://host:port
/voice input disabled|tcp://host:port
/voice shortcut <key|disabled>
/voice submit review|auto
```

Shortcut names use Pi's key format, such as `alt+m`, `ctrl+shift+m`, or `f8`. Run `/reload` after changing the shortcut. `review` leaves dictation in the editor for confirmation; `auto` immediately submits it.

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
- `PI_VOICE_MAX_RECORD_SECONDS`: safety limit for one phone recording (default `120`)

See `THIRD_PARTY_NOTICES.md` for attribution and model/runtime licensing.
