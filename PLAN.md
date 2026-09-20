# Pi Voice — implemented agreements and live-validation handoff

## Latest authorized live-UX follow-up

Implemented: `aa0aa40` (quality provenance), `b588661` (native follow), `8e4638f` (stable batch progress).

- **LIVE user evidence:** ASR second-pass display works intuitively; UI is much faster; restart cache checks appear instant. The Stop/draft cancellation bug is no longer reproducible. `/voice attention` explicit play is confirmed and retained without further attention changes. The accidental Escape was user input, not a product crash.
- Native follow: avoid Pi's forced-render layout reset, which temporarily replaced the primary transcript viewport with its implicit fallback. Explicit ⏮/⏭, ↶/↷, ⏯ and ↺ reframe before asynchronous preparation; paused navigation stays silent. Native accepted scrolling, including deferred search reveals and timed selection drags, not programmatic layout motion, disables follow. Manual PageDown/wheel/scrollbar moves landing at bottom still suspend narration; only explicit End/banner records native tail intent. Initial 20% / ongoing 20–80%, final-next tail and replay-from-tail remain covered.
- Progress: retain the previous background row through pending batch preparation; coalesce replacements and final clearing on the existing 80 ms cadence. First status remains immediate; foreground input/playback stays immediate and retains precedence. Native Pi widget-layout regression checks that adjacent timing jobs do not remove/reinsert rows.
- Quality: label **word timing quality** belongs to the selected message, not active recovery work. Fixed a reproducible stale saved-unit quality update when regenerated playback time differs from saved time; identify the saved sentence by source offset/ordinal. Listening alone does not guarantee CTC refinement; legitimate estimated/mixed checkpoints survive restart.
- `/voice stop` must be entered as a command at the beginning of editor input. A nonempty draft is an acknowledged usability gap, not permission to discard it or invent a shortcut/Escape binding. Existing/manual drafts remain protected; explicit play still finalizes microphone capture.

Validation: no configured LSP; `npm run check` and `npm test` passed (**494 passed, 1 known dependency-banner skip, 0 failed; 495 total**). Installed native Pi TUI inert-terminal tests: **10/10 passed**, including deferred search/drag, bottom-landing manual gestures, banner and explicit controls after manual unfollow. All six added regressions fail against pre-fix source. Logs: `/tmp/voice-full-test.log`, `/tmp/voice-installed-native.log`, `/tmp/voice-native-before.log`. No live settings/clients/SSH/session restarts, inference, application-provider calls or private exports. `ISSUES.md` remains untouched.

Remaining LIVE checks: user confirmation of rearming after manual browse while playing/paused and during cold ownership waits; visual comfort/no row flashing during real adjacent recovery batches; selected-message quality after actual late alignment/restart. Synthetic provenance tests do not establish the cause of the user's particular persisted mixed label.

## Previous UX follow-up — fast restart counter

New user clarification: the `0/605` speech-timing counter advanced **quickly**, and alignment looked good. This is not evidence of cache loss or full regeneration. The authorized follow-up traces restoration and labels actual work; it does not reopen the completed playback/ownership batch.

Implemented in **`5b11e76`**:
- Separate startup **Checking saved timing** from **Recovering speech timing**. Recovery reports waiting/preparation, timing-unit reuse, cached-audio decoding, synthesis and word-timing estimates. Counts name eligible targets, use the configured recovery scope, and never claim alignment accuracy or a percentage.
- Unified `Voice · …` notices with native Pi severity; readable input/playback/footer states, grouped status/help, effective microphone shortcuts, omission/retry and stop-recovery guidance. Input → playback → descriptions → timing order is unchanged. No competing widgets or hardcoded ANSI.
- Fresh-host JSON-round-trip regression: 605 targets (including 7 conversation-context code blocks), a changed editing model, and a synthetic refined snapshot restore without provider/measure/synthesis/alignment calls. Genuine speed changes still invalidate timing. Worker fixtures separately count cache decoding versus synthesis; cancelled progress cannot update foreground state.

No cache defect was demonstrated, so persistence identities and compatibility guards are unchanged. The old counter counted completed missing-timing recovery targets, **not snapshot checks**. Fast cached-audio measurement is possible; which path the user's live run took, and why those maps were considered missing, remain unknown without live aggregate evidence. See the new `FINDINGS.md` entry rather than reviving an earlier cache-loss claim.

Validation: `npm run check`, `npm test` (**485 passed, 1 known native-TUI compatibility skip, 0 failed**, 486 total), and `git diff --check`. No LSP server is configured. Final suite log: `/tmp/voice-ux-final.log`. Only source and synthetic fixtures were used; no live configuration/session/client restart, real inference, paid provider call, hardware playback or private transcript export. Preserve untracked `ISSUES.md`.

