# Pi Voice investigation ledger

Updated incrementally. Companion: `PLAN.md`. Reorganize freely while preserving evidence and disposition.

## Final implementation checkpoint — `a62a11d`

**The agreed batch is implemented.** This section and the rewritten `PLAN.md` supersede historical “awaiting discussion”, “deferred”, “resume here”, old HEAD/test counts and unresolved implementation statuses below. The chronological record remains as evidence, not a current task list. User-requested interruptions/reboots were not diagnosed product crashes.

### Validation and disposition

Final parent-run `npm run check`, `npm test` and whitespace check passed: **481 passed, 1 skipped, 0 failed** (482 tests, about 39 seconds). The skipped older-dependency native-banner case was exercised against the installed Pi TUI: **paused anchor, End, banner all passed**, no skips. Logs: `/tmp/pi-voice-final-batch.log`, `/tmp/pi-voice-final-native.log`. The default test runner now sanitizes child-only connection/voice environment and bounds concurrency to four; it does not change the user's environment.

| Findings | Current disposition |
| --- | --- |
| PERF-1 through PERF-6 | Render/context/idle caches and bounded yielding preparation implemented. A later immediate-preview regression was fixed in `2639e64`; synthetic cold replay handler ~572→11.7 ms, repeated ~20.8→7.6 ms, maximum measured heartbeat gap ~46.7 ms. Actual live typing/Escape latency still needs verification. |
| PERF-7, long-unit alignment | Bounded parent/child work and overlapping-window refinement implemented (`94fd4b0`, `52f278d`, `cb94935`); prioritize current/nearest upcoming work and indicate estimates on overload. Long-unit real-model accuracy remains untested. |
| UI-1 through UI-7, UX-4/UX-6 | Word-boundary nested display-only ASR preview, draft ownership/cancellation and playback/capture exclusion implemented. Editing-model candidate JSON is unchanged. Microphone startup cancellation is protocol-fenced, not merely a UI flag. |
| PLAY-1 through PLAY-5, PLAY-7, UI-8, UX-2/UX-5 | Sticky/dirty pause, single-action resume, status preservation, Stop suppression, late-request fencing, actual stop-proof ownership and reload cleanup implemented. Missing remote proof deliberately blocks transfer. |
| SCROLL-1 through SCROLL-4 | Transcript/sentence navigation, immediate 20% framing, ongoing 20–80% following, free paused scrolling, layout-aware Alt+V and native tail/banner integration implemented. The original Ctrl+T report was clarified as uncertain Alt+T/Alt+V behavior; no invented Ctrl+T diagnosis. |
| TIME-1 through TIME-6 | Bounded paused partial recovery, stale-event fences, frozen paused cursor, exact source/ordinal offsets, compatible replay refinements and drain clocks implemented. |
| UX-1/UX-3 | Noninterrupting/disabled-session attention and strict fresh-attachment pins implemented. ↺ remains current-project; `/voice attention` explicitly routes to an eligible waiting project with the origin pin and confirmed handoff. |
| CACHE-1 through CACHE-13 | Model-independent compatible reuse, canonical following-prose context, sticky omissions, stable budget/attempt charging, full-key retry coalescing, retained-compaction eligibility, bounded shared validation, exact spoken-plan timing identity and bounded version reuse implemented. Superseded context-boundary proposals are not current behavior. |
| SENTENCE-1 through SENTENCE-3 | Whole sentence/literal-newline units, ordered bounded synthesis and sentence navigation remain implemented. Production benchmark selected default **3**, not the earlier standalone result of 4. |

### Important review-driven refinements

- Canonical target finalization waits for the containing transcript entry, renames a batch before syncing, and highlights duplicate thinking fences by source range (`2ba0b7f`, `cb50c27`, `075d67f`, `a1ba79b`).
- Budgets/cache/version work landed in `eb8a1ca`, `01ea9e7`, with fallback/first-resolution/retained-reference corrections in `e07e44b`; lazy serialized-context compatibility and caller-specific budget rejection fixes followed. Newly generated summaries obey the same 1,500-character validation as restoration; invalid old oversized snapshots are not silently truncated or promised universally reusable.
- Scroll/timing refinements through `53955ee` and subsequent fixes preserve manual framing through delayed markers/retry, paused completion positions, absolute replay checkpoints, tail intent and rapid provisional selection. Live replay is supported again without dropping future deltas or newer sources (`4c827df`, `da574cb`, `ce98ad5`).
- Incoming/outgoing attention preparation is fenced symmetrically against automatic drain and superseding controls; obsolete pending replay is retired immediately (`41af337`, `65386b7`, `311dc78`, `d97b7a2`).
- Empty bridge connections/probes no longer replace a player (`712f939`). Actual endpoint readiness/completion is authoritative, not a successful TCP accept.
- Recorder admission is ordered against pre-start cancellation, handles ownerless locks and retryable Android stop failures, and uses a server-epoch/counter plus an exact matching stop receipt (`92fb09d`, `5ca4543`, `f2a9808`, `dc99b86`). Reassigned endpoints/generic old ACKs cannot confirm another recorder's stop.
- Audio stop/completion proof uses random opaque stream identities instead of reusable PIDs (`90b6517`). Numeric-v2 clients are refused before PCM. Helper exit classification waits for control-stream drain so a delayed pre-audio refusal marker does not permanently latch a false failure (`a62a11d`).
- Shutdown and same-PID reload cannot steal an unconfirmed lease; retired cleanup can be retried without restarting obsolete session callbacks (`e74b4a7`, `1dcb70d`).

