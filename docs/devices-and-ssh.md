# Devices and SSH routing

[← README](../README.md) · [Installation](installation.md) · [Endpoint protocol](endpoint-protocol.md)

## Routing order

With `input`/`output` set to `auto`, Pi Voice selects:

1. the device ID inherited by the current `pi-voice-ssh` session;
2. the most recently active connected client;
3. local Linux or Termux devices on the Pi host.

Explicit `/voice device local` pins the session locally. `/voice device <id>` pins a registered client. Output-producing keybindings and voice commands claim the selected device and update its activity time. A device remains pinned during active speech or microphone capture so a newly connected client cannot move an utterance mid-stream.

Explicit `local`, `disabled`, `tcp://…`, and `unix:///…` endpoint settings bypass automatic routing.

## Managed SSH topology

`pi-voice-ssh` launches a local client bridge and asks OpenSSH to create two reverse Unix-socket forwards:

```text
Pi host ~/.cache/pi-voice/devices/<id>.audio.sock → SSH → client player
Pi host ~/.cache/pi-voice/devices/<id>.input.sock → SSH → client microphone
```

The wrapper writes a registration file alongside those sockets. Pi scans registrations dynamically, so a running session can discover newly connected clients without reload.

Managed endpoints never listen on a public interface. SSH encrypts transport between the client and Pi host. Explicit custom TCP endpoints do not inherit this guarantee.

## Shared wrappers and lifetime

For the same client device and SSH target, concurrent wrappers share:

- one persistent device identity;
- one client bridge;
- one OpenSSH ControlMaster;
- one pair of reverse forwards.

Reference files track interactive wrapper processes. The last shell to exit closes the ControlMaster and client bridge. Stale local wrapper references are cleaned on the next invocation.

Setup and bridge transitions use atomic owner-tagged locks. A contender waits for a live owner, reclaims a dead owner's lock, and cannot delete a replacement acquired concurrently. Current wrappers also recover ownerless lock directories left by a crashed legacy wrapper once no other legacy wrapper could still own them.

Different target hosts use separate masters while sharing the same local bridge. Different client devices register separate IDs and may connect simultaneously.

## Device identity

The client ID is stored at:

```text
${XDG_CONFIG_HOME:-~/.config}/pi-voice/device-id
```

Copy this file when migrating a client if it should retain the same explicit device selection. Delete it before reconnecting to intentionally create a new identity.

`PI_VOICE_DEVICE_NAME` controls the human-readable registered name. The default is the short hostname, with ` (Termux)` appended on Android.

The wrapper exports `PI_VOICE_DEVICE_ID` into the remote shell so Pi can prefer the current client's device. Existing multiplexer processes may preserve an older environment; most-recently-active routing and `/voice device <id>` provide fallbacks.

## Wrapper syntax

The wrapper accepts ordinary SSH options before the target and an optional remote command:

```bash
pi-voice-ssh [--device-dir <absolute-remote-path>] [-p PORT] [-i KEY] [-o OPTION] USER@HOST [REMOTE_COMMAND ...]
```

If the target has a configured `RemoteCommand`, the wrapper preserves it while injecting the device environment. Otherwise it opens an interactive shell or runs the supplied command.

### Custom device registries

By default the wrapper registers the client into `~/.cache/pi-voice/devices` on the Pi host. When the remote Pi runs with a custom `PI_VOICE_DEVICE_DIR`, tell the wrapper so both sides agree:

```bash
pi-voice-ssh --device-dir /srv/pi-voice/devices u@host
pi-voice-ssh --device-dir=/srv/pi-voice/devices u@host
```

The value must be an absolute remote path (`~` and relative paths are rejected). If `--device-dir` is omitted but the client's own `PI_VOICE_DEVICE_DIR` is set, that value is treated as the intended remote path. The chosen directory is used for registration, sockets, and cleanup, and is exported as `PI_VOICE_DEVICE_DIR` into the remote shell so a Pi started there scans the same registry.

Set `PI_VOICE_SSH_DRY_RUN=1` to print resolved identity/platform/target information without connecting.

## Legacy bridge compatibility

If no managed registration exists but loopback listeners are present on ports 8765 and 8766, automatic routing exposes a `legacy-loopback` Termux device. This permits old fixed-port wrappers to keep working during migration. New installations should use managed per-device Unix sockets.

## Multiple Pi sessions

Interactive TUI sessions coordinate through `~/.cache/pi-voice/coordinator`:

- one session owns speech at a time;
- tool-only and headless child/subagent sessions do not request attention;
- waiting responses never start automatically;
- manual input and playback controls can preempt ownership;
- F11 and `/voice attention` route cross-process requests to waiting sessions;
- paused sessions remain paused until explicit user action.

Project labels use the root directory name and add the shortest parent suffix needed to distinguish duplicates.
