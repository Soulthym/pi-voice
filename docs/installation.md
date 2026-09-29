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

Speech ownership requires Linux (including an otherwise supported Termux host) with `flock` (util-linux) in `PATH` and a local filesystem supporting directory fsync and symlinks. Missing locking support fails closed before acquiring speech; native macOS/Windows hosting is not supported by this recovery path.

Install `ffmpeg` for microphone decoding and Opus cache reads/writes. Without it, synthesis still works, but microphone input and audio caching do not.

For local Linux devices, install:

- PipeWire's `pw-play`, `pw-record`, and `wpctl`; or PulseAudio's `parec` for recording.
- `mpv` or `ffplay` as a playback fallback.
- Python 3 with `os.pidfd_open` and `signal.pidfd_send_signal`, and Linux pidfd support, for desktop capture (normally Python ≥3.9 / Linux ≥5.3). No numeric-PID fallback is used.

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

Install `openssh`, `socat`, `mpv`, `ffmpeg`, `flock` (util-linux), Python 3 with the pidfd facilities listed above, and PipeWire or PulseAudio recording utilities. From a Pi Voice checkout:

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

Grant Termux:API microphone permission in Android app settings. Do not run a raw microphone/audio probe as an installation or upgrade check.

On some Android 15 builds, the API callback remains blocked even though recording works. A timed-out start leaves dispatch uncertain: `termux-microphone-record -q` followed by `isRecording: false` is only an idle snapshot, not proof that a queued start cannot execute later. Do not retry capture over that uncertainty. Stage C retains unknown same-boot dispatch fences. For **covered new-protocol scopes**, a matching scoped receipt or eligible same-device, validated changed-kernel-boot proof can retire the scope through recovery; host ownership releases only when both directions are durably idle. A reboot alone cannot promote legacy/uncertain journals or uncovered local output to covered proof.

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

### Stage C boot-bound microphone upgrade

Update the host and every desktop/Termux recorder helper together; bootless ticket
or capability-less ticket replies now fail before recording with an explicit upgrade error.
Network capture requires `ticket-admit`: Termux reports `admit-v1` plus its existing
stable device ID as a quoted JSON string (or JSON `null` if absent), while desktop reports `wait-v1` with scoped child-wait receipts.
Local desktop retains `ticket-wait`/`wait-v1`. Preserve `device-id`; do not regenerate it. This is not a
host-only update. Follow the confirmed-stop/full-helper procedure below at a time
you choose; no deployment or restart is automatic.