### Deployment and remaining evidence gaps

**Client update required.** Copy all current `client/pi-voice-*` files from this host checkout, not GitHub (not pushed), and restart the client wrappers only at the user's chosen time. Earlier copied versions may predate scoped tickets/receipts and opaque audio IDs. See `docs/installation.md` and `docs/endpoint-protocol.md`; numeric ticket-state migration requires confirmed old-recorder shutdown first. Never erase an outstanding receipt/fence or treat host kill/lease deletion as remote stop proof.

No live client/SSH/session settings were changed, and this batch used no real inference, paid application-provider calls or private transcript exports. Real phone/SSH behavior, physical buffers, long-window model accuracy, live typing/Escape latency and the user's intermittent interruption remain live-validation items, not proven fixed incident causes. User manual reboots/interruption are not product-crash evidence. Timing estimates/refinement are explicitly distinguished; no byte-identical provider-payload guarantee is made. Integrated main-model narration/code presentation and richer regeneration selection remain future-only; Confucius/R2T2 remains archived off main. Preserve untracked `ISSUES.md`.

## Historical user feedback / discussion phase (superseded status)

- User corrected the latest crash/reload report: **it was their own action; ignore it as a product failure**. Continue implementation. This does not resolve or invalidate the earlier typing/scrolling/attention symptoms.

- **Implementation recovery:** user reported Pi crash/reload again; cause unknown. HEAD now `d4de64b` canonical transcript/context changes, with uncommitted follow-up source/tests. Prior orphaned agent processes exited on recheck; no duplicate implementation launched. Post-reload typecheck and whitespace check passed; full-suite validation of canonical changes and final subagent review results remain pending. Latest received full-suite result was 242 passed before canonical phase. See `PLAN.md` implementation recovery checkpoint for committed work, interrupted files, remaining phases and measurement caveats. Do not claim this crash is caused/fixed by a particular subsystem.

- **PLAY-5 fix approved:** explicit resume must clear the intended pause for a replacement/fallback player in the same action; no second ⏯ press required. Retain paused navigation and no-background-auto-resume semantics. Verify pending handoff and cold/recreated-worker paths separately.

- **TIME-2 fix approved:** fence stale playback-position ticks from superseded requests so they cannot clear or move a newly selected preview/highlight. User thinks they have encountered it; this is tentative recognition, not a new confirmed reproduction. Test stale ticks explicitly, not only old idle/completion events.

- **UI-8 fix approved:** preserve the real transport playing/paused state across settings changes unrelated to current audio; do not show idle while speech continues. Changes invalidating the current asset still pause immediately and retain ownership without auto-resume as already agreed.

- **SCROLL-4 anchor fix approved:** user reports frequently seeing the stale-position symptom. Invalidate absolute anchors on layout changes and refresh them for explicit re-anchor/navigation; do not wait for a five-second TTL. Preserve paused/manual viewport stability. This confirms desired behavior and user recognition, not literal Ctrl+T key failure.

- **UX-1 fix approved with re-enable requirement:** remove/suppress waiting entries when a session disables Voice and skip disabled sessions during routing. On re-enable, recompute whether attention is still needed and requeue if so. Avoid duplicate/stale entries and already-handled or explicitly Stop-cancelled work; do not interrupt ongoing speech. User did not specify a special priority boost when re-enabled.

- **SCROLL-3 fix approved:** Alt+V and explicit playback-navigation framing must remain functional with autoscroll disabled. Separate manual target lookup from automatic follow, preserving immediate movement and paused-state semantics.

- **PLAY-2 lifecycle fix approved:** user reports having seen this behavior before. Shutdown/reload must invalidate pending replay and ownership acquisition, fence late results, and clean up obsolete leases safely without disturbing a newer owner. Old session work must never start after teardown. Queue for the agreed implementation batch.

- **TIME-1 recovery approved:** keep existing compatible partial timing and fill only missing portions through bounded background work even while paused. No audible playback, paused highlight/viewport movement or ownership release. Whole-message completeness requires full eligible-content coverage; fence old results against new versions/navigation. This extends earlier suffix-not-complete protections to eventual recovery.

- **Navigation ordering clarified:** use actual **transcript order**, filtered by current narration/readability settings, for both **⏮/⏭ message navigation** and **↶/↷ sentence/newline navigation**. All eligible spoken content, including thinking when enabled, must be reachable. Do not impose the assistant's proposed thinking→answer pattern; follow whatever order the transcript actually has. Sentence navigation crosses eligible targets in that same order and skips excluded content. Live/replay/timing/highlighting must share this source model; preserve paused navigation and immediate target framing.

- **CACHE-7 scope expanded/approved:** exact narrated content must match across live/replay and timing identity. In `all` mode, user explicitly wants **⏮/⏭ navigation to reach and play spoken thinking traces**, not only final answers. Preserve thinking/text ordering and source mapping; assistant mode remains answer-only. Treat thinking traces as eligible navigation targets, not merely concatenate them invisibly into answer replay. Exact target granularity is being clarified in discussion.

- **CACHE-12 fix approved:** user understood generation-versus-restore length validation mismatch and recognized a similar past symptom. Align acceptance and restoration so valid generated descriptions survive reload. The audit's 1,649-character summary exceeded restore's 1,500 limit; this does not confirm the cause of the user's guided-mode incident. Numeric limit/compatibility strategy not separately agreed; do not silently truncate text to conceal validation inconsistency.

