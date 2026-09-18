# Pi Voice investigation ledger

Updated incrementally. Companion: `PLAN.md`. Reorganize freely while preserving evidence and disposition.

## Resume here

- Branch: `main`, baseline `98a33fb`; R2T2 remains only on `feature/confucius-cpu-streaming`.
- User priorities: fix long-conversation Pi UI lag first; show dictation alternatives using exactly the LLM evidence syntax; stop invalidating existing derived assets merely because LLM selection changes; audit remaining scrolling/timing/cache/UI behavior and report for approval.
- Do not automatically fix every finding below. Requested performance/display/cache-policy work is authorized; other findings await decisions unless inseparable from implementing that work safely.
- Preserve untracked `ISSUES.md`. No paid model calls or private transcript exports.
- Performance fixes are implemented and validated: lazy historical context, block-only render fast path, targeted Markdown-leaf invalidation, no unchanged-session timing rescans from the 200ms poll, and deduplicated progress widget updates. Added `test/index-render-cost.test.ts` and `test/narration-render.test.ts`. Typecheck and full suite pass: **149/149 tests**. Live-session latency remains unmeasured; `/reload` is required to activate extension changes.
- Performance commit: `f504597` (149 tests/typecheck passed).
- **Implemented and committed:** `fc521e5` fixes wrapped thinking invalidation; `7d970da` shows exact live/final ASR evidence and protects draft/cancellation ownership; `a17782e` makes description identities independent of LLM selection and preserves compatible legacy timing keys via persisted aliases.
- **Validation:** typecheck and **159/159 tests pass**, log `/tmp/pi-voice-reviewed-tests.log` (followed by an expanded worker-routing/alignment safety test, also passing). Docs updated. Existing single-string ASR APIs remain compatible. Fresh per-event context integration and legacy assets across model changes/reload are tested.
- **Legacy limitation:** snapshots without source metadata can only be adopted when their original model/prefix hash is reconstructable under current settings. Unmatchable older hashes can require one initial regeneration; subsequent changes no longer invalidate newly stored/adopted assets.
- **New requested follow-up, after current work:** whole-sentence or literal-newline TTS generation; benchmark sequential vs 2/3/4/... parallel sentence inference, maximize aggregate throughput subject to ≤2× ordered-output latency; convert ±10s controls to sentence/newline navigation and remove `10` from Termux button symbols. Detailed acceptance criteria and ordering are in `PLAN.md`. Whole-unit generation is committed (`8c5a05b`), the actual benchmark selected 4 workers, and long-unit alignment is bounded (`a9b0b0c`). **Production parallel scheduling and sentence navigation/Termux labels remain unfinished.**
- Additional read-only UX audit completed with source traces/mocked reproductions; see UX-1 through UX-6 and SCROLL-4. These remain decisions, not silently applied fixes.
- Baseline validation from preceding work: 147 tests and typecheck passed.

## Immediate resume instructions

1. Finish the **production parallel synthesis pipeline**, using the measured limit of 4 and bounded lookahead. `worker.mjs` still pumps synthesis sequentially. Reuse existing model loading/audio caching; keep playback/alignment delivery ordered even when generation completes out of order. Preserve pause intent and cancel/fence queued/current work on Stop, handoff and shutdown; avoid retaining unbounded completed PCM or leaving model children alive after parent exit. Benchmark is an experiment, not proof that production scheduling changed.
2. Implement sentence/newline navigation and only then remove `10` from Termux labels. `PlaybackHistory` distinguishes segment checkpoints (`duration > 0`) from word checkpoints (`duration === 0`), but code-description sentences can share a source offset. Navigation must distinguish those units, preserve inherited code cues, and not replay literal source from inside a fence. Incomplete timing must not become falsely complete just because a suffix finished generating. Snapshot downsampling currently can discard segment boundaries; account for this before relying on them exclusively.
3. Repeat full checks and review; report outstanding UX decisions. Do not silently fix every unrelated audit item.

Latest review corrections: `eb9e9ca` forwards PCM candidate count through the real worker router; `81131d1` restores an untouched draft when candidate preview is cancelled; `7c0cda9` schedules idle model cleanup after reviewed dictation; `95776e4` prevents an early live-ASR rejection from becoming unhandled while recording continues. These have regression coverage; the routing check reproduced **1 instead of 3** candidates before the fix.

## Status vocabulary

