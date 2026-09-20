# Custom endpoint protocol

[← README](../README.md) · [Devices and SSH](devices-and-ssh.md)

This is an advanced reference for replacing the bundled client bridge. Managed `pi-voice-ssh` users do not need to implement it.

Endpoints may use `tcp://host:port` or `unix:///absolute/path`. Explicit TCP is plaintext; put it behind SSH or another authenticated encrypted tunnel.

## Output connection

Audio protocol v2 requires a handshake on the actual output connection (never an empty connection probe):

1. Host sends `PI_VOICE_CONTROLhello\n` (the existing 16-byte control prefix).
2. Client replies `{"type":"protocol","version":2}\n`.
3. Host sends `PI_VOICE_AUDIO\n`.
4. After player startup, client replies `{"type":"session","version":2,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}\n` (example ID).
5. Only then does the host send mono little-endian Float32 PCM at 24 kHz.

The client keeps the reverse direction open for newline-delimited JSON `{"type":"playback","position":1.234}`. Position is the actual player position in seconds. The client-generated session ID scopes control to this player. Generate a secure random lowercase UUID v4 once per stream, independent of its PID; preserve it as an opaque string. All scoped commands and completion/stop receipts must match that exact ID. Numeric IDs (including numeric strings), malformed IDs and path components are rejected.

The host appends approximately one second of silence before clean EOF. After feeder EOF and successful player exit, the client sends `{"type":"complete","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}` and closes. TCP acceptance, EOF, helper exit by signal, and elapsed duration are not completion proof. Premature close fails without automatic replay.

**Migration:** upgrade to the latest host and all client audio-script copies together. Earlier v2 clients using PID/numeric IDs are incompatible: the host rejects readiness before sending PCM and requests an upgrade. A failed pre-audio handshake is not a playback completion or remote stop proof; cancellation can release ownership only because no audio was admitted. Old numeric receipts cannot confirm modern streams. A v1 bundled client safely ignores the existing control command `hello`; the new host fails clearly without sending PCM or unknown raw headers. Custom clients must implement this safe control negotiation before use. New bundled clients retain legacy raw-input support for older hosts, but new hosts never accept legacy non-proof feedback.

## Pause/resume control connection

A second short connection to the same output endpoint starts with exactly 16 ASCII bytes followed by a command and player ID:

```text
PI_VOICE_CONTROLpause aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n
PI_VOICE_CONTROLresume aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n
PI_VOICE_CONTROLstop aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n
```

The bundled client maps pause/resume to mpv's `pause` property and stop to mpv's `quit` command. Stop replies `{"type":"stopped","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}` only after the owning session has waited for actual player exit. Missing socket/PID alone is not proof. Exit receipts remain in the runtime directory so a scoped retry can recover a lost ACK. Control connections carry no PCM. Starting a new stream also replaces the previous endpoint player.

### Host cancellation API and limitations

`VoiceWorkerClient.cancel()` returns a cancel ID; only matching `idle.cancelId` confirms stop. Integration may wait one second, then await `VoiceWorkerClient.terminate()`. Termination cleans up its owned detached local worker group, including descendants after unexpected worker exit. **A rejected termination retains the speech lease in the extension integration.**

Forced local termination cannot confirm remote buffered audio stopped. This implementation deliberately rejects termination and blocks replacement worker creation when remote completion/stop proof is missing; it does not claim that killing SSH/helper/worker stops the phone. A lost ACK, disconnected endpoint, stuck player, or unconfirmed local cleanup therefore requires recovery rather than lease release. Local cleanup is bounded and retains retiring handles on failure. Process-group cleanup is POSIX-only; Windows lacks descendant group confirmation. Player-exit proof does not measure physical speaker latency or hardware buffers. Runtime receipt cleanup must not occur while stop confirmation is outstanding.

## Input commands

The host opens a recording connection and sends `ticket\n`. The server replies
`ticket N\n`, where N is `<epoch>.<counter>`: a 32-character lowercase random hex
server-state epoch and a positive monotonically increasing safe integer (maximum
9007199254740991). Treat the entire ticket as opaque; numeric-only tickets are rejected.
Only then may the host send `record N\n` **on that same connection**. Keep its
write side open throughout capture; EOF triggers generation-scoped cleanup.
Cancellation before receiving a ticket must close the connection without sending record.

A separate control connection sends `stop N\n`. It cancels that pending request
before admission/publication, or stops only the active recording bearing N. A late
old stop cannot stop a newer recording. Bare `record` / `stop` are rejected.