## Previous batch checkpoint

The discuss-first phase is finished and the agreed implementation batch is committed on `main`, through **`a62a11d`** before this documentation checkpoint. Do not restart the old discussion or redo completed implementation. User-requested interruptions/reboots were not evidence of product crashes.

Final parent-run validation:
- `npm run check` passed.
- `npm test`: **481 passed, 1 skipped, 0 failed** (482 total), about 39 seconds.
- The skip is the native jump-banner test against the older project TUI dependency. Running against the installed Pi TUI separately passed **paused anchor, End, and banner: 3/3**, no skips.
- `git diff --check` passed.
- Logs: `/tmp/pi-voice-final-batch.log`, `/tmp/pi-voice-final-native.log`.
- Independent read-only reviews found additional races; fixes and regressions were committed in stages. Last fix waits for helper control feedback to drain before classifying a pre-audio exit.

**Still required:** update the phone/client scripts to this host checkout, then perform live phone/SSH/listening/typing checks. No live client, SSH session or personal configuration was restarted/modified by implementation tools. No paid application-provider calls, real-model inference or private transcript exports were used in this batch.

## Deployment and safety

The transport/recorder protocol changed for real stop confirmation. Old clients are deliberately rejected, not silently trusted. The user saw `Audio client closed without v2 readiness/completion proof`; that means a client update or forward repair is required, not an automatic replay.

Copy **all** client scripts from the current host checkout in a **local Termux shell**, not the remote shell:

```sh
mkdir -p "$HOME/.local/bin"
scp 'curiosithy@zero:/home/curiosithy/code/pi/pi-voice/client/pi-voice-*' "$HOME/.local/bin/"
chmod 755 "$HOME"/.local/bin/pi-voice-*
```

These commits have not been pushed; fetching GitHub is not equivalent. The client protocol evolved further after earlier update instructions, so recopy the final versions. Close all voice SSH wrappers on that device and reconnect; the remote tmux session can remain running. Then `/reload` and `/voice reconnect` in Pi.

Read `docs/installation.md` and `docs/endpoint-protocol.md` for migration/recovery:
- Audio proof uses random opaque stream IDs, not reusable PIDs. Readiness, completion and stop receipts are scoped to that stream.
- Microphone admission/stop uses server-epoch/counter tickets and an exact `stopped <ticket>` receipt. Generic acceptance or `stopped` is not proof.
- Older numeric microphone ticket state requires the documented migration **only after confirming old recorders stopped and ending old sessions**. Do not delete state/receipts/fences while a stop is unconfirmed.
- Losing a connection, killing a host worker or deleting a lease does not prove remote silence. Unconfirmed stop retains ownership, including across reload. Restore the original connection and retry cleanup via `/voice reconnect`; otherwise manually stop and verify the original recorder/player before restarting Pi. No unsafe bypass is provided.
- Multiple ambiguous tmux attachments, inaccessible identity information, nested unsupported attachment or missing identity fail closed. No guessing another device from registry activity.

## Agreed behaviors implemented

### Playback, ownership and attention

- `/voice stop` is a prompt UI/processing cancellation escape hatch: cancel speech, queued replay/test/acquisition and dictation processing; fence late callbacks; suppress old attention announcements/retries. Preserve existing/manual draft content. Physical ownership is released only after actual stop proof, not a timeout.
- Ordinary explicit playback actions finish microphone capture first and transcribe captured audio into the draft without auto-submitting or overwriting manual edits. Stop is the hard-cancel exception; read-only queries do not interrupt recording.
- Second **🎙** during microphone acquisition cancels the pending start. Protocol admission tickets also prevent Stop overtaking an earlier not-yet-published recording request.
- Pausing retains ownership and resumable audio. New messages do not clear pause; new speech queues. One explicit **⏯** resume suffices even if recreating transport.
- Changes affecting the currently playing text/audio asset, including dirty/pending regeneration, pause immediately and retain ownership. No automatic resume on regeneration or late results. Unrelated settings preserve actual playing/paused status; microphone-only changes do not release ongoing speech ownership.
- **↺ always stays in this project**. `/voice attention` remains the separate explicit cross-project action, using the initiating connection's device pin and confirmed handoff. Automatic attention never interrupts speech; it announces at the next safe opportunity.
- Disabled sessions cannot block attention; re-enable re-evaluates and requeues only still-needed attention. Do not revive Stop-cancelled or already-handled work.
- Old shutdown/reload/acquisition/worker events cannot reacquire ownership, release a newer lease, mutate retired UI, or revive cancelled work. Failed-stop cleanup remains fenced across same-PID reloads.
- Newer partial/completed sources and waiting attention survive older replay queue drains. Explicit user intent wins over automatic draining; rapid controls accumulate their provisional selection before asynchronous preparation.

