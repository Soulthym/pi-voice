# Environment variables

[← README](../README.md) · [Devices and SSH](devices-and-ssh.md)

## Pi host

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_VOICE_CONFIG` | `~/.pi/agent/pi-voice.json` | Alternate configuration file. |
| `PI_VOICE_CACHE_DIR` | `~/.cache/pi-voice/models` | Model-weight cache. |
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
| `PI_VOICE_DEVICE_NAME` | short hostname | Advertised client label. Termux appends its platform label. |
| `PI_VOICE_CLIENT_COMMAND` | `~/.local/bin/pi-voice-client` | Alternate bridge executable started by `pi-voice-ssh`. |
| `PI_VOICE_SSH_DRY_RUN` | unset | Set to `1` to print resolved SSH/device state without connecting. |

`XDG_CONFIG_HOME` controls the persistent client device-ID location. `XDG_RUNTIME_DIR`, then `TMPDIR`, controls Linux and Termux client runtime files; the fallback is `/tmp`.

## Internal wrapper variables

`pi-voice-ssh` injects `PI_VOICE_DEVICE_ID` into the remote environment. The extension uses it to prefer the client associated with the current shell. Users normally should not set it manually; `/voice device` is the supported explicit override.

The wrapper also exports target bookkeeping for its own lifecycle. Variables not listed above are implementation details and may change.
