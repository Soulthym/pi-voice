# Devices and SSH routing

[← README](../README.md) · [Installation](installation.md) · [Endpoint protocol](endpoint-protocol.md)

## Session pinning

With `input`/`output` set to `auto`, a new session pins its current connection's device. Reloading/resuming a session restores its saved pin; merely attaching another client does not change it. Pins are stored in the existing session device entry, never global configuration. A genuinely local, non-SSH/non-tmux connection can pin local I/O.

`/voice reconnect` adopts the **current attachment** without starting playback. Replay, resume, playback-requesting navigation and `/voice test` also adopt the current connection before speaking, except when the session explicitly selects `local` or `output` is non-`auto`. Forced reconnect and attention-origin adoption use their separate paths. Cross-project `/voice attention` sends the origin terminal's freshly resolved identity to the waiting session, which adopts that pin instead of resolving its possibly detached pane. Unavailable or ambiguous origin identity fails closed; old tmux environment identity is never guessed. Pause-only and paused navigation do not look up or change identity; navigation previews remain immediate. Automatic narration, dictation and automatic attention retries use the existing pin. An active old transport is terminated before rebinding; reconnect leaves playback paused.

There is **no fallback** to another client or host I/O when the pin is missing or the connection identity is unavailable/ambiguous. Transport failures stop the affected operation: reconnect/fix the client and explicitly retry. `/voice device`, `/voice output` and `/voice input` without arguments are read-only metadata reports: a listed registration or endpoint does **not** mean connected or ready. Routing never opens a test socket (even an empty connection can kill an existing client player); SSH accepting a reverse connection does not prove client readiness.

Explicit `/voice device local` selects local I/O; `/voice device <id>` selects a registered client until an eligible explicit playback action repins it (non-`auto` output bypasses ordinary adoption). Explicit `local`, `disabled`, `tcp://…`, and `unix:///…` endpoint settings bypass automatic routing for that direction. `/voice reconnect` resets the device selection to auto with the new pin, but does not change endpoint settings.

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

Names are display metadata, **not authentication or routing identity**. Duplicate names never select or redirect a device: routing uses stable IDs and fresh verified connection/SSH-attachment identity at the existing adoption boundaries, not an arbitrary newest registry entry. An unrelated control sender/registry label is not attachment proof. Automatic narration retains its pin; changing a file or attaching a client never automatically repins mid-playback or bypasses confirmed-stop barriers.

`pi-voice-client` and the older `pi-voice-phone` bridge do not register devices or choose names; the SSH wrappers alone publish metadata. Internal per-stream helpers never prompt.

Changing the label leaves the stable device ID and `<id>.json` registry filename unchanged; do not delete `device-id` to rename a client. Platform is recorded separately. The wrapper's `Connected to <name>` message confirms registration identity, and Pi's corresponding message confirms selected identity; neither proves microphone/output readiness. Before editing the local name file, confirm playback/capture stopped and close all wrappers on that client; then reconnect from an updated wrapper to register the changed name. Preserve connections/state if stop remains unconfirmed.

The wrapper exports `PI_VOICE_DEVICE_ID` and target identity into the remote shell. Direct SSH uses that connection's environment. For tmux, Pi reads the current attached client's identity using the pane/socket and checks that the attachment did not change during lookup; it does not trust the long-lived Pi process's startup device ID. Multiple clients, no attached client, unreadable identity, or unresolved nested tmux fail closed rather than guessing.

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

If loopback listeners are present on ports 8765 and 8766, the device menu can expose a `legacy-loopback` Termux candidate for explicit selection. Automatic routing never falls back to this candidate. New installations use managed per-device dynamic TCP forwards. Existing Unix-socket registrations remain readable for compatibility; exit all old wrappers before upgrading.

## Multiple Pi sessions

Interactive TUI sessions coordinate through `~/.cache/pi-voice/coordinator`:

- one session owns speech at a time;
- tool-only and headless child/subagent sessions do not request attention;
- waiting responses never start automatically;
- manual input and playback controls can preempt ownership;
- F5/↺ replays this project's response; `/voice attention` explicitly attends the oldest eligible waiting session (current-project replay when current/none waiting); queued attention alone does not interrupt current speech;
- paused sessions remain paused until explicit user action.

Project labels use the root directory name and add the shortest parent suffix needed to distinguish duplicates.
