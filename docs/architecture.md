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

The main worker serializes TTS/STT operations and loads models lazily. Alignment and network playback events bypass that queue and write progress directly back to Pi, so ongoing Kokoro inference cannot delay highlighting updates.

Network playback helpers own full-duplex client connections and forward actual player position. The worker can pause/resume a specific client player over a short control connection without framing the raw PCM stream.

## Streaming narration

The extension incrementally parses assistant deltas into speech and code items. Prose segments are sent immediately. A closing code fence starts an asynchronous description request and inserts a delivery barrier so preceding speech can continue while code narration is prepared; later speech remains ordered behind it.

Each narration segment carries source ranges, utterance/segment IDs, optional code focus cues, and description offsets. Playback and alignment events update the corresponding TUI ranges.

Assistant messages separated by tool calls retain distinct source bases inside one continued narration state, preventing later messages from resetting highlighting for queued earlier audio.

## Session data

Pi Voice persists non-context-injecting custom entries for:

- complete playback timing snapshots;
- code-description cache snapshots;
- per-session device preference.

These entries are excluded from model context. Code-description keys still hash Pi's resolved historical text context through each block, including preceding compaction summaries. Content-addressed Opus lives outside the session under the audio cache.

## Cross-session coordination

Interactive TUI processes coordinate through atomic files under `~/.cache/pi-voice/coordinator`:

- heartbeat/presence records;
- an atomic speech lease;
- waiting-attention records;
- explicit cross-process attention requests;
- shared code/timing resource leases.

Heartbeats recover stale files and crashed leases. Presence records explicitly mark interactive sessions, so headless child/subagent processes are excluded even if they inherit the extension and global config.

Manual activity uses force-acquire semantics. The displaced process notices lease loss during polling, stops its own transport, and records a waiting response when appropriate. Paused sessions never auto-resume.

## Device registry

`pi-voice-ssh` creates JSON metadata and reverse-forwarded Unix sockets under `~/.cache/pi-voice/devices`. The extension validates metadata version, ID, endpoints, socket presence, and staleness before routing.

The router prefers an inherited device ID and otherwise sorts by recent activity. Legacy loopback TCP listeners are detected only when no managed device registration is available.

## Failure and reload behavior

Background work captures a session epoch and checks it after asynchronous operations. Reload/session replacement invalidates Pi contexts; stale work returns local fallback or stops without touching the old context. Preprocessing promises absorb cancellation so a late worker rejection cannot become an uncaught exception.

Code/audio caches retain completed dependencies. Message timing snapshots are atomic and only persisted after the complete message render succeeds.

## Key modules

- [`src/index.ts`](../src/index.ts): Pi lifecycle, commands, routing, coordination, and TUI integration
- [`src/vocalizer.ts`](../src/vocalizer.ts): streaming speech/code delivery
- [`src/worker.mjs`](../src/worker.mjs): TTS/STT, caching, local/network output
- [`src/narration-progress.ts`](../src/narration-progress.ts): source timing and Markdown styling
- [`src/session-coordinator.ts`](../src/session-coordinator.ts): leases and attention
- [`src/device-router.ts`](../src/device-router.ts): registered-device resolution
- [`src/playback-history.ts`](../src/playback-history.ts): navigation, timing, seeking
- [`src/code-describer.ts`](../src/code-describer.ts): semantic and guided code narration
