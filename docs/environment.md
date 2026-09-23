# Environment variables

[← README](../README.md) · [Devices and SSH](devices-and-ssh.md)

## Pi host

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_VOICE_CONFIG` | `~/.pi/agent/pi-voice.json` | Alternate configuration file. |
| `PI_VOICE_CACHE_DIR` | `~/.cache/pi-voice/models` | Model-weight cache. |
| `PI_VOICE_TTS_WORKERS` | `3` | Legacy fallback for playback synthesis/lookahead, integer 1–8. Valid persisted `ttsWorkers` takes precedence; `/voice tts-workers <1..8>` changes it live and persists it. Benchmark other hardware/models before increasing it. |
| `HF_HUB_OFFLINE` | unset | Set to `1` to prohibit model downloads in synthesis/transcription workers. The alignment worker currently does **not** honor this flag; it may download missing weights. |
| `PI_VOICE_AUDIO_CACHE_DIR` | `~/.cache/pi-voice/audio` | Content-addressed Opus cache. |
| `PI_VOICE_COORDINATOR_DIR` | `~/.cache/pi-voice/coordinator` | Cross-session presence, leases, and attention. |
| `PI_VOICE_DEVICE_DIR` | `~/.cache/pi-voice/devices` | Device registry scanned by the extension. On clients it doubles as the intended remote registry for managed wrappers; on the Pi host pass the same absolute path to `pi-voice-ssh --device-dir`. |
| `PI_VOICE_PLAYER` | automatic | Alternate executable accepting `pw-play`-compatible raw-player arguments. |

## Client bridge

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_VOICE_AUDIO_PORT` | `8765` | Client loopback audio listener. |
| `PI_VOICE_CONTROL_PORT` | `8766` | Client loopback microphone-control listener. |
| `PI_VOICE_MAX_RECORD_SECONDS` | `120` | Client recording limit. The host still caps capture at 120 seconds. |
| `PI_VOICE_CLIENT_COMMAND` | `~/.local/bin/pi-voice-client` | Alternate bridge executable started by `pi-voice-ssh`. |
| `PI_VOICE_SSH_DRY_RUN` | unset | Set to `1` to print resolved SSH/device state without connecting. |

`XDG_CONFIG_HOME` controls the persistent client `device-id` and `device-name` location. The SSH wrapper and Linux helpers use `XDG_RUNTIME_DIR`, then `TMPDIR`, then `/tmp` for runtime files. Termux recorder/player helpers instead use `TMPDIR`, falling back to `/data/data/com.termux/files/usr/tmp`; they do not consult `XDG_RUNTIME_DIR`. Retain the original runtime state while stop recovery is outstanding.

## Device-name validation

The name is read only from `${XDG_CONFIG_HOME:-$HOME/.config}/pi-voice/device-name`, prompted on the first interactive connection when missing. There is **no device-name environment override or hostname fallback**, even if an obsolete name variable is inherited. The wrapper accepts **1–128 characters**, counted under `C.UTF-8`, **not 128 bytes**. Unicode names, spaces, quotes and backslashes are preserved; quotes and backslashes are JSON-escaped in the registration, not removed. Control characters (C0/C1, including tabs, newlines and ESC) and bidi controls are rejected. The host also rejects whitespace-only names, bidi controls, line/paragraph separators and surrogate code points in registrations.

Empty or whitespace-only names are errors. The UTF-8 file contains the literal name, optionally followed by one newline; additional lines and NUL are invalid. The directory is mode 700 and files are mode 600. Missing names in noninteractive runs fail with the exact local path and provisioning instructions, never choose a hostname. The label does not change the stable device ID, registry filename, platform or routing identity. The client's `Connected as <name>` confirms registration identity, not audio readiness.

See [installation and upgrades](installation.md#install-a-device-name) for visible first-run prompts, standalone `pi-voice-ssh --set-device-name ["Device name"]` provisioning/renaming and client-copy instructions. The setter changes only the local name, never creates a new ID, and needs no SSH options or target. Editing configuration on the remote Pi host does not rename a managed client.

## Internal wrapper variables

`pi-voice-ssh` injects `PI_VOICE_DEVICE_ID` into the remote environment. The extension uses fresh connection identity to pin a new session or auto-mode playback/reconnect action. A manual device selection remains sticky until successful explicit reconnect/`device auto`. In tmux it resolves the current attachment rather than trusting Pi's startup environment; missing or ambiguous identity fails closed. Users normally should not set it manually; `/voice device` is the supported explicit override and `/voice reconnect` adopts the current attachment without playback.

The wrapper also exports target bookkeeping for its own lifecycle. Variables not listed above are implementation details and may change.
