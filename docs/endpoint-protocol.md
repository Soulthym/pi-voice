# Custom endpoint protocol

[← README](../README.md) · [Devices and SSH](devices-and-ssh.md)

This is an advanced reference for replacing the bundled client bridge. Managed `pi-voice-ssh` users do not need to implement it.

Endpoints may use `tcp://host:port` or `unix:///absolute/path`. Explicit TCP is plaintext; put it behind SSH or another authenticated encrypted tunnel.

## Output connection

Audio protocol v3 requires a handshake on the actual output connection (never an empty connection probe):

1. Host sends `PI_VOICE_CONTROLhello\n` (the existing 16-byte control prefix).
2. Client replies `{"type":"protocol","version":3}\n`.
3. Host sends `PI_VOICE_PREPARE\n`.
4. Client durably reserves a random UUID v4 **without opening a player**, then replies `{"type":"prepared","version":3,"id":"<uuid>","boot_id":"<kernel-boot-uuid>","device_id":"<stable-device-id>","boot_fenced":true}\n`. Boot identity comes only from `/proc/sys/kernel/random/boot_id`; missing/invalid identity is JSON `null`, never a generated boot UUID. Null-boot scopes retain receipt-based operation and cleanup, but cannot use reboot proof.
5. The host fsyncs the original endpoint, selection/configuration, ID and boot ID to its recovery journal. Only successful journal publication permits `output-grant` to the worker. The worker checks the expected boot and cancellation epoch before forwarding the grant.
6. Host sends `PI_VOICE_COMMIT <uuid> <kernel-boot-uuid>\n` on that same connection. Use literal `null` instead of the boot UUID for a null-boot scope. The client verifies both identities, takes the scope lock, checks the durable stop tombstone, and persists possible dispatch before spawning mpv. `boot_fenced:true` promises that a known expected boot is also re-read and checked immediately before spawn; the host persists this per-scope capability before granting only when `device_id` independently reported by the helper matches the original registered route ID. The helper reads its existing `${XDG_CONFIG_HOME:-$HOME/.config}/pi-voice/device-id`; missing/invalid identity is `null` and cannot enable reboot discharge.
7. After player startup, client replies `{"type":"session","version":3,"id":"<uuid>","boot_id":"<kernel-boot-uuid>"}\n`. Only then does the host send mono little-endian Float32 PCM at 24 kHz.

The client keeps the reverse direction open for newline-delimited JSON `{"type":"playback","position":1.234}`. Position is the actual player position in seconds. The client-generated session ID scopes control to this player. Generate a secure random lowercase UUID v4 once per stream, independent of its PID; preserve it as an opaque string. All scoped commands and completion/stop receipts must match that exact ID. Numeric IDs (including numeric strings), malformed IDs and path components are rejected.

The host appends approximately one second of silence before clean EOF. After feeder EOF and successful player exit, the client sends `{"type":"complete","id":"<uuid>","boot_id":"<kernel-boot-uuid>"}` and closes. TCP acceptance, EOF, helper exit by signal, and elapsed duration are not completion proof. Premature close fails without automatic replay.