**Reported/reproduced by audit** means source tracing or an agent's in-memory mock reproduced it; it is not yet a committed regression test. **Confirmed/fixed** requires a reproducible check in this work. **Hypothesis** is not an established bug. Numbers below are stable finding IDs, not priority order. For fixed items, cause/reproduction bullets describe the pre-fix behavior; original audit line references may have shifted.

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

### PERF-6 — Conversation-mode rendering repeatedly rebuilds identical context identities
- Status: fixed in `bc1a534`; typecheck and **154/154 tests pass**.
- Actual current user configuration is **conversation context, all-history preprocessing, unlimited budget**, not the block-only default. This required an additional realistic-mode check rather than relying on the earlier default-mode benchmark.
- Isolated pre-fix worktree at `a17782e`: 400-message warm render **270.9ms**, 400 branch traversals (cached contexts still serialized/hashed again). After: **3.5ms**, zero branch/entry reads. Cold render: 366.8ms before, 211.4ms after (historical contexts still need one initial resolution).
- Cache the completed-message index per session/leaf/mode and memoize contextual description keys for immutable completed source messages, not mutable streaming partials. Resolve alias/plan/omission state at display time so cache arrivals and explicit retries remain visible.
- Baseline log `/tmp/pi-voice-context-before.log`; disposable detached worktree `/tmp/pi-voice-context-before`.

## B. Requested dictation display

### UI-1 — Live preview hides ASR alternatives
- Status: implemented in `7d970da`; integration regression passes.
- Existing LLM evidence is **tagged JSON**, not `(a|b)`: `<asr_candidates_json>\n[\n  "candidate one",\n  "candidate two"\n]\n</asr_candidates_json>`.
- Source: `src/prompt-editor.ts` request builder (~85–107). Reuse one formatter in prompts and editor.
- Live PCM currently forces one hypothesis: `worker.mjs` (~355–362), `worker-client.ts` (~128–137), `live-transcription.ts` string callbacks, `index.ts` talk preview (~1969–1986). Multiple hypotheses appear only during final whole-recording ASR; UI currently shows count rather than evidence.
- Literal live alternatives require threading `sttCandidates` and arrays through PCM decoding/callbacks. Preserve coalescing and do not invent Cartesian combinations between segment alternatives. Avoid adding live editing-provider calls.
- Preserve original draft separately; never send tagged preview as `existing_draft` or auto-submit markup.

### UI-2 — Manual typing during dictation/resolution gets overwritten [P1]
- Status: fixed as necessary for safe UI-1 (`7d970da`); manual-edit/auto-submit regression passes.
- `index.ts` captures `editorBase`, then rewrites from it for partials, rollback and resolved text. Manual edits are lost.
- Proposed: track last extension-written preview; stop replacing/submitting if editor ownership changes.

### UI-3 — Stop cannot cancel pending editing resolution [P1]
- Status: fixed with capture-scoped abort and input lifetime through resolution (`7d970da`); late-result regression passes.
- `inputInProgress` clears before resolver awaits; `/voice stop` then skips cancellation. Result may overwrite or auto-submit later.
- Keep cancellation scope alive through resolution. `prompt-editor.ts` currently has only its own timeout signal, not capture cancellation.

### UI-4 — Cancel during device acquisition can still start microphone [P1]
- Status: post-acquisition epoch guard added in `7d970da`; repeated-button acquisition issue remains separately tracked as UX-4.
- `talk()` lacks a post-`reserveSpeechForInput(true)` epoch check before capture.

### UI-5 — Cancel does not stop live queue/final ASR [P2]
- Status: fixed in `7d970da`; cancellation now stops the live queue and checks epoch before final ASR.
- `cancelActiveInput()` has no reference to local live session; cancel during `live.finish()` can still start whole-recording transcription afterward.

### UI-6 — Unscoped worker events alter cancelled/new input state [P2]
- Status: transcribing/transcript UI ownership moved to the epoch-fenced capture in `7d970da`.
- `index.ts` unconditional `transcribing`/`transcript` event handlers can resurrect progress or mark a newer recording idle.

### UI-7 — Stale resolver clears newer progress [P2]
- Status: fixed in `7d970da`; cleanup/notifications fenced and positive resolver harness implemented.
- Resolver continuation clears widget before checking epochs; failure notifications also require fencing.
- Test harness note: `FakeVoiceHost` lacks `buildContextEntries()`; positive resolver tests need it to reach mocked completion rather than fall back early.

