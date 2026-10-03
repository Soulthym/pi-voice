# Devices and SSH routing

[← README](../README.md) · [Installation](installation.md) · [Endpoint protocol](endpoint-protocol.md)

## Priority routing (UNDEPLOYED)

Current host source integrates priority routing; it is **UNDEPLOYED and not live-validated**. These priority commits change no client helpers or wire protocol. Already-compatible clients need only a later host reload when safe; outstanding [protocol/helper upgrades](installation.md#upgrading) still apply.

**Select and Pin are separate.** `/voice device <id>` or picker **Select (temporary)** changes the selected route, not its pin or manual priority. Selection holds until the next genuine connection/ranking/configuration event; ordinary activity and heartbeat-only updates do not rerank it. Session entries persist selection and the separate pin across reload; startup evaluates current availability/order again. Picker **Pin (priority 0)** persists only in that Pi session, not global JSON. A connected priority-0 pin wins even over a request to select another device; unpin it first. An offline pin retains 0 but is not an available winner.

The shared order is relational, not a numeric minimum:

1. The available session pin has priority **0**.
2. Explicit `user_order` is the manual prefix, followed by automatic devices in ascending earliest host discovery `date` (ID breaks ties). Dates are separate metadata, not last activity or connection timestamps.
3. Positive positions include offline devices and the pin's underlying position, so displayed numbers can have gaps. Offline rows show `!` and cannot be selected, but can be pinned/reordered/reset.
4. Local defaults to **-1**, a last-resort sentinel, never a numerically winning rank. Promoting Local into manual order gives it an explicit positive position. Reset removes only manual order; it preserves discovery dates and any pin.

Polling checks registrations every second; changed membership, `connectedAt`, endpoints, pin, shared order or endpoint configuration replaces the cached event snapshot. `lastActive` heartbeats and label-only changes do not rerank, refresh discovery dates or replace a temporary selection. Rendering and picker snapshot reads do not read the priority store or probe devices.

### Disconnect WAIT and handoff

With `output: auto`, a genuine event also switches a healthy selected route to the highest available priority when it differs. An active handoff preserves playing/paused intent through the same proof gates; idle routing does not invent playback. Explicit output overrides bypass these automatic handoffs, while explicit input overrides remain authoritative independently.

When the selected output disappears, active playback enters **WAIT** (the UI says “waiting for …”), retaining its current cursor and prior playing/paused intent. It does not fall down to a lower-ranked client or Local. The same device's return or a relationally higher available arrival can trigger handoff; a manual selection can clear WAIT for a chosen available route, subject to connected-0 precedence. After original-resource stop proof and current route/session/intent checks, still-current playing intent resumes from the **current cursor**, not message start; paused intent remains silent. A healthy ordinary manual switch outside WAIT instead leaves existing playback paused.

Stop, explicit pause, newer playback/navigation, dirty-asset changes, explicit reconnect or session replacement retire obsolete automatic-resume intent. A pending route decision may still finish safely without reviving that playback. Registration/reconnect, elapsed time, EOF and cancellation ACK alone are never stop proof: original scoped receipts or eligible verified same-device boot proof must satisfy the existing coverage gates for both resources. Failed proof keeps ownership and diagnostics; no new sink or capture is admitted.

Routing never starts a microphone automatically. A handoff finalizes existing dictation review-only (even with `submitMode: auto`), preserves manual edits and never submits the draft. `/voice reconnect` explicitly retries original-resource cleanup and adopts fresh attachment identity (subject to an available pin); it clears automatic-resume intent and **does not resume playback**. `/voice device auto` selects the current priority winner; it neither unpins nor resets manual order.

Fresh attachment resolution still fails closed on unavailable/ambiguous SSH/tmux identity, never guessing from old environment values. Priority discovery is a separate policy, not proof of the key sender. Cross-project `/voice attention` retains its explicit origin-selection/fresh-auto-attachment and receiver-selection guards; it does not bypass an available pin or stop proof.

`/voice device`, `/voice output` and `/voice input` without arguments are read-only metadata reports: a listed registration or endpoint does **not** mean connected or ready. Routing never opens a test socket (even an empty connection can kill an existing client player); SSH accepting a reverse connection does not prove client readiness.

### Priority persistence

The store is **outside** the registration directory: `join(dirname(deviceRouter.directory), "device-priorities.json")`, normally `~/.cache/pi-voice/device-priorities.json`, not `devices/device-priorities.json`. `PI_VOICE_DEVICE_DIR=/absolute/path/to/devices` therefore places it at `/absolute/path/to/device-priorities.json`; there is no separate priority-path variable. It stores version 1 `discovery[id].date` and `user_order`, not session pins. Locked read-modify-write, private temporary files, fsync and atomic rename preserve concurrent updates; malformed state fails rather than being overwritten as empty. Keep the `.lock` inode.

`/voice device forget <exact-id>` removes remembered date/manual-order metadata and clears this session's matching pin, **not** the registration, connection, selected device, other sessions' pins or stop evidence. It is not a blacklist: a still-available device can be rediscovered immediately with a new date.

### Explicit selection in a shared terminal

```text
/voice devices                 # native picker (also Alt+S / supported badge click)
/voice device                  # read-only current selection and registered candidates
/voice device <exact-id>
/voice device "Linux Mint PC"  # unique exact name; spaces inside quotes preserved
/voice device next
/voice device prev
/voice device local
/voice reconnect               # explicit attachment adoption/cleanup; never resumes playback
```

The entire argument is a name or ID, not just its first word. Single/double outer quotes are accepted; escape embedded quotes/backslashes with a backslash. Exact IDs win over names; duplicate names are rejected with matching IDs, never guessed. ID-prefix input is not supported. The reserved unquoted words are `auto`, `local`, `next`, `prev`.

Cycling wraps in stable, case-sensitive ID order, not activity order. With no candidates it reports an error and changes nothing; one candidate selects that device; a missing current ID (including local) selects the first for `next`, last for `prev`. Only valid registered metadata with at least one apparently available endpoint participates. Removed registrations/closed forwards are excluded where detectable. Registration lifetime follows the wrapper/forward, **not a timestamp TTL**: long-lived idle connections do not expire from inactivity. No readiness probes are made; on hosts hiding procfs, TCP availability remains unknown until actual use. Local and synthesized legacy-loopback entries are not inserted into the cycle.

A switch supersedes obsolete replay/capture acquisition, finalizes an active recording into the draft **without submitting**, and preserves manual editor changes. Unlike `/voice stop`, it does not cancel/discard that dictation. The old player and recorder must actually stop before committing the new selection. Failure keeps the old selection, badge and unconfirmed ownership; restore the original route and retry, never delete leases/tickets/receipts. Outside WAIT, successful manual switching preserves the playback cursor, leaves selected playback paused (idle stays idle), and sends no audio to the new device until explicit playback. WAIT clearing follows the retained-intent rules above. F8 resumes; F5 replays. A paused same-route reconnect also retires the sink while retaining queued streaming text for exact suffix resume; input-only ownership is not playback pause intent, so later manual prompt submission can narrate normally.

`local` means the machine running Pi, not the client issuing the command. Explicit `local`, `disabled`, `tcp://…`, and `unix:///…` endpoint settings still override the device selection **per direction**; only `auto` follows the selected device. Selection notices identify unchanged overrides, without guessing which physical host a custom endpoint represents.

Any attached client able to issue commands in this shared terminal may select a device. This is an explicit shared-terminal trust decision, **not identification/authentication of the key sender**. There is no key interception, new credential or control channel.

The selected device appears once as `[🎧:device]` at the right end of the first VoiceUI line (input, then playback, descriptions, timing; otherwise idle status). Idle status now occupies the Voice widget, not Pi's footer. Identity is reserved before status/hints; names are width-bounded with an ellipsis, and the badge is omitted below six available columns. Missing metadata uses a short ID, local is `[🎧:local]`, and no adopted identity is `[🎧:no device]`. This is selection feedback, not physical readiness, and endpoint URLs/credentials are never used as badges.

The same badge opens the [native device picker](usage.md#device-picker) in supported fullscreen Pi; Alt+S or `/voice devices` also works without mouse support. Opening/cancelling is read-only. Candidates are snapshots, revalidated by stable ID, registration generation and endpoints when chosen and before committing after stop. Offline remembered rows are marked `!`, never advertised as available; synthesized legacy entries are not added. Local means host audio and defaults to the last-resort -1 rank, not a disconnect fallback. New controls/session replacement invalidate pending choices.

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

Names are display metadata, **not authentication or routing identity**. An explicit unique-name command resolves to a stable ID; duplicate names never select or redirect a device. Fresh connection/SSH-attachment adoption and event-driven priority routing are distinct. Neither uses an arbitrary newest registry entry or treats a registry label/control sender as authentication. Genuine connection/order events can cause a priority handoff during playback, but never bypass confirmed-stop barriers.

`pi-voice-client` and the older `pi-voice-phone` bridge do not register devices or choose names; the SSH wrappers alone publish metadata. Internal per-stream helpers never prompt.

Changing the label leaves the stable device ID and `<id>.json` registry filename unchanged; do not delete `device-id` to rename a client. Platform is recorded separately. The wrapper's `Connected as <name>` message confirms the client's registration identity, and Pi's `Connected to <name> · identity selected` notice confirms selected identity; neither proves microphone/output readiness. Before editing the local name file, confirm playback/capture stopped and close all wrappers on that client; then reconnect from an updated wrapper to register the changed name. Preserve connections/state if stop remains unconfirmed.

The wrapper exports `PI_VOICE_DEVICE_ID` and target identity into the remote shell. Direct SSH uses that connection's environment. For tmux, Pi reads the current attached client's identity using the pane/socket and checks that the attachment did not change during lookup; it does not trust the long-lived Pi process's startup device ID. During fresh attachment resolution, multiple clients, no attached client, unreadable identity, or unresolved nested tmux fail closed rather than guessing. Explicit manual selection is the supported alternative when several clients share the terminal.

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