### Device routing and commands

- Pin the connecting device; no silent host/other-device fallback if unavailable.
- `/voice reconnect` adopts fresh connection identity for this session. Explicit replay/resume/navigation also repins as appropriate; automatic speech retains the pin. Pause-only actions do not repin.
- Tmux identity is derived from the relevant current client, not blindly from the old Pi environment. Rebinding checks input/output endpoints and generations independently, including same-device new ports, and gates the entire adoption against microphone/streaming races.
- Explicit local/custom/disabled I/O choices remain intentional choices, not fallbacks.
- `/voice tts-workers [1..8]` persists and changes playback concurrency without audio restart or cache invalidation. Default **3**; persisted value overrides legacy `PI_VOICE_TTS_WORKERS`. `tts-worker` is accepted silently as an alias; autocomplete advertises only `tts-workers`.
- All value-setting `/voice` commands without arguments report their effective values read-only. True actions retain action semantics.

### Transcript order, navigation and scrolling

- Live speech, replay, **⏮/⏭** message navigation and **↶/↷** sentence/literal-newline navigation use actual transcript order filtered by narration settings. Thinking participates when enabled; do not impose an artificial thinking/answer alternation or use terminal wrapping as a boundary.
- After **⏭** enters tail at the latest message, explicit play/replay can replay the last eligible message and return to tail. Live replay preserves future text, source context, ordinal, pending finalization and newer-source attention.
- Explicit play and paused navigation preview/frame their destination immediately, before audio, identity lookup or ownership acquisition is ready. Paused navigation remains silent.
- Playback starts anchor at **20%** even if the target was already visible, clamped to document bounds. Continued following uses the **20–80%** window and moves only when needed.
- Manual scrolling wins over automatic motion, including pending initial marker/frame arrival. Re-arm only on explicit follow/play/navigation.
- **Alt+V** returns to the paused/current narrated target without resuming. It works with autoscroll disabled. Layout changes invalidate stale coordinates; explicit re-anchor does not wait five seconds.
- **Alt+T/native End** pins the actual tail using Pi's native facilities. Avoid native jump-banner spam/last-line occlusion. New text during active narration restores windowed follow with remembered final-tail intent. Completion returns to tail only if still intended and not manually overridden; queued next speech frames its next target instead.
- Late alignment may improve stored timing but must not move paused highlighting/viewport until explicit resume/navigation. Late idle/ticks likewise cannot advance the frozen cursor or clear a newer preview.

### ASR preview

- This is **display-only**; the editing LLM still receives its unchanged actual candidate JSON.
- Factor shared words/phrases readably, **never cut within a word**. Nested alternatives and multiline fallback are supported. Readability outranks mathematically shortest compression.
- Every real candidate must be represented; extra combinations are permitted but not encouraged.
- Adding an already-covered candidate must leave the displayed expression unchanged. User example: `[a|b]c[b|d]` already covers `acd`; **a/b/c/d represent arbitrary subexpressions**, not individual characters.
- Preserve draft ownership/cancellation; the resolved editor draft is ordinary text, not the preview notation.

### Descriptions, cache, budgets and timings

- Conversation narration uses the full available conversation-model context through the **next code-block opening or containing message end**, including following prose, plus explanation/highlighting instructions. Wait for the boundary while streaming. Preserve guided highlighting and ask for complementary relevant explanation; do not delete original prose.
- Generation/cache/replay/backfill use the same canonical context boundary. Explicit block-only mode remains an option. Provider hooks/payload transformations are not guaranteed byte-identical to the main model's final wire request.
- Compatible descriptions survive editing-LLM/thinking selection changes. Lazy migration supports prior serialized context identities without retaining full prompt/context strings per block. Genuine context/prompt/narration incompatibility remains invalidating.
- Failed/omitted descriptions remain omitted until explicit retry or genuinely changed inputs. Existing `/voice code-retry current` and `historical [all|<message-id>]` remain; historical without an argument has a basic picker. No general force-regeneration UI was added.
- Budget/override survives ordinary sweeps, replay and unrelated settings; new session or explicit budget authorization replenishes it. Known preflight failures without a completion call are uncharged. Retry once per complete description key, not code text alone.
- Since-compaction scope includes retained active messages/materialized tails, excludes actually summarized-away history, and schedules missing work only.
- Generation/restoration share bounded validation. Oversized newly generated summaries are rejected/retried, not silently truncated; this does not retroactively guarantee every formerly invalid snapshot is restored.
- Timing identity includes actual spoken plan content and synthesis settings, not just the code block/lookup key. Capture the version at job start; reject stale results. First resolution and stable local fallbacks must not be mislabeled as incompatible regeneration.
- Bounded compatible timing variants support A→B→A reuse; retired captures are pruned. Eviction can require later remeasurement.
- Retain valid partial timings and recover missing portions in bounded background work even while paused, without audio or ownership release. Completeness requires full applicable source coverage. Compatible replay alignment refinements update/persist absolute checkpoints too.

