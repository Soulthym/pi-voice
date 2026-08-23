# Troubleshooting

[← README](../README.md) · [Installation](installation.md) · [Devices and SSH](devices-and-ssh.md)

Use one diagnostic step at a time. After replacing client scripts, exit **all** wrappers before reconnecting because the old shared bridge remains alive until the final shell exits.

## Confirm routing

In Pi:

```text
/voice status
```

Look for `device=auto→<id>` or `→local`, plus the configured `input` and `output`. Explicitly select a connected client if necessary:

```text
/voice device <id>
```

On the Pi host, managed registrations and sockets should exist under:

```bash
ls -la ~/.cache/pi-voice/devices
```

## “Voice microphone connection closed before returning audio”

This means the selected microphone bridge exited before sending a `stream`, `audio`, `ok`, or `error` response.

On Termux, verify:

```bash
command -v termux-microphone-record
command -v ffmpeg
ls -l ~/.local/bin/pi-voice-stt-session
```

Then test permission directly:

```bash
rm -f "$HOME/pi-voice-test.ogg"
timeout 2s termux-microphone-record -f "$HOME/pi-voice-test.ogg" -l 5 -e opus
```

If direct recording works, reinstall all `client/pi-voice-*` scripts together and restart every wrapper. Do not mix a new `pi-voice-ssh` with an older bridge/helper set.

On Linux, confirm a real default microphone—not only a monitor source—appears in `wpctl status` or `pactl get-default-source`.

## Only the project name plays

A project announcement and response are separate queued utterances. Reload the current extension if an older playback helper is stuck:

```text
/reload
```

Check that no obsolete `tcp-playback.mjs` helper remains after reload. Current helpers terminate after their client stream closes so the next utterance can start.

## Pause stops highlighting but not audio

The server and client must both include the pause-control protocol. Reinstall client scripts, exit all wrappers, reconnect, and reload Pi. F8 should pause mpv and leave highlighting at the same position.

## SSH forwarding fails

Run a dry resolution check:

```bash
PI_VOICE_SSH_DRY_RUN=1 pi-voice-ssh YOUR_HOST
```

If OpenSSH reports forwarding failure, enable `AllowTcpForwarding yes` and `AllowStreamLocalForwarding yes` on the target SSH server. Check for path-length or permission errors under `~/.cache/pi-voice/devices`.

## No Linux local playback

Pi Voice tries `pw-play`, `mpv`, then `ffplay`. Confirm at least one is in `PATH`:

```bash
command -v pw-play || command -v mpv || command -v ffplay
```

`PI_VOICE_PLAYER` may override detection, but the executable must accept the raw-player argument shape documented in [Environment variables](environment.md).

## Highlighting position is delayed

Run:

```text
/voice timing
```

A `~` in the playback line means actual client feedback has not arrived recently and Pi is estimating position. On Termux, the repository also includes `termux/pi-voice-test-playback-position` for direct mpv clock diagnostics.

## Model load failure

Verify that the configured repository contains the selected dtype. Switch to a supplied precision, often `fp32` or `q8`. The default Whisper dtype is FP32 because some quantized decoder exports fail during ONNX graph initialization.

Clear only a broken model download from `~/.cache/pi-voice/models`; audio-cache files are independent.

## Reload reports a stale extension context

Current preprocessing captures a session epoch and safely abandons stale work. If an older loaded extension crashes during `/reload`, restart Pi. Completed Opus segments, code descriptions, and complete timing maps remain reusable.

## Attention repeats during tools

Only speakable assistant text should create a waiting response. Raw tool calls/results and headless child sessions are excluded. Reload all interactive Pi sessions so every process uses the same coordinator schema and attention logic.