- **CACHE-9 fix approved:** deduplicate retry invalidation/scheduling by complete description key, not code text. Identical code with different conversation context remains distinct. User accepted after clarification that repeated code does not necessarily share identity in their conversation-context configuration.

- **CACHE-10 fix approved; user recognizes the symptom:** retained messages that survive compaction must remain eligible for missing description/timing preprocessing under since-compaction scope. Do not include summarized-away history or regenerate compatible cached assets. Existing audit reproduction stands; the user's recognition does not isolate the cause in their current all-history configuration. Implementation queued for the agreed batch.

- **TIME-6 fix approved after clarification:** continue host-local audio playhead updates through buffered playback drain and mark completion only at actual playback end. This drives highlight/progress, not wall-clock time. No evidence yet links this local-player defect to the user's Termux incidents.

- **PLAY-4 sticky-pause behavior approved:** new assistant messages queue speech without clearing the paused indicator, moving the frozen paused target or automatically resuming. Retain ownership until explicit resume/playback or Stop. Preserve the separately agreed paused-navigation rule; incoming content is not a resume action.

- **TIME-3 behavior approved:** background alignment can update stored timing, but must not move the paused highlight or viewport. Keep the paused target fixed until explicit resume/navigation; Alt+V should return to that same target. Preserve useful compatible refinements rather than discarding them to freeze the UI.

- **Long-unit alignment approved:** use bounded overlapping windows and combine timestamps for narration units >30s instead of always skipping forced alignment. Keep the audible sentence and navigation unit intact, never block playback on alignment, retain indicated estimates for unreliable/unavailable refinements, and bound queue/window resources. Include seam/source-order regressions; no implementation yet.

- ASR acceptance example clarified: adding candidate **`acd`** to display **`[a|b]c[b|d]`** must leave the display exactly unchanged because the candidate is already covered by existing combinations. Coverage does not require an explicit branch or provenance marker. User clarifies **a/b/c/d are placeholders for arbitrary subexpressions**, not literal characters, so the example does not violate word boundaries. Preserve it as given and test coverage across nested subexpressions; do not assume only flat token alternatives.

- ASR UX priority refinement: user acknowledges word-boundary-only factoring cannot always produce minimum-size combinations. Optimize for **intuitive reading and limiting confusing accidental overlaps**, not absolute compression. Extra combinations are permitted, not a goal; use sensible phrase grouping/nesting or separate alternatives when aggressive sharing would mislead. Preserve every real candidate, the already-covered-candidate stability rule, and unchanged LLM JSON evidence.

- **Latest authoritative ASR display requirements:** nested alternatives allowed; extra combinations need not correspond to actual ASR candidates. All actual candidates must remain expressible. If a candidate is already expressible incidentally through other combinations, adding it must not change the display just to represent it explicitly. Factor **only at word boundaries**, never within words. Thus earlier proposals requiring branch linkage/provenance or allowing subword factoring are superseded. Compact presentation is a readable user preview, not an exact enumeration of model evidence; editing-model candidate JSON stays untouched. Implementation remains deferred with the rest of the agreed batch.

- **Latest ASR correction / compaction handoff:** user insists on **always choosing the most compact factoring of shared text**, not presenting a redundant alternative first. Example must be `Please follow [my|the] advice today.`, not `Please follow [my advice|the advice] today.` They request a full reformulation and durable handoff notes. The earlier single-prefix/suffix-span restriction was an assistant proposal, not an agreed limit on compactness. Multiple difference spans need linked branch identity or a lossless full-candidate fallback to avoid implying fabricated combinations. Exact UI notation remains under discussion; LLM JSON stays unchanged. See the immediate handoff at the top of `PLAN.md`; do not start the deferred implementation batch after compaction.

- ASR clarification: the user explicitly wants **display-only** changes; keep the successful editing-model JSON evidence unchanged. They propose full-sentence superpositions for divergent hypotheses, perhaps one candidate per line. Reliability discussion should distinguish lossless candidate presentation from confidence/recognition correctness. Suggested conservative formatting: common whole-word prefix/suffix plus one linked alternative span, with multiline full candidates as fallback; avoid independent brackets implying combinations never observed. This remains a UX proposal under discussion.

- User accepts bounded/prioritized alignment work with clearly marked estimated word timings when overloaded, favoring responsive playback over alignment-induced gaps. Implementation remains part of the later agreed batch.
- ASR UX: user confirms alternatives are visible but finds JSON cumbersome, asks about compact inline differences (`fo[r row|ollow] your recommendat[ion|ed ion]`) and whether divergent options make that unreliable. Need discuss presentation separately from actual model evidence: retain real candidate arrays, avoid fabricating Cartesian combinations across independent difference spans, fall back to whole phrase/candidate alternatives for divergence, and preserve manual editor ownership. This is a question/preference, not yet an agreed formatting algorithm.

- Timing fencing/cache reuse approved: reject late results from incompatible asset versions, retain compatible timings for switching back, and do not auto-resume. User asks about binding granularity. Current timing snapshots bind to message ID plus render-input hash; individual Opus assets are separately hashed by spoken text/TTS settings. These are not waveform-file checksums. Current code-description timing dependencies contain source-description key and availability state, not generated plan content; refreshing a successful description under the same key needs content/version invalidation to avoid stale timing reuse. Inspect this in the authorized implementation round.

