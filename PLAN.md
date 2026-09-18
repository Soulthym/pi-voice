# Pi Voice responsiveness, dictation UI, and behavior audit

## Scope and order

1. **Fix long-conversation UI lag first.** Trace Pi Voice's event-loop work during streaming, idle, rendering, playback and preprocessing. Reproduce/measure avoidable overhead with long synthetic histories, fix root causes, and add regression checks. Separate extension overhead from upstream Pi costs; do not claim the live UI is fixed solely from unit tests.
2. **Show dictation alternatives in the editor.** Trace the exact alternation syntax sent to the editing LLM and reuse it in live dictation UI rather than inventing another representation. Preserve editable drafts, cancellation fencing and review/submit behavior.
3. **Audit scrolling controls and shortcuts.** Follow button and keyboard paths through playback, pause, completion, replay, pending timing, ownership handoff and tail-follow. Specifically reproduce F10 after message completion, unreachable states and surprising no-ops. Report additional behavior changes for approval rather than silently implementing them.
4. **Audit pausing during timing generation.** Check late timing results, pause/resume intent, seek anchors and duration changes. Reproduce race conditions with deterministic tests and report findings for approval.
5. **Audit asset caching and invalidation.** Trace model and thinking-level changes across descriptions, narration, timing and audio caches. Implement the requested policy: changing the editing/model selection alone must not regenerate existing derived assets. Preserve invalidation for actual content, voice/audio or format incompatibilities. Document thinking-level behavior and any remaining issues.
6. **Report all findings.** Maintain `FINDINGS.md` incrementally as a compaction-safe investigation ledger with severity, reproduction/evidence, cause, status and proposed resolution. Distinguish fixed requested work, confirmed bugs awaiting a decision, and unverified hypotheses. Include additional UI/non-UI findings found along these paths.

## Follow-up phase: whole-sentence TTS, measured concurrency, and sentence navigation

Do this **after** the responsiveness/dictation/cache implementation and current behavior audit above.

7. **Generate whole sentences or real newline-delimited units.** TTS must receive complete sentences at once, never arbitrary streamed fragments. A literal source `\n` is also a boundary; terminal soft wrapping is not. Trace Markdown, code descriptions, streaming completion and final unterminated text. Preserve source mapping and code-narration cues. Add sentence/newline boundary regressions, including sentences arriving across multiple deltas.
8. **Benchmark parallel sentence inference before selecting concurrency.** Compare warmed sequential generation with 2 simultaneous sentences, then 3, 4, and upward while aggregate throughput improves. Use the same local model/voice/settings and non-private representative sentences; repeat runs and report medians. Measure aggregate audio-seconds generated per wall second **and time until the next ordered sentence is playable**. Keep latency at no more than **2× the equivalent sequential baseline**, and preserve playback order. Stop when throughput stops improving, latency exceeds the bound, or host resource limits intervene; choose the best admissible measured setting, not the highest worker count. Prefer 1 if no parallel setting qualifies. Include cold-start/memory caveats separately and retain responsiveness/cancellation while prefetching.
9. **Replace ±10-second navigation with sentence/newline navigation.** Forward/back controls and their shortcuts must move by actual sentence or literal `\n` boundaries, not ten seconds, words, or rendered line wraps. Define and test behavior mid-sentence, at exact boundaries, while paused, before timings exist, and at message ends; maintain source alignment for narrated descriptions. Update UI labels and Termux configuration to show only forward/backward symbols, removing `10`. Audit both full client and Termux copies and installation/docs; do not alter unrelated controls.
10. **Record results and outstanding decisions.** Add benchmark data, selected concurrency/latency tradeoff, navigation semantics, tests, and any newly found bugs to `FINDINGS.md`; update user-facing usage/shortcut documentation.

- [x] Whole-sentence/newline generation (`8c5a05b`); native long-sentence preservation checked. Long-unit alignment bounded in `a9b0b0c`.
- [x] Sequential vs parallel benchmark: 4 workers selected; 5 exceeded the latency ceiling.
- [ ] Wire the measured parallelism into actual ordered playback (the production worker is still sequential).
- [ ] Sentence/newline navigation and Termux symbol labels.
- [ ] Follow-up validation and findings report.

## Updated instructions after reload

- User confirmed reload after performance commit `f504597`; continue autonomously with the remaining implementation and audit.
- Expand the UX audit to annoying no-ops, inconsistent toggles, user-stuck states, and interactions between multiple Pi sessions (focus, ownership, pending acquisition, pause/resume, shutdown/reload).
- Investigate the exact **Ctrl+T while paused** report; distinguish Pi's own keybinding from Alt+T and configured Pi Voice shortcuts.
- Keep `FINDINGS.md` updated after each useful result, including reproduction steps, what is fixed, what remains proposed, and where to resume after compaction.
- Finish live alternatives using the actual LLM evidence syntax and model-independent cache reuse. Report unrelated behavioral fixes for a decision rather than silently applying all audit findings.

## Guardrails

- Keep the R2T2 experiment off main; preserve untracked `ISSUES.md` and unrelated work.
- No paid provider calls or private transcript exports. Prefer synthetic histories and mocked inference.
- Reuse current render/cache/control mechanisms and existing tests; no speculative infrastructure.
- Add runnable regressions for fixes; run typecheck, relevant tests and the full suite.
- Use separate atomic commits for independent fixes. Update this plan and findings as evidence emerges.

## Progress

- [x] Record scope before investigation.
- [x] Measure and fix avoidable extension event-loop overhead (149 tests pass; live session must reload to use changes).
- [x] Implement live editor alternation notation, cancellation/draft safety, and actual worker candidate routing.
- [x] Audit scrolling/buttons/shortcuts; actual idle-completion F10 test passes; remaining findings await decisions.
- [x] Audit pause/timing-generation races; unresolved control/ownership defects recorded.
- [x] Implement model-independent reuse and audit remaining invalidation.
- [x] Complete initial regression/full-suite validation and report findings (160 tests, including whole-sentence safety and real worker control-path regressions).
