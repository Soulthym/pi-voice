# Installation and upgrades

[← README](../README.md)

## Pi host

Pi Voice runs synthesis, transcription, alignment, preprocessing, and optional audio-cache conversion on the Pi host.

```bash
git clone https://github.com/Soulthym/pi-voice.git
cd pi-voice
npm install
pi install .
```

Install `ffmpeg` for microphone decoding and Opus cache reads/writes. Without it, synthesis still works, but microphone input and audio caching do not.

For local Linux devices, install:

- PipeWire's `pw-play`, `pw-record`, and `wpctl`; or PulseAudio's `parec` for recording.
- `mpv` or `ffplay` as a playback fallback.

Pi Voice prefers `pw-play`, then `mpv`, then `ffplay` for local output. It prefers a usable PipeWire source, then a non-monitor PulseAudio source for local input.

Run `/reload` after installing or updating the extension. Spoken output defaults to off; enable it with `/voice on`. Microphone dictation remains available when spoken output is off unless input or the shortcut is disabled.

## Linux SSH client

Install `openssh`, `socat`, `mpv`, `ffmpeg`, `flock` (util-linux), and PipeWire or PulseAudio recording utilities. From a Pi Voice checkout:

```bash
mkdir -p "$HOME/.local/bin"
install -m755 client/pi-voice-* "$HOME/.local/bin/"
```

Ensure `~/.local/bin` is in `PATH`, then connect with:

```bash
pi-voice-ssh YOUR_HOST
```

Start `pi` in the resulting remote shell. The wrapper detects Linux and registers the client's default microphone and output device on the Pi host.

## Termux SSH client

Install Termux and the **Termux:API Android app from the same source**, normally F-Droid. Mixing F-Droid and Play Store builds prevents Termux:API communication.

```bash
pkg update
pkg install git openssh socat mpv ffmpeg termux-api util-linux
```

Install the bridge scripts from a checkout:

```bash
mkdir -p "$HOME/.local/bin"
install -m755 client/pi-voice-* "$HOME/.local/bin/"
```

For Bash, add the install directory to `PATH`:

```bash
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc" || \
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
export PATH="$HOME/.local/bin:$PATH"
```

Grant microphone permission with a short test:

```bash
rm -f "$HOME/pi-voice-test.ogg"
timeout 2s termux-microphone-record -f "$HOME/pi-voice-test.ogg" -l 5 -e opus
```

Speak for five seconds. On some Android 15 builds, the API callback remains blocked even though recording works; the two-second timeout is intentional and recording continues to its configured limit.

Connect using the wrapper:

```bash
pi-voice-ssh YOUR_HOST
```

See [Usage](usage.md#optional-termux-function-key-row) for one-tap F5–F11 controls.

## Local Termux Pi

Install the extension and client dependencies in Termux as above, then run normal `pi`. With `input` and `output` set to `auto`, a genuinely local session pins Termux's microphone and `mpv`; no SSH wrapper is required.

## SSH server configuration

Managed clients use dynamically allocated reverse TCP forwarding on server loopback, for both ordinary SSH and Tailscale SSH. No public voice ports need opening.

For an OpenSSH server, retain `GatewayPorts no` and permit remote forwarding:

```text
AllowTcpForwarding yes
GatewayPorts no
```

Validate with `sshd -t`, then reload `sshd` after changing its configuration. These settings do not control Tailscale's built-in SSH server; its version and policy must permit TCP reverse forwarding. Managed endpoint metadata is stored under `~/.cache/pi-voice/devices` on the Pi host.

## Upgrading

**Required for the current, not-yet-pushed protocol batch:** use the Pi host's **local checkout** as the source for every client script. A fresh clone or client-side `git pull` does not contain these changes yet. Copy the complete `client/pi-voice-*` set using the `scp` example below, including any alternative installed copies/custom client paths; do not mix old and new helpers. Install `flock` (`util-linux`) on Linux/Termux.

Before replacing scripts or exiting wrappers, explicitly stop active playback/capture and confirm actual device stop. If stop is unconfirmed, preserve the original connection, runtime state, tickets, receipts and leases; restore that connection and retry `/voice stop` (or `/voice reconnect` for retained output stop). Do not kill host processes or delete leases as proof. See [recovery](troubleshooting.md#unconfirmed-stop).

After confirmed stop, exit every old wrapper, update all copies together, reconnect and reload the host extension. The microphone now requires origin-scoped random-epoch tickets (`<epoch>.<counter>`, UUID-like identity, not numeric-only) and exact `stopped N` receipts. Audio requires v2 negotiation and completion/stop proof. Existing epoch-qualified ticket state must be retained; only incompatible numeric-era `.tickets` state may be removed **after all old captures are confirmed stopped and old sessions exited**. Never unconditionally remove runtime state or the persistent `flock` fence. See [protocol migration](endpoint-protocol.md#microphone-protocol-migration).

For later published updates, update the host checkout:

```bash
cd /path/to/pi-voice
git pull
npm install
```

Reinstall client scripts whenever files under `client/` changed:

```bash
cd /path/to/pi-voice
install -m755 client/pi-voice-* "$HOME/.local/bin/"
```

For the Unix-socket-to-TCP migration, first confirm old devices stopped, update the Pi host and reinstall all client scripts, then exit every existing `pi-voice-ssh` shell before reconnecting. Run `/reload` in Pi. No `--tailscale` option or endpoint configuration is needed.

Exit every existing `pi-voice-ssh` shell before testing a new bridge. Multiple wrappers share a bridge and ControlMaster, so the old bridge remains alive until the final wrapper exits. Current wrappers use owner-tagged locks and recover locks left by crashes; reinstalling all scripts together is required because an already-running legacy wrapper still executes its old locking and endpoint logic.

If the checkout is not available on the client, copy scripts directly from the Pi host:

```bash
mkdir -p "$HOME/.local/bin"
scp 'YOUR_HOST:/path/to/pi-voice/client/pi-voice-*' "$HOME/.local/bin/"
chmod 755 "$HOME"/.local/bin/pi-voice-*
```

## Platform status

Linux and Termux are currently supported. Native macOS and Windows capture/playback backends are planned.