## C. Scrolling, playback controls and timing

### SCROLL-4 — Ctrl+T does not work while playback is paused (user report)
- Status: **unverified user reproduction; deferred for audit/decision**, not fixed.
- Exact reported key: **Ctrl+T**, not Alt+T. First verify active Pi keybinding and distinguish Pi's thinking-display toggle from the configured transcript-tail shortcut; do not assume they are the same action.
- User confirmed reload. Installed Pi 0.85.1 binds Ctrl+T to `app.thinking.toggle`; no Pi Voice interception found.
- Audit reproduced **stale layout**, not literal key failure: F11 → F8 → Ctrl+T collapses preceding thinking → Alt+V still scrolls using old message top. Marker moved from line 203 to 5 but viewport stayed at 195 until the five-second anchor cache expired. Explicit re-anchor does not invalidate this layout cache.
- Proposed fix for approval: force recomputing absolute position for manual re-anchor and invalidate cached anchors when layout changes.

### SCROLL-1 — F10 after completion: intended tail action, inadequate test
- Status: genuine `idle` completion regression added and passes; tested F10 follows transcript tail without regenerating audio. This reproduces intended behavior, not a literal no-op defect.
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

### UX-1 — Disabled waiting session blocks later attention targets [P2]
- Status: audit mock reproduction; awaiting decision.
- B owns speech; A finishes blocked response; `/voice off` in A; repeated F11 in B keeps routing to disabled A. A reports disabled but retains its oldest waiting entry, starving later sessions. Clear/suppress waiting registrations when disabling.

### UX-2 — Failed attention announcement retries even after Stop [P1]
- Status: audit mock reproduction; awaiting decision.
- Pending unannounced response + unavailable player causes repeated acquisition/announcement failures from 200ms polling. Three failures followed by `/voice stop` still yielded a fourth attempt, while repeated error notices were suppressed.
- Needs bounded retry/backoff and an explicit Stop suppression state; this is additional resource churn beyond the history-rescan performance fix.

### UX-3 — Disconnected explicitly selected device silently falls back to host [P1]
- Status: audit mock reproduction; awaiting decision.
- `/voice device phone`, disconnect it, then F11/F5: automatic endpoints become `local`. Unlike auto-device fallback, an explicit pin should fail clearly rather than unexpectedly use the host speaker/microphone.

### UX-4 — Second microphone press during handoff fails to cancel future recording [P2]
- Status: audit reproduction; refinement of UI-4.
- Press F5 twice while acquiring ownership: second press sends `stop` before capture exists, but acquisition later starts recording anyway. Need an acquiring phase or cancellation of pending acquisition; a post-await epoch check alone is insufficient.

### UX-5 — `/voice test` ignores Stop during acquisition [P2]
- Status: audit mock reproduction; refinement of PLAY-2.
- `/voice test Hello` during delayed handoff → `/voice stop` → acquisition resolves → Hello still enqueued. Test-speech path needs the same cancellation fencing as replay.

### UX-6 — `/voice test` can speak into active dictation [P1]
- Status: audit mock reproduction; awaiting decision.
- Start microphone capture, run `/voice test Hello`: playback starts without cancelling recording. This entry point bypasses normal recorder/player exclusion and may transcribe its own TTS.

### PERF-5 — Selective invalidation missed wrapped thinking Markdown
- Status: fixed in `fc521e5`; regression and full suite pass. Introduced compatibility issue in `f504597`.
- Actual Pi wraps expanded thinking in `MouseRegion.child`, not `children`. Traverse both (with visited-node deduplication) so narrated thinking refreshes without returning to whole-tree invalidation.
- This may contribute to stale-looking thinking UI, but it does not establish literal interception of Ctrl+T.

## D. Caches, context, preprocessing and invalidation