- **Immediate usability work authorized and implemented:** no-argument value-setting `/voice` commands now report effective settings without changing playback, tail-follow, budgets or saved configuration. `7c90403`: tts-workers query plus tts-worker alias; `4e159c1`: consistent queries across setters. True actions (stop/talk/test/setup/toggle/etc.) are unchanged. Voice query replaces its previous picker behavior; completion still lists choices. Read-only review found shortcut reporting ignored binding collisions; `f23f5a1` reports actual surviving bindings and pending reload settings, with Alt+T/F5 coverage. Implementer reports **typecheck and 179 tests pass**. No personal runtime settings or live sessions changed; other discussed work remains deferred.

- **Authorized immediate exception completed:** runtime `/voice tts-workers <1..8>` in `82384dd`, implemented by newly created user-level `voice-implementer` subagent. Agent definitions can be added mid-session; the earlier claim that only the configured reviewer could be used was corrected. Separate read-only reviewer found no actionable introduced defects. Subagent reports syntax checks, typecheck and **172 tests passed**; parent verified commit/status and obtained review, not a separate full rerun.
- Valid persisted `ttsWorkers` overrides the legacy environment fallback; default remains 3. Command applies to an existing worker without changing audio identity, restarting playback, releasing ownership, or auto-resuming. Shrink constrains new lookahead and retires excess workers after in-flight ordered jobs finish; growth is lazy. User must load the updated extension first; no live Pi/SSH/client session or personal runtime configuration was changed. Discussion notes and untracked ISSUES.md were excluded from the implementation commit. Other pending fixes remain deferred.

- Context clarification accepted: user wants the **full conversation-model context** up to the next code block/message end, with added explanation instructions and current highlighting capabilities, and explicitly agrees to wait for that boundary during streaming. Exact provider request reconstruction/context limits still require investigation; do not claim byte-identical context without verifying it.
- Performance hypothesis: user suspects parallel TTS. Existing setting is host environment variable `PI_VOICE_TTS_WORKERS` (1–8, default 3), read at worker startup. A sequential comparison can test synthesis contention but does not disable independent timing/code-description preprocessing or prove the source of the visual lag. No runtime configuration changed.
- **Future feature only, not authorized for today's implementation:** move narration/highlighting into the main conversation model's context/output instead of generating side-context descriptions. User envisions inline explanatory prose/highlighting after code, replacing separate code-block presentation/narration and better avoiding repetition. Keep as a design TODO; clarify final code visibility and output protocol when that future work is scheduled.

- **Context-policy correction for CACHE-5:** user rejects stopping context at the target fence. They want context through **message end or the start of the next code block, whichever is earlier**, so the narrator can see following explanatory prose and avoid effectively explaining the same thing twice (with versus without code highlighting). Prompt should identify the latest/target included code block and explain it relevantly in context. Generation and cache identities must use the same boundary. Earlier through-fence proposals in this ledger are superseded by this requested policy.
- Streaming consequence remains to discuss: the boundary is unavailable until a next code block or message end arrives, so stable code-description generation may have to wait. Prompting to complement prose is not a guarantee of semantic deduplication and does not authorize suppressing the original prose. No implementation yet.

- **Budget fix approved:** user agreed after clarification that a sweep scans completed messages for missing code descriptions and can be triggered by session loading, completed responses, replay/navigation, settings/budget changes or changed work. Such checks must not reset used allowance. Preserve session budget across ordinary sweeps/settings changes, require a new session or explicit budget authorization to replenish, and do not charge preflight failures without provider calls. Queue for the post-discussion implementation round.

- Confirmed invalidation behavior: changing the current asset's **voice, TTS model, tone, text, etc.**, when regeneration is required, must **pause immediately while retaining ownership**. Dirty/pending changes trigger this before regenerated content arrives. No automatic restart when regeneration completes or late results arrive; require explicit user playback action. This does not authorize adding a tone setting or invalidating compatible assets merely for editing-LLM selection changes.

- User clarified narration-change scope: **anything that changes, or marks dirty/pending change, the text/audio asset currently being played** should trigger pause with ownership retained. This is dependency/invalidation behavior, not a request to change shortcut keys. Unrelated asset/settings changes should not cause this pause. The assistant's proposed resume-from-sentence-start behavior was not approved; do not carry it forward as an agreement.

- Settings/ownership decision: user agrees microphone-only changes retain ownership while current speech continues. For changes affecting current narration—examples: **TTS voice change or regeneration of the code block currently being spoken**—apply the change and **pause without releasing ownership**. Other projects can register attention but cannot take over. This supersedes any blanket release-on-settings-change behavior; stale audio/results must not resume under the new settings. Exact resume anchor/output-device-change policy is not yet settled by this response.

- User clarified the Stop exception: **`/voice stop` must provide an escape from a hung operation**, retaining cancellation rather than requiring dictation finalization. Stop recording/cancel pending transcription or editing without awaiting a final transcript; fence late callbacks and preserve pre-existing/manual draft content. Ordinary playback-triggered recording finalization must not make Stop depend on the same stalled work.

- Dictation/playback exclusion discussion: user prefers **voice-related user actions to end recording and transcribe the audio captured so far**, not refuse the action. They ask how the `/voice test` overlap could occur and request a recommendation. Existing UX-6 audit scenario is invoking the test command during active recording; this is not a new user reproduction. Proposed shared finalization must freeze capture before playback, preserve draft ownership and avoid playback-triggered submission. Whether this also changes previously agreed `/voice stop` cancellation semantics remains to be clarified; read-only commands should be considered separately. No implementation yet.

- User acknowledged/agreed to fixing pending microphone acquisition cancellation (UX-4): a second 🎙 during ownership/device setup cancels the pending start and prevents later recording. Clarified this is **not SSH reconnection**. User had not known about the bug; do not treat acknowledgment as a new live reproduction. Continue discussing remaining items individually.

