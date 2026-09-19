# Custom endpoint protocol

[← README](../README.md) · [Devices and SSH](devices-and-ssh.md)

This is an advanced reference for replacing the bundled client bridge. Managed `pi-voice-ssh` users do not need to implement it.

Endpoints may use `tcp://host:port` or `unix:///absolute/path`. Explicit TCP is plaintext; put it behind SSH or another authenticated encrypted tunnel.

## Output connection

Audio protocol v2 requires a handshake on the actual output connection (never an empty connection probe):

1. Host sends `PI_VOICE_CONTROLhello\n` (the existing 16-byte control prefix).
2. Client replies `{"type":"protocol","version":2}\n`.
3. Host sends `PI_VOICE_AUDIO\n`.
4. After player startup, client replies `{"type":"session","version":2,"id":12345}\n`.
5. Only then does the host send mono little-endian Float32 PCM at 24 kHz.

The client keeps the reverse direction open for newline-delimited JSON `{"type":"playback","position":1.234}`. Position is the actual player position in seconds. The client-generated session ID scopes control to this player.

The host appends approximately one second of silence before clean EOF. After feeder EOF and successful player exit, the client sends `{"type":"complete","id":12345}` and closes. TCP acceptance, EOF, helper exit by signal, and elapsed duration are not completion proof. Premature close fails without automatic replay.

**Migration:** upgrade both host and client audio scripts. A v1 bundled client safely ignores the existing control command `hello`; the new host fails clearly without sending PCM or unknown raw headers. Custom clients must implement this safe control negotiation before use. New bundled clients retain legacy raw-input support for older hosts, but new hosts never accept legacy non-proof feedback.

## Pause/resume control connection

A second short connection to the same output endpoint starts with exactly 16 ASCII bytes followed by a command and player ID:

```text
PI_VOICE_CONTROLpause 12345\n
PI_VOICE_CONTROLresume 12345\n
PI_VOICE_CONTROLstop 12345\n
```

The bundled client maps pause/resume to mpv's `pause` property and stop to mpv's `quit` command. Stop replies `{"type":"stopped","id":12345}` only after the owning session has waited for actual player exit. Missing socket/PID alone is not proof. Exit receipts remain in the runtime directory so a scoped retry can recover a lost ACK. Control connections carry no PCM. Starting a new stream also replaces the previous endpoint player.

### Host cancellation API and limitations

`VoiceWorkerClient.cancel()` returns a cancel ID; only matching `idle.cancelId` confirms stop. Integration may wait one second, then await `VoiceWorkerClient.terminate()`. Termination cleans up its owned detached local worker group, including descendants after unexpected worker exit. **A rejected termination must retain the speech lease.** No index integration is included here.

Forced local termination cannot confirm remote buffered audio stopped. This implementation deliberately rejects termination and blocks replacement worker creation when remote completion/stop proof is missing; it does not claim that killing SSH/helper/worker stops the phone. A lost ACK, disconnected endpoint, stuck player, or unconfirmed local cleanup therefore requires recovery rather than lease release. Local cleanup is bounded and retains retiring handles on failure. Process-group cleanup is POSIX-only; Windows lacks descendant group confirmation. Player-exit proof does not measure physical speaker latency or hardware buffers. Runtime receipt cleanup must not occur while stop confirmation is outstanding.

## Input commands

The host opens a recording connection and sends `ticket\n`. The server replies
`ticket N\n` with a positive, monotonically increasing safe-integer admission ticket.
Only then may the host send `record N\n` **on that same connection**. Keep its
write side open throughout capture; EOF triggers generation-scoped cleanup.
Cancellation before receiving a ticket must close the connection without sending record.

A separate control connection sends `stop N\n`. It cancels that pending request
before admission/publication, or stops only the active recording bearing N. A late
old stop cannot stop a newer recording. Bare `record` / `stop` are rejected.

The persistent fence protects an atomically replaced pair of counters (latest issued
ticket and cancellation watermark). Admission requires the connection's ticket to
be the latest issued and above the watermark; newer ticket issuance supersedes older
unadmitted requests. Stop advances the watermark, but touches active state only for
its exact ticket. Storage is bounded, including one fixed replacement temp file;
ticket exhaustion fails closed. Never reset counters or delete the fence while
requests/stop retries may remain. Runtime-directory loss requires a fresh session,
not replaying old tickets. This is process-crash fencing, not power-loss durability.

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
ok c3RvcHBlZA==\n
```

The payload is base64 UTF-8 `stopped`. Send it **only after actual microphone stop is confirmed**, or after cancelling an admitted pre-start generation so it can never start. Accepting a stop request, closing a socket, or observing a dead API client is not confirmation. Linux waits for its recorder process group; Android issues quit and requires `isRecording: false`. An unconfirmed stop returns `error <base64-error-message>` and retains the lease. A later explicit Android stop retries the actual recorder even after its original owner exits, and retires that stale lease only after confirmation, fenced against new admission. Disconnect cleanup is generation-scoped too.

For `record`, an `ok` response is treated as direct recognized text for compatibility.

### Host input API

`PhoneInputClient.capture(endpoint, options)` acquires the ticket internally.
`stop(endpoint?)` keeps its legacy optional argument for source compatibility but
always uses the active capture's saved endpoint and ticket, never a newly routed
endpoint. With no owned capture it is a no-op; before ticket acquisition it cancels
without recording. `cancel()` aborts capture and returns stop confirmation (or
rejection). No index integration changes are included. Await cleanup before
releasing a microphone lease; a rejected stop retains ownership for scoped retry.
The recording connection's EOF cleanup remains useful if an SSH listener changes;
a control request reaching a different server is not proof about the old server.

### Microphone protocol migration

Older documentation defined stop `ok` as acceptance only. That contract is **not safe or compatible** with the current host: `ok` with `stopping`, an empty payload, or any payload other than `stopped` is rejected. Do not relabel an acceptance response as `stopped`; implement confirmation and pre-start cancellation fencing first. Ticket negotiation is mandatory; upgrade both host and recorder scripts. Upgrade all recorder-script copies on the client together, with no old recorder sessions still running. The bundled scripts require `flock` (util-linux on Linux/Termux); its persistent fence file must not be deleted while sessions may use it. No host compatibility switch permits acceptance-only ACKs.

`/voice stop` remains an immediate UI/processing cancellation escape hatch: it need not wait for transcription or editing to finish. Microphone cleanup continues separately and must report failure honestly. Network loss/timeouts are **unconfirmed**, never proof the microphone stopped; a new capture must wait for a successful explicit stop retry after reconnection.

## Limits

The host rejects microphone responses larger than 32 MB, ends no-speech capture after 12 seconds, and enforces a 120-second recording timeout. Streaming encoded audio is decoded as 16 kHz mono for voice detection and Whisper.
