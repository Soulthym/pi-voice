# Pi Voice investigation ledger

Updated incrementally. Companion: `PLAN.md`. Reorganize freely while preserving evidence and disposition.

## Resume here

- Branch: `main`, baseline `98a33fb`; R2T2 remains only on `feature/confucius-cpu-streaming`.
- User priorities: fix long-conversation Pi UI lag first; show dictation alternatives using exactly the LLM evidence syntax; stop invalidating existing derived assets merely because LLM selection changes; audit remaining scrolling/timing/cache/UI behavior and report for approval.
- Do not automatically fix every finding below. Requested performance/display/cache-policy work is authorized; other findings await decisions unless inseparable from implementing that work safely.
- Preserve untracked `ISSUES.md`. No paid model calls or private transcript exports.
- Performance fixes are implemented and validated: lazy historical context, block-only render fast path, targeted Markdown-leaf invalidation, no unchanged-session timing rescans from the 200ms poll, and deduplicated progress widget updates. Added `test/index-render-cost.test.ts` and `test/narration-render.test.ts`. Typecheck and full suite pass: **149/149 tests**. Live-session latency remains unmeasured; `/reload` is required to activate extension changes.
- Three read-only audit agents completed source tracing and mocked probes. Dictation alternatives and model-independent cache identity are not implemented yet.
- Baseline validation from preceding work: 147 tests and typecheck passed.

## Status vocabulary

**Reported/reproduced by audit** means source tracing or an agent's in-memory mock reproduced it; it is not yet a committed regression test. **Confirmed/fixed** requires a reproducible check in this work. **Hypothesis** is not an established bug. Numbers below are stable finding IDs, not priority order.

## A. Responsiveness — investigate first

### PERF-1 — Long-conversation event-loop overhead
- Status: fixed; regression/typecheck/full suite pass.
- Block-only rendering unnecessarily scanned the entire branch for every fence and materialized historical LLM contexts even though those contexts are never sent. `completedAssistantMessages()` eagerly built every prior context.
- Reproduction: `test/index-render-cost.test.ts`, 400 synthetic fenced messages. Before: **132.1ms**, 400 branch reads and 400 full-entry reads. After: **9.1ms**, zero branch/entry reads. Tests assert operation counts, not flaky wall-time thresholds.
- Fixed with lazy context getters, no history lookup for block-only render, and no live context construction in block-only mode. Conversation-mode integration tests still pass.
- These are extension benchmark results, not a measurement of the user's live terminal round-trip latency.

### PERF-2 — Narration invalidates the entire Pi component tree every word tick
- Status: fixed; native-Markdown regression and full suite pass.
- `requestNarrationRender()` called root `TUI.invalidate()` every ~80ms. Pi invalidates all Markdown caches and rebuilds every assistant component in response.
- New helper `src/narration-render.ts` traverses mounted nodes but invalidates only affected source Markdown leaves (including previous narration sources) or changed code descriptions. Full invalidation remains for actual global display setting changes and unsupported TUI shapes.
- Native Pi Markdown regression benchmark: 1,000 messages, **9.7ms full invalidation vs 0.7ms targeted**, and **1,000 transforms vs 1**. This excludes the extra extension-transform overhead measured in PERF-1.

### PERF-3 — Idle ownership polling rebuilds all timing identities at 5Hz
- Status: fixed; regression and full suite pass.
- 200ms poll called `scheduleMissingTimings()` even when history/config/work epochs were unchanged and no work remained. Scheduler also scanned before noticing timing concurrency was zero.
- Poll now skips unchanged session/leaf/work epoch; explicit event-driven scheduling can force a scan. Disabled timing preprocessing returns before history work. Cancellation changes work epoch, allowing resumed scheduling.

### PERF-4 — Identical progress widgets are repeatedly recreated
- Status: fixed; regression and full suite pass.
- Timeline/settings refreshes call `setWidget` even when displayed text is identical. Deduplicate rendered lines per context epoch so actual status/position/theme changes still update.