- **Scroll priorities now agreed**, with corrections superseding the earlier proposal: the user believes the jump-to-latest banner is Pi's own; verify ownership instead of assuming duplicate Voice UI. Playback starts must frame the narrated target at **20% down the viewport even if already visible**, clamped to available document bounds. Explicit play must preview/frame immediately, before audio is ready, just as paused navigation must reveal its destination immediately. During continued playback use the 20–80% window and move only as needed. Manual scrolling overrides automatic following until an explicit follow/navigation action. Explicit end-jump pins now; new arrivals during active narration restore windowed following with remembered return-to-tail intent; completion returns to tail only if still intended and not manually overridden, or frames the next message if playback continues. Paused navigation stays paused. User confirmed the remaining proposed priorities match their intent; implementation still awaits completion of the overall discussion.

- New UI report: when narration re-anchors near the last lines, **“↓ Jump to latest message” repeatedly appears and hides the last line**. Inspect coordination with Pi's native jump-to-latest/tail-follow controls and hint rendering; do not assume a cause yet.
- User requests **immediate destination framing for paused playback navigation**, before audio starts, including pending generation/handoff. Preserve pause and the narration window, rather than waiting for audio metadata to locate text.
- User wants all recorded issues considered for fixes in the next round, but asks to discuss sensible **jump-to-end versus narration-window priority** first. Proposed (not yet agreed): manual scroll overrides automatic motion; explicit jump-to-end pins now; new arrivals during active narration restore windowed following while remembering a final return to tail; progressing to another message frames that next target; final completion returns to tail only when still intended, not after manual browsing. Reuse native tail state/hints, avoid duplicate banners and last-line occlusion. Detailed discussion checkpoint is in `PLAN.md`; implementation is still deferred.

- Attention discussion: user explicitly requires **no interruption of current speech; schedule the other project's announcement next**. **↺ must always replay this project**, not switch to another waiting project. This resolves the earlier open priority question; apply explicit-replay repinning as already agreed.
- User asks whether Stop suppresses retries or suppresses then retries. Intended proposal is **suppress announcements AND retries**, with no automatic deferred retry of the stopped work. Explicit playback or genuinely new responses can authorize new work; cancelled requests must not be resurrected. Clarify this in the discussion before proceeding.

- Additional agreed routing behavior: **explicit replay/playback actions, including shortcut keys, repin to the current connection's device**, using the same fresh-attachment identification as `/voice reconnect`. This is user-initiated rebinding, not automatic fallback. Automatic narration/attention retries must not silently repin. Preserve paused navigation; do not treat a pause-only action as a request to move audio. Implementation remains deferred until discussion completes.

- Device-routing discussion: user agreed to no silent fallback for a selected device and explicitly requested **pinning the connecting client's device**, plus **`/voice reconnect`** to adopt the current connection's device ID as the session's new device (corrected from `/reconnect`). Implementation deferred until discussion completes. Fresh attachment identity must not be inferred blindly from an old Pi process environment, particularly under tmux.
- Read-only settings check: `~/.pi/agent/pi-voice.json` has `input: auto`, `output: auto`; current process inherits device ID `1d845b64-58f6-444a-91a8-368adbe906d4`, whose registry entry identifies Termux, name `localhost`. `DeviceRouter.resolve(auto)` prefers this inherited ID but falls back to the most recently active connected device when it is absent. Thus current behavior is preference, not strict pinning. No settings or transports changed.

- Clarification of paused scrolling: the workaround was probably **Alt+T**, not Ctrl+T. Alt+V may do nothing or prevent further scrolling in some cases; user is unsure of the exact failure. Do not conflate this with the earlier thinking-collapse finding.
- Corrected end-of-message report: after **⏭** at the latest message enters tail-follow, pressing **⏯** or **↺** produces no audible playback. The user was not asking to change ⏭ or Alt+V into replay controls. Desired outcome stated earlier is replaying the last message and then resuming tail-follow. Clarify ↺ priority when other projects await attention. The earlier “no active narrated position” report should not be assigned to a particular triggering control without further evidence.
- User agrees with the preceding paused-scrolling point. New report: **Escape takes a long time to stop** in this approximately **500-message** conversation. User suspects Pi itself may contribute; this is a hypothesis, not a diagnosis. User clarified: **only the visuals are slow to stop; already-started audio continues**. They requested a loop-script Escape cancellation test. Two finite, one-line-per-second loops were aborted. The first included assistant commentary beforehand; user requested no preceding speech, so the second was run without commentary. User confirms **the visual cancellation lag still occurs with no audio playing**. This rules out actively playing audio as a necessary condition, but does not isolate Pi core versus the loaded Voice extension, rendering/history work, transport, or background activity. Tool output confirms abortion, not Escape-to-cancellation latency: the keypress time was not measured. No fixes authorized.

- User **agreed** to proposed Stop semantics: stop speech/dictation; cancel pending replay/test/ownership requests; suppress attention announcements/retries until an explicit playback action or genuinely new response. Leave voice mode enabled. Pause retains resumable audio and ownership. Implementation remains deferred until all discussion points are agreed.
- New live report: **manual scrolling sometimes does not work while paused**; toggling what the user describes as “Ctrl+T tail/untail” restores it. They require free scrolling while paused. **Alt+V also appears incorrect while paused**, exact failure not yet specified. Earlier keybinding audit found Ctrl+T toggles thinking visibility and the default tail shortcut is Alt+T; clarify the actual shortcut rather than correcting away the observed symptom. Potential relation to SCROLL-3/SCROLL-4 remains unconfirmed.

