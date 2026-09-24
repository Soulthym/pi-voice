# Devices and SSH routing

[← README](../README.md) · [Installation](installation.md) · [Endpoint protocol](endpoint-protocol.md)

## Session pinning

With `input`/`output` set to `auto`, a new session pins its current connection's device. Reloading/resuming a session restores its saved pin; merely attaching another client does not change it. Pins are stored in the existing session device entry, never global configuration. A genuinely local, non-SSH/non-tmux connection can pin local I/O.

In **auto mode**, `/voice reconnect` adopts the current attachment without starting playback. Replay, resume, playback-requesting navigation and `/voice test` also adopt the current connection before speaking (unless `output` is non-`auto`). Automatic narration and dictation retain the pin. Pause-only and paused navigation do not resolve identity; navigation previews remain immediate. Ambiguous or unavailable identity fails closed, never guessing from old tmux environment values.

**Manual selection is sticky for this Pi session, including reload.** F4/mic, F5/replay, F6–F10 and ordinary activity do not resolve tmux attachment identity or repin it. `/voice reconnect` (or the existing `/voice device auto`) explicitly returns to auto mode **only on successful adoption**; failures retain the previous mode/pin. No endpoint settings change.

Cross-project `/voice attention` carries the origin session's manual selection, or freshly resolves its attachment in auto mode. The receiving session adopts that origin identity when in auto mode; a receiver's own manual selection remains sticky. Request freshness, cancellation, session ownership and confirmed-stop checks still apply; a detached receiver need not resolve its own attachment.

There is **no fallback** to another client or host I/O when the pin is missing or the connection identity is unavailable/ambiguous. Transport failures stop the affected operation: reconnect/fix the client and explicitly retry. `/voice device`, `/voice output` and `/voice input` without arguments are read-only metadata reports: a listed registration or endpoint does **not** mean connected or ready. Routing never opens a test socket (even an empty connection can kill an existing client player); SSH accepting a reverse connection does not prove client readiness.

### Explicit selection in a shared terminal

```text
/voice devices                 # native picker (also Alt+S / supported badge click)
/voice device                  # read-only current selection and registered candidates
/voice device <exact-id>
/voice device "Linux Mint PC"  # unique exact name; spaces inside quotes preserved
/voice device next
/voice device prev
/voice device local
/voice reconnect               # return to auto using fresh attachment identity
```

The entire argument is a name or ID, not just its first word. Single/double outer quotes are accepted; escape embedded quotes/backslashes with a backslash. Exact IDs win over names; duplicate names are rejected with matching IDs, never guessed. ID-prefix input is not supported. The reserved unquoted words are `auto`, `local`, `next`, `prev`.

Cycling wraps in stable, case-sensitive ID order, not activity order. With no candidates it reports an error and changes nothing; one candidate selects that device; a missing current ID (including local) selects the first for `next`, last for `prev`. Only valid registered metadata with at least one apparently available endpoint participates. Removed registrations/closed forwards are excluded where detectable. Registration lifetime follows the wrapper/forward, **not a timestamp TTL**: long-lived idle connections do not expire from inactivity. No readiness probes are made; on hosts hiding procfs, TCP availability remains unknown until actual use. Local and synthesized legacy-loopback entries are not inserted into the cycle.

A switch supersedes obsolete replay/capture acquisition, finalizes an active recording into the draft **without submitting**, and preserves manual editor changes. Unlike `/voice stop`, it does not cancel/discard that dictation. The old player and recorder must actually stop before committing the new pin. Failure keeps the old pin, badge and unconfirmed ownership; restore the original route and retry, never delete leases/tickets/receipts. Successful switching preserves the playback cursor, leaves selected playback paused (idle stays idle), and sends no audio to the new device until explicit playback. F8 resumes; F5 replays. A paused same-route reconnect also retires the sink while retaining queued streaming text for exact suffix resume; input-only ownership is not playback pause intent, so later manual prompt submission can narrate normally.

`local` means the machine running Pi, not the client issuing the command. Explicit `local`, `disabled`, `tcp://…`, and `unix:///…` endpoint settings still override the device selection **per direction**; only `auto` follows the selected device. Selection notices identify unchanged overrides, without guessing which physical host a custom endpoint represents.