The persistent fence protects an atomically replaced state file containing the epoch,
latest issued counter and cancellation watermark. The epoch is generated from 16 bytes
of OS randomness under that fence on first issuance and persists across connections.
Admission rechecks the epoch as well as the latest counter and watermark; newer
issuance supersedes older unadmitted requests. Stop rejects foreign or missing-state
epochs before touching markers or acknowledging anything, even when the receiving
server's counter is higher. This binds retries to the origin, not its forwarded address.
Stop advances the watermark, but touches active state only for its exact ticket.
Storage is bounded (one state file and fixed replacement temp file), without tombstones.
Counter exhaustion fails closed without rollover. State loss creates a new epoch on
next issuance; old stop and record tickets fail closed, including loss between issuance
and record. Never reset counters, restore stale state, copy state between servers, or
delete the fence while sessions may use it. Lost state cannot prove an old microphone
stopped: recover the original recorder out of band before releasing its lease.
This is process-crash persistence, not power-loss durability or backup-rollback protection.

Under the fence, an empty recording-lock directory with **no active marker** is
provably pre-publication debris and is removed with `rmdir` before admission.
Existing owner markers are never removed by that recovery.

### Streaming recording

The preferred response is:

```text
stream\n
<encoded audio bytes until EOF>
```

The bundled clients stream Ogg/Opus. Host-side FFmpeg/VAD consumes the growing stream, and a second `stop N` connection asks the recorder to finalize and close the original stream. Recording admission is published under a per-device fence **before** dependency/device checks. A concurrent second `record` request is rejected rather than sharing or replacing microphone state. Startup rechecks that same generation under the fence, so a stop can cancel a blocked pre-start request without allowing it to start later.

### Single-response recording

A bridge may return one encoded recording on a single line:

```text
audio <base64-encoded-audio>\n
```

### Text or status response

Status payloads are base64-encoded UTF-8:

```text
ok <base64-text>\n
error <base64-error-message>\n
```

For `stop`, the only successful response is exactly:

```text
ok <base64 UTF-8 of "stopped N">\n
```

The decoded payload must be exactly `stopped N`, echoing the full origin-scoped `<epoch>.<counter>` ticket requested by the host. Generic `stopped`, foreign epochs, and different counters are rejected without releasing ownership. Validate the ticket against persistent server state before acknowledging it; blindly echoing a foreign request is not proof. This protocol trusts the recorder implementation, not an unauthenticated echo as cryptographic attestation. Send it **only after actual microphone stop is confirmed**, or after cancelling an admitted pre-start generation so it can never start. Accepting a stop request, closing a socket, or observing a dead API client is not confirmation. Linux waits for its recorder process group; Android issues quit and requires `isRecording: false`. An unconfirmed stop returns `error <base64-error-message>` and retains the lease. A later explicit Android stop retries the actual recorder even after its original owner exits, and retires that stale lease only after confirmation, fenced against new admission. Disconnect cleanup is generation-scoped too.

For `record`, an `ok` response is treated as direct recognized text for compatibility.

### Host input API

`PhoneInputClient.capture(endpoint, options)` acquires the ticket internally.
`stop(endpoint?)` keeps its legacy optional argument for source compatibility but
always uses the active capture's saved endpoint and ticket, never a newly routed
endpoint. With no owned capture it is a no-op; before ticket acquisition it cancels
without recording. `cancel()` aborts capture and returns stop confirmation (or
rejection). The extension awaits cleanup before
releasing a microphone lease; a rejected stop retains ownership for scoped retry.
The recording connection's EOF cleanup remains useful if an SSH listener changes;
a control request reaching a different server is not proof about the old server.

### Microphone protocol migration

Older documentation defined stop `ok` as acceptance only. That contract is **not safe or compatible** with the current host: `ok` with `stopping`, generic `stopped` (including older epoch-aware bridges), an empty payload, or any payload other than the exact `stopped N` is rejected. Do not merely echo the requested ticket onto an acceptance response; implement origin validation, confirmation and pre-start cancellation fencing first. Upgrade host and all recorder copies together. For this not-yet-pushed batch, copy the full script set from the host's local checkout, not a client-side pull; see [safe upgrade steps](installation.md#upgrading). Existing epoch-qualified state files need no reset for this receipt-only upgrade; retain them for outstanding retries. Epoch-qualified ticket negotiation is mandatory; upgrade both host and recorder scripts. Numeric-only hosts, tickets and old two-counter state files are incompatible. After confirming all old microphones stopped and exiting old sessions, remove the old `.tickets` state file before using the upgraded scripts; never migrate an outstanding numeric ticket into the new epoch. Upgrade all recorder-script copies on the client together, with no old recorder sessions still running. The bundled scripts require `flock` (util-linux on Linux/Termux); its persistent fence file must not be deleted while sessions may use it. No host compatibility switch permits acceptance-only ACKs.

`/voice stop` remains an immediate UI/processing cancellation escape hatch: it need not wait for transcription or editing to finish. Microphone cleanup continues separately and must report failure honestly. Network loss/timeouts are **unconfirmed**, never proof the microphone stopped; a new capture must wait for a successful explicit stop retry after reconnection.

## Limits

The host rejects microphone responses larger than 32 MB, ends no-speech capture after 12 seconds, and enforces a 120-second recording timeout. Streaming encoded audio is decoded as 16 kHz mono for voice detection and Whisper.
