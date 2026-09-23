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

Pi Voice prefers `pw-play`, then `mpv`, then `ffplay` for local output. It prefers a usable PipeWire source, then PulseAudio for local input. Selecting a non-monitor PulseAudio source requires successful `pactl` detection; otherwise the backend uses its default.

Run `/reload` after installing or updating the extension. Spoken output defaults to off; enable it with `/voice on`. Microphone dictation remains available when spoken output is off unless input or the shortcut is disabled.

## Install a device name

On each **client**, desktop or Termux, run `pi-voice-ssh YOUR_HOST` from a terminal. On the first connection it asks for a device name **before** starting SSH or the bridge. Input is visible as you type, including Unicode and Backspace; unsafe control/bidi sequences and incomplete or malformed UTF-8 are never echoed. Enter a label such as `My laptop` or `My phone`; Ctrl+C or EOF cancels without connecting or creating identity files.

The wrapper saves the literal UTF-8 label at `${XDG_CONFIG_HOME:-$HOME/.config}/pi-voice/device-name` (normally `~/.config/pi-voice/device-name`), beside the existing `device-id`. It reuses that file on subsequent connections. Both files are private (600), in a private directory (700), and newly created files are atomically published without replacing another first launch's choice. Concurrent prompts do not lock out other wrappers; the first successfully saved name wins.

There is **no device-name environment override or hostname fallback**, including inherited obsolete variables. Existing installations without the file prompt on their **next interactive connection**, retaining their stable ID. First runs with SSH `BatchMode=yes` (from `-oBatchMode=yes`, `-o BatchMode=yes`, or SSH configuration) or without a controlling terminal fail with the path and provisioning instructions. Otherwise prompting uses `/dev/tty`, even with redirected stdin; stdin intended for SSH is never consumed by the prompt.

Use the standalone local CLI for setup or renaming (also the official unattended provisioning path):

```bash
pi-voice-ssh --set-device-name              # visible prompt, even if already named
pi-voice-ssh --set-device-name "My laptop"  # headless; no TTY required
```

Only one optional positional name is accepted: no SSH target, SSH options, `--device-dir`, or other flags. The flag must be first. Extra arguments/options fail before mutation or SSH; `-v --set-device-name` is an error. After an SSH target, `host remotecommand --set-device-name` remains a remote command, not local setup. No equals-form is supported. Option-like names starting with `-` must be entered at the prompt. The no-argument form requires a controlling terminal and gives a provisioning example if unavailable.

Setup never queries SSH configuration, connects, starts bridges or creates a device ID. It validates and atomically replaces **only the name**, using the same bounded publication lock; existing ID bytes remain untouched. Concurrent explicit setters publish whole files, last writer wins. Normal first-run prompts still preserve the first writer's choice. Invalid or cancelled input leaves the old name intact. See [name validation](environment.md#device-name-validation): 1–128 characters, not whitespace-only, no controls/bidi or extra lines; Unicode, spaces, quotes and backslashes are preserved. Invalid input fails rather than being sanitized.