Any attached client able to issue commands in this shared terminal may select a device. This is an explicit shared-terminal trust decision, **not identification/authentication of the key sender**. There is no key interception, new credential or control channel.

The selected device name appears once in brackets at the end of the first existing progress row (input, then playback, descriptions, timing). If there is no progress row, the existing Voice footer carries it; no extra work row is invented. Names are width-bounded; missing metadata uses a short ID, local is `[local]`, and no adopted identity is `[no device]`. This is selection feedback, not physical readiness, and endpoint URLs/credentials are never used as badges.

The same badge opens the [native device picker](usage.md#device-picker) in supported fullscreen Pi; Alt+S or `/voice devices` also works without mouse support. Opening/cancelling is read-only. Candidates are snapshots, revalidated by stable ID, registration generation and endpoints when chosen and before committing after stop. No disconnected pin or synthesized legacy entry is advertised as available; explicit Local is host audio, not a fallback. New controls/session replacement invalidate pending choices.

## Managed SSH topology

`pi-voice-ssh` launches a local client bridge and requests two dynamically allocated reverse TCP forwards. The same mechanism is used with OpenSSH and Tailscale SSH:

```text
Pi host 127.0.0.1:<allocated audio port> → SSH → client 127.0.0.1:8765
Pi host 127.0.0.1:<allocated input port> → SSH → client 127.0.0.1:8766
```

The wrapper writes the allocated endpoints to `~/.cache/pi-voice/devices/<id>.json`. Ports are cached alongside the shared ControlMaster on the client and reused by concurrent wrappers. Pi scans registrations dynamically and ignores closed loopback listeners when procfs is available.

Managed forwards request loopback-only listeners; keep OpenSSH `GatewayPorts no` (the default) to prevent the server from overriding that restriction. Do not open voice ports in your firewall. SSH encrypts transport between the client and Pi host. Local users on a shared server can access loopback endpoints; this topology is intended for personal servers, not untrusted multi-user isolation.

Connect from Termux or Linux with `pi-voice-ssh USER@TAILSCALE_NAME_OR_IP`. No Tailscale flag is needed. This avoids reverse Unix sockets that some Tailscale SSH versions create as root, preventing the Pi user from accessing them. TCP reverse forwarding must be allowed by the SSH server/policy; support is checked during setup.

## Shared wrappers and lifetime

For the same client device and SSH target, concurrent wrappers share:

- one persistent device identity;
- one client bridge;
- one OpenSSH ControlMaster;
- one pair of reverse forwards.

Reference files track interactive wrapper processes. The last shell to exit closes the ControlMaster and client bridge. Stale local wrapper references are cleaned on the next invocation.

Setup and bridge transitions use atomic owner-tagged locks. A contender waits for a live owner and attempts to reclaim a dead owner's lock. Stale-owner checking and reclaim are separate operations, not a general race-free filesystem guarantee. Current wrappers also recover ownerless lock directories left by a crashed legacy wrapper once no other legacy wrapper could still own them.

Different target hosts use separate masters while sharing the same local bridge. Different client devices register separate IDs and may connect simultaneously.

## Device identity

The client ID is stored at:

```text
${XDG_CONFIG_HOME:-~/.config}/pi-voice/device-id
```

Copy this file when migrating a client if it should retain the same explicit device selection. Delete it before reconnecting to intentionally create a new identity.

The human-readable name is saved beside the ID at `${XDG_CONFIG_HOME:-$HOME/.config}/pi-voice/device-name`. Both desktop and Termux wrappers prompt on the first interactive connection when it is missing, then reuse the saved name. Existing installs prompt on their next interactive connection without changing their ID. There is no name environment override or hostname fallback, even for inherited obsolete variables. Use `pi-voice-ssh --set-device-name "My device"` for headless setup or rename, or omit the name for a visible prompt even when already named. This is strictly standalone (no SSH target/options), local-only, and preserves the ID. Normal first-connection prompts are visible too. Noninteractive first connections must run the setter or fail with instructions. See [validation and limits](environment.md#device-name-validation) and [install/upgrade instructions](installation.md#upgrade-device-name-support).

Names are display metadata, **not authentication or routing identity**. An explicit unique-name command resolves to a stable ID; duplicate names never select or redirect a device. Auto mode uses fresh verified connection/SSH-attachment identity at its adoption boundaries, not an arbitrary newest registry entry. An unrelated control sender/registry label is not attachment proof. Automatic narration retains its pin; changing a file or attaching a client never automatically repins mid-playback or bypasses confirmed-stop barriers.

`pi-voice-client` and the older `pi-voice-phone` bridge do not register devices or choose names; the SSH wrappers alone publish metadata. Internal per-stream helpers never prompt.

Changing the label leaves the stable device ID and `<id>.json` registry filename unchanged; do not delete `device-id` to rename a client. Platform is recorded separately. The wrapper's `Connected as <name>` message confirms the client's registration identity, and Pi's `Connected to <name> · identity selected` notice confirms selected identity; neither proves microphone/output readiness. Before editing the local name file, confirm playback/capture stopped and close all wrappers on that client; then reconnect from an updated wrapper to register the changed name. Preserve connections/state if stop remains unconfirmed.

The wrapper exports `PI_VOICE_DEVICE_ID` and target identity into the remote shell. Direct SSH uses that connection's environment. For tmux, Pi reads the current attached client's identity using the pane/socket and checks that the attachment did not change during lookup; it does not trust the long-lived Pi process's startup device ID. In auto mode, multiple clients, no attached client, unreadable identity, or unresolved nested tmux fail closed rather than guessing. Explicit manual selection is the supported alternative when several clients share the terminal.

## Wrapper syntax

The wrapper accepts common SSH options before the target and an optional executable plus arguments (its option parser is not exhaustive; separate-argument `-B` is not supported):

```bash
pi-voice-ssh [--device-dir <absolute-remote-path>] [-p PORT] [-i KEY] [-o OPTION] USER@HOST [REMOTE_COMMAND ...]
```

Remote arguments are quoted individually, not parsed as one shell program: use `pi-voice-ssh HOST sh -lc 'echo hello'` for shell syntax, not `pi-voice-ssh HOST 'echo hello'`. A configured `RemoteCommand` is prefixed with `env` to inject device identity, so shell builtins/compound commands likewise need an explicit shell. Otherwise the wrapper opens an interactive shell or runs the supplied executable.

### Custom device registries

By default the wrapper registers the client into `~/.cache/pi-voice/devices` on the Pi host. When the remote Pi runs with a custom `PI_VOICE_DEVICE_DIR`, tell the wrapper so both sides agree:

```bash
pi-voice-ssh --device-dir /srv/pi-voice/devices u@host
pi-voice-ssh --device-dir=/srv/pi-voice/devices u@host
```

The value must be an absolute remote path (`~` and relative paths are rejected). If `--device-dir` is omitted but the client's own `PI_VOICE_DEVICE_DIR` is set, that value is treated as the intended remote path. The chosen directory is used for registration and cleanup, and is exported as `PI_VOICE_DEVICE_DIR` into the remote shell so a Pi started there scans the same registry.

Set `PI_VOICE_SSH_DRY_RUN=1` to print resolved identity/platform/target information without connecting.

## Legacy bridge compatibility

Saved `legacy-loopback` pins remain readable, but menus/cycling no longer synthesize an unregistered device from ports 8765/8766. For an unregistered legacy bridge, use explicit input/output endpoint settings; automatic routing never falls back to it. New installations use managed per-device dynamic TCP forwards. Existing Unix-socket registrations remain readable for compatibility; exit all old wrappers before upgrading.

## Multiple Pi sessions

Interactive TUI sessions coordinate through `~/.cache/pi-voice/coordinator`:

- one session owns speech at a time;
- tool-only and headless child/subagent sessions do not request attention;
- waiting responses never start automatically;
- manual input and playback controls can preempt ownership;
- F5/↺ replays this project's response; `/voice attention` explicitly attends the oldest eligible waiting session (current-project replay when current/none waiting); queued attention alone does not interrupt current speech;
- paused sessions remain paused until explicit user action.

Project labels use the root directory name and add the shortest parent suffix needed to distinguish duplicates.
