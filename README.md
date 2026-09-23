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
- Replays historical messages with previous/next, seek, native pause/resume, and persisted timing controls. Shows explicit playback state and actual estimated-word counts.
- Reuses content-addressed 32 kbps VBR Opus segments by default; raw PCM is never retained.
- Incrementally preprocesses missing code descriptions and speech timing from the selected message forward, then backward.
- Routes multiple clients and Pi sessions safely with explicit device selection, speech ownership, attention requests, and manual preemption.
- Keeps synthesis, alignment, playback, and preprocessing outside Pi's TUI event loop.

> **Best contextual narration:** set `"codeDescriptionContext": "conversation"` to let `editModel` explain code using the discussion that led to it. The privacy-safe default, `"block-only"`, sends only the concerned fence. Conversation mode sends Pi's provider-compatible history and may include user/assistant content, images, compaction summaries, tool calls, and tool results. It also sends the available effective system prompt and active tool schemas; using the current model can let supported providers reuse the normal conversation's prompt cache. See [Models and privacy](docs/models-and-privacy.md) before enabling it with a remote model.

> Short demonstration videos will be added alongside the relevant features.

## Supported setups

| Pi host and connection | Automatic microphone and output |
| --- | --- |
| Linux desktop, normal `pi` | Desktop defaults |
| Server, `pi-voice-ssh` from Linux | Linux client defaults |
| Server, `pi-voice-ssh` from Termux | Termux client |
| Linux desktop, `pi-voice-ssh` from Termux | Termux client |
| Termux, normal `pi` with a compatible native ONNX runtime | Termux microphone and `mpv`; [host caveat](docs/installation.md#local-termux-pi) |

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

**Device-name update:** recopy the SSH wrapper on every desktop/Termux client using the [upgrade commands](docs/installation.md#upgrade-device-name-support). `pi-voice-ssh --set-device-name` prompts visibly; `pi-voice-ssh --set-device-name "My device"` provisions/renames headlessly without SSH or changing the ID. No target or other options are allowed. Normal first-connection prompts are visible too. The editable name uses a one-row tail preview (`<` means earlier text is hidden); the full name is saved. Existing connections are not restarted; after confirmed stop, close all wrappers and reconnect to use the new name. If you have not completed the earlier protocol migration, its [safe upgrade steps](docs/installation.md#upgrading) still apply. Never discard outstanding [stop-recovery proof](docs/troubleshooting.md#unconfirmed-stop).

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

See [Configuration](docs/configuration.md) for valid values and setting behavior, or copy [`pi-voice.example.json`](pi-voice.example.json), which deliberately enables spoken output.

## Controls

### Everyday shortcuts

| Key | Action |
| --- | --- |
| `Alt+M` or `F4` | Start/stop microphone dictation |
| `F5` (↺) | Replay this project's selected/waiting response; never switch projects |
| `F6` | Previous assistant message |
| `F7` | Previous sentence or literal-newline unit |
| `F8` | Pause/resume audio and highlighting |
| `F9` | Next sentence/newline unit; cross messages, then enter playback Tail |
| `F10` | Next assistant message; after the latest, enter playback Tail |
| `Alt+V` | Re-anchor the current narrated position |
| `Alt+T` | Pin to and follow the transcript tail |
| `Alt+D` | Choose a voice device (also click the existing `[device]` badge in supported fullscreen Pi) |
| `Ctrl+Shift+V` | Toggle spoken output |

Live and completed content share one playback cursor. Navigation preserves playing/paused intent, including at Tail; from Tail, F6 selects the last message and F7 its last available unit. Alt+T moves only the viewport, not this cursor. Playback/navigation re-arm follow and frame immediately; paused navigation stays silent. Alt+V or **Jump to voice location** re-arms follow without resuming. Later manual scrolling wins again.

Automatic Voice following at the exact bottom adopts Pi's native end-follow and clears its “Jump to latest” banner without selecting playback Tail. Manual scrolling and paused framing still win.

`Word timing: n/total estimated` describes the selected message's source words, not background work; sparse saved timing shows `unknown/pending`. Listening alone does not guarantee alignment refinement.

Speak after pressing the microphone key. Recording normally stops after about 1.35 seconds of silence. In the default review mode, edit the resulting prompt and press Enter yourself.

### Useful commands

```text
/voice status
/voice on|off|toggle|stop
/voice talk
/voice attention
/voice scroll-to
/voice bottom
/voice devices                      # native picker; arrows/Enter/Escape
/voice device                       # read-only selection + candidates
/voice device "Linux Mint PC"        # unique exact name (or exact ID)
/voice device next|prev|local|auto
/voice reconnect                    # return to auto attachment mode; no playback
/voice setup
```

Manual device selection is session-sticky, including reload and shared tmux controls. Switching waits for confirmed stop, preserves the draft/cursor, and leaves existing playback paused; F8 resumes. Idle/input-only selection does not pause future narration. The first existing progress row (or idle footer) ends with `[device name]`; click it in mouse-capable fullscreen Pi or press Alt+D for the same native picker. Open/cancel is read-only. Regular/older TTYs keep a plain label and keyboard hint. Alt+D replaces Pi's forward-delete-word binding (Alt+Delete remains); configured voice-control conflicts retain their binding with a warning. See [picker controls and limitations](docs/usage.md#device-picker). Explicit endpoint overrides still win. See [routing and trust](docs/devices-and-ssh.md).

`/voice stop` must start the editor input to be recognized as a command. Nonempty-draft access remains a usability gap; no Escape/Stop shortcut discards your draft. Explicit playback finalizes microphone capture and preserves manual edits.

### Termux extended keyboard

`/voice attention` explicitly attends the oldest eligible waiting session using the requesting session's manual pin (fresh attachment identity in auto mode), falling back to this project's replay when current/none waiting. F5 always stays in this project. Handoff waits for confirmed stop; stop/newer playback actions cancel pending requests.

Termux can expose one-tap microphone, message navigation, sentence/newline navigation, pause/resume, and replay controls through an optional F4–F10 extra-key row.

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