**Rename safely:** explicitly stop playback/capture and confirm actual stop, then close **all** wrappers on that client. Run `pi-voice-ssh --set-device-name "New label"` locally, then open a fresh connection. Existing bridges/registrations pick up the name on the next connection; the setter never implicitly restarts anything. Never regenerate/delete `device-id` to customize the label. If stop is unconfirmed, retain the old connection/state and follow [recovery](troubleshooting.md#unconfirmed-stop) first.

After registration, `Connected as <name>` confirms the **client's** identity, **not audio readiness**. Renaming does not change the persistent device ID or registry filename.

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

Speak for five seconds. On some Android 15 builds, the API callback remains blocked even though recording works; the two-second timeout is intentional and recording continues to its configured limit. Before connecting or retrying, run `termux-microphone-record -q` and confirm `termux-microphone-record -i` reports `isRecording: false`; timeout alone is not stop proof.

Connect using the wrapper:

```bash
pi-voice-ssh YOUR_HOST
```

See [Usage](usage.md#optional-termux-function-key-row) for one-tap F4–F10 controls.

## Local Termux Pi

Local audio routing supports Termux, but hosting inference also requires a working native ONNX runtime. The pinned Node runtime package does not list Android as a supported platform; the client dependencies alone do not establish stock-Termux host support. With a compatible runtime installed, run normal `pi`. With `input` and `output` set to `auto`, a genuinely local session pins Termux's microphone and `mpv`; no SSH wrapper is required.

## SSH server configuration

Managed clients use dynamically allocated reverse TCP forwarding on server loopback, for both ordinary SSH and Tailscale SSH. No public voice ports need opening.

For an OpenSSH server, retain `GatewayPorts no` and permit remote forwarding:

```text
AllowTcpForwarding yes
GatewayPorts no
```

Validate with `sshd -t`, then reload `sshd` after changing its configuration. These settings do not control Tailscale's built-in SSH server; its version and policy must permit TCP reverse forwarding. Managed endpoint metadata is stored under `~/.cache/pi-voice/devices` on the Pi host.

## Upgrading

### Sticky device selection and selected-device badge

The badge picker is **host-only**: update this extension and run `/reload` when ready. Alt+D and `/voice devices` open Pi's native selector; fullscreen Pi with native `MouseRegion` also accepts clicks/taps on the existing first-line or built-in idle-footer badge. Older/regular TTYs retain keyboard access; custom footers may not be clickable. No wrapper recopy, reconnect, runtime-settings change, or live-session restart is needed for this picker. See [actual Alt+D conflict and usage](usage.md#device-picker).

Update the host extension and run `/reload` when ready. Existing clients already publishing names/IDs need **no protocol upgrade or reconnect for manual routing**: `/voice device "Linux Mint PC"`, an exact ID, or `next`/`prev` selects a sticky session pin, usable even with multiple attached tmux clients. `/voice device` is read-only; successful `/voice reconnect` returns to auto mode. Selection honors explicit input/output overrides and does not itself play audio. See [handoff and shared-terminal trust](devices-and-ssh.md#explicit-selection-in-a-shared-terminal).

Only the wrapper identity wording changed on clients (`Connected to` → `Connected as`). Recopy both installed wrapper variants using the commands below to get that wording on future connections; no live connection needs restarting merely for the text. Never discard unconfirmed stop state to apply an update.

### Upgrade device-name support

For visible prompts and standalone setup/rename, or first-save failure after an older hidden prompt (including on Termux): update both installed wrapper variants from this checkout using the commands below, then retry interactively. Publication now uses a short, bounded `flock` plus a private temporary file and atomic rename, not hard links. Linux/Termux already require `flock` (`util-linux`); it is now needed for first-time identity saving even on playback-only clients. Experimental macOS setups also need a `flock` implementation supporting `-x -w` (native macOS support remains unimplemented), or pre-provision both identity files. No lock is held during the prompt. The empty `.device.lock` fence remains intentionally; the kernel releases its lock on exit. Do not delete that fence while wrappers may be saving.

On save failure, the diagnostic identifies the failed operation and utility reason. Check that the local config directory is on writable storage owned by your Termux/client user and that `flock` is installed; retry after correcting the reported cause. A failed name save can leave `device-name` absent: this is safe and the next run prompts again. **Retain `device-id` and the config directory**; do not reset identity or delete runtime/registration state to recover.

This update changes both `client/pi-voice-ssh` and `termux/pi-voice-ssh`; a host update and `/reload` alone are **not sufficient**. Update the host checkout/extension and the installed wrapper on **every desktop and Termux client**, including custom launcher paths. The previous environment-based naming design is superseded entirely: remove obsolete name exports from launchers/shell startup files; even inherited values are ignored. Existing clients missing `device-name` prompt on their next interactive connection; unattended clients must [run the headless setter](#install-a-device-name) first. Existing `device-id` is retained.

Before replacing scripts or exiting wrappers, follow the confirmed-stop precautions below. Then exit all old wrappers. On each client, from the matching updated checkout, install the complete shared helper set (this is also the standard Termux installation):

```bash
mkdir -p "$HOME/.local/bin"
install -m755 client/pi-voice-* "$HOME/.local/bin/"
```

If the checkout exists only on the Pi host, run this **on each client**, desktop or Termux:

```bash
mkdir -p "$HOME/.local/bin"
scp 'YOUR_HOST:/path/to/pi-voice/client/pi-voice-*' "$HOME/.local/bin/"
chmod 755 "$HOME"/.local/bin/pi-voice-*
```

Use the host's updated local checkout when the changes are not yet published upstream. For an installation that deliberately invokes the alternative `termux/pi-voice-ssh`, also replace that exact installed wrapper from the matching `termux/pi-voice-ssh` source; the standard `client/` copy above does not update a separate custom path. For example, on that Termux client:

```bash
scp 'YOUR_HOST:/path/to/pi-voice/termux/pi-voice-ssh' /absolute/custom/path/pi-voice-ssh
chmod 755 /absolute/custom/path/pi-voice-ssh
```

Substitute the actual host checkout and installed paths. Update the underlying wrapper custom launchers execute. Reconnect interactively, answer the first-run name prompt if the file is missing, and run `/reload` in Pi. Check the `Connected as <name>` client identity message; it is not a playback or microphone test. Do not delete `device-id`, registrations, or runtime state to rename a device.

### Earlier upgrades and protocol migration

**Historical host-only follow-up after `ade0670`, through `d4cf759`:** no `client/` or `termux/` scripts changed in that range. Already-migrated users need the host update and `/reload` only, with no client recopy or SSH restart. The bridge replacement steps below apply only if scripts changed or the earlier migration is still outstanding.

**Earlier protocol migration, if outstanding:** use the Pi host's **local checkout** as the source for every client script when those changes are not available upstream; a client-side `git pull` is then insufficient. Copy the complete `client/pi-voice-*` set using the `scp` example below, including any alternative installed copies/custom client paths; do not mix old and new helpers. Install `flock` (`util-linux`) on Linux/Termux.

Before replacing scripts or exiting wrappers, explicitly stop active playback/capture and confirm actual device stop. If stop is unconfirmed, preserve the original connection, runtime state, tickets, receipts and leases; restore that connection and retry `/voice stop` (or `/voice reconnect` for retained output stop). Do not kill host processes or delete leases as proof. See [recovery](troubleshooting.md#unconfirmed-stop).

After confirmed stop, exit every old wrapper, update all copies together, reconnect and reload the host extension. The microphone now requires origin-scoped random-epoch tickets (`<epoch>.<counter>`, UUID-like identity, not numeric-only) and exact `stopped N` receipts. Audio requires the latest host and client scripts: v2 negotiation now uses secure opaque UUID stream IDs for scoped control and completion/stop proof. Older numeric/PID-based v2 clients are rejected before PCM; upgrade every audio-script copy together, not just the host. Retained numeric receipts are not valid modern proof. Existing epoch-qualified ticket state must be retained; only incompatible numeric-era `.tickets` state may be removed **after all old captures are confirmed stopped and old sessions exited**. Never unconditionally remove runtime state or the persistent `flock` fence. See [protocol migration](endpoint-protocol.md#microphone-protocol-migration).

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

Linux hosting and Linux/Termux clients are supported; local Termux hosting has the native-runtime caveat above. Native macOS and Windows capture/playback backends are planned.
