# Pi Voice responsiveness, dictation UI, and behavior audit

## Scope and order

1. **Fix long-conversation UI lag first.** Trace Pi Voice's event-loop work during streaming, idle, rendering, playback and preprocessing. Reproduce/measure avoidable overhead with long synthetic histories, fix root causes, and add regression checks. Separate extension overhead from upstream Pi costs; do not claim the live UI is fixed solely from unit tests.
2. **Show dictation alternatives in the editor.** Trace the exact alternation syntax sent to the editing LLM and reuse it in live dictation UI rather than inventing another representation. Preserve editable drafts, cancellation fencing and review/submit behavior.
3. **Audit scrolling controls and shortcuts.** Follow button and keyboard paths through playback, pause, completion, replay, pending timing, ownership handoff and tail-follow. Specifically reproduce F10 after message completion, unreachable states and surprising no-ops. Report additional behavior changes for approval rather than silently implementing them.
4. **Audit pausing during timing generation.** Check late timing results, pause/resume intent, seek anchors and duration changes. Reproduce race conditions with deterministic tests and report findings for approval.
5. **Audit asset caching and invalidation.** Trace model and thinking-level changes across descriptions, narration, timing and audio caches. Implement the requested policy: changing the editing/model selection alone must not regenerate existing derived assets. Preserve invalidation for actual content, voice/audio or format incompatibilities. Document thinking-level behavior and any remaining issues.
6. **Report all findings.** Maintain `FINDINGS.md` incrementally as a compaction-safe investigation ledger with severity, reproduction/evidence, cause, status and proposed resolution. Distinguish fixed requested work, confirmed bugs awaiting a decision, and unverified hypotheses. Include additional UI/non-UI findings found along these paths.

## Guardrails

- Keep the R2T2 experiment off main; preserve untracked `ISSUES.md` and unrelated work.
- No paid provider calls or private transcript exports. Prefer synthetic histories and mocked inference.
- Reuse current render/cache/control mechanisms and existing tests; no speculative infrastructure.
- Add runnable regressions for fixes; run typecheck, relevant tests and the full suite.
- Use separate atomic commits for independent fixes. Update this plan and findings as evidence emerges.

## Progress

- [x] Record scope before investigation.
- [x] Measure and fix avoidable extension event-loop overhead (149 tests pass; live session must reload to use changes).
- [ ] Implement live editor alternation notation.
- [ ] Audit scrolling/buttons/shortcuts and F10 completion behavior.
- [ ] Audit pause/timing-generation races.
- [ ] Implement model-independent reuse and audit remaining invalidation.
- [ ] Complete regression/full-suite validation and report findings.