- Further incident context: user was in another **Termux window** and returned to this one around the interruption/attention announcement. They cannot tell whether it happened **before or after** returning. They subsequently repeated the window switch and **the interruption did not recur**. Window switching is not a reliably reproduced trigger; no causal link, focus-triggered handoff or reconnection has been established. The original incident remains unresolved.

- Read-only check after another just-now attention incident: **three existing live Pi processes** are registered with fresh coordinator heartbeats: `mu` (PID 222919, running ~3 days), `humo-loan-scorer` (PID 306631, ~31 hours), and this `pi` session (PID 1308393, ~17 hours). User confirms they have not started any additional session since the current setup. These are existing sessions, not newly launched sessions or merely stale registry files.
- At inspection, both `speech.lock/lease.json` and `attention-current.json` named this `pi` instance; waiting/preemption directories were empty. Four voice workers belonged to the existing `mu` process. This snapshot confirms other sessions exist but **does not prove another session caused the interruption or that a crash occurred**. No processes, clients, leases or SSH connections were changed.

- After reload, user reports **huge typing lag when voice starts or stops playing**, while **the rest is a lot smoother**. Transition-specific live lag is unresolved; synchronous I/O or event-loop saturation are hypotheses, not diagnosed causes. Future investigation should separate main-thread work, rendering, inference CPU contention and client/transport effects at start/stop.
- New live incident reported immediately afterward: narration started, then unexpectedly stopped (described by the user as a crash) and announced **“project pi requires attention next”**. This is unexpected behavior; neither a process crash nor its cause is confirmed. Possible attention/ownership routing or transport failure needs investigation, not assumption. Do not silently classify this as normal attention behavior or attribute it to an existing finding without evidence.
- Discuss all remaining points with the user before implementing agreed fixes. Current discussion is live validation; use Termux icons inline with the instructions, not Fn names or a separate legend. See `PLAN.md` for the discussion checkpoint. No fixes authorized merely by these reports.
- **User returned; discussion resumed.** They confirmed that typing lag occurs **only when playback starts/stops, not during ⏯ pause/resume**. This narrows the observed trigger but does not establish a cause. Replay/navigation/pause/Stop functional checks remain unconfirmed. Continue discussing all points before implementation.

## Resume here

- Branch: `main`, baseline `98a33fb`; R2T2 remains only on `feature/confucius-cpu-streaming`.
- User priorities: fix long-conversation Pi UI lag first; show dictation alternatives using exactly the LLM evidence syntax; stop invalidating existing derived assets merely because LLM selection changes; audit remaining scrolling/timing/cache/UI behavior and report for approval.
- Do not automatically fix every finding below. Requested performance/display/cache-policy work is authorized; other findings await decisions unless inseparable from implementing that work safely.
- Preserve untracked `ISSUES.md`. No paid model calls or private transcript exports.
- Performance fixes are implemented and validated: lazy historical context, block-only render fast path, targeted Markdown-leaf invalidation, no unchanged-session timing rescans from the 200ms poll, and deduplicated progress widget updates. Added `test/index-render-cost.test.ts` and `test/narration-render.test.ts`. Typecheck and full suite pass: **149/149 tests**. Live-session latency remains unmeasured; `/reload` is required to activate extension changes.
- Performance commit: `f504597` (149 tests/typecheck passed).
- **Implemented and committed:** `fc521e5` fixes wrapped thinking invalidation; `7d970da` shows exact live/final ASR evidence and protects draft/cancellation ownership; `a17782e` makes description identities independent of LLM selection and preserves compatible legacy timing keys via persisted aliases.
- **Latest validation:** typecheck and **169/169 tests pass**, log `/tmp/pi-voice-parallel-nav-final.log`. Ordered synthesis, cancellation/cleanup, code-unit navigation/cues, no-timing navigation, pause retention, real replay ticks/completion, large snapshots and Termux label migration are covered. Follow-up read-only review found no remaining blocking defects. Existing ASR APIs and model-independent asset reuse remain covered.
- **Legacy limitation:** snapshots without source metadata can only be adopted when their original model/prefix hash is reconstructable under current settings. Unmatchable older hashes can require one initial regeneration; subsequent changes no longer invalidate newly stored/adopted assets.
- **Requested follow-up implemented:** whole units (`8c5a05b`), bounded long alignment (`a9b0b0c`), production parallel synthesis (`5e2b14c`), sentence/newline controls and Termux labels (`f003991`), completed-cursor fencing (`b8ffd3a`). The production-pool benchmark selected **3 workers**, superseding the initial standalone experiment's 4: approximately **1.76× throughput** at **1.75× ordered latency**. Four breached the 2× ceiling in this recheck. See SENTENCE-3; actual phone playback latency is not claimed measured.
- Additional read-only UX audit completed with source traces/mocked reproductions; see UX-1 through UX-6 and SCROLL-4. These remain decisions, not silently applied fixes.
- Baseline validation from preceding work: 147 tests and typecheck passed.

## Immediate resume instructions

