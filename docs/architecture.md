# Architecture

[← README](../README.md) · [Endpoint protocol](endpoint-protocol.md) · [Devices](devices-and-ssh.md)

## Process layout

Pi Voice keeps expensive and latency-sensitive work outside the extension's TUI thread:

```text
Pi extension
├── main voice worker: Kokoro + Whisper + playback transport
├── alignment worker: Wav2Vec2 CTC
├── lightweight network playback helper per utterance
└── independent timing-preprocessing workers
```

The main worker serializes operations and loads models lazily, dispatching ordered sentence synthesis to a bounded child-process pool (default three); STT is not parallelized. Alignment and network playback events bypass that queue and write progress directly back to Pi, so ongoing Kokoro inference cannot delay highlighting updates.

Network playback helpers own full-duplex client connections and forward actual player position. The worker can pause, resume, or stop a specific client player over a short control connection without framing the raw PCM stream. Each endpoint enforces a single active Pi Voice player, so a replacement seek terminates buffered stale audio before starting.

Protocol v4 requires the installed `pi-voice-mpv-watchdog.lua` beside each audio helper. Native mpv binds its Linux process identity before PCM admission and owns the monotonic 30-second watchdog; the TCP helper renews every 5 seconds independently of PCM/pause. Host journals persist `nativeWatchdog:true` per scope before grant. Admission intent is fsynced under the scope lock before feeder/start dispatch. Marked reservations without intent can retire through durable `sealed-nonadmission`, even after idle-player spawn; possible audio admission requires verified bound process exit or separately eligible reboot proof, never elapsed time. See [native limits](endpoint-protocol.md#native-watchdog-and-proof-limits).

## Streaming narration

The extension incrementally parses assistant deltas into speech and code items. Complete sentence/literal-newline prose units are sent as they become available, without waiting for the entire message; unfinished units wait for a boundary or message end. A closing code fence starts a block-only description request; conversation mode waits through following prose until the next fence opening or containing message end. A delivery barrier lets preceding speech continue while preserving later transcript order.

Each narration segment carries source ranges, utterance/segment IDs, optional code focus cues, and description offsets. Playback and alignment events update the corresponding TUI ranges.

Conversation-aware descriptions hash a deterministic serialization of Pi's provider-compatible structured messages through that boundary for content-addressed identity. Inference also receives the available effective system prompt and active tool schemas, but those runtime definitions and generator selection are not description cache dependencies. When the description model is the active model, the effective system prompt, active tools, session ID, and pre-response messages preserve the normal request prefix for provider prompt-cache reuse; narration instructions are appended after the assistant prefix rather than replacing that system prompt.

Assistant messages separated by tool calls retain distinct source bases inside one continued narration state, preventing later messages from resetting highlighting for queued earlier audio.

## Session data

Pi Voice persists non-context-injecting custom entries for:

- complete playback timing snapshots;
- code-description cache snapshots;
- per-session device preference.

These entries are excluded from model context. In opt-in `conversation` mode, code-description keys hash Pi's resolved provider context through the next fence opening/message end—including preceding compaction summaries but excluding the runtime system/tool prefix—while default `block-only` keys omit discussion context. Content-addressed Opus lives outside the session under the audio cache.

## Cross-session coordination

Interactive TUI processes coordinate through atomic files under `~/.cache/pi-voice/coordinator`:

- heartbeat/presence records;
- an atomic, durable speech fence;
- per-owner original remote input/output scope and diagnostic journals under `stop-recovery/`;
- waiting-attention records;
- explicit cross-process attention requests;
- shared code/timing resource leases.

Heartbeats recover stale presence metadata, not speech ownership. Expiry/process death is not stop proof: failed cleanup retains the speech fence and blocks replacement work. Presence records explicitly mark interactive sessions, so headless child/subagent processes are excluded even if they inherit the extension and global config.

Manual activity uses acknowledged force-acquire semantics. The requester writes a preemption request, the displaced process stops its transport and releases the lease, and only then does replacement audio start. There is no age/PID-only stale-owner fallback: only an owner with complete durable idle proof for both directions (never dispatched, or covered dispatch with all scopes retired) can be reclaimed after process loss. A paused sink retains its device lease because it still owns the physical output resource; paused sessions never auto-resume. Cancellation ACK without matching remote receipts retains turn ownership but cannot admit new live audio (including flushes or project prefixes); source text remains available for explicit replay. Unresolved stop episodes force even unchanged-route reconnects to retry the retained clients/scopes. Matching late receipts complete an acknowledged episode, not an unacknowledged cancellation; deferred preemption releases only after both resource proofs, exactly once. Newer command/session/input epochs and callback reentry cannot restore obsolete displaced intent. Cleanup does not implicitly resume narration.

Waiting records carry a generation and original output identity. Current matching interactive presence keeps them alive; heartbeat age never creates speech-acquisition authority. Automatic delivery requires an eligible same-output receiver and an ordinary owned/free lease. `index.ts` keeps one independent untracked announcement continuation, not another notification queue. It offers that record at whole-message final + physical EOF before local backlog, or after Pause/Stop/navigation's original-resource proof. ACK plus delayed individual receipts retains the same boundary until proof completes. Only matching successful announcement EOF acknowledges the exact waiting generation. Playback/context/output epochs fence continuation and ACK; local arrivals remain in the existing source queue. Notification failure stops its own original scope before continuing local work and never acknowledges delivery.

Pause snapshots the selected source unit and device-confirmed playhead without mutating history. It retains remaining blocks before cancellation; explicit Resume forwards the offset and decoded-audio identity through Vocalizer/worker admission. The worker trims only an identical decoded cache hit and reports canonical, offset-adjusted time. Estimated/absent clocks and regenerated/changed PCM repeat the unit instead. This is software/device-clock evidence, not sample-exact hardware timing; local-output durable recovery limits below are unchanged.

## Device registry

`pi-voice-ssh` registers dynamically allocated reverse TCP forwards as JSON metadata under `~/.cache/pi-voice/devices`. Both SSH implementations use the same loopback transport. The extension validates metadata and checks registered loopback listener presence through procfs when available. Existing Unix endpoint registrations remain supported. Listener presence is not an authenticated health check; port reuse and a failed client bridge are still detected by playback/input connection failures.

Session routing uses a saved current-connection pin, never recent-activity fallback. Eligible explicit playback and forced reconnect resolve fresh attachment identity (ordinary playback skips adoption for session-local or non-auto output); automatic narration and dictation retain the pin. Missing or ambiguous identity fails closed. Registry ordering and legacy loopback candidates are metadata for explicit selection, not permission to switch devices.

## Failure and reload behavior

Background work captures a session epoch and checks it after asynchronous operations. Reload/session replacement invalidates Pi contexts; stale work returns local fallback or stops without touching the old context. Preprocessing promises absorb cancellation so a late worker rejection cannot become an uncaught exception.

Code/audio caches retain completed dependencies. Complete message timing maps are persisted after the complete render succeeds. Explicit timing retry can also persist metadata-only partial unit refinements without marking the message complete.

Original saved remote input/output scopes and device/cause diagnostics survive process loss in atomic, fsynced recovery journals. Startup reconstructs warnings; guarded automatic stop-only retries and explicit `/voice reconnect` retry the original ticket/stream IDs via the original registered device identity (or exact custom endpoint), with configuration/metadata validation. Automatic retries are single-flight, back off from 3 to 60 seconds, and never adopt a new route, resume playback or restart capture. Live healthy work is not a failed stop episode. Session, input, playback, owner/acquisition and journal-generation guards reject stale results. Scoped receipts retire matching handles; generation checks prevent older cleanup from clearing newer scopes. Confirmed output cleanup clears its cancellation barrier even while input recovery remains pending; unresolved input still blocks ownership release and replacement work. Healthy sibling work is neither stopped nor released by that cleanup.

Fresh owners initialize a v4 idle ledger before acquiring speech. Remote output dispatch durably enters `covered`: prepare grants require the exact endpoint/ID/boot scope to be fsynced first. Matching receipts retire scopes; confirmed cancellation (or dead-owner recovery) with no remaining scopes durably returns covered output to idle. Local output enters monotonic uncertainty; fresh covered desktop/Termux input requires its saved admission capabilities and exact receipts. Persistence failure prevents dispatch and aborts the narration generation. A dead process with both directions proven idle can be reclaimed under Linux `flock`, comparing owner, PID and acquisition generation. A live/reused PID is never reclaimed this way. Lease publication uses a populated backing directory and atomic no-clobber symlink, including against legacy contenders; backing directories are retained. The persistent lock inode must never be deleted. Deferred release retries contention without throwing through worker callbacks and cannot release a newer generation.

Remote-output resource coverage is complete under the mandatory prepare/grant protocol; durable local-output coverage remains missing. Microphone recovery retains its separate wait/admission rules, not native mpv proof. Uncertain and legacy owners are **not reclaimed even if all saved receipts succeed**. Missing or malformed journals fail closed. No existing record is upgraded to complete coverage. See the [legacy incident and recovery limitations](troubleshooting.md#disconnected-replay-incident-2026-09-27).

Progress rendering reuses the mounted widget and reads the foreground playback context without synchronously preparing cold history. Background history preparation yields in bounded slices; off renders no reserved rows. `/voice timing` combines quality, latency, worker limits and active retry progress. Explicit timing retry snapshots current-branch targets and cached spoken plans, serially decodes bounded cached Opus and aligns it in a dedicated cancellable child; it never routes through synthesis, description providers or audio output. Only wholly estimated units are replaced, with session/source/render fences and persisted per-unit coverage; mixed, refined, unknown and missing timing are skipped. Foreground speech/input preempts retry; Stop, session replacement/shutdown and newer valid retries cancel it. See [retry details](preprocessing-and-cache.md#silent-timing-retry).

## Key modules

- [`src/index.ts`](../src/index.ts): Pi lifecycle, commands, routing, coordination, and TUI integration
- [`src/vocalizer.ts`](../src/vocalizer.ts): streaming speech/code delivery
- [`src/worker.mjs`](../src/worker.mjs): TTS/STT, caching, local/network output
- [`src/narration-progress.ts`](../src/narration-progress.ts): source timing and Markdown styling
- [`src/session-coordinator.ts`](../src/session-coordinator.ts): leases and attention
- [`src/stop-recovery.ts`](../src/stop-recovery.ts): durable idle/admission evidence, original scopes, diagnostics and explicit scoped retries
- [`src/device-router.ts`](../src/device-router.ts): registered-device resolution
- [`src/playback-history.ts`](../src/playback-history.ts): navigation, timing, seeking
- [`src/code-describer.ts`](../src/code-describer.ts): semantic and guided code narration