### Alignment and playback clocks

- Bounded alignment admission/PCM retention; preserve current and nearest upcoming queued work. Overload leaves **indicated estimates**, not delayed playback or unlimited queues.
- Long units use overlapping 30-second windows (24-second stride), conservative source-ordered refinement and estimates for uncertain portions. Sentence audio/navigation remains atomic. Limits: 16 MiB PCM and 32,768 text characters per alignment unit. No promise of complete long-unit refinement.
- Word-timing quality is distinct from transport-clock estimation. Local playhead updates continue through buffered playback drain; helper `close`/feedback drain precedes classification of completion/refusal.

## Latest requested UX and sentence fix

- User LIVE confirmation: paused/unpaused navigation works and flicker is gone; retain those behaviors.
- Implemented separate actual-source-word `Word timing: n/total estimated` row, honest unknown/pending coverage, explicit idle/waiting/paused/playing states, and fixed-width numeric updates under native wrapping. Sparse saved checkpoints cannot reconstruct word totals; code-description coordinates are excluded. Denominator/unknown-state transitions may resize naturally; fixed-total refinements do not.
- Fixed formatted/marker-adjacent sentence endings in the shared synthesis/navigation splitter, preserving ordered prefixes, abbreviations, numeric decimals/versions, inline code and UTF-16 offsets. Plain reported text already split correctly. Boundary identity bumped only for affected narration timing compatibility; description/audio-content assets unchanged.
- Offline validation: typecheck, 506 passing tests (one native-banner compatibility skip), installed native TUI 10/10. See latest `FINDINGS.md` evidence and `docs/testing.md`. No live restart or provider/hardware validation performed.

## Evidence and outstanding verification

- Initial production-pool concurrency benchmark selected **3**, not the earlier standalone experiment's 4: ~1.76× sequential synthesis throughput at ~1.75× ordered latency; 4 exceeded 2×. This is not a live phone throughput claim.
- 500-message synthetic transition audit originally measured first replay handler ~1,064 ms. Latest targeted comparison at `2639e64`: ~572→11.7 ms cold and ~20.8→7.6 ms repeated; maximum measured heartbeat gap ~46.7 ms. Earlier intermediate retained-heap growth ~69.9→6.7 MiB. Comparisons use mocks; handlers can return before catch-up completes. Logs/scripts under `/tmp/pi-voice-transition-*`; do not claim all live typing/Escape latency is proven fixed.
- User reported start/stop typing lag but not pause/resume lag. Escape visual lag also occurred in a silent loop test; no exact keypress latency measured. For further silent tests, invoke the tool without preceding spoken commentary.
- User reported an intermittent unexpected stop followed by “project pi requires attention next.” Returning from another Termux window was a tentative, non-reproducible correlation. Existing other sessions were observed then; no causal attribution was established.
- Live verification should cover typing/escape, playback starts/stops, rapid navigation/paused framing/tail, code/thinking order, dictation cancellation/preview, cross-project handoff, disconnect/reconnect and protocol migration. No active session/device was changed to test these.
- Real-model long-window alignment accuracy and physical audio/recorder/network failure behavior remain unvalidated. Failed remote proof deliberately blocks ownership transfer rather than pretending success.

## Future only — NOT implemented

- Integrate descriptions/highlighting into the main conversational model output instead of a side narrator; possible inline/code-block presentation redesign needs future discussion.
- Richer selection UI for arbitrary description regeneration.
- R2T2/Confucius remains archived on `feature/confucius-cpu-streaming`, off main; leave its cached models untouched.

## Working rules

Use Termux icons in user instructions, not a separate Fn legend. Preserve intentionally untracked `ISSUES.md`. No private transcript export, paid application-provider calls, unsafe lease deletion or unrequested live client/SSH restart. Keep independent Conventional Commits and runnable regressions. User-level `voice-implementer` can be created/discovered dynamically; `code-reviewer` is read-only. LSP is unavailable; use typecheck/tests. See `FINDINGS.md` for historical stable finding IDs and evidence.
