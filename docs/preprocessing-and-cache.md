# Preprocessing, timing, and audio cache

[← README](../README.md) · [Narration and highlighting](narration-and-highlighting.md) · [Architecture](architecture.md)

## Why preprocessing exists

Replay, seeking, synchronized highlighting, and written code descriptions need metadata that older or interrupted messages may not have. Pi Voice fills missing dependencies incrementally without playing audio.

Work is prioritized from the currently selected playback message forward to the session end, then backward toward the beginning. This makes nearby and future navigation useful first while eventually covering the full session.

Preprocessing continues while spoken output is disabled. Foreground speech defers further historical description submissions; already-submitted historical requests may finish and retain their slot. Cancellable shared description work aborts only when its last consumer leaves; other consumers keep it alive. Timing recovery yields to foreground speech/microphone ownership.

## Status lines

Session-wide progress and selected-message playback state use distinct labels. Foreground phases are Idle, Playing, Paused, Synthesizing, Loading, Describing, Connecting and Queued; background work does not itself select a foreground phase. The separate native error-red `● live` replaces time only at the unpaused chronological edge (including caught-up next-output wait); viewport End/Alt+T is unrelated. Unknown times are not fabricated. See [status](usage.md#highlighting-and-status).

Example (badge spacing depends on terminal width):

```text
○ Idle [━━━━━━━━━━━━━━━━━━━━━━━━] --:-- · 280/605 · timing pending    [🎧:local]
↺ Preparing code descriptions · 24/61 targets processed
↺ Recovering speech timing · 109/605 targets ready · decoding cached audio: 2
```

Lines remain ordered input → playback → code descriptions → speech timing. Background phase rows remain mounted across adjacent jobs to avoid flicker; counter updates do not restart the playback state. Background counts are narration targets (eligible text/thinking blocks), not words or percentages. Timing “ready” means complete compatible coverage; descriptions “processed” can include omissions with retry callouts. Recovery totals cover the configured historical scope. The selected message index is navigation state, not a worker index.

On startup, `↺ Checking saved timing · 109/605 targets checked` means preparing identities and validating/restoring saved maps—not inference. Compatible complete maps need no audio decoding, synthesis or alignment. If timing is missing/incompatible, **Recovering speech timing** separately shows active lanes preparing descriptions, restoring timing units, measuring audio, decoding cached audio, generating speech, or estimating word timing. Cached Opus decoding is real work but does not run Kokoro. Background measurement uses duration-weighted word estimates, not forced alignment. A fast recovery counter alone does not prove regeneration or cache loss.

The `/voice timing` report (not a persistent UI row) shows `Word timing: n/total estimated` (fully refined: `0/total estimated`). Counts cover actual applicable source words in the selected timed units, including a selected suffix, before navigation checkpoint thinning; code-description coordinates are excluded. Unknown provenance, untimed units and sparse-only restored snapshots show `Word timing: unknown/pending`, not invented totals. In-memory compatible variants retain counts. New streaming words can change the denominator; fixed-total count updates keep their width stable under wrapping.

Estimates remain when alignment fails, exceeds resource/queue limits, or cannot reliably refine a long window; later refinement is not guaranteed. Saved checkpoints retain quality, but sparse snapshots cannot reconstruct full word counts. Word timing is separate from the transport clock; the playback row no longer displays a clock-provenance indicator. Background completion or late refinement cannot reset playing/paused state or move paused highlights.

## Code descriptions

Missing descriptions use `editModel`; existing descriptions are content-addressed by prompt version, narration mode, context mode, language, and source code—not the selected LLM, thinking level, or its runtime system/tool prefix. Changing the generator only affects cache misses. With `codeDescriptionContext: "conversation"`, the key also includes a deterministic serialization of Pi's provider-compatible historical context through the next code-block opening or containing message end (including following prose). Future turns do not change that prefix; identical code in a different discussion gets a different description. With the default `block-only`, identical blocks share descriptions without including discussion context. Live narration, written callouts, timing preprocessing, and concurrent workers share in-flight requests and persisted results.

Compatible old snapshots are adopted under a persisted source alias while retaining their original timing dependency key. Old snapshots contain only opaque hashes: if the original generator/prefix cannot be reconstructed from the current configuration, that legacy entry cannot be safely matched and may require one initial regeneration. Newly stored or adopted entries survive subsequent LLM selection changes. TTS model/dtype, voice, speed, source, narration mode and audio-format compatibility still determine whether audio/timing assets can be reused.

`codeDescriptionPreprocessConcurrency` controls parallel model requests from 1 to 8; the default is 4. It is explicit because API-backed model capacity is not derived from local hardware. Global coordinator slots enforce the limit across Pi processes.

Background preprocessing is scoped and budgeted separately from live narration: `codeDescriptionPreprocessScope` defaults to `since-compaction`, including retained messages before the marker (`retainedTail` or legacy `firstKeptEntryId`) as well as later messages, but excluding summarized-away history. Only missing work is scheduled. `codeDescriptionPreprocessBudget` (default 25) caps historical provider attempts per session load. Cache hits, coalesced requests and preflight failures before provider submission are free; live narration stays uncharged. Ordinary sweeps and setting changes never replenish the counter or replace a session override. `/voice code-budget <n|unlimited>` explicitly authorizes a fresh allowance; a new session load resets to the configured allowance. Explicit description retries remain budgeted and coalesce by the complete cache key, not code alone.

Failed model requests leave a silent omission and a retry callout. Omissions remain sticky across sweeps, replay and unrelated settings until explicit `/voice code-retry` or genuinely changed identity inputs. Summary and guided generation share restoration validation, including the 1,500-character total speech bound; oversized output is rejected/retried, never silently truncated. Before inference, `block-only` supplies the concerned block as numbered source, while `conversation` preserves that fence in the structured assistant context and references it without resending the body. Pi Voice conservatively checks the complete request—including system prompt and tools when reused—against the selected model's context window. With the active model, the request extends the normal conversation prefix and uses the Pi session ID with provider-default cache retention, allowing supported providers to reuse a still-live prompt cache. Oversized conversation requests first try a locally reduced context retaining a fitting leading message and target-containing suffix; this can omit intervening history and does not compact the Pi session. If still oversized, they are reported and use local fallback. See [context limits](models-and-privacy.md#editing-model). Only fallback/model plans passing current shared validation remain usable after reload; invalid or oversized legacy plans are not guaranteed restoration. Prompt-version changes invalidate stale narration plans.

## Speech timing

A timing pass converts speakable text and persisted code narration into segments, obtains each segment's synthesized duration, and stores segment starts plus duration-weighted prose word checkpoints under a complete render identity. Live playback replaces estimates with sampled Wav2Vec2-aligned word checkpoints when alignment arrives, retaining per-word quality and segment-level quality in timing snapshots. Duration-only background measurements remain explicitly estimated. Sentence navigation uses complete generation units, not these sampled word checkpoints. All sentence starts are retained in snapshots so code-description unit ordinals remain stable.

`timingPreprocessConcurrency` accepts `auto` or `1..8`. Each lane is an independent CPU Kokoro worker because the runtime does not batch concurrent synthesis in one process. `auto` considers available RAM and CPU parallelism and caps at four. Kokoro is currently CPU-bound; VRAM is not used in this calculation.

Timing follows the same narration-eligible transcript and content-block order as playback, including thinking when the selected narration mode permits it. Raw tool results and pure tool-call/edit messages are excluded.

A complete message timing map is persisted only when all required segments complete. Valid partial timing after seeks remains available while bounded background recovery fills missing coverage, including while paused, without acquiring playback ownership, moving the highlight/viewport or resuming audio. Late results are fenced against newer navigation and asset identities. Interrupted segment files remain reusable, so automatic timing recovery decodes completed Opus files and synthesizes only misses. Explicit alignment retry below never synthesizes.

## Silent timing retry

`/voice timing retry current|all|<min>-<max>|<message-id>` explicitly retries alignment using cached audio. Targets are completed narration-eligible playback messages in the current session branch and current narration mode. `current` uses the selected target; `all` is never automatic. Ranges are inclusive 1-based displayed playback-message numbers, not raw transcript entries. IDs must match exactly; invalid/out-of-bounds ranges and unknown/ambiguous targets are rejected. Target IDs, source text, render identity and available spoken plans are captured when invoked.

Estimated units and reconstructable mixed units are retried. Mixed admission requires explicit labels for every word in the cached spoken plan, or valid coverage whose refined count is fully accounted for by distinct retained CTC word anchors in that plan. The segment anchor carries aggregate quality, not the first word's provenance; the first word's actual CTC timestamp is retained separately. Fully refined, unknown/ambiguous sparse and missing timing units are skipped. A partial refinement can be retried again for its remaining estimates. Missing description plans skip the target; saved omissions remain omitted. Missing/unreadable audio is reported without synthesis. Retry never calls a description provider, generates speech, writes new audio or starts playback; it can read existing Opus even with normal audio caching disabled.

One bounded cache decode/alignment runs at a time, with a per-unit timeout and text/PCM limits, independently of the automatic timing-worker count. Foreground speech/input gets priority and can interrupt the dedicated retry alignment child; retry waits until foreground work clears. Stop, session replacement/shutdown or a newer valid retry cancels pending work without cancelling another consumer's alignment. `/voice timing` reports active target progress; completion reports improved/still-estimated units, missing cached audio and skips. Refinement is not guaranteed.

Results merge only while session, source and render identity still match and cached duration is compatible. Unit eligibility is checked again after alignment, against current metadata (including original alignment/recovery improvements). Only estimated words can gain new CTC timing; retained refined timestamps and qualities are preserved exactly. Crossing/non-monotonic candidates skip the unit rather than shifting old refined words. Coverage is counted from the actual mapped source words, not the segment anchor. Updates are metadata-only: selection, playback clocks, playing/paused state, highlights, viewport and drafts stay unchanged. Complete and partial timing snapshots retain their completeness and per-unit coverage; a retry does not turn sparse timing into a complete message map. Newly measured source-word coverage is persisted; unavailable coverage still reports unknown/pending.

## Render identity and invalidation

Timing validity depends on the rendered audio, including:

- assistant text;
- TTS model and dtype;
- voice and speed;
- code-description content and narration mode;
- cached/non-cached representation;
- Opus bitrate.

Changing a dependency invalidates only affected messages. Jobs retain their starting spoken-plan identity; stale results cannot be relabeled as new assets. A dirty current asset pauses immediately with ownership retained and never auto-resumes. Compatible A→B→A timing variants are reusable, including restored snapshots. Historical variants are bounded to four per target, 256 targets and 50,000 checkpoints in each of the in-memory and restored-version pools. A compact index references session entries so exact persisted identities remain available after pool eviction, including fallback plans whose identity resolves only during recovery. Resolution rechecks complete saved timing before measuring or appending another snapshot. Timing entries on sibling branches are reusable only for current transcript target IDs with exactly matching render keys; branch exports that omit those entries cannot recover them. Legacy timing versions, including presence-only description dependencies that cannot prove the spoken wording, are treated as missing and rebuilt incrementally.

The Markdown/marker-aware sentence-boundary fix changed render identity from version 3 to 4. This still causes one-time invalidation, including for unchanged plain prose: saved hashes alone do not prove identical old/new spoken units and source-offset mappings (including code-plan units). No permissive old-hash migration is applied. Subsequent unchanged version-4 restarts reuse exact saved maps; this one-time upgrade is separate from repeated fallback recovery.

## Audio cache

Audio caching is enabled by default under `~/.cache/pi-voice/audio`. Each synthesized segment is encoded as 32 kbps VBR Opus unless configured otherwise.

Cache keys include the audio-generation format version, TTS model, dtype, voice, speed, text, and bitrate. The whole-sentence upgrade changes timing identity and bumps audio format identity once: previous audio may have silently truncated long phoneme sequences, and clause-based durations no longer describe the same generation boundaries. This necessary one-time regeneration is separate from LLM selection, which does not invalidate descriptions or compatible assets. A cache hit avoids loading or running Kokoro. Newly encoded Opus is decoded before alignment/playback so first playback analyzes the same representation as later cache hits.

No raw PCM is persisted. Disabling caching prevents normal reads/writes but does not delete existing Opus files; explicit timing retry may still read them. Configure with:

```text
/voice audio-cache on|off
/voice audio-bitrate <12..128>
```

`ffmpeg` is required for Opus conversion.

## Session persistence

Timing maps and code descriptions are stored as non-context-injecting Pi custom entries. The entries themselves do not enter model context, although description cache identities include a hash of the resolved conversation prefix. Cached audio stays in the external cache and is addressed by render dependencies rather than session entry IDs.

Global preprocessing leases and crash recovery state live under `~/.cache/pi-voice/coordinator`. Idle timing workers terminate after a pass; the primary voice worker also shuts down after an idle period when no session owns speech or microphone input.