## B. Requested dictation display

### UI-1 — Live preview hides ASR alternatives
- Status: source-traced; implementation requested.
- Existing LLM evidence is **tagged JSON**, not `(a|b)`: `<asr_candidates_json>\n[\n  "candidate one",\n  "candidate two"\n]\n</asr_candidates_json>`.
- Source: `src/prompt-editor.ts` request builder (~85–107). Reuse one formatter in prompts and editor.
- Live PCM currently forces one hypothesis: `worker.mjs` (~355–362), `worker-client.ts` (~128–137), `live-transcription.ts` string callbacks, `index.ts` talk preview (~1969–1986). Multiple hypotheses appear only during final whole-recording ASR; UI currently shows count rather than evidence.
- Literal live alternatives require threading `sttCandidates` and arrays through PCM decoding/callbacks. Preserve coalescing and do not invent Cartesian combinations between segment alternatives. Avoid adding live editing-provider calls.
- Preserve original draft separately; never send tagged preview as `existing_draft` or auto-submit markup.

### UI-2 — Manual typing during dictation/resolution gets overwritten [P1]
- Status: audit reproduction; decision needed or guard as necessary for safe UI-1.
- `index.ts` captures `editorBase`, then rewrites from it for partials, rollback and resolved text. Manual edits are lost.
- Proposed: track last extension-written preview; stop replacing/submitting if editor ownership changes.

### UI-3 — Stop cannot cancel pending editing resolution [P1]
- Status: audit reproduction.
- `inputInProgress` clears before resolver awaits; `/voice stop` then skips cancellation. Result may overwrite or auto-submit later.
- Keep cancellation scope alive through resolution. `prompt-editor.ts` currently has only its own timeout signal, not capture cancellation.

### UI-4 — Cancel during device acquisition can still start microphone [P1]
- Status: source-traced.
- `talk()` lacks a post-`reserveSpeechForInput(true)` epoch check before capture.

### UI-5 — Cancel does not stop live queue/final ASR [P2]
- Status: source-traced.
- `cancelActiveInput()` has no reference to local live session; cancel during `live.finish()` can still start whole-recording transcription afterward.

### UI-6 — Unscoped worker events alter cancelled/new input state [P2]
- Status: source-traced.
- `index.ts` unconditional `transcribing`/`transcript` event handlers can resurrect progress or mark a newer recording idle.

### UI-7 — Stale resolver clears newer progress [P2]
- Status: audit reproduction.
- Resolver continuation clears widget before checking epochs; failure notifications also require fencing.
- Test harness note: `FakeVoiceHost` lacks `buildContextEntries()`; positive resolver tests need it to reach mocked completion rather than fall back early.

## C. Scrolling, playback controls and timing

### SCROLL-1 — F10 after completion: intended tail action, inadequate test
- Status: source-traced; reproduce actual completed state before deciding defect.
- Intended: F10 on latest message follows transcript tail, not replay. F11 replays. Tail leaves latest history item selected, so F6 selects the preceding one.
- Existing `index-auto-scroll.test.ts` exercises an oversized playback timestamp, not an actual `idle` completion. User reports surprising no-op here; needs a genuine completion test/UI inspection.

### PLAY-1 — Cold worker drops pause intent [P1]
- Status: source-traced.
- `worker-client.ts` pause before process exists is discarded. F11 during handoff → F8 → ownership arrives can play audibly while UI says paused.
- Current handoff mock records calls but misses real worker lifecycle. Preserve desired pause across startup.

### PLAY-2 — Pending replay survives shutdown [P1]
- Status: audit delayed-handoff reproduction.
- `index.ts` shutdown leaves `pendingReplay` valid. Late acquisition can reacquire ownership/enqueue after shutdown. Invalidate pending requests and fence async acquisition by session epoch.