### CACHE-1 — LLM selection unnecessarily invalidates derived assets [P1]
- Status: fixed in `a17782e`; legacy alias/timing/model-switch/reload regression passes. Opaque legacy migration limitations are documented above.
- Description hash in `code-describer.ts` includes selected provider/model. `index.ts` additionally conditionally injects current system/tool prefix into contextual identity. Even pinned narrator can regenerate when active model changes.
- Description identity feeds narration render identity and timing invalidation. Opus identity already depends on text and TTS settings, not editing-model selection; keep that design.
- Thinking-level selection alone does **not** invalidate: no model/thinking event hooks; descriptions request minimal reasoning.
- Proposed: source-based local identity retaining prompt/format version, narration/context modes, language, code and historical context through fence. Resolve current provider/prefix on genuine misses only. Remove `editModel` from timing cancellation dependencies.
- Migration: old snapshots contain opaque key+plan only. A blind key change regenerates everything once. Preserve legacy entries where resolvable; cannot infer all old identities losslessly from snapshots alone.

### CACHE-2 — Context-object equality disables persistence/catch-up in real Pi [P1]
- Status: fixed in `a17782e` as required for reliable asset persistence; regression uses a fresh context on every event and retains epoch fencing.
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

## E. Whole-sentence follow-up — implementation in progress

### SENTENCE-1 — Existing chunker deliberately splits sentences
- Fixed in `8c5a05b`: removed clause/length cuts, retain literal newline boundaries, never idle-flush unfinished prose, keep short sentences separate, and split code narration at sentences while preserving cue offsets. UTF-16 source offsets corrected along this path. Navigation and labels are still pending.
- Timing render identity bumped to 3 and audio-generation identity to 2: one necessary format transition because old clause durations and potentially truncated audio are not compatible. LLM selection still does not invalidate descriptions or compatible assets.
- Kokoro's ordinary `generate()` silently truncates past ~510 phonemes. Committed `sentence-audio.mjs` reuses Kokoro phonemization with truncation disabled, generates bounded native windows, and joins them before exposing a complete sentence audio unit. Shared model is not mutated; cancellation stops remaining windows. A deterministic 1,200-phoneme preservation test passes; actual short-sentence inference exercised by benchmark.
- Actual offline long-input check: **1,302 tokens**, native windows **512/512/282**, all 1,300 non-padding tokens retained, **72.175s audio generated in 52.20s**. No audio saved. This demonstrates both intact endings and the unavoidable first-audio cost of demanding a very long sentence as one unit.
- `a9b0b0c`: units over 30 seconds use existing duration-weighted word estimates rather than potentially unbounded quadratic CTC attention. A real-worker routing test covers both 31-second skip and 30-second alignment paths with mocked inference.
- Important limitation: exceptionally long sentences cannot physically fit one Kokoro inference call. They can still be one atomic playback/alignment/navigation unit; internal window seams may affect prosody. No PCM is persisted.

### SENTENCE-2 — Actual offline CPU concurrency benchmark
- New runnable script: `node scripts/benchmark-sentences.mjs`. Uses current q8 Kokoro / af_heart / speed 1, eight synthetic sentences, three warmed rounds per level, separate CPU processes, no audio playback/cache/remote downloads/provider calls. All benchmark children cleaned up.
- Output: `/tmp/pi-voice-sentence-benchmark.log`. Latency is maximum ratio of median ordered-prefix readiness to sequential (includes first playable sentence). Throughput is generated audio seconds per wall second.

| Workers | Throughput | First sentence | Worst ordered latency ratio |
|---|---:|---:|---:|
| 1 | 1.524× real time | 2.970s | 1.000× |
| 2 | 2.366× | 3.982s | 1.341× |
| 3 | 2.821× | 4.484s | 1.510× |
| **4** | **2.999×** | **5.591s** | **1.882×** |
| 5 | 3.016× | 6.518s | **2.194× — rejected** |

- **Measured choice: 4**, approximately 1.97× sequential throughput. Stopped at 5 because latency breached the 2× ceiling. Additional worker cold start/warm-up was 3.8–4.6s, excluded from warm latency.
- This is an inference benchmark, not an installed parallel playback pipeline. Real live-arrival scheduling, startup latency, source mapping, cancellation, ordering and the coordinator still need integration/testing. Do not claim playback concurrency changed yet.

## Validation / next actions

1. Initial performance, dictation, cache-policy and audit work completed; review corrections regression-tested. Continue with the remaining parallel playback and sentence-navigation integration above.
2. Confirm relevant audit reproductions in committed tests before changing behavior.
3. Implement authorized UI/caching requirements with safety guards, recording any inseparable fixes explicitly.
4. Run typecheck and full tests; record commands/results and commits here.
5. Final user report: fixed requested work + prioritized remaining choices, with intended behavior called out separately.