Microphone ownership now uses private durable state under
`${XDG_STATE_HOME:-$HOME/.local/state}/pi-voice/microphone-desktop` (desktop) or
`pi-voice/microphone/termux` (Termux). Keep these directories and host journals.
Legacy runtime recorder state is deliberately refused, including idle old ticket/fence
files. Earlier four-field Termux ticket files are also refused because they lack
persisted owner proof. Before using the new microphone, independently confirm all old
captures stopped **and outstanding Android start/quit dispatches drained**, then end
all old sessions. Only then archive the specifically identified legacy recorder paths
under supervision; copying helpers alone will still hit the legacy-state guard.
An idle snapshot alone is insufficient. See [microphone migration](endpoint-protocol.md#microphone-protocol-migration)
for the exact recorder-only paths; move those existing paths to a private evidence
archive outside their old runtime locations, not a blanket TMPDIR/config cleanup.
If dispatch closure cannot be independently confirmed, stop here and retain evidence;
upgrade/reload is not a bypass. Keep current durable receipts, IDs and host leases.

Android API timeout/interruption remains uncertain on the same boot; quit plus an
idle info snapshot alone cannot close an outstanding start or quit. An uncertain quit
stays fenced because it could stop a later capture. Ordinary completed stock
API responses are tracked separately. No APK/dependency change or native service
cancellation guarantee is added. Current stock quit stdout is `Recording finished: <exact recording path>`
or `No recording to stop`; neither alone proves recorder destruction. Unknown start
or quit responses stay fenced on the same boot.

Fresh v4 owners with explicit covered input and saved `networkAdmission` or
`desktopWait` capabilities can recover original input scopes on reconnect, including
a live owner's original registered device at its current endpoint. Eligible Termux
`stop-admit` recovery also accepts same-device changed-kernel-boot proof. Orphan
release still requires both directions durably idle; version 4 alone is insufficient.
Covered new-protocol input can retire on matching scoped receipts or eligible validated
boot proof; unknown same-boot Android dispatch and legacy/uncovered input remain
fenced. Local-output admission is still the remaining coverage gap, not automatically
recoverable. This does not mean every input/output failure now recovers.

After confirmed playback/capture stop and closure of every old wrapper, install the
complete shared set using the exact [checkout/SCP commands below](#upgrade-device-name-support).
If a separate Termux helper set is installed, replace that complete set too, on the
client, substituting its actual installed directory:

```bash
scp 'YOUR_HOST:/path/to/pi-voice/termux/pi-voice-*' /absolute/custom/bin/
chmod 755 /absolute/custom/bin/pi-voice-*
```

Only then reconnect with `pi-voice-ssh YOUR_HOST` and run `/reload` in Pi when safe.
These are operator-run upgrade instructions, not deployment or stop-proof shortcuts.

Desktop capture now requires Python 3 with `os.pidfd_open` and `signal.pidfd_send_signal`, plus Linux pidfd support (normally Python ≥3.9 / Linux ≥5.3). Install/verify this on local Linux Pi hosts and every desktop capture client before upgrading; Termux's Android recorder path does not use Python. The recorder acquires its own incarnation-safe signal handle before opening the device; unavailable support fails closed rather than signalling a potentially reused PID.

### Audio protocol v3 (host and every client)

Update the host and **all installed helpers and SSH wrappers together** on every desktop and Termux client, including custom launcher paths. Copy the complete `client/pi-voice-*` set using the [local install or SCP commands below](#upgrade-device-name-support), not just `pi-voice-audio-session`. If using a separate `termux/` installation, update its complete `termux/pi-voice-*` set at its actual installed location too. Use the matching host checkout if these changes are not published upstream.

When probing a newly started bridge, both SSH wrapper variants require the exact v3 control-only `hello` acknowledgement; v1/v2, malformed and empty replies are rejected without sending audio or starting a player. The existing-live-bridge command-line check can bypass that wrapper probe; wrapper reuse is not an upgrade check. Actual host admission still requires v3 prepare/journal/commit before PCM (and the current boot-bound microphone capability before START). Old wrappers that require v2 will reject a new v3 bridge. Readiness is not a playback test.

Before replacing scripts or exiting wrappers, explicitly stop playback/capture and confirm actual device stop. If unconfirmed, preserve the connection, tickets, receipts, leases and runtime state and follow [stop recovery](troubleshooting.md#unconfirmed-stop); an upgrade is not stop proof. After confirmed stop, close every old wrapper on that client (they share a bridge), replace the complete helper set, reconnect and reload the host extension when ready. Retain device IDs, names/configuration and durable recovery evidence; remote tmux may remain. Earlier host-only notes below do not waive this v3 upgrade.

### Never-admitted orphan recovery

This earlier change was host-only; **no client scripts or endpoint protocol changed**. Load the updated extension when it is safe to do so; no SSH/client restart or hardware test is needed for this change. New owners get durable pre-dispatch admission evidence. Old journals are not upgraded, and an existing unresolved fence is not cleared by `/reload` or updating clients. Read the [legacy incident limitations](troubleshooting.md#disconnected-replay-incident-2026-09-27) before attempting recovery. Do not interrupt live sessions or delete coordination/runtime state to install this update.

### Sticky device selection and selected-device badge

The badge picker is **host-only**: update this extension and run `/reload` when ready. Alt+S and `/voice devices` open Pi's native selector; fullscreen Pi with native `MouseRegion` also accepts clicks/taps on `[🎧:device]` at the right end of the first VoiceUI line, including idle status. The badge is no longer in the built-in footer. Older/regular TTYs retain keyboard access. No wrapper recopy, reconnect, runtime-settings change, or live-session restart is needed for this picker. See [Alt+S conflicts and usage](usage.md#device-picker).

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

Before replacing scripts or exiting wrappers, explicitly stop active playback/capture and confirm actual device stop. If stop is unconfirmed, preserve the original connection, runtime state, tickets, receipts and leases; restore that connection and retry `/voice stop` (or `/voice reconnect` for retained input/output stop). Do not kill host processes or delete leases as proof. See [recovery](troubleshooting.md#unconfirmed-stop).

After confirmed stop, exit every old wrapper, update all copies together, reconnect and reload the host extension. The microphone now requires origin-scoped random-epoch tickets (`<epoch>.<counter>`, UUID-like identity, not numeric-only), an actual kernel boot ID echoed in START, and explicit capability-scoped stop receipts (`stopped N` for Termux, `stopped-wait N B` for desktop). Audio requires v3 prepare/journal/commit with opaque UUID stream IDs and boot-bound completion/stop proof. All v1/v2 clients are rejected before PCM; upgrade every helper and SSH wrapper copy together, not just the host or audio helper. Retained numeric receipts are not valid modern proof. Retain current durable epoch-qualified ticket state. Legacy runtime recorder paths—including idle epoch `.tickets` and `.fence` files—are refused by the new helper. Only after independently confirming all old captures and outstanding API dispatches stopped and closing all old sessions, archive those recorder-only paths under supervision as described in the protocol migration. Preserve durable audio/microphone receipts, device IDs and host leases. Never unconditionally remove runtime state, blanket-delete configuration/TMPDIR or remove a fence while any session may use it. See [protocol migration](endpoint-protocol.md#microphone-protocol-migration).

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