### PLAY-3 — Input-setting change releases lease without stopping TTS [P1]
- Status: source-traced.
- While speaking, `/voice input disabled` releases speech ownership but leaves player running. Another session can acquire concurrently. Retain lease or acknowledge transport stop first.

### PLAY-4 — New assistant message loses UI pause state [P2]
- Status: source-traced.
- `message_start` sets `playbackPaused=false` without resuming worker. Paused tool-use response continuing into next message needs two F8 presses to resume.

### TIME-1 — Seek on incomplete timing can prevent completion while paused [P2]
- Status: audit reproduction (replacement generated fully, duration stayed at first two seconds).
- Seek cancels original generation, replacement uses `recordTimings=false`, background timing blocked by retained lease. Existing partial-timing test checks no premature tail but not eventual completion.

### PLAY-5 — Resume fallback creates another paused transport [P2]
- Status: source-traced.
- F11 pending handoff → F10 cancels/follows tail → handoff settles → F8. Fallback `playTarget()` inherits paused intent, so another F8 is needed.

### SCROLL-2 — Explicit scroll controls mishandle pending ownership [P2]
- Status: source-traced.
- Alt+T during pending replay does not retain tail pin because `ownsSpeech=false`; playback later pulls viewport back. Alt+V rejects visible pending target for the same reason.

### SCROLL-3 — Manual re-anchor silently fails with autoscroll off [P2]
- Status: source-traced.
- Forced Alt+V bypasses autoscroll guard, but rendering no longer emits its lookup marker. Keep manual target lookup separate from automatic following.

### TIME-2 — Stale playback tick erases new preview anchor [P2]
- Status: source-traced.
- `narration-progress.ts` unmatched old utterance playback event recomputes empty segments and clears replacement marker. Existing tests cover stale completion, not ticks.

### TIME-3 — Late alignment moves paused highlight [P2]
- Status: audit reproduction: paused “beta” moved back to “Alpha” with no playback tick.
- Alignment recomputes source anchor from frozen timestamp. Duration refinement is legitimate; highlight movement conflicts with F8 viewport/anchor expectations. Decision: freeze displayed anchor until resume vs document exception.

### TIME-4 — Continued-message word offsets use global coordinates [P2]
- Status: source-traced.
- Segment offsets subtract `sourceBase`, word offsets do not. Seeking in a queued second message can clamp beyond its end to an empty suffix/no-op.

### TIME-5 — Code-description words are not Markdown source positions [P2]
- Status: source-traced.
- Description-relative offsets enter history as assistant-Markdown offsets. Seeking code narration can jump to unrelated prose or inside a fence. Map to concerned block or omit description-word checkpoints.

### TIME-6 — Local playback clock ends before audio drain [P2]
- Status: source-traced.
- `worker.mjs` local sink `close()` stops clock before awaiting player exit. Audio keeps playing while highlighting/seek position freezes. Existing drain tests check pause delivery, not ticking.

### UI-8 — Unrelated settings mark playing transport idle [P3]
- Status: source-traced.
- `updateConfig()` resets state on autoscroll/highlight changes while actual audio continues; playback ticks do not restore playing indicator.

## D. Caches, context, preprocessing and invalidation

### CACHE-1 — LLM selection unnecessarily invalidates derived assets [P1]
- Status: audit reproduction; policy change requested.
- Description hash in `code-describer.ts` includes selected provider/model. `index.ts` additionally conditionally injects current system/tool prefix into contextual identity. Even pinned narrator can regenerate when active model changes.
- Description identity feeds narration render identity and timing invalidation. Opus identity already depends on text and TTS settings, not editing-model selection; keep that design.
- Thinking-level selection alone does **not** invalidate: no model/thinking event hooks; descriptions request minimal reasoning.
- Proposed: source-based local identity retaining prompt/format version, narration/context modes, language, code and historical context through fence. Resolve current provider/prefix on genuine misses only. Remove `editModel` from timing cancellation dependencies.
- Migration: old snapshots contain opaque key+plan only. A blind key change regenerates everything once. Preserve legacy entries where resolvable; cannot infer all old identities losslessly from snapshots alone.