1. Requested implementation is complete; do not reimplement parallel scheduling or sentence controls. Stop playback and reload Pi to activate it. Updated Termux clients migrate old labels on their next process start; `docs/usage.md` also has a local-Termux one-liner that needs no SSH reconnect. No live client/session was restarted during this work.
2. Validate perceived latency, pause/seek and handoff on actual phone/SSH playback when authorized. The production-pool benchmark includes IPC/native inference, not device playback, Opus transport or live token-arrival scheduling. Other hardware/models may need `PI_VOICE_TTS_WORKERS` tuning.
3. Ask for decisions on the remaining audit items, especially UX-2/UX-3, pending replay/test cancellation, microphone acquisition and ownership exclusions, paused layout anchors, and caching/budget/context issues. Long (>30s) units still use estimated word timings. Do not silently fix every unrelated item.

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
- Helper `src/narration-render.ts` traverses mounted nodes but invalidates only affected source Markdown leaves (including previous narration sources) or changed code descriptions. Full invalidation remains for actual global display setting changes and unsupported TUI shapes.
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

### PERF-7 — Existing alignment backlog has no queue budget [P2]
- Status: source-traced during final integration review; not reproduced with live device/model load, awaiting decision.
- Synthesis lookahead is bounded, but the separate pre-existing alignment path writes without waiting for stdin backpressure and `alignment-worker.mjs` queues audio strings without a count/byte limit. Cached replay bursts can therefore outpace alignment and retain extra audio in RAM.
- Decide between bounded alignment backpressure (possibly delaying delivery) and retaining estimated timings when overloaded. This is separate from the new bounded synthesis window; do not claim the entire downstream pipeline has a fixed memory bound.

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
- Status: fixed in `47f1602` as a sentence-generation startup prerequisite. Actual worker-client spawn/restart protocol test verifies pause is sent before audio; cancellation resets it.
- `worker-client.ts` pause before process exists is discarded. F11 during handoff → F8 → ownership arrives can play audibly while UI says paused.
- Current handoff mock records calls but misses real worker lifecycle. Preserve desired pause across startup.

### PLAY-2 — Pending replay survives shutdown [P1]
- Status: audit delayed-handoff reproduction.
- `index.ts` shutdown leaves `pendingReplay` valid. Late acquisition can reacquire ownership/enqueue after shutdown. Invalidate pending requests and fence async acquisition by session epoch.

### PLAY-7 — Worker shutdown calls a nonexistent function [P1]
- Status: fixed in `5961fe0` as required for safe long-unit shutdown. Real worker protocol test verifies exit waits for transport acknowledgement, stops alignment, and is idempotent across shutdown + stdin close.
- Before the fix, `worker.mjs` shutdown case called `cancel()`, but the worker only defines `scheduleCancel()`. The resulting ReferenceError skips orderly player/alignment teardown. A mere non-awaited substitution would still exit before the asynchronous player-stop acknowledgement.
- Parallel children now join this shutdown path in `5e2b14c`; regressions cover bounded lookahead, old-result fencing, busy-child interruption and complete child cleanup.

### PLAY-3 — Input-setting change releases lease without stopping TTS [P1]
- Status: source-traced.
- While speaking, `/voice input disabled` releases speech ownership but leaves player running. Another session can acquire concurrently. Retain lease or acknowledge transport stop first.

### PLAY-4 — New assistant message loses UI pause state [P2]
- Status: source-traced.
- `message_start` sets `playbackPaused=false` without resuming worker. Paused tool-use response continuing into next message needs two F8 presses to resume.

### TIME-1 — Seek on incomplete timing can prevent completion while paused [P2]
- Status: full timing completion during a paused suffix remains deferred. Sentence controls now work without complete timings and never mislabel a suffix as complete; replay from the first unit can rebuild full timing. Original audit: replacement generated fully, duration stayed at first two seconds.
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
- Status: fixed in `f003991` as required for consistent sentence/source metadata. Capture origins and source bases now normalize both segment and word offsets; regression covers global word coordinates and protects sentence boundaries during refinement.
- Segment offsets subtract `sourceBase`, word offsets do not. Seeking in a queued second message can clamp beyond its end to an empty suffix/no-op.

### TIME-5 — Code-description words are not Markdown source positions [P2]
- Status: fixed in `f003991`; description-word checkpoints are omitted, while whole description units retain source offset plus ordinal. Regression verifies no description-relative word offset enters the Markdown timing snapshot.
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
- Status: fixed by whole-unit source mapping in `8c5a05b`; prose and emoji-before-fence regressions verify UTF-16 slices retain the complete fence.
- Original audit reproduction: emoji before fence produced range 2..18 instead of UTF-16 3..19, truncating closing fence in contextual lookup.
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

## E. Whole-sentence follow-up — implemented and regression-validated

### SENTENCE-1 — Existing chunker deliberately splits sentences
- Fixed in `8c5a05b`: removed clause/length cuts, retain literal newline boundaries, never idle-flush unfinished prose, keep short sentences separate, and split code narration at sentences while preserving cue offsets. UTF-16 source offsets corrected along this path. Navigation and labels are implemented in `f003991`.
- Timing render identity bumped to 3 and audio-generation identity to 2: one necessary format transition because old clause durations and potentially truncated audio are not compatible. LLM selection still does not invalidate descriptions or compatible assets.
- Kokoro's ordinary `generate()` silently truncates past ~510 phonemes. Committed `sentence-audio.mjs` reuses Kokoro phonemization with truncation disabled, generates bounded native windows, and joins them before exposing a complete sentence audio unit. Shared model is not mutated; cancellation stops remaining windows. A deterministic 1,200-phoneme preservation test passes; actual short-sentence inference exercised by benchmark.
- Actual offline long-input check: **1,302 tokens**, native windows **512/512/282**, all 1,300 non-padding tokens retained, **72.175s audio generated in 52.20s**. No audio saved. This demonstrates intact endings and the measured first-audio cost with serial internal windows; it is not a hardware-independent lower bound.
- `a9b0b0c`: units over 30 seconds use existing duration-weighted word estimates rather than potentially unbounded quadratic CTC attention. A real-worker routing test covers both 31-second skip and 30-second alignment paths with mocked inference.
- Important limitation: exceptionally long sentences cannot physically fit one Kokoro inference call. They can still be one atomic playback/alignment/navigation unit; internal window seams may affect prosody. No PCM is persisted.

