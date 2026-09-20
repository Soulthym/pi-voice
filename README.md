# pi-voice

Bidirectional, local-first voice input and output for the [Pi coding agent](https://github.com/earendil-works/pi). Pi Voice combines streaming Kokoro speech synthesis, local Whisper dictation, synchronized playback highlighting, narrated code, replay controls, and automatic Linux/Termux device routing.

Kokoro, Whisper, Wav2Vec2 alignment, and audio-cache processing run on the machine hosting Pi. With the managed `pi-voice-ssh` topology, bridge endpoints use loopback TCP with dynamically allocated server ports, and audio travels inside SSH (ordinary OpenSSH or Tailscale SSH). A remote `editModel` may still receive ASR alternatives, drafts, bounded dictation context, and—when explicitly enabled—compaction-aware conversation context for fenced blocks; see [Models and privacy](docs/models-and-privacy.md).

## Features

- Speaks assistant text while it streams, with `assistant`, `all`, and strict final-response `yield` modes.
- Records from local Linux, local Termux, or an SSH-connected Linux/Termux client.
- Stops dictation on silence, displays revisable Whisper previews, and leaves the final prompt editable by default.
- Resolves multiple ASR hypotheses against recent session context; smart mode also performs spoken corrections.
- Dims unread prose, highlights the active sentence, and reveals words against the client player's real playback position.
- Reads prose fences and Markdown tables naturally; can describe code and patches using the compaction-aware discussion through each block.
- Supports guided code focus with synchronized line groups, bold ranges, and exact Tree-sitter targets for JavaScript/TypeScript families.
- Replays historical messages with previous/next, seek, native pause/resume, and persisted timing controls. Labels estimated/mixed/CTC-refined word timing separately from estimated playback clocks.
- Reuses content-addressed 32 kbps VBR Opus segments by default; raw PCM is never retained.
- Incrementally preprocesses missing code descriptions and speech timing from the selected message forward, then backward.
- Routes multiple clients and Pi sessions safely with explicit device selection, speech ownership, attention requests, and manual preemption.
- Keeps synthesis, alignment, playback, and preprocessing outside Pi's TUI event loop.

> **Best contextual narration:** set `"codeDescriptionContext": "conversation"` to let `editModel` explain code using the discussion that led to it. The privacy-safe default, `"block-only"`, sends only the concerned fence. Conversation mode sends Pi's provider-compatible history and may include user/assistant content, images, compaction summaries, tool calls, and tool results. With `editModel: "current"`, it also reuses Pi's effective system prompt and active tool schemas so supported providers can reuse the normal conversation's prompt cache. See [Models and privacy](docs/models-and-privacy.md) before enabling it with a remote model.

> Short demonstration videos will be added alongside the relevant features.

## Supported setups

| Pi host and connection | Automatic microphone and output |
| --- | --- |
| Linux desktop, normal `pi` | Desktop defaults |
| Server, `pi-voice-ssh` from Linux | Linux client defaults |
| Server, `pi-voice-ssh` from Termux | Termux client |
| Linux desktop, `pi-voice-ssh` from Termux | Termux client |
| Termux, normal `pi` | Termux microphone and `mpv` |

Ordinary OpenSSH and Tailscale SSH use the same `pi-voice-ssh` command and reverse TCP transport; no public voice ports or special Tailscale flag are needed. This is intended for personal servers: loopback endpoints are accessible to other local users.

Native macOS and Windows client backends are planned. Voice ownership and attention are limited to interactive Pi TUI sessions; headless child/subagent sessions stay silent.

## Quick start

Install the extension on the Pi host:

```bash
git clone https://github.com/Soulthym/pi-voice.git
cd pi-voice
npm install
pi install .
```

Install `ffmpeg`. For local Linux audio, also install PipeWire utilities or PulseAudio utilities plus `mpv` or `ffplay`.

For a Linux or Termux SSH client, install the bridge scripts from the checkout:

```bash
mkdir -p "$HOME/.local/bin"
install -m755 client/pi-voice-* "$HOME/.local/bin/"
```

Termux additionally requires the Termux:API Android app and:

```bash
pkg install openssh socat mpv ffmpeg termux-api util-linux
```

Connect with the wrapper, start Pi remotely, and enable spoken output:

```bash
pi-voice-ssh YOUR_HOST
pi
```

```text
/voice on
```

**Current protocol upgrade:** these changes are not yet pushed. Copy the complete client script set from the **host's local checkout**, updating all client copies together; a client-side `git pull` is insufficient. Confirm old captures stopped before exiting wrappers or migrating state. See [safe upgrades](docs/installation.md#upgrading) and [stop recovery](docs/troubleshooting.md#unconfirmed-stop).

See [Installation](docs/installation.md) for permissions, dependencies, SSH server settings, and local-only setups.

## Default configuration

Pi Voice reads `~/.pi/agent/pi-voice.json`. Missing settings use these defaults; spoken output starts disabled:

```json
{
  "enabled": false,
  "mode": "assistant",
  "voice": "af_heart",
  "speed": 1,
  "ttsModel": "onnx-community/Kokoro-82M-v1.0-ONNX",
  "ttsDtype": "q8",
  "ttsWorkers": 3,
  "sttModel": "onnx-community/whisper-tiny.en",
  "sttDtype": "fp32",
  "sttCandidates": 3,
  "alignmentModel": "onnx-community/wav2vec2-base-960h-ONNX",
  "alignmentDtype": "q8",
  "editModel": "current",
  "output": "auto",
  "input": "auto",
  "talkShortcut": "alt+m",
  "scrollToShortcut": "alt+v",
  "scrollBottomShortcut": "alt+t",
  "submitMode": "review",
  "editMode": "smart",
  "playbackHighlight": true,
  "autoScroll": true,
  "codeNarration": "guided",
  "codeDescriptionContext": "block-only",
  "codeDescriptionPreprocessConcurrency": 4,
  "codeDescriptionPreprocessScope": "since-compaction",
  "codeDescriptionPreprocessBudget": 25,
  "timingPreprocessConcurrency": "auto",
  "audioCache": true,
  "audioCacheBitrate": 32
}
```

See [Configuration](docs/configuration.md) for valid values and setting behavior, or copy [`pi-voice.example.json`](pi-voice.example.json).

## Controls

### Everyday shortcuts

| Key | Action |
| --- | --- |
| `Alt+M` or `F5` | Start/stop microphone dictation |
| `F6` | Previous assistant message |
| `F7` | Previous sentence or literal-newline unit |
| `F8` | Pause/resume audio and highlighting |
| `F9` | Next sentence/newline unit; at message end advance, or pause and follow the latest tail |
| `F10` | Next assistant message; from the latest message, pause and follow the transcript tail |
| `F11` (↺) | Replay this project's selected/waiting response; never switch projects |
| `Alt+V` | Re-anchor the current narrated position |
| `Alt+T` | Pin to and follow the transcript tail |
| `Ctrl+Shift+V` | Toggle spoken output |

Speak after pressing the microphone key. Recording normally stops after about 1.35 seconds of silence. In the default review mode, edit the resulting prompt and press Enter yourself.

### Useful commands

```text
/voice status
/voice on|off|toggle|stop
/voice talk
/voice attention
/voice scroll-to
/voice bottom
/voice device auto|local|<device-id>
/voice reconnect  # adopt current attachment for this session; no playback
/voice setup
```

### Termux extended keyboard

`/voice attention` explicitly attends the oldest eligible waiting session using the requesting terminal's fresh device pin, falling back to this project's replay when current/none waiting. F11 always stays in this project. Handoff waits for confirmed stop; stop/newer playback actions cancel pending requests.

Termux can expose one-tap microphone, message navigation, sentence/newline navigation, pause/resume, and replay controls through an optional F5–F11 extra-key row.

[![Termux extended keyboard row for Pi Voice playback controls](docs/assets/pi-voice-ssh-termux-extended-kb.jpg)](docs/usage.md#optional-termux-function-key-row)

[Configure the Termux extended keyboard row →](docs/usage.md#optional-termux-function-key-row)

See [Usage](docs/usage.md) for dictation, editing, playback, highlighting, session attention, and keybinding details. See [Command reference](docs/commands.md) for every `/voice` command.

## Documentation

- [Installation and upgrades](docs/installation.md)
- [Usage and keybindings](docs/usage.md)
- [Configuration](docs/configuration.md)
- [Command reference](docs/commands.md)
- [Devices and SSH routing](docs/devices-and-ssh.md)
- [Narration and highlighting](docs/narration-and-highlighting.md)
- [Preprocessing, timing, and audio cache](docs/preprocessing-and-cache.md)
- [Models and privacy](docs/models-and-privacy.md)
- [Architecture](docs/architecture.md)
- [Custom endpoint protocol](docs/endpoint-protocol.md)
- [Environment variables](docs/environment.md)
- [Troubleshooting](docs/troubleshooting.md)

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for dependency and model attribution.

## License

[MIT](LICENSE)