### CACHE-2 — Context-object equality disables persistence/catch-up in real Pi [P1]
- Status: audit fresh-context reproduction.
- Pi creates fresh event context objects (`extensions/runner.js`); `agent_settled` compares to stored startup object and returns. `turn_end` timing path also uses identity comparison.
- `FakeVoiceHost` reuses one object and masks this. Use session identity/epochs.

### CACHE-3 — Omitted descriptions retry automatically despite omission records [P1]
- Status: audit reproduction: fatal quota failure repeated after unrelated setting change.
- Request/scheduling consult description cache but ignore `codeDescriptionOmissions`. Honor omissions until explicit retry; include omission state in render dependencies.

### CACHE-4 — Historical budget replenishes during ordinary sweeps [P1]
- Status: audit reproduction: budget 1 authorized two different historical misses across sweeps.
- Sweeps and ordinary config updates reset counters; updates also overwrite session `/voice code-budget`. Reset only at session boundary or explicit authorization.

### CACHE-5 — Live context extends past concerned fence [P1]
- Status: audit reproduction: fence plus trailing prose in one delta created two descriptions.
- Live captures whole streaming partial, historical lookup truncates through fence. Canonicalize each concerned-fence context before key/generation; multiple fences can otherwise refer to wrong “immediately before” block.

### CACHE-6 — Old timing can be saved under new audio settings [P1]
- Status: audit reproduction: speed-1 callbacks persisted as speed-2 timing.
- Changing speed cancels background measurements but not live capture references whose record render key changes. Detach/fence captures on incompatible identity changes.

### CACHE-7 — Thinking-plus-answer timings reused for answer-only replay [P2]
- Status: audit reproduction: offsets 0/66 persisted for 19-character answer in `all` mode.
- Live speech includes thinking, finalized replay source excludes it. Merely hashing voice mode does not fix replay within `all` mode.

### CACHE-8 — Non-BMP text corrupts source offsets [P2]
- Status: audit reproduction: emoji before fence produced range 2..18 instead of UTF-16 3..19, truncating closing fence in contextual lookup.
- `speakable.ts` increments by code points; consumers slice UTF-16. Use consistent UTF-16 offsets.

### CACHE-9 — Duplicate-block retry defeats coalescing [P2]
- Status: audit reproduction: duplicate failed fence generated twice from one retry.
- `collectFailed` returns occurrences sharing key; each invalidation cancels prior pending request. Deduplicate keys before invalidating.

### CACHE-10 — Compaction scope excludes retained messages [P2]
- Status: audit reproduction: retained fence got no descriptions/timing.
- Slicing from compaction entry ignores earlier messages retained via `firstKeptEntryId`. Use compaction-aware context, including legacy entries.

### CACHE-11 — Preflight failures spend provider-request budget [P2]
- Status: audit reproduction: oversized context spent two units, zero completion calls.
- `onAttempt()` occurs before window validation. Charge immediately before actual completion request.

### CACHE-12 — Accepted summary can fail snapshot restoration [P2]
- Status: audit reproduction: accepted 1,649-character summary rejected by cache parser after reload.
- Generation and snapshot length validation differ; unify acceptance validation.

### CACHE-13 — Returning to an earlier configuration remeasures valid cached timing [P2]
- Status: audit reproduction: speed A→B→A measured three times despite persisted compatible A snapshot.
- Timing restoration only at startup. Try matching snapshots after invalidation before scheduling missing work.

## Validation / next actions

1. Performance investigation and measurement by main agent; no profiler evidence recorded yet.
2. Confirm relevant audit reproductions in committed tests before changing behavior.
3. Implement authorized UI/caching requirements with safety guards, recording any inseparable fixes explicitly.
4. Run typecheck and full tests; record commands/results and commits here.
5. Final user report: fixed requested work + prioritized remaining choices, with intended behavior called out separately.
