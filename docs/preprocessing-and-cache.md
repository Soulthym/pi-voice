# Preprocessing, timing, and audio cache

[← README](../README.md) · [Narration and highlighting](narration-and-highlighting.md) · [Architecture](architecture.md)

## Why preprocessing exists

Replay, seeking, synchronized highlighting, and written code descriptions need metadata that older or interrupted messages may not have. Pi Voice fills missing dependencies incrementally without playing audio.

Work is prioritized from the currently selected playback message forward to the session end, then backward toward the beginning. This makes nearby and future navigation useful first while eventually covering the full session.

Preprocessing continues while spoken output is disabled. Live speech, microphone actions, manual replay, and cross-session ownership preempt low-priority work.

## Status lines

Session-wide progress and selected-message playback state use distinct labels:

```text
Preprocessing · code descriptions (12/25 budget): 24/61 ready
Preprocessing · speech timing: 109/284 ready
○ Playback · message 280/284: speech timing pending
```

“Ready” counts complete persisted message-level results. The selected message index is navigation state, not the current preprocessing worker index.

## Code descriptions

Missing descriptions use `editModel` and are content-addressed by prompt version, model, narration mode, context mode, language, and source code. With `codeDescriptionContext: "conversation"`, the key also includes a deterministic serialization of Pi's provider-compatible context through the closing fence and, when the active model is reused, its effective system prompt and active tool schemas. Future turns do not change that historical prefix, so later preprocessing and replay hit the same entry; identical code appearing later in a different discussion gets a different description. With the default `block-only`, identical blocks share descriptions without including discussion context. Live narration, written callouts, timing preprocessing, and concurrent workers share in-flight requests and persisted results.

`codeDescriptionPreprocessConcurrency` controls parallel model requests from 1 to 8; the default is 4. It is explicit because API-backed model capacity is not derived from local hardware. Global coordinator slots enforce the limit across Pi processes.

Background preprocessing is scoped and budgeted separately from live narration: `codeDescriptionPreprocessScope` defaults to `since-compaction`, covering only messages the latest compaction retained, and `codeDescriptionPreprocessBudget` (default 25) caps historical backfill requests per session load. Cache hits are free; newly completed messages always describe themselves without consuming budget. `/voice code-budget <n|unlimited>` raises the current session's allowance and resumes skipped blocks.

Failed model requests use local structural narration. Before inference, `block-only` supplies the concerned block as numbered source, while `conversation` preserves that fence in the structured assistant context and references it without resending the body. Pi Voice conservatively checks the complete request—including system prompt and tools when reused—against the selected model's context window. With the active model, the request extends the normal conversation prefix and uses the Pi session ID with provider-default cache retention, allowing supported providers to reuse a still-live prompt cache. Oversized requests are reported and use the same local fallback instead of truncating historical context. Completed fallback or model plans remain usable after reload. Prompt-version changes invalidate stale narration plans.

## Speech timing

A timing pass converts speakable text and persisted code narration into segments, obtains each segment's synthesized duration, and stores segment starts plus duration-weighted prose word checkpoints under a complete render identity. Live playback replaces estimates with sampled Wav2Vec2-aligned word checkpoints when alignment arrives. This gives ±10-second scrubbing useful precision without retaining audio.

`timingPreprocessConcurrency` accepts `auto` or `1..8`. Each lane is an independent CPU Kokoro worker because the runtime does not batch concurrent synthesis in one process. `auto` considers available RAM and CPU parallelism and caps at four. Kokoro is currently CPU-bound; VRAM is not used in this calculation.

Thinking, raw tool results, and pure tool-call/edit messages are excluded. `yield` mode indexes final responses only.

A message timing map is persisted only when all required segments complete. Interrupted segment files remain reusable, so retry decodes completed Opus files and synthesizes only misses.

## Render identity and invalidation

Timing validity depends on the rendered audio, including:

- assistant text;
- TTS model and dtype;
- voice and speed;
- code-description content and narration mode;
- cached/non-cached representation;
- Opus bitrate.

Changing a dependency invalidates only affected messages. Legacy timing versions, including older segment-only maps, are treated as missing and rebuilt incrementally.

## Audio cache

Audio caching is enabled by default under `~/.cache/pi-voice/audio`. Each synthesized segment is encoded as 32 kbps VBR Opus unless configured otherwise.

Cache keys include model, dtype, voice, speed, text, and bitrate. A cache hit avoids loading or running Kokoro. Newly encoded Opus is decoded before alignment/playback so first playback analyzes the same representation as later cache hits.

No raw PCM is persisted. Disabling caching prevents new reads/writes but does not delete existing Opus files. Configure with:

```text
/voice audio-cache on|off
/voice audio-bitrate <12..128>
```

`ffmpeg` is required for Opus conversion.

## Session persistence

Timing maps and code descriptions are stored as non-context-injecting Pi custom entries. The entries themselves do not enter model context, although description cache identities include a hash of the resolved conversation prefix. Cached audio stays in the external cache and is addressed by render dependencies rather than session entry IDs.

Global preprocessing leases and crash recovery state live under `~/.cache/pi-voice/coordinator`. Idle timing workers terminate after a pass; the primary voice worker also shuts down after an idle period when no session owns speech or microphone input.