**Migration:** upgrade the host and every installed desktop/Termux helper and SSH wrapper together, including custom paths—not just audio-script copies. Both wrapper variants require the exact v3 `hello` reply for readiness; their probe sends only control `hello`, never prepare/commit or PCM. Follow the [confirmed-stop and complete-helper upgrade steps](installation.md#audio-protocol-v3-host-and-every-client). V1/v2 negotiation, old `PI_VOICE_AUDIO`, and raw PCM cannot start a player; there is no fallback. A failure **before commit** can prove non-admission. After commit, even zero PCM requires an exact player-exit receipt. Old numeric receipts cannot confirm modern streams. V1 safely ignores `hello`; v2 is rejected without sending its audio header. Existing durable receipts are retained for scoped legacy cleanup, never for new admission.

## Pause/resume control connection

A second short connection to the same output endpoint starts with exactly 16 ASCII bytes followed by a command and player ID:

```text
PI_VOICE_CONTROLpause aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n
PI_VOICE_CONTROLresume aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n
PI_VOICE_CONTROLstop aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n
```

The bundled client maps pause/resume to mpv's `pause` property and stop to mpv's `quit` command. Stop replies `{"type":"stopped","id":"<uuid>","boot_id":"<kernel-boot-uuid>"}` after actual player exit, or after durably closing an uncommitted reservation under the same lock as commit/spawn. Missing socket/PID alone is not proof. Exit receipts remain under `${XDG_STATE_HOME:-$HOME/.local/state}/pi-voice/playback` so a scoped retry can recover a lost ACK across runtime-directory loss. Non-admission has its own durable `not-admitted` receipt; only the actual owner's child wait may publish `exited`. A persisted possible dispatch without the owner's child-wait receipt stays fenced. Control connections carry no PCM. Starting a new stream also replaces the previous endpoint player.

For eligible reboot recovery only, the host sends `PI_VOICE_CONTROLstop <uuid> <expected-boot-uuid>\n`. A changed known boot returns `{"type":"stopped","id":"<uuid>","boot_id":"<current-boot>","device_id":"<stable-device-id>","proof":"reboot","expected_boot_id":"<saved-boot>"}` without stopping anything on the new boot. The host accepts this only with persisted commit fencing, original registered-device routing, and an independently reported matching `device_id` on the recovery connection; a stale registration pointing at another client's reused socket is rejected. Matching addresses or display names alone are insufficient. Device IDs rely on the existing trusted registration/authenticated tunnel boundary, not cryptographic attestation by this protocol. Ordinary/legacy receipt retries retain the two-token stop command. Unknown boot, missing capability, and unknown admission coverage never become idle through reboot inference.

### Host cancellation API and limitations

`VoiceWorkerClient.cancel()` returns a cancel ID; only matching `idle.cancelId` confirms stop. Integration may wait one second, then await `VoiceWorkerClient.terminate()`. Termination cleans up its owned detached local worker group, including descendants after unexpected worker exit. **A rejected termination retains the speech lease in the extension integration.**

Before physical dispatch, the worker publishes the original endpoint, opaque stream ID and actual boot ID to `VoiceWorkerClient`. Its in-process `remote-handle.grant()` callback must only be called after durable host journaling; merely observing the event does not authorize playback. This handle survives helper/worker failure. Retry `terminate()` on that **same client instance** after restoring the original connection: it cleans owned local descendants and requests `stop` for the retained stream, never a newly routed endpoint or PID. Only its exact receipt clears the failure latch and permits a replacement worker; disconnected or foreign-session responses retain ownership. Do not discard the failed client during reconnect. Remote failures expose `code: "REMOTE_PLAYBACK_UNCONFIRMED"` on errors/events for episode-level UI handling, rather than relying on error-message matching.

The original live EPIPE cause remains **unobserved**. An EPIPE/helper-exit report establishes transport failure, not its underlying network/device cause. Mocked disconnect, broken-pipe and lost-ACK tests demonstrate retained-handle/receipt retry semantics, not reproduction or diagnosis of that incident. UI failure notices are deduplicated per resource and error episode: input and output failures remain independently visible; only matching confirmed cleanup resets that resource's episode. An older cleanup cannot clear a newer failure.

Forced local termination cannot confirm remote buffered audio stopped. This implementation deliberately rejects termination and blocks replacement worker creation when remote completion/stop proof is missing; it does not claim that killing SSH/helper/worker stops the phone. A lost ACK, disconnected endpoint, stuck player, or unconfirmed local cleanup therefore requires recovery rather than lease release. Local cleanup is bounded and retains retiring handles on failure. Process-group cleanup is POSIX-only; Windows lacks descendant group confirmation. Player-exit proof does not measure physical speaker latency or hardware buffers. Runtime receipt cleanup must not occur while stop confirmation is outstanding.

### Stage B scope and remaining gaps

Stage B remote output uses **prepare/journal/commit and a complete v3 admission ledger**, including orphan reclamation when every direction is proven idle. Output reservations are limited to 256 unresolved host-journal scopes; exceeding the limit denies grants. Cancellation closes worker grants synchronously; delayed grants cannot reopen that epoch. Original-route recovery remains mandatory, and v3 receipts must match the saved boot as well as the opaque ID.

Fresh owners initialize the v3 ledger before acquiring a lease. Remote dispatch durably marks output `covered` before preparation; no physical player can exist without its exact scope being journaled before the grant. Queued work and ungranted preparations therefore cannot hide a player. Matching receipts durably retire scopes; confirmed cancellation with no remaining scopes returns covered output to `idle`. After owner death, explicit reconnect retries original scopes and durably clears covered empty output. Reclamation then rechecks death, owner, PID, acquisition generation and **every** direction's durable idle proof under the speech mutation lock. Unused input stays idle, not a synthetic input episode. Unknown/legacy uncertainty is never upgraded. Output reboot discharge is allowed only for a saved v3 scope advertising `boot_fenced:true`, with a known saved boot and a different known current boot on the original registered device. Recovery resolves that original device ID to its current endpoint, never the new selection. Custom endpoints and synthetic `legacy-loopback` IDs cannot establish same-device reboot proof. Historical scopes without the saved capability require their original exact receipts.

Endpoint-owner `SIGKILL` after durable commit remains conservatively fenced, including the committed-before-spawn crash window. A replacement handler cannot perform the original owner's child wait: missing PID/socket state, elapsed time, or a synthetic wait result cannot become an exit receipt. A verified same-device reboot can close this window for boot-fenced scopes; otherwise reconnect does not invent evidence.

Local output still uses owned-process cleanup, not a prepared durable per-resource output ledger. Any local output admission or input admission keeps that owner's direction uncertain for orphan recovery, even after known scopes retire. Durable local/input all-idle accounting remains follow-up work; these cases stay fenced despite output reboot proof and the helper-level microphone boot checks below. Receipts are retained indefinitely; do not delete them while recovery is outstanding.

## Input commands

The host opens a recording connection and sends `ticket\n`. The server replies
`ticket N B\n`, where N is `<epoch>.<counter>`: a 32-character lowercase random hex
server-state epoch and a positive monotonically increasing safe integer (maximum
9007199254740991). B is the actual kernel UUID from `/proc/sys/kernel/random/boot_id`,
not a process-start identity. Missing/invalid boot identity denies admission.
The host durably retains endpoint, ticket, boot and route identity before sending
`record N B\n` **on that same connection**. Old bootless replies fail with an upgrade
error before START; there is no compatibility fallback. Keep its
write side open throughout capture; EOF triggers generation-scoped cleanup.
Cancellation before receiving a ticket must close the connection without sending record.

A separate control connection sends `stop N\n`. It cancels that pending request
before admission/publication, or stops only the active recording bearing N. A late
old stop cannot stop a newer recording. Bare `record` / `stop` are rejected.

The persistent fence protects a private, atomically replaced and synced state file containing the epoch,
latest issued counter, cancellation watermark and actual boot identity. The epoch is generated from 16 bytes
of OS randomness under that fence on first issuance and persists across connections.
Admission rechecks the epoch as well as the latest counter and watermark; newer
issuance supersedes older unadmitted requests. Stop rejects foreign or missing-state
epochs before touching markers or acknowledging anything, even when the receiving
server's counter is higher. This binds retries to the origin, not its forwarded address.
Stop advances the watermark, but touches active state only for its exact ticket.
Storage is bounded (one state file and fixed replacement temp file), without tombstones.
Counter exhaustion fails closed without rollover. Detectable missing/corrupt ownership
state fails closed. If all evidence is lost, first-install initialization may create a new
epoch; old stop and record tickets still fail closed. A new epoch cannot prove that
work admitted under the lost epoch stopped. Never reset counters, restore stale state, copy state between servers, or
delete the fence while sessions may use it. Lost state cannot prove an old microphone
stopped: recover the original recorder out of band before releasing its lease.
Publication syncs files and containing directory entries; this is not backup-rollback
protection or hardware power-loss validation. Desktop state lives under
`${XDG_STATE_HOME:-$HOME/.local/state}/pi-voice/microphone-desktop`, and Termux state
under `pi-voice/microphone/termux` in the same state root. Runtime audio files are not
ownership proof. Preserve durable state even when runtime directories are cleaned.
Desktop initialization retries sync the containing filesystem before issuing tickets,
including ancestors left behind by an interrupted initialization. Termux tickets also
persist the admitted owner; missing or mismatched `active` evidence remains fenced,
not acknowledged as stopped or reclaimed as an empty lock.

START rechecks its expected kernel boot and cancellation under the admission fence.
A verified different kernel boot cancels all previously issued tickets and retires
old helper ownership while retaining the epoch/counters. Process replacement does
neither. Same-boot admitted desktop ownership can retire only through its original
owner's direct recorder/encoder child waits. A random capture incarnation prevents
an older cleanup from retiring a newer capture; missing/reused PIDs are not proof.
An orphan admitted desktop capture stays fenced until verified reboot, even if its
children appear absent. Pending, not-yet-dispatched work can be cancelled under the fence.

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

The decoded payload must be exactly `stopped N`, echoing the full origin-scoped `<epoch>.<counter>` ticket requested by the host. Generic `stopped`, foreign epochs, and different counters are rejected without releasing ownership. Validate the ticket against persistent server state before acknowledging it; blindly echoing a foreign request is not proof. This protocol trusts the recorder implementation, not an unauthenticated echo as cryptographic attestation. Send it **only after actual microphone stop is confirmed**, or after cancelling an admitted pre-start generation so it can never start. Accepting a stop request, closing a socket, or observing a dead API client is not confirmation. The bundled Linux helper directly owns and waits for the recorder and encoder children before publishing durable retirement; arbitrary daemonizing replacement tools are not supported. Android requires a persisted successful, exact-path stock API start response, successful quit-call completion, and subsequent `isRecording: false`. Quit dispatch is durably marked before the call; a failed, timed-out or interrupted quit leaves a same-boot fence even if info reports idle, since a delayed quit could stop the next capture. A timed-out, failed, interrupted or unrecognized start response remains uncertain on the same boot even if info reports idle. A later explicit Android stop can retire a completed-start scope after its original helper exits only if no uncertain quit remains; it cannot invent dispatch completion. No native Android ticket enforcement or cancellation watermark is claimed. An unconfirmed stop returns `error <base64-error-message>` and retains ownership. Disconnect cleanup is generation-scoped too.

For `record`, an `ok` response is treated as direct recognized text for compatibility.

### Host input API

`PhoneInputClient.capture(endpoint, options)` acquires the ticket internally.
Its synchronous retention callback must finish durable publication before START.
The extension journals both local and remote input identities, rejects changed scope
metadata, and keeps input admission **uncertain**, not `covered`: pre-ticket accounting
and complete input all-idle/orphan recovery are not implemented. Local orphan scopes
are retained for diagnosis, not automatically retried.
`stop(endpoint?)` keeps its legacy optional argument for source compatibility but
always uses the active capture's saved endpoint and ticket, never a newly routed
endpoint. With no owned capture it is a no-op; before ticket acquisition it cancels
without recording. `cancel()` aborts capture and returns stop confirmation (or
rejection). The extension awaits cleanup before
releasing a microphone lease; a rejected stop retains ownership for scoped retry.
The recording connection's EOF cleanup remains useful if an SSH listener changes;
a control request reaching a different server is not proof about the old server.

### Microphone protocol migration

**Stage C requires another coordinated host/recorder upgrade**, including both
installed Termux helper copies and the desktop helper. Bootless epoch-aware clients
are now incompatible before START. Earlier four-field Termux ticket files lack durable
owner proof and are also refused rather than upgraded to idle. Existing legacy runtime recorder evidence is
refused, not silently migrated to idle: after independently confirming all old capture
and outstanding API dispatches have stopped and ending old sessions, explicitly
archive the old recorder-only state under operator supervision. Preserve it as evidence;
do not delete unrelated playback state, device identity or host leases. An idle Android
snapshot after a timed-out start is insufficient for that confirmation. An upgrade or
new helper process cannot clear an existing uncertain host direction.

Older documentation defined stop `ok` as acceptance only. That contract is **not safe or compatible** with the current host: `ok` with `stopping`, generic `stopped` (including older epoch-aware bridges), an empty payload, or any payload other than the exact `stopped N` is rejected. Do not merely echo the requested ticket onto an acceptance response; implement origin validation, confirmation and pre-start cancellation fencing first. Upgrade host and all recorder copies together. If this earlier migration is still outstanding, copy the full script set from the host's local checkout when it is not available upstream; see [safe upgrade steps](installation.md#upgrading). The historical batch after `ade0670` through `d4cf759` was host-only; that exemption does not apply to Stage C. Existing epoch-qualified state files need no reset for this receipt-only upgrade; retain them for outstanding retries. Epoch-qualified ticket negotiation is mandatory; upgrade both host and recorder scripts. Numeric-only hosts, tickets and old two-counter state files are incompatible. After confirming all old microphones stopped and exiting old sessions, remove the old `.tickets` state file before using the upgraded scripts; never migrate an outstanding numeric ticket into the new epoch. Upgrade all recorder-script copies on the client together, with no old recorder sessions still running. The bundled scripts require `flock` (util-linux on Linux/Termux); its persistent fence file must not be deleted while sessions may use it. No host compatibility switch permits acceptance-only ACKs.

`/voice stop` remains an immediate UI/processing cancellation escape hatch: it need not wait for transcription or editing to finish. Microphone cleanup continues separately and must report failure honestly. Network loss/timeouts are **unconfirmed**, never proof the microphone stopped; a new capture must wait for a successful explicit stop retry after reconnection.

## Limits

The host bounds recording-response accumulation at 32 MB, ends no-speech capture after 12 seconds, and enforces a 120-second recording timeout. The separate stop-response accumulator currently lacks that size bound; endpoints remain trusted local/tunneled services, not hardened untrusted servers. Streaming encoded audio is decoded as 16 kHz mono for voice detection and Whisper.
