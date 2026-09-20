# Troubleshooting

[← README](../README.md) · [Installation](installation.md) · [Devices and SSH](devices-and-ssh.md)

Use one diagnostic step at a time. Confirm active capture/playback stopped before replacing scripts or exiting wrappers. Update **all** client copies from the host's local checkout for the current not-yet-pushed batch, then exit all wrappers before reconnecting: the shared bridge remains alive until the final shell exits. See [safe upgrades](installation.md#upgrading).

## Confirm routing

In Pi:

```text
/voice status
```

Look for `device=auto→<id>` or `→local`, plus the configured `input` and `output`. These are metadata, not readiness proof. `/voice reconnect` adopts fresh current-attachment identity without playback. Explicitly select a registered client if necessary:

```text
/voice device <id>
```

On the Pi host, managed registration JSON files should exist under:

```bash
ls -la ~/.cache/pi-voice/devices
```

## Unconfirmed stop

`/voice stop` cancels processing promptly but a timeout/disconnect does not prove remote audio or microphone capture stopped. Ownership stays retained and replacement work is blocked. Restore the **original device connection**, then explicitly retry `/voice stop` for capture cleanup or `/voice reconnect` for retained output cleanup. Input retries use the saved endpoint and full ticket, not a newly selected route; a different server at the same port cannot acknowledge the old epoch. If the original recorder cannot be reached, confirm/stop it on that device out of band before recovery.

`REMOTE_PLAYBACK_UNCONFIRMED` reports one actionable diagnostic for the failed playback episode, including its original cause; cascading helper/Stop/Input/Turn failures do not repeat it. An explicit reconnect retry reports its own result. Output cleanup retains the same worker client and opaque original remote handle, even if the helper has exited or route metadata changed. Reconnect awaits that cleanup before adopting a new pin, including same-route retries and retained cleanup after reload; failure keeps the lease.

Do not remove coordinator leases, ticket state, recorder locks, persistent fences or receipts while confirmation is outstanding. Killing Pi, SSH, a helper or the host worker is not remote stop proof. Do not start a permission-test recording alongside an unconfirmed capture. Successful cleanup permits a later explicit retry; it never automatically restarts playback/capture.

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

The server and client must both include the current pause/resume/stop protocol and single-player endpoint lock. Reinstall client scripts, exit all wrappers, reconnect, and reload Pi; older clients can keep buffered audio alive after a seek. F8 should pause mpv and leave highlighting at the same position.

## No sound after suspend or network loss

If the phone slept or the network dropped mid-session, one of the client
listeners may have died silently. The client supervisor now restarts dead
listeners automatically (up to 20 times) and `pi-voice-ssh` verifies bridge
liveness via `/proc/<pid>/cmdline` plus a client-local audio-port probe before trusting a
pid file. This wrapper startup check is distinct from host routing: host route
queries and current-attachment resolution never open probe connections. If you still hear nothing after reconnecting:

```bash
pgrep -af "socat|mpv|pi-voice"   # expect two socat listeners while connected
runtime=${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pi-voice-ssh-$(id -u)
tail -20 "$runtime/client-bridge.log"
```

Missing processes mean the bridge is not running; rerun `pi-voice-ssh`. If
processes exist but audio is silent, check Android media volume (separate from
the ringer) and Termux battery-optimization exemptions.

## SSH wrapper waits on a lock

Current wrappers use owner-tagged locks and automatically reclaim dead-owner locks. They also reclaim ownerless directories left by older crashed wrappers once no other legacy wrapper could still own them. After confirmed device stop, reinstall the complete `client/pi-voice-*` set and restart every wrapper. If a legacy wrapper is stuck, inspect its owner and client log rather than recursively deleting runtime directories. Do not remove locks while a wrapper or unconfirmed capture may still own them. New owner-tagged locks are released only by their owner and stale ownership is recovered automatically. For a diagnostic trace, run `timeout 30s bash -x "$(command -v pi-voice-ssh)" -vvv YOUR_HOST >~/pi-voice-ssh-debug.log 2>&1`; review hostnames, usernames, key paths, and secret-bearing proxy options before sharing it.

## SSH forwarding fails

Run a dry resolution check:

```bash
PI_VOICE_SSH_DRY_RUN=1 pi-voice-ssh YOUR_HOST
```

If OpenSSH reports forwarding failure, enable `AllowTcpForwarding yes` on the target SSH server and retain `GatewayPorts no`. Tailscale SSH is controlled by Tailscale, not `sshd_config`; its version/policy must allow remote TCP forwarding. The wrapper must receive two allocated port numbers before registering the device.

If an older Tailscale connection reports `Permission denied` on root-owned `.audio.sock` or `.input.sock` files, reinstall all client scripts and exit every old wrapper before reconnecting. Current wrappers use dynamic loopback TCP forwards for both SSH implementations, avoiding socket ownership issues. Do not solve this by exposing listeners on `0.0.0.0` or opening firewall ports.

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