### SENTENCE-2 — Actual offline CPU concurrency benchmark
- Runnable script committed in `d0b0e33`: `node scripts/benchmark-sentences.mjs`. Uses current q8 Kokoro / af_heart / speed 1, eight synthetic sentences, three warmed rounds per level, separate CPU processes, no audio playback/cache/remote downloads/provider calls. All benchmark children cleaned up.
- Output: `/tmp/pi-voice-sentence-benchmark.log`. Latency is maximum ratio of median ordered-prefix readiness to sequential (includes first playable sentence). Throughput is generated audio seconds per wall second.

| Workers | Throughput | First sentence | Worst ordered latency ratio |
|---|---:|---:|---:|
| 1 | 1.524× real time | 2.970s | 1.000× |
| 2 | 2.366× | 3.982s | 1.341× |
| 3 | 2.821× | 4.484s | 1.510× |
| **4** | **2.999×** | **5.591s** | **1.882×** |
| 5 | 3.016× | 6.518s | **2.194× — rejected** |

- **Historical standalone choice: 4**, approximately 1.97× sequential throughput. Stopped at 5 because latency breached the 2× ceiling. Additional worker cold start/warm-up was 3.8–4.6s, excluded from warm latency.
- These are the original standalone-inference results, not production playback measurements. They are retained as historical evidence; the production pool is now integrated and its recheck below supersedes this concurrency choice.

### SENTENCE-3 — Production integration, navigation and recheck
- Implemented in `5e2b14c` and `f003991`; completion fencing in `b8ffd3a`. The worker now uses separate model processes with ordered consumption and a bounded synthesis lookahead. Cancellation kills busy inference children and fences late results, idle models can remain warm, and shutdown/IPC disconnect cleans up children. Parent-side Opus cache hits avoid launching TTS model processes. No new dependency or raw-PCM persistence.
- `scripts/benchmark-sentences.mjs` now exercises the **production synthesis pool**, including IPC audio delivery. Same eight synthetic sentences, q8/af_heart/speed 1, three warmed rounds, offline weights, no playback/cache/provider calls. Log: `/tmp/pi-voice-production-benchmark.log`.

| Workers | Throughput | First sentence | Worst ordered latency ratio |
|---|---:|---:|---:|
| 1 | 1.509× real time | 2.831s | 1.000× |
| 2 | 2.407× | 3.545s | 1.252× |
| **3** | **2.657×** | **4.963s** | **1.753×** |
| 4 | 2.699× | 5.875s | **2.075× — rejected** |

- **Current default: 3**, approximately **1.76× sequential throughput**. Four offered little extra throughput and exceeded the latency bound in this recheck. Configure 1–8 with `PI_VOICE_TTS_WORKERS`; calibration is model/hardware/load-specific, not a universal latency guarantee. Pool warm-up at each level took 4.2–6.9s and is excluded from the warm comparison.
- A separate real four-process cold smoke check returned four valid 24kHz PCM arrays (3.100/2.475/2.525/2.500 seconds) in 7.44s without playback or saved PCM. This was an interoperability check, not the selected concurrency or a phone-latency result.
- F7 selects the previous sentence/newline unit (also when mid-unit), clamping at the first. F9 selects the next, advances into the next message at a known end, or follows the latest transcript tail. Returning backward from tail selects the final unit even after ownership release. Terminal wrapping never defines a unit.
- Navigation works without durations. Code descriptions use block source offset plus sentence ordinal, preserve inherited focus/reset cues, skip terminal omissions, and never replay from inside a fence. Paused movement remains paused. Incomplete suffix captures do not claim whole-message completeness; first-unit/full replay can rebuild timing.
- Snapshots no longer uniformly discard sentence boundaries. Word refinement protects positive-duration boundaries and normalizes source bases; description-relative words are not Markdown source coordinates (TIME-4/TIME-5). Playback completion advances the cursor and rejects late clock packets.
- Both client variants migrate the old numbered Termux labels on startup, preserving custom layout and symlinks. Docs include an immediate local-Termux migration command without reconnecting. No active SSH session was interrupted or client deployed by this work.
- Final review caught and fixed suffix-relative cursor drift, omitted-description dead ends, stale completion cursors and ownership-dependent tail navigation. Regressions cover these paths, code cue inheritance, large timing snapshots, out-of-order generation, backpressure, cancellation and child cleanup. **Typecheck and all 169 tests pass**; follow-up review reported no remaining blocking introduced defects.
- Still unmeasured: actual phone/SSH end-to-end playback latency and live-arrival throughput. Existing alignment backlog (PERF-7), long-unit timing estimates, and unrelated audit findings remain explicit follow-ups.

## Validation / next actions

1. Requested performance, dictation, cache-policy, parallel synthesis and sentence navigation are implemented; reload/deploy and perform live device validation when authorized.
2. Confirm relevant audit reproductions in committed tests before changing behavior.
3. Implement authorized UI/caching requirements with safety guards, recording any inseparable fixes explicitly.
4. Run typecheck and full tests; record commands/results and commits here.
5. Final user report: fixed requested work + prioritized remaining choices, with intended behavior called out separately.
