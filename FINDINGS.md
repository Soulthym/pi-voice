# Pi Voice investigation ledger

Updated incrementally. Companion: `PLAN.md`. Reorganize freely while preserving evidence and disposition.

## Current checkpoint — final review fixes after `fa80347`

- **A — stop journal:** cleanup now checks unresolved saved scopes rather than generation changes. Late handles with matching releases plus cancel ACK clear safely; unreleased handles and pending preemption retain ownership. ACK is not a global remote-release receipt (`73b4f27`, `e846d98`).
- **B — phone capture:** accepted single-response AUDIO/OK persists matching retirement before dropping its ticket; rejection/EOF never proves retirement. Actual PhoneInput/recovery tests use temporary filesystem state and fake sockets to verify completed custom endpoint A cannot obstruct recovery of active B (`32d8da6`).
- **C/D — timing quality:** automatic recovery merges current compatible unit metadata and all coverage, including refinements arriving during same-unit measurement. Wholly estimated retry does not supersede pending original CTC. Deferred-background/retry/reload and paused-original-CTC regressions preserve refined quality/counts and paused highlight/scroll, with stale identity still rejected (`4fb16b9`, `e5232cd`; coverage expectation updates `33969ed`).
- Validation: typecheck passed; full checkout **1038 passed / 33 compatibility skips / zero failures**, installed-native **1071 passed / zero skips or failures**. Logs and initial failure disposition: `docs/testing.md`. LSP unavailable. All inference/transport is mocked; native UI is inert. No real providers/models/hardware, live restart, settings or private exports; `ISSUES.md` untouched and deleted demos not restored.
- **Remaining real restart-proof limitation:** complete durable admission/local-child proof is still missing. An orphan ownership fence remains blocked even if all saved remote receipts succeed; these fixes do not provide automatic reclamation or an unsafe unlock. The already-landed >800-line retry feature/history is unchanged; these fixes are split by stop journal, phone capture and timing-quality concerns.

## Historical checkpoint — phase 2 display coherence and scoped recovery

- Phase 2 points **1–6 plus handoff/off presentation are implemented offline**. Active incomplete/context/resource waits are Queued; unknown/incomplete totals have a neutral bar and only reliable elapsed time (otherwise `--:--`), not a false completion fraction. Phase, clock and index follow the audible foreground A until B takes over; B never borrows A's clock, and paused selection stays stable. Progress updates reuse the mounted component rather than reinsert it; off renders no blank rows. Narrow layout shrinks/omits decoration before status/time and keeps a closed right-aligned device badge where space permits.
- Lease-free live intent survives normal prompt submission and canonical source-ID handoff; unread output blocked by another owner is Queued, not live. Device adoption shows Connecting during the handoff, then preserves deliberate silent pause for prior playback or Idle for an idle session. Picker open/cancel does not create a handoff or acquire ownership.
- Original saved remote input/output scopes now persist in a per-owner recovery journal, with reconstructed diagnostics and explicit `/voice reconnect` retries using scoped receipts. Matching normal receipts retire saved handles; older cleanup cannot erase newer generations. Reconnection may use the original registered device's new endpoint, never a replacement device/ticket/stream ID; custom endpoint/configuration checks fail closed.
- **Phase 1 is still partial:** missing durable admission/local-child proof coverage means an orphan speech fence is **never automatically reclaimed, even when every saved receipt succeeds**. Startup reconstructs warnings without stop I/O; missing/malformed journals and ambiguous/unavailable routes do not release ownership. Broader admission/proof protocol work is separate, not a force-unblock workaround.
- Earlier repeated cold-history performance failures also reproduced on baseline. The minimal fix avoids cold history preparation in progress rendering and warms history with bounded background yields; performance limits were not changed. Final typecheck passed; full checkout **1015 passed / 33 skips / zero failures**, full installed-native **1048 passed / zero skips or failures**. Logs: `/tmp/phase2-final2-{check,test,native}.log`. Final regressions include persisted user-entry count invalidation and paused yield-mode foreground selection. Native frames, synthetic transports and fresh-host recovery fixtures are offline evidence, not hardware/live symptom-resolution proof.
- Phase 3 timing-command unification/retry is approved next, **not implemented**. Current commands remain unchanged, including `/voice timing-preprocess`; the historical proposed replacement is not available yet.
- User clarification supersedes the earlier attribution uncertainty: the prior PC crash was user-caused, not a product crash, and `docs/assets/demo*` was explicitly removed by the user. Leave it removed; preserve the earlier notes as historical evidence. Untracked `ISSUES.md` is untouched. Topic commits are `2dddb0a` (recovery) and `8ef1dd7` (display/live coherence). No client/runtime-configuration/private-data changes, live calls/restarts or push.

## Historical phase 1 checkpoint — native paint and stop safety (partial)

- Native root causes: SGR 22/reset 0 inside native output cancelled dim/bold styling, especially the first displayed line; native Markdown leaf recreation could drop patched rendering. Post-wrap painting now restores narration intensity without replacing syntax foreground colors, and hooks follow recreated leaves. Actual AssistantMessage streamed/final frames test effective SGR state rather than ANSI presence, canonical source handoff, independent continuing audio, layout, graphemes, markers and manual scroll. Unmappable baseline remains intentional.
- Current-queue membership, not only the last paused-prefix utterance, now determines terminal cancellation. Matching source abort/error precedes paused queueing; cancellation remains effective after device adoption clears live transport activity. Tests cover first-of-two failure, withheld stop ACK/retained lease, matching proof/release, stale errors and unrelated historical selection.
- Persistent warning rows retain per-resource device snapshots through Ready/Idle, coalesce reconnect notices and clear on matching proof. A review reproduction exposed older cleanup releasing a lease despite a newer failure; release now checks unresolved resources. Reconnect tests retain original opaque handles despite replacement endpoint selection and ambiguity; input drafts remain covered.
- Speech ownership no longer expires merely because its process/heartbeat died. **Remaining gap:** full restart loses in-memory cleanup handles and warning episodes; the durable fence fails closed but cannot yet recover automatically or reconstruct diagnostics. Phase 1 C is partial, not complete. No unsafe bypass was added. UI 1–6/handoff presentation/timing retry remain pending.
- Commits: `34e82da`, `239a18e`, `9e739a2`, `ae78b19`, review fixes `12c85e7`, `2015286`. Typecheck passed; final serial checkout **994 passed / 33 skips**, installed-native **1027 passed / no skips**, zero failures. All transport evidence is synthetic/mocked; native renderer checks do use installed Pi. No live symptom-resolution claim, providers, inference, hardware, runtime changes or session restarts.
- Initial native invocation incorrectly selected the AssistantMessage module as the agent entry and failed imports; corrected full native invocation uses installed `dist/index.js` and passes. Earlier concurrent-agent runs were not final validation. Logs: `/tmp/phase1-final-{check,test,native}.log`.
- Preservation limitation: initial status included untracked `docs/assets/demos/`, subsequently absent. No deletion appears in committed changes or inspected cleanup; cause remains unknown. `ISSUES.md` remains untracked and untouched. No claim that missing demos were preserved.

## Previous checkpoint — live between completed responses

- Clarified user evidence: latest finished source displayed `○ Idle · [full bar] 0:35 / 0:35 · message 669/669`; live only survived while the model worked. Prior 1004-test coverage actually asserted Idle after full completion, so streaming-only live checks did not establish the intended lifecycle.
- Root cause: completeOwnerSpeech cleared playbackTailIntent before releaseSpeechOwnership/relinquishSpeech cleared turn activity; the badge lost its active-playback guard. restoreFollowAfterSpeech separately tied navigationAtTail to viewport-bottom restoration.
- Fix: latest chronological completion retains existing intent and navigation Tail while relinquishing the audio lease. Retained completed history supplies paused time; F8 controls lease-free follow intent and queued incoming output. Manual viewport movement cannot change playback chronology. Older completed replay remains Idle, not live.
- Updated native-mounted regression executes full message_end/turn_end/worker-idle ordering and asserts lease release, persistent live, next-response queue/resume, F6 last-message selection, historical Idle; existing F7 tests now require last-sentence behavior regardless of viewport. No provider/inference/hardware calls or live reload. ISSUES and demo assets preserved.

- Validation: typecheck passed; full checkout **971 passed / 33 compatibility skips**, installed-native **1004 passed / no skips**, no failures. No LSP configured. Logs: `/tmp/voice-live-final.log`, `/tmp/voice-live-native-final.log`. Operator host `/reload` only when ready, not performed here.

## Previous checkpoint — four review fixes before user reload

- Shared estimated clock settles against the old submitted-audio limit before append; starvation is not playback. Fake clock: 1 second played + 9 seconds empty + 2 seconds appended + 125 ms = **1.125 seconds**. Real feedback reanchors fallback; estimates never prove a device stopped.
- Describing is only an actual foreground API dependency, including an already-active shared producer. Canonical context/next-fence, replay preparation and resource waits are Queued; cache hits charge no attempt and never report Describing. Consumer cancellation and generation guards remain intact.
- Live checks use a separate consumed source frontier: final description completion (including persisted/cached skipped-unit replay) or terminal omission consumes the block without stretching word/highlight ranges. Pending/unplayed units and paused state remain non-live. Closed silent fences no longer extend pending source; unfinished fences use shared speech-parser state.
- Typecheck passed; full checkout **971 passed / 33 compatibility skips**, installed-native **1004 passed / no skips**, no failures. Initial backfill failure was a test timing assumption exposed by added promise cleanup, not established pre-existing failure: clean baseline passed. Bounded waiting for both actual requests fixed the test. See `docs/testing.md` for logs and scope.
- Atomic topic commits start with `97b7008`, `3d031f9`, `c5323f2`, `36ec214`; follow-ups cover omissions, production phase tests, replay context, parser reuse and bounded test synchronization. Badge/mouse, ISSUES/demo assets and runtime settings untouched. No live/provider/hardware validation or reload performed.

## Previous checkpoint — compact phases, chronological live edge and VoiceUI badge

- Current compact phases are Idle, Playing, Paused, Synthesizing, Loading, Describing, Connecting and Queued, with paused intent taking precedence. `● live` is separate, uses native Pi `error` red, and occupies the time field only at the unpaused chronological playback edge, including caught-up next-output waits. It does not mean simply Playing or viewport-bottom follow. End/Alt+T cannot make old replay live; unknown timing stays `--:-- / --:--` rather than a fabricated duration.
- `[🎧:device]` is reserved at the right edge of the first VoiceUI line, including idle status; status/hints truncate before identity. A too-narrow badge is omitted rather than left open. The host widget replaces the old idle Voice footer placement; Alt+S and supported first-line clicks open the picker, not footer clicks. Other extension statuses/Pi's footer remain intact.
- **New scoped offline reproduction:** `test/index-live-progress.test.ts` uses the real native widget lifecycle and rendered frames with mocked transport/synthetic events, explicitly mocking `PlaybackHistory.status()` to return no record during streaming and chronological Tail. Active intent now supplies the bar through that history gap; completed idle/Stop without history must not invent one. Coverage also includes preparation phases, blocks/tools, pause, known/unknown times and resizing. This is a controlled missing-history reproduction, **not proof that history loss caused the user's original random live disappearance**. Earlier native-frame tests did not reproduce that gap and their limits remain valid for those checkpoints.
- Final serial validation: typecheck passed; full checkout **956 passed / 33 compatibility skips**, full installed-native **989 passed / no skips**, no failures. Review exposed and fixed premature/stale live badges, abandoned Tail timestamps, suppressed stop warnings, interrupted pointer clicks and cancelled multi-utterance phase entries. Partial prose/fence and silent Markdown tail regressions use source events without unrelated worker nudges. These are offline checks, not live confirmation; logs and limitations are in `docs/testing.md`.
- Clients unchanged; this UI diff needs host `/reload` only when the user is ready. No reload, hardware/provider calls, real inference, live Pi/SSH/client restarts or runtime-settings changes were performed for this docs sync. No commit; `ISSUES.md`, assets, code/tests and prior discussion/evidence remain untouched by the docs work.

## Historic evidence and discussion

All entries below retain their checkpoint-specific evidence and proposals, not current UI guarantees. In particular, old Waiting labels, plain device badges, footer click targets and older shortcut choices are superseded above. Prior user LIVE confirmations remain scoped to what was observed then.

## Historic checkpoint — Alt+S and current-device selection after `7a63f7e`

- Fixed picker shortcut is now Alt+S; native Alt+D forward-delete-word is untouched. Configured Voice Alt+S controls still win with a warning. No badge hint, new setting or client interception.
- Exact current ID initializes native selection and its visible window; non-TUI display puts current first. Missing current falls back to the first available choice, not a fabricated candidate. Same healthy picker choice pins automatic selection manually without audio changes; explicit device commands keep their existing transition.
- Historical shortcut/default-selection statements below describe their original checkpoints, not current behavior. Validation and operator limits: see `docs/testing.md`; host `/reload` only.

## Historic user LIVE report — streaming playbar / hint removal after `36d9b3b`

- User reports the playbar randomly disappears while assistant text streams. **Literal disappearance and its live root remain unconfirmed**; do not treat the narrower reproduced bug as proof of that report's cause.
- Proven defect: `refreshProgressWidget` derived its playback label from the worker-wide `state`. Ready/unscoped idle and completed source-block utterances can set that state to idle while the owned response still awaits text/synthesis. The mounted extension event-sequence test reproduced premature Idle. The builder now uses existing turn/utterance ownership and completion markers to label that gap Waiting, while preserving Paused precedence, actual Playing, unknown timing, errors and true completion. Stop now refreshes the timeline immediately rather than waiting for transport events.
- The playback row itself is gated by enabled/history selection, **not** `vocalizer.isSpeaking`. Streaming text growth, selected capture updates, canonicalization and background preparation preserved the row in the reproduction. No speculative history pinning, duration invention, worker preload rewrite or routing changes were added. Existing paused cursor/native follow/input-only and same-route reconnect tests remain green.
- Regression mounts the actual extension widget callback/replacement path and exercises growing source text, pending timing, loading/ready/unscoped idle, playback ticks, consecutive source blocks, pause, Stop, true completion and shutdown. This is mocked transport evidence, not a real model/description-provider or live terminal reproduction.
- Removed visible shortcut hints entirely from progress/footer badges; first-row badge/pointer behavior remains. Alt+D binding and help/docs shortcut entries remain unchanged. Alt+S, Alt+I and F2 have no conflicts in checked Pi 0.84.2/installed 0.85.1 and Voice defaults; other extensions and terminal interception remain unverified. No replacement chosen.
- Validation: `npm run check`; full checkout suite **940 passed / 29 compatibility skips**, full installed-native suite **969 passed / no skips**, no failures. Logs: `/tmp/pi-voice-live-progress-tests.log`, `/tmp/pi-voice-live-progress-native.log`. No LSP configured. No live provider/model/hardware calls, settings/session changes, private exports or push; untracked ISSUES/demo assets preserved.

## Review of `91042d7` — terminal cancellation before ACK

- Reproduced aborted/error `message_end` during an IDLE source gap retaining **Waiting** until stop proof: all six terminal-cancellation cases fail the new immediate-Idle assertion against `91042d7` (`/tmp/voice-review-before.log`). The lease must remain held; its presence is not continuing source intent.
- Both live-source cancellation paths now mark the logical turn ended/suppressed and repaint Idle immediately, independently of transport acknowledgement. Existing ACK/termination barriers and lease-epoch fencing remain unchanged. Suppressed, unpaused playback ignores late `speaking`; late source deltas/playback/idle/ready cannot resurrect the cancelled source. Tests withhold ACK, check unchanged lease, unrelated ACK, post-ACK events, and replay/session replacement ownership. They use explicit mocked local output so an inherited automatic route cannot silently skip synthesis.
- Validation: `npm run check` passed; full `npm test` **940 passed / 29 compatibility skips** (`/tmp/voice-review-full.log`); full installed-native suite **969 passed / no skips** (`/tmp/voice-review-installed.log`), zero failures. Installed run includes the added post-ACK assertion. `git diff --check` passed; LSP unavailable. No commits, live/provider/model/hardware/settings/private-export work; ISSUES/demo files untouched.

## Historic Part 2 — native-frame playbar investigation

- Inspected Pi's actual `InteractiveMode.setExtensionWidget` → `renderWidgets` → `renderWidgetContainer` lifecycle (checkout 0.84.2 and installed 0.85.1): replacement disposes/deletes the old component, invokes the factory, inserts the new component, rebuilds the mounted containers, then requests rendering. `undefined` removes it; `resetExtensionUI` explicitly clears widgets. No intervening render request occurs between deletion and insertion. Fullscreen uses transcript plus a dock ordered pending/status/above-widget/editor/below-widget/footer; below widgets have `shrink: 1, minSize: 0` (installed Pi extracts this into `chat-viewport.js`). Reviewed the complete extension/TUI docs and widget-placement example, plus Voice's progress builder and streaming/finalization handlers.
- `test/index-live-progress.test.ts` now mounts each factory once through that actual lifecycle, including the render driver and jump widget, and captures native `TuiAltScreen.previousScreen` after render requests into an inert terminal. Assertions cover every captured frame across live growth, loading/ready/idle preparation gaps, source-block handoff, pause, canonicalization, tool execution boundaries and the next assistant; also checks 40/100-column resizing. The first narrow assertion failed because the device badge correctly truncates `message N/N` to `message ...`, **not** because the bar disappeared; the narrow assertion now checks the visible playback label instead of demanding an untruncated counter.
- Badge/footer trace: `deviceProgressComponent` adds the device badge to the first physical progress row only. `refreshProgressWidget` supplies playback even without timings/duration; `progressWidgetVisible = lines.length > 0` suppresses only the footer's duplicate device badge, not its Voice status or the progress row. This flag describes requested widget content, not measured on-screen visibility. No automatic footer/status path removes a mounted playback row; no visibility cause inferred from the badge.
- **LIMIT — literal random disappearance and its live root remain unconfirmed.** No missing playback row reproduced in these frames. This exercises real mounting/layout/rendering with synthetic events and mocked audio, not Pi's full agent loop, native terminal write timing, arbitrary dock-height pressure, real tool execution, inference or provider preparation. Dock shrinking is an observed policy, not a proven cause. No speculative production fix added; existing notes above remain historical evidence.
- Validation: `npm run check` passed; no LSP server configured. Targeted checkout run **23 passed / 4 compatibility skips**; installed-native run **27 passed / no skips**, both zero failures. Logs: `/tmp/pi-voice-part2-targeted-clean.log`, `/tmp/pi-voice-part2-native.log`. Initial adjacent-suite run retained inherited `PI_VOICE_DEVICE_ID`/`PI_VOICE_DEVICE_TARGET` and failed two `[local]` badge assertions; removing those test-process variables fixed both without code changes (`/tmp/pi-voice-part2-targeted.log`). No live settings/session/provider changes or commits.
- Exact test commands (installed root below is the already-installed package, not an installation step):
  ```sh
  npm run check
  env -u PI_VOICE_DEVICE_ID -u PI_VOICE_DEVICE_TARGET -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY -u TMUX -u TMUX_PANE node --import tsx --test --experimental-test-module-mocks test/index-live-progress.test.ts test/index-progress.test.ts test/index-native-scroll.test.ts
  env -u PI_VOICE_DEVICE_ID -u PI_VOICE_DEVICE_TARGET -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY -u TMUX -u TMUX_PANE PI_VOICE_TEST_AGENT_MODULE=/home/curiosithy/.nvm/versions/node/v26.7.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js PI_VOICE_TEST_TUI_MODULE=/home/curiosithy/.nvm/versions/node/v26.7.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js node --import tsx --test --experimental-test-module-mocks test/index-live-progress.test.ts test/index-progress.test.ts test/index-native-scroll.test.ts
  ```

## Final picker integration after `e44775d`

- Inherited routing changes were checked and committed separately as `8d665ce`. Reconnect of an already-paused unchanged route must retire its sink once incoming deltas are queued; resume preserves the audible suffix without duplicated prefix or lost future text. Input-only ownership must not set playback pause intent; finalized dictation stays review-only, and a later manually submitted turn narrates normally.
- The exported narrow-label helper was not yet used by `index.ts`: embedding IDs after names hid identity on narrow screens. The picker now passes raw names/full IDs to `devicePickerLabels`; number/current/short-ID render before names, with full-ID snapshot mapping and local default unchanged. Mounted 40-column integration verifies duplicate long Unicode names, colliding short IDs, current visibility, actual pointer choice and keyboard local default.
- Alt+D and supported badge pointer clicks open the native keyboard/pointer overlay while preserving underlying select/confirm promises/focus. Retired mouse targets, prompt expiry/new overlay/height cancellation, narrow badge/footer rendering and regular/frame-mode keyboard fallback remain covered. Alt+D overrides native forward-delete-word; Alt+Delete remains available. F4 mic/F5 replay, sticky selection commands and read-only no-argument queries remain as documented. This is explicit shared-terminal selection, not sender authentication or SSH-wrapper key interception.
- Validation: typecheck passed; default full suite **939 passed, 29 skipped, 0 failed (968 total)**; **full installed-native suite 968 passed, 0 skipped/failed**, including all optionally gated native cases, not just 27 picker tests. Logs: `/tmp/pi-voice-integration-full.log`, `/tmp/pi-voice-integration-native.log`; [commands and coverage](docs/testing.md). Focused test development caught the native ASCII `...` truncation expectation and a fixture-induced playback pause; both assertions/setup were corrected before final green full runs. No LSP configured.
- Latest feature remains **not live-validated**. Prior user confirmations of Mint capture and narration UX do not validate this batch. Operator `/reload` only; no live config, SSH/client/Pi restart, user-file/ISSUES/demo modification, container, real model/hardware/provider call or push. Historical notes below retain their original evidence/counts.

## Explicit shared-terminal routing — previous agreement checkpoint

- Implemented the explicitly authorized command alternative, not sender detection: exact ID / unique exact name selection, robust whole-argument quoted spaces, stable-ID wrapping `next`/`prev`, read-only selection/list query, duplicate-name rejection listing IDs. Registry enumeration validates canonical IDs/endpoints and excludes disappeared registrations/closed forwards where observable; it opens no sockets. Existing registration metadata has no heartbeat/expiry field, so no invented age cutoff expires a long-lived idle connection. No synthetic local/legacy candidate enters the registered cycle; saved legacy pins remain readable.
- Manual selection persists as the existing session `selection` plus `pin`, including reload, and bypasses ambiguous tmux lookup in ordinary controls and attention origin. Auto behavior remains available only after successful explicit reconnect/`device auto`. Receiver manual pins remain sticky too; request-source/freshness/session-ownership gates are unchanged. Any attached shared-terminal user can select: a display name is never authentication, and no key sender is claimed. No new credential/channel/key interception/global setting/dependency.
- Reused the serialized adoption/stop-proof path instead of the old destructive device setter. Superseded playback/acquisition cannot commit; active recording (including forced reconnect) finalizes into the draft without submission/manual-edit overwrite. The old player and recorder must acknowledge actual stop before new pin commit. Failure retains the old selection, badge and unconfirmed lease/retry handles. Successful handoff stays silent/paused at the canonical cursor, preserves manual viewport, and keeps explicit input/output overrides (including raw custom endpoints).
- The first **existing** progress row alone ends in a bounded `[name]`, falling back to short ID, `[local]`, or `[no device]`; otherwise the existing Voice footer carries it. Native-width rendering reserves suffix space and preserves widget margins without adding a row. Input/playback/description/timing precedence and non-first timing row wrapping remain intact. No endpoint/credential is used as a badge. Client wrapper wording changed to `Connected as`; host notices explicitly describe identity selection, not readiness.
- Regression coverage uses fake workers/capture and temporary registrations: ambiguous attachment with manual name/ID/cycle selection; ordinary F4/F5/F8; sticky reload and explicit auto return; silent new endpoint and canonical second-sentence resume; failed stop retains pin/tag/lease and retry succeeds; manual editor preservation plus non-submitting finalization; zero/one/missing/duplicate cycles; no-argument immutability; unchanged custom endpoint policy; attention origin/current-request cancellation. Existing full/native suites cover navigation/code previews, stale SDK facades, opaque stop proof, playback/capture acquisition and manual scroll behavior. No claim of a live two-client tmux or physical-device test.
- Validation: `npm run check` passed; final full `npm test` **923 passed, 3 existing TUI compatibility skips, 0 failed (926 total)**. Installed-native inert-terminal key/scroll/marker tests **307 passed, no skips/failures**. Full-suite native widget/width tests cover the actual Pi widget factory, first physical row, footer exclusivity and stable mobile rows. Shell syntax and diff whitespace passed; LSP unavailable. Logs: `/tmp/voice-final-tests-2.log`, `/tmp/voice-final-native.log`. Earlier runs caught old UI assertions/array-widget assumptions and a reconnect finalization guard; both were corrected and rerun. Optional isolated SSH 12-case suite not rerun for the client text-only change. No real inference/provider/microphone/audio, live session/configuration changes, restarts, pushes or private exports.
- Operator: host update plus user-chosen `/reload` enables routing/UI with already-compatible registered clients. New `Connected as` wording needs the installed desktop/Termux wrapper copies updated for future connections, not an immediate restart. Always retain unconfirmed stop state. Preserved untracked `ISSUES.md` and `docs/assets/demos/`; neither staged nor altered. Implementation commits: `b93f830` (routing), `3a00247` (UI/client identity text), `627493c` (reconnect finalization and routing regressions).

## Visible device-name prompt and strict standalone CLI

- Supersedes the historical hidden-input/manual-file-provisioning guidance below. Both wrapper copies now support `pi-voice-ssh --set-device-name ["Device name"]`: first argument only, at most one positional name, no target/options. No argument always prompts, even for an existing name; an argument needs no terminal. Wrapper-position misuse rejects before mutation/SSH, while `host remotecommand --set-device-name` remains remote command semantics. Bridge launchers and per-stream helpers are unchanged and do not prompt.
- The existing byte reader now prints only validated safe UTF-8 prefixes, including spaces while typing; Backspace restores/redraws the input origin so wide characters need no guessed widths. Raw input is never terminal-echoed. Malformed UTF-8 still cannot consume Enter/EOF; NUL, controls/bidi, blank and over-limit final names fail. Terminal state is restored and SSH stdin is preserved. Native line echo was not used because pasted controls must not execute before validation.
- `80aca1d` bounded flock/private temporary/atomic rename publication is retained. Only explicit setters override the name; normal concurrent first launches still use the winning name/ID. Setters never generate/read/rewrite the ID, query SSH configuration, start bridges, create runtime state or restart a connection. Concurrent setters publish complete files, last writer wins. Errors/cancellation preserve the previous name and ID.
- Validation: `npm run check` passed; full `npm test` **917 passed, 3 existing compatibility skips, 0 failed (920 total)**. Both copies have PTY checks for visibility before Enter, first-run/rename, Unicode/Backspace, Ctrl+C/D, malformed UTF-8 and restored modes. Headless checks cover strict arguments before mutation, no TTY diagnostics, validation, ID absence/preservation, no network/runtime activity, concurrent setters and remote-command flag pass-through. Isolated real-SSH harness **12/12 passed**, using the headless CLI for ephemeral client provisioning; no helper configuration changed. Logs: `/tmp/pi-voice-visible-tests.log`, `/tmp/pi-voice-visible-ssh.log`. One intermediate full-suite run hit the existing ownerless-lock test's 15-second process timeout after `Connected to testdev`; an unchanged full rerun passed (timeout log: `/tmp/pi-voice-visible-tests-retry-timeout.log`). Owned container/image cleanup completed (scoped SIGKILL fallback reported). No LSP configured; typecheck/shell syntax provide diagnostics. No live client/SSH/Pi changes, paid provider/inference/hardware calls, runtime settings or `ISSUES.md` edits.
- Upgrade every installed desktop and alternative Termux wrapper using `docs/installation.md#upgrade-device-name-support`; host `/reload` alone is insufficient. Official provisioning is the headless CLI. To apply a rename to registrations, confirm playback/capture stop, close all wrappers and reconnect; retain device ID and outstanding recovery state. No implicit restart.

## First device-name save failure — report against `16d45f9`

- User report: `pi-voice-ssh zero-sc` displays `Device name (1–128 characters; input hidden):`, then `Cannot read/write pi-voice device configuration in /data/data/com.termux/files/home/.config/pi-voice`. Parent directory creation/chmod precedes the prompt; prompt cancellation and name validation have distinct messages. This does **not** establish incorrect directory permissions.
- Offline PTY reproduction against the `16d45f9` wrapper: injecting either `ln: failed to create hard link: Operation not permitted` or `ln: invalid option -- T` after a valid name produces exactly the hidden prompt followed by `Cannot read/write pi-voice device configuration in <temporary config>/pi-voice`. No name file is created and the injected reason is swallowed. Confirmed code mechanism: `ln -T` is required for publication and discards stderr. The actual phone cause (SELinux/filesystem/tool implementation or another save error) remains unknown without device evidence; no live device investigation was performed.
- Replaced hard-link publication in **both** wrappers with a private same-directory temporary file and atomic rename under a five-second `flock` fence. Check existence under the lock; concurrent first launches reuse the winner for both name and ID. Prompts remain outside the lock. Existing files/IDs remain intact. Normal exit and INT/TERM clean temporary files and release the kernel lock; the empty `.device.lock` inode intentionally persists so waiting writers cannot lock different inodes. As with other shell cleanup, SIGKILL cannot run traps; an orphan private temp is not a published identity.
- Save errors now identify name/ID, operation and the original utility diagnostic, with terminal control/non-ASCII diagnostic bytes filtered and no entered name echoed. Linux/Termux installation already requires util-linux `flock` for recorder helpers; identity provisioning now uses it even for playback-only clients. Installation docs explicitly cover that expanded requirement, experimental macOS setups, retry, and retaining `device-id`/config root. No native macOS support is claimed.
- Validation: `npm run check` passed; full `npm test`: **917 passed, 3 existing skips, 0 failed (920 total)**. Separate Python PTY run passed both wrappers: denied hard links, complete mode-600 source/absent destination at rename, simultaneous first prompts, 12-way ID creation, retained ID, rename diagnostic/control-byte filtering, INT/TERM immediately before rename, real EACCES on the fence and newly read-only config directory, bounded lock contention and subsequent lock reuse. Shared identity blocks are byte-identical. Shell syntax and diff whitespace checks passed; no LSP configured. The isolated opt-in real-SSH harness passed **12/12**, with synthetic audio only and owned-container cleanup. Logs: `/tmp/pi-voice-save-test.log`, `/tmp/pi-voice-save-ssh.log`.
- Early validation exposed the restricted-PATH fixture's missing `flock`; its allowed core-tool list now includes it. One initial unchanged prompt Ctrl-C case timed out; subsequent standalone and full-suite runs passed. No real inference/provider calls, user config/private host-state reads, live SSH/audio/session changes or deployment. `ISSUES.md` and historical ledger entries remain untouched; no commit requested or made. Recovery: install the updated local checkout's client helper set (and any custom Termux wrapper copy), then retry the prompt; do not delete the device ID or config root.

## Persistent-name clarification — supersedes environment naming entirely

Implementation and regressions: `d09e051`.

- Latest user clarification is authoritative: no device-name environment override or silent hostname default. Both SSH wrappers prompt on their first interactive connection, before SSH/bridge activity, and reuse the local `${XDG_CONFIG_HOME:-$HOME/.config}/pi-voice/device-name` file thereafter. An existing ID is preserved; missing-name upgrades prompt next time. Noninteractive missing names fail with the exact file path and provisioning instructions, even with an inherited obsolete export.
- Atomic hard-link publication of private temporary files gives first-writer-wins name and ID creation without locks across unbounded prompts. Files are 600, directory 700. Names are validated before persistence/registration/output: 1–128 Unicode characters, not blank/whitespace-only; controls, bidi, line separators, invalid UTF-8, NUL and extra file lines fail. Prompt input is hidden and read from `/dev/tty`, preserving SSH stdin. Character reads reject NUL instead of Bash line-read sanitization, retain bounded input and support Backspace; temporary terminal modes are restored on success, invalid input, EOF and Ctrl+C (PTY-verified). Cancel/EOF does not create identity files or report connected. Stored files are bounded-read; configuration failures are explicit.
- Inspected direct `pi-voice-client` and `pi-voice-phone`: they launch listeners, not registrations, so no prompt/name plumbing was added there or to per-stream helpers. Registry name metadata comes from the wrapper's local file. Duplicate-name tests preserve ID selection; fresh identity lookup alone does not mutate an existing pin. No routing, SSH attachment proof, authentication or confirmed-stop barrier was weakened, and no automatic mid-playback repin was added.
- Validation: `npm run check` passed; full `npm test` **917 passed, 3 existing TUI compatibility skips, 0 failed (920 total)**. The new Python-stdlib PTY test runs through the normal suite for both wrappers, including simultaneous first prompts and 12-way ID publication. The isolated real-SSH harness passed **all 12 cases**, with the name prefilled only on the client in `/work/device-config/pi-voice/device-name`; no production name-env fixture remains. Logs: `/tmp/pi-voice-persisted-final.log`, `/tmp/pi-voice-persisted-ssh.log`. Owned containers/image were removed; normal cleanup used its scoped SIGKILL fallback. Shell syntax and diff whitespace checks passed. No LSP configured; no extension UI/API changes, so no new native-TUI run.
- During development, two wrapper/whole-suite invocations embedded a wrapper filename in the invoking shell command; the existing conservative legacy-lock process check saw that shell as a live wrapper and timed out. Re-running with the ordinary standalone test command passed; no unrelated lock-policy changes were made. Early new validation/PTY test mistakes were corrected before the final full run.
- Deployment is **not performed**: user must confirm actual playback/capture stop, close every wrapper on each client, copy the updated scripts from this host checkout, reconnect/answer the prompt, and `/reload` Pi. Rename by editing only the local file after the same stop/close precautions; do not delete `device-id` or stop-proof state. No live SSH/Pi/client restart, hardware/provider/inference calls, runtime/user settings, or `ISSUES.md` changes.

## Current keyboard mapping and user LIVE evidence

- A: default Alt+M/custom microphone bindings unchanged; automatic F4 only when `talkShortcut` is not `disabled` (custom F4 deduplicated). F5 replays this project independently of microphone-shortcut disablement. No automatic F11; custom F11 remains allowed. Existing registration collisions are unchanged. Desktop: F4 mic, F5 replay, F6 previous message, F7 previous sentence, F8 pause/resume, F9 next sentence, F10 next message.
- Termux row: `F4🎙 | F6⏮ | F7↶ | F8⏯ | F9↷ | F10⏭ | F5↺`; edit the phone's local `~/.termux/termux.properties`, no generator. See `docs/usage.md`.
- Historical F11 replay / F5 microphone references below describe their original audit mappings; they are intentionally preserved, not current instructions. Pi keybindings/extensions and relevant TUI/terminal docs were read; native defaults have no F4/F5 bindings. Terminal/OS interception and user/extension collisions remain possible.
- **Previously unrecorded user LIVE confirmation:** Linux Mint microphone capture and transcription worked. This supersedes earlier pending-recovery language below for that observed result; it does not establish the original hardware/backend cause or validate this new keyboard mapping. No new live test, inference, deployment, session restart or user-settings change was performed.

Validation for A: `npm run check` passed; full `npm test` **910 passed / 3 existing TUI compatibility skips / 0 failed (913 total)**; installed-native key/scroll/marker tests **307 passed / 0 skipped / 0 failed**. No LSP server configured. Initial validation exposed a test-only implicit type and disabled-voice fixture setup mistake; both were corrected before the clean full rerun. Logs: `/tmp/pi-voice-A-{check,test,native}.log`. Final integrated device-selection validation is recorded in `docs/testing.md`.

## Review follow-up — `88ee55b` / `faee523`

The earlier unconditional removal of `--raw` below was valid only for the tested
native PipeWire 1.0.5 writer, not newer libsndfile defaults (WAV/AU). Capability
probing now uses bounded help, without semver assumptions or grep-q/SIGPIPE false
negatives. It runs outside the admission fence; cancellation is rechecked before
capture. Advertised `--raw` is passed, old implicit raw otherwise. Probe failures
report an explicit error; recorder failures retain the no-decodable-audio diagnostic.
No monitor/server-local fallback was added.

Harness cleanup ignores repeated INT/TERM while disabling EXIT recursion, bounds
Podman diagnostics/removals, preserves failure status and touches only owned names
and temporary keys. Ticket reads now accumulate through newline with timeout/size/
EOF checks and preserve the socket plus extra bytes. Actual fragmented TCP tests
and six repeated-signal cleanup fixtures pass. New PipeWire families are explicitly
fixtures, with flag and full decoded PCM sample assertions, not a second real image.

Validation: real two-container SSH **12/12 passed twice**, actual PipeWire **1.0.5** /
PulseAudio **16.1**; final cleanup left no containers or run image tags and removed
its temporary keys. `npm run check` passed; `npm test`: **902 passed, 3 existing TUI
skips, 0 failed (905 total)**. LSP unavailable. Logs:
`/tmp/voice-ssh-review-final.log`, `/tmp/voice-review-full.log`. Only isolated test
resources were used; no hardware, host services/settings, live SSH/Pi, providers or
inference touched. Actual Mint microphone cause/recovery remains unknown.
`ISSUES.md` preserved. Local-desktop copy commands from this host checkout and
required wrapper restart **after verified capture stop** are in `docs/testing.md`;
no forced lease cleanup or deployment performed.

## Desktop SSH recovery — 2026-09-21, baseline `4965fce`

**New user evidence:** Linux Mint desktop, Alt+M decoding error before the microphone starts. This corrects the older unknown-OS note below, but does not identify the live backend/version, environment, permissions or hardware cause. `4965fce` was diagnostic-only.

**Proven startup defect:** Ubuntu 24.04 PipeWire **1.0.5** `pw-record --raw --format s16 --rate 16000 --channels 1 -` returns **1**, `unrecognized option '--raw'`, before connecting to a microphone. `-` already selects raw stdout. Removing only `--raw` permits the actual PipeWire synthetic source → production encoder → SSH reverse forwarding → production host decoder to return finite, nonzero-energy PCM (47,360 samples in the final run). PulseAudio **16.1** retains its supported `parec --raw`. No backend policy or protocol change was needed.

**Proven bridge/environment defect:** the previous `trap cleanup EXIT INT TERM` returns to the supervisor after TERM, allowing listeners to restart. The recovered change now exits and lets EXIT cleanup run once. A subprocess regression times out against baseline but exits cleanly with both listeners gone after the fix. A separate argv-sensitive real-ffmpeg regression fails baseline with no decodable audio. Both deliberately negative checks ran: **0 passed, 2 failed as expected** (`/tmp/pi-voice-recovery-before.log`). This is source/fixture evidence, not proof that a stale bridge caused the Mint report.

**Environment scope verified:** a freshly auto-launched bridge inherits the desktop's private `XDG_RUNTIME_DIR`, `PULSE_SERVER`, and session-bus environment; the server has neither those sockets nor hardware access. A second concurrent wrapper with a different, invalid `PULSE_SERVER` still captures from the first bridge's launch environment. That shared-session behavior is documented, not silently restarted or changed. After final-wrapper shutdown a new bridge sees its new environment. Invalid `PIPEWIRE_REMOTE` plus unavailable PulseAudio produces an error, not server-local capture. Selection remains PipeWire-first when its default source check succeeds; Pulse environment variables are not a global backend selector.

**Final real-SSH matrix: 12/12 passed, exit 0.** All use production wrapper, dynamic reverse forwards, v2 hello, ticket admission/cancel-before-record ACK, and real encoder/decoder. Cases: Pulse timer completion (66,560 samples), explicit Stop (33,280), Cancel (200 before cancellation); unavailable endpoint (ECONNREFUSED, zero samples); concurrent bridge environment drift (70,400); default monitor rejected (zero); Pulse server unavailable (zero); genuine PipeWire synthetic source (47,360); invalid audio-server environment (zero); injected finite PCM natural EOF (**240,000/240,000 samples**); injected empty recorder and startup exit 1 (both meaningful no-decodable-audio errors, zero samples). Counts for live synthetic streams depend on scheduling. The three injected recorder cases do not claim actual device failures. Server-local capture and player invocation are tripwires. This is not Pi UI/ASR inference, physical microphone, Android, or virtual playback validation; hello-only playback existed in the recovered harness. Existing Termux, stop-proof, SSH identity and strict router fixtures remain complementary, not relabeled container cases.

**Resource recovery/safety:** orphan servers `35ca2274984b`, `a3fa07c020b1`, `4801088c1f54` had exact interrupted harness names/images, no mounts, init PIDs 1849921/1851665/1853407 matching the reported sshd parents, and `/work/sshd_config`. Their original launch PIDs no longer existed. Removed only these and subsequent owned test-run leftovers. Discovered Podman's single multi-container removal could attempt the namespace server before its dependent client; cleanup now removes client then server, reports errors, and preserves test failure status. New containers have `io.pi-voice.ssh-desktop=<run-name>` labels. Intentional TERM interruption returned **124**, printed bounded synthetic-only diagnostics, and removed both containers. Final `podman ps -a` was empty. No user sshd/live SSH/Pi process, host audio/home/socket, runtime configuration, provider/model or private audio was touched.

Validation: `npm run check` passed; full `npm test` **872 passed / 3 existing TUI compatibility skips / 0 failed (875 total)**. No language server configured. Logs: `/tmp/pi-voice-recovery-{check,tests,final-ssh,interrupt}.log`; runnable commands and manual ownership-checked recovery in `docs/testing.md`. Earlier harness development runs failed while bringing up the isolated PipeWire graph (missing audiotestsrc SPA mapping); that test configuration is corrected, not counted as passing validation. Prior recovered Pulse/monitor/unavailable baseline passed before the production capture fix.

**Deployment:** copy all current `client/pi-voice-*` to the local Mint desktop; after confirmed recorder/player stop, close/reopen that device's voice wrappers when ready. No host sshd restart or deletion of proof/fence state. Host `/reload` alone cannot fix the client invocation. No live deployment was performed; user confirmation of actual Alt+M recovery remains required. `ISSUES.md` and historical evidence are preserved.

## Desktop SSH dictation investigation — baseline `6a5fe13`

LIVE report: PC-over-SSH dictation returns “Microphone audio decoding failed”; earlier phone ASR worked. **PC OS and actual live cause remain unconfirmed.** No hardware capture, provider/model calls, SSH probes, runtime changes, or live restarts performed.

Verified offline candidate: desktop `pw-record` startup failure (mock exit 1), or successful exit without PCM, feeds empty input to real ffmpeg. The encoder exits successfully with Ogg headers but no audio packets; the real host decoder fails, formerly producing only the generic error. Recorder stderr and pipeline status are discarded; the binary `stream` protocol has no trailing source-error frame. The host now reports **no decodable audio** with selected-recorder/access/tool checks, without retaining stderr or claiming a specific permission/device failure. Zero-sample WAV is also rejected rather than accepted solely on decoder exit 0; nonzero exits and partial float samples still fail closed.

`test/desktop-capture.test.ts` exercises actual desktop ticket/record/stop scripts through a loopback fake bridge, fake microphone and real encoder/decoder. Synthetic PCM decodes completely on natural EOF and explicit process-group stop; empty/failed sources reproduce the error. This does not prove every codec/version flushes correctly. `test/phone-input.test.ts` covers malformed and empty WAV rejection. Ticket ACK, cancellation, draft preservation, endpoint generation and routing logic are unchanged.

Source trace: desktop supports PipeWire/PulseAudio raw PCM → ffmpeg/Ogg, not SoX/arecord/native macOS. Termux records/tails Ogg and confirms stop before final-page drainage. Streaming is binary after `stream\n`, not base64; legacy `audio` responses are base64. SSH reverses the registered input port to the client listener; saved session pins can retain a different device. Wrapper metadata labels every non-Termux client `linux`, **not reliable OS identification**. Ask which PC OS and which device/input is selected before prescribing microphone/tool fixes. This diagnostic-only change needs a host extension reload to take effect; no phone/PC client script update is required, and no reload was performed.

Validation: TypeScript check and targeted desktop/phone/recorder-stop/client/routing/SSH/UI cancellation and stop-proof fixtures pass (UI mocks require `--experimental-test-module-mocks`). Live cause/fix remains pending user evidence.

## Current documentation audit — `d4cf759`, 2026-09-20

**New LIVE evidence supplied by the user:** the newest batch “seems fixed,” and native bottom-follow/banner behavior is confirmed. This supersedes earlier pending-live statements below; it is limited observed success, not proof across all hardware, transport failures or layouts. Earlier navigation, Jump-to-voice, ASR, fast-UI and flicker confirmations stand. Original EPIPE cause remains **UNOBSERVED**; real start latency remains **unmeasured**.

Audit scope: all **149 commits** in the 2026-09-13–2026-09-20 window (`3e66cb1`…`d4cf759`; no commits on September 13–16), plus relevant preceding routing/control/protocol history including September 12 `1ed15dc`. Compared actual current sources/callers and fixtures—not just messages—with README, **all 13 `docs/*.md`**, `pi-voice.example.json`, `src/config.ts` validation/defaults and command help. Example intentionally enables output; no schema/help/example code change needed.

| Commit range / representative changes | Documentation coverage reconciled |
| --- | --- |
| `3e66cb1`…`81131d1`, `eb9e9ca`, later input fixes | Usage: candidate evidence, manual edits, owned-preview rollback and Stop; configuration: live/final candidates |
| `a17782e`, `8c5a05b`…`a62a11d`, `9e59d32` | Preprocessing/cache: generator-independent identity, budget attempts, branch/fallback recovery, bounded variants, one-time identity v4 invalidation |
| `2b94c09`, `77638de`, `e060772`, `8e4638f` | Narration: numeric/dotted/markup boundaries; usage/cache: stable phase rows, real word counts, unknown coverage and explicit playback states |
| `ade0670`…`d4ce9c9` | Narration/usage: chronological live/completed cursor, sentence/message Tail, post-wrap glyph-stable highlighting, Jump-to-voice and native fallback limits |
| `61c7c41`, `ba72618`, `3d1ea03`, `4c07612` | Narration/cache/architecture: cancellation, next-request foreground priority, asynchronous preload and first prose before message end—not measured latency |
| `2aaffbf`…`83fd88c`, earlier protocol/routing history | Endpoint/devices/installation/troubleshooting: retained opaque proof, retry/error scope, pins, attention, old-client migration vs current host-only update |
| `b4ee633`…`d4cf759` | Narration/README/troubleshooting: exact automatic bottom adopts native End and clears banner; resize recheck, delayed return-tail intent, unchanged chronological cursor/manual/paused authority |
| Current config/worker/command implementations | Commands/config/environment/models: read-only queries, default 3 runtime workers and precedence, TTS-only identity, conversation privacy, runtime paths and alignment offline caveat |

**Other inaccuracies corrected:** F8 re-anchors before toggling pause; absent transport resumes from retained source units. Visible UI no longer exposes a `~`/clock-provenance label or old aggregate quality wording. Explicit local/non-auto-output routes bypass ordinary playback repinning. Termux names have separate platform metadata, and native hosting needs a compatible ONNX runtime. SSH argv/option and stale-lock guarantees are qualified; permission tests require actual stop confirmation. Detailed behavior stays in docs rather than growing README into a changelog.

**Remaining implementation/test limits, documented rather than fixed:** narrow-table reference-link URL probes can preserve the baseline without highlight/anchor mapping; lightweight speech parsing is not full CommonMark (link-label punctuation, nested URL parentheses, double-backtick spans, long/indented fences and four-digit list markers). Alignment does not honor `HF_HUB_OFFLINE`. Microphone stop-response accumulation lacks the recording size bound; Linux recorder shutdown waits for its pipeline shell, not independent descendant confirmation. Explicit description retry still uses historical scope. SSH stale-owner check/reclaim is not atomic. These are not newly diagnosed live incidents. Future inline main-model narration remains unimplemented. Native automatic-arrival and delayed-acquisition tests do not form a single natural cached-Markdown/reflow/acquisition end-to-end case.

**Validation:** `npm run check` passed. Final `npm test`: **865 passed, 3 skipped, 0 failed (868 total)**; installed-native checks: **306 passed, 0 skipped/failed** using an inert terminal and sanitized test environment. Two earlier audit full runs each reported **864 passed, 3 skipped, 1 failed** at `test/index-render-cost.test.ts:68` (two widget writes vs one); targeted rerun and final full run passed. Preserve this intermittent result; no source/test changes to mask it. Three standard skips are the older project TUI's MouseRegion/banner compatibility cases. Logs: `/tmp/pi-voice-doc-audit-{check,test,native}.log`. Local Markdown links/anchors and whitespace checked; LSP unavailable.

`git diff ade0670 d4cf759 -- client termux` is empty: **latest batch host update + `/reload` only**, not a promise that older bundled scripts never need upgrading. Outstanding protocol migration still requires matching scripts and preserved stop proof. No providers, real inference, hardware, live Pi/SSH/client restarts, runtime/user settings or private exports used. `ISSUES.md` remains untouched. Historical discussion/evidence below is retained verbatim except checkpoint labeling in PLAN.

## Pre-reload review corrections to `b4ee633`

- Automatic native-tail adoption now rechecks the 20–80% speech window on layout changes, using existing `lastNarrationLayout` and explicit `atTranscriptTail` intent rather than another flag. Explicit End still waits for document growth; paused/manual framing guards remain intact. Native arrival → small growth → viewport shrink reproduced word 299 above top 304 before the fix; the regression now requires top 297. Explicit End/banner resize retention is also tested.
- Bottom adoption no longer overwrites an already-true replay return-tail intent while speech ownership is pending. A gated coordinator acquisition test covers pending bottom framing → output growth → acquired playback → completion, including manual override. Before the fix completion stayed at 291 instead of restoring 360. Both new regressions failed against `b4ee633` (`/tmp/voice-review-before.log`) and pass with the correction.
- `npm run check` passed; `npm test`: **865 passed, 3 skipped, 0 failed (868 total)**, 60.01 s. The three skips remain the older project TUI's MouseRegion/banner cases. Installed-native command in `docs/testing.md`: **306 passed, no skips/failures**, 51.83 s. Logs: `/tmp/voice-review-check.log`, `/tmp/voice-review-full.log`, `/tmp/voice-review-native.log`. LSP unavailable; TypeScript and whitespace checks provide static validation.
- **Ready for user `/reload`**; actual live confirmation remains outstanding. No live/model/provider calls, session/client restarts or runtime settings changes. `ISSUES.md` untouched and excluded from the atomic commit; no client recopy or SSH reconnect required.

## Native automatic-bottom handoff — interrupted fix completed

- **User LIVE positive/new defect:** Voice follow reaches the actual bottom, but native “Jump to latest” can remain visible/end-follow inactive. Earlier positive windowed-follow, navigation, Jump-to-voice and flicker feedback remains valid; no live confirmation of this new fix is claimed.
- Read and retained the interrupted production/test changes. The shared auto-scroll path previously returned immediately for an in-band word, even at exact maximum scroll with native follow suppressed. It now reconciles that arrival through the existing `frameNarrationViewport` / native `scrollTo` state transition, which clears suppression and lets Pi hide its own banner. Automatic actual-bottom arrival also records the existing pin height/final-tail intent, so growth is not mistaken for manual scrolling and can restore the 20–80% speech window. No proximity-based jump, native banner patch, chronological Tail action, audio regeneration or pause-state toggle.
- Native regressions cover initial clamped framing, ongoing arrival at short/tall viewport heights, an in-band word one row before bottom (no jump), suppressed follow at exact bottom, subsequent small/large output growth, completion restoration, and unchanged pause/back cursor behavior. Existing wheel/PageDown/scrollbar manual-bottom tests still prevent Voice reclamation; paused native tests now inject background alignment/ticks and assert frozen highlight, position and end-follow state. Existing F6/F10/F7/F9 and real Jump-to-voice dispatch remain covered.
- `npm run check`: passed. `npm test`: **863 passed, 3 skipped, 0 failed (866 total)**, 61.29 s. Skips are the older project TUI's two MouseRegion cases and native banner. Installed-native command from `docs/testing.md` (both native test files): **305 passed, 0 skipped/failed**, 49.54 s. Logs: `/tmp/pi-voice-tail-check.log`, `/tmp/pi-voice-tail-full.log`, `/tmp/pi-voice-tail-native.log`. LSP status/diagnostics report no configured server; typecheck is the static validation.
- **Ready for user `/reload`**, no client recopy or SSH restart/reconnect needed. No live session changes, application-provider calls, real inference, settings changes or transcript reads/exports. `ISSUES.md` preserved and excluded from staging. Live banner/follow behavior remains for the user to confirm after reload.

## Final reconciliation against `d4ce9c9` — newest batch offline only

This entry supersedes older current-status claims without deleting discussion or incident evidence. User LIVE confirmations already include working windowed follow, paused/unpaused navigation, intuitive ASR alternatives, much faster UI and fixed flicker. The newest implementation batch has **not** been live-tested; do not extend those earlier confirmations to it.

### Agreed behavior and inspected implementation

- `src/index.ts` navigation (`previewHistoricalTarget`, `stepSentence`, `followTranscriptTail`, `playTarget`) now shares chronological live/completed targets. F6/F10 step messages, F7/F9 step source sentences/newlines, filtered by mode and actual content-block order, never terminal wraps. Back from playback Tail selects the final message/unit. Tail preserves pause/play intent: it retires historical transport/preparation but continues an active source from the captured boundary, retaining unfinished units/future deltas and respecting already-closed blocks. Alt+T/native bottom changes viewport follow only, not the playback cursor. Rapid mixed navigation, cancellation ACK waits, explicit F11 resume, preview context and canonical source finalization are covered by `test/index-navigation-preview.test.ts`; paused navigation remains silent, playing navigation continues.
- `src/narration-render.ts` paints native post-wrap baseline rows, caches up to two leaf layouts, and preserves them through native rebuilds and word ticks. `src/narration-progress.ts` maps normalized Markdown back to original source offsets, including table cell spans/escaped pipes, nested syntax, inline atoms and graphemes. Active background clips on each rendered line without moving baseline glyphs or losing native syntax. Real MouseRegion dispatch in installed-native tests exercises Jump to voice location while paused/playing: re-arm follow, frame at 20%, do not resume or change keyboard focus; later manual scrolling wins. Unmappable probes leave the exact styled/padded baseline unchanged rather than corrupting layout. **Remaining limit:** narrow tables with reference-link URL output can be unmappable, so highlight/anchor coverage is not universal. Identical assistant source bodies also retain the earlier text-identity limitation.
- `test/index-transcript.test.ts` asserts `Preceding prose.` reaches the mocked worker on streaming deltas **before `message_end`**, while conversation-mode code waits for next-fence/message-end context and later speech stays ordered. That is control-flow evidence, not milliseconds-to-audible-speech measurement. `test/worker-preload.test.ts` verifies playback before aggregate warm-up readiness; `preload-ready` is request-only and cannot reset speaking state. `test/index-description-priority.test.ts` verifies foreground priority over the next historical request. `test/description-cancellation.test.ts` covers sole/shared consumers and queued lease cancellation: only the last consumer leaving aborts shared work. Already-running provider work need not instantly free its slot. No real provider/model or device latency was measured.
- **Original EPIPE cause: UNOBSERVED.** Source and mocked transport tests establish retained original endpoint/opaque stream handles, exact completion/stop receipt scope, bounded local cleanup and same-client retry after helper/worker loss. They do not establish why the user's connection failed. EOF, elapsed time or killing a host process is never remote stop proof. `test/index-stop-proof.test.ts` verifies per-input/output error episodes: each independently notifies/deduplicates and only matching confirmed cleanup resets it; stale proof cannot clear newer failures. No fake success or unsafe lease deletion.

### Fresh validation and deployment scope

Source checkpoint history reported **822**, then **858 passing / 3 skipped**. This documentation-only pass reran against `d4ce9c9`:

- `npm run check`: passed; no configured LSP server.
- `npm test`: **858 passed, 3 skipped, 0 failed; 861 total** (55.34 s). Skips: two native MouseRegion button cases and the native banner, unsupported by the project dependency.
- Installed global Pi TUI, `test/index-native-scroll.test.ts` plus `test/narration-marker-native.test.ts`: **300 passed, 0 skipped, 0 failed** (46.22 s), including real native button dispatch and banner, with an inert terminal. `PI_VOICE_TEST_TUI_MODULE=/home/curiosithy/.nvm/versions/node/v26.7.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js`. Logs: `/tmp/pi-voice-finaldocs-check.log`, `/tmp/pi-voice-finaldocs-test.log`, `/tmp/pi-voice-finaldocs-native.log`.
- `git diff ade0670 d4ce9c9 -- client termux` is empty. **This batch needs host update + `/reload` only**, not client recopy, SSH/wrapper restart or routine `/voice reconnect`. Earlier migration requirements remain applicable to installations that never completed them; restore the original connection and retry if stop proof is outstanding.
- No source/test writes, fixture fixes, live/client/session/settings changes, provider calls or real inference. `ISSUES.md` and historical discussion preserved. Remaining operator checks: newest live-stream navigation/Tail in both pause states, native click/manual-follow behavior, real wrapping and perceived startup. Physical buffers, disconnect causality and real model/device latency remain unproven.

## Authorized current-session inspection — saved contamination confirmed, live geometry unobserved

- **Identification: high confidence.** The tool's `PI_SESSION_ID` belongs to the ephemeral delegated agent, not the interactive parent. Process ancestry identifies the parent Pi with cwd `/home/curiosithy/code/pi`; its single matching coordinator presence was interactive and 0.8 seconds old. Presence session ID and the saved JSONL header agree on identity/cwd. Only that session's bodies were inspected; no transcript export or session-manager load/migration. Other candidate files in that cwd were checked by header only.
- **On-disk proof (19,411-entry snapshot):** literal legacy signature `U+2063 U+200B U+2063 U+200C U+2063` occurs seven times in message text: four at tool-result entry 9035, two at tool-result entry 9131, one at user entry 18042 (1-based JSONL lines). None has the new 96-codepoint scoped prefix. The user occurrence is in block 0, line 1 of a four-line message: quoted first line, unquoted continuation, blank line, separate prose. This proves a legacy token in saved quoted user text; it does not establish which assistant rendering was copied.
- **Anchor association:** original user anchor is entry 17996, block 0, one text line, with no marker. Contaminated user entry 18042 follows by 46 entries: one assistant message, 42 timing custom entries and two device-selection custom entries intervene. The later anchor reference at entry 19398 has no marker. All three lie on the last persisted entry's ancestry; that does not establish the live UI's selected leaf or rendered document after compaction.
- **Source/timing, not selected-target proof:** preceding nonempty assistant entry 17992 has one seven-line text block, no fenced code/legacy marker, and no duplicate exact assistant body in this saved file. It has 65 version-3 timing snapshots under two distinct render keys; the latest has 53 estimated checkpoints. There is no saved playback-selection/viewport record establishing this as the target at failure. File-wide timing counts: 7,529 entries (214 schema-v1, 1,275 v2, 6,040 v3), 1,069 distinct target IDs. V1 lacks `renderKey`; the other 7,315 have lowercase 64-hex keys. Common fields are `version`, `messageId`, `duration`, `checkpoints`; later schemas add `renderKey`. The hash does not expose render-identity version 3 versus 4 or prove compatibility with current settings. No cache change is warranted by these aggregates.
- **Read-only dimensions:** `TIOCGWINSZ` on the parent Pi's actual PTY reports 120 columns × 50 rows at inspection. This is current kernel terminal size, not incident-time dimensions or the live app's in-memory `viewportHeight`, scroll position, selected source, editor/footer allocation, or marker layout. Those are not recoverable from this JSONL; live causality remains unproven.
- **Minimal regression extension:** replaced conversation wording in `test/narration-marker-native.test.ts` with synthetic four-line, single-token quoted history and a synthetic preceding label request; added 120-column coverage. Added a cache-enabled 120×50 native viewport case, retaining the existing 24/32/52 height changes, 45 checkpoints, chrome changes, manual override, paused navigation and replay. Existing live-delta/finalization/selection tests cover source changes. Global suffix lookup still demonstrably chooses old history; `ec68eb4`'s full scoped token chooses only the current target. No production code change.
- **Validation:** `npm run check`; focused native/source-lifecycle checks passed (one old-dependency banner skip); full `npm test`: **514 passed, 1 dependency-banner skip, 0 failed (515 total)**; installed native TUI **16/16 passed**. Logs: `/tmp/voice-current-session-focused.log`, `/tmp/voice-current-session-full.log`, `/tmp/voice-current-session-installed-native.log`. No LSP configured. Session/settings/coordinator/playback were not written; no hardware, inference/provider calls, runtime changes or restarts. `ISSUES.md` preserved. **User `/reload` remains ready; no SSH restart needed.**

## Latest viewport handoff — selection-scoped marker integration

**User version correction:** the reported failing session was **pre-`5882cff`**. The older wording below about recovery and restart must not be read as confirmation that `5882cff` was loaded or failed. The user was asked to WAIT before reload while this atomic integration was unfinished; validation is now complete and the user can reload. No live reload was performed by the implementation.

**Proven quoted-marker path:** raw copied text can contain the legacy invisible marker, including the quoted `494 tests passed; native-TUI checks 10/10. Run /reload...` report. A full native-document `findIndex` on that static marker selects an earlier quotation rather than the newly narrated assistant. `test/narration-marker-native.test.ts` demonstrates this ordering at widths 28/100, including raw markers inside selected source and repeated copied selections. This is an offline demonstrated defect, **not proof of the cause of the user's live viewport incident**.

**Fix:** `NarrationProgress.activeMarker` is a fresh zero-width identity per `begin()`/completed selection. The transform and both index lookup paths use the full identity, and the absolute message-top cache includes it. The static suffix remains for source compatibility, never as the runtime lookup key. User/tool quotations and legacy source bytes are not stripped; UTF-16 offsets are unchanged. Live deltas, pause, and canonical source finalization preserve the identity; paused navigation/new selection/replay refresh it. The helper plus integration ship together, with existing synthetic scroll fixtures rendering actual host markers rather than forging static ones.

**Native coverage:** actual TuiAltScreen/ScrollView/VStack/Markdown, 1,500 history rows, 28/100 columns and 24/32/40/52 screen rows, separate editor/progress/footer height changes. Checks require the actual spoken target visible, initial/explicit 20% positioning clamped at both ends, ongoing 20–80%, manual override surviving layout changes, synchronous silent paused navigation, replay, tail intent, native search/drag and banner behavior. Old user/tool marker quotations remain present and cannot win selection. Live/source-finalization regression checks marker lifecycle and byte-identical raw quoted source. Identical source blocks still match by text/type, so this does not claim unique session-message matching for duplicate assistant bodies.

**Cache work already done in `9e59d32`:** exact saved render identities remain lazily recoverable after fallback description resolution and bounded variant eviction; sibling-branch entries are reusable only for current target IDs with matching identities. Recovery checks saved timing before measuring/appending again. No duplicate cache implementation in this change. The prior sentence-boundary render identity **3→4 bump intentionally invalidates timing once**, including unchanged plain prose; this is distinct from repeated fallback recovery. Compatible subsequent version-4 restarts reuse saved timing.

**Latest validation:** typecheck passed; full standard `npm test` **512 passed, 1 dependency-banner skip, 0 failed (513 total)**, 42.5s, `/tmp/voice-marker-final-full.log`; installed native TUI **14/14 passed**, `/tmp/voice-marker-installed-native.log`. The previously reported concurrent cache-test timeout did not recur in full runs; no deterministic cache-test fix or test-runner change was needed. During fixture development the new native test rerendered source per history line and retained mock style/worker histories, producing heap exhaustion; those test-only issues were removed, all 45 checkpoints retained, and the full runner then passed. No configured LSP; whitespace check clean. No application-provider/model calls, inference, live process/SSH/client restarts, runtime settings changes, or private exports. `ISSUES.md` untouched. **Ready for user reload; live confirmation remains outstanding.**

## Viewport follow-up — reproduced narrow-width drift, LIVE cause not yet established

**User-observed:** LIVE playback still pins narrated text out of view after timing recovery completed and a Pi restart. Neither recovery work nor an unrestarted session explains away this report.

**Exact offline reproduction:** `test/index-native-scroll.test.ts`, `native viewport: narrow cached`, uses native TuiAltScreen/ScrollView/VStack/Markdown with an inert 28×40 terminal, 1,500 preceding history rows, 60 prose sentences and 100 following rows. Unlike previous native cases, the real message-anchor cache stays enabled. Synthetic two-second sentence audio events advance playback without inference/audio. Footer/editor height starts at eight rows, gains one at checkpoint 12 (timing-row simulation), then five at checkpoint 24 (multiline editor simulation). Before the fix the 20–80% assertion fails at checkpoint 11: marker 1522, scrollTop 1494, viewportHeight 32. Temporarily relaxing that assertion to mere visibility reproduces **offscreen** playback on the installed TUI at checkpoint 35: marker 1570, scrollTop 1543, viewportHeight 26 (visible rows 1543–1568). The committed test retains the stricter band assertion.

**Reproduced cause and minimal fix:** `requestNarrationAutoScroll` rendered the full native document at terminal width but rendered local cached marker offsets at `Math.max(40, contentWidth)`. Initial absolute anchoring was correct; later word deltas used different wrapping and drifted. Use the actual content width (minimum one, matching native layout). No forced render, cache removal, provider work or timing changes. The regression now passes through 45 checkpoints, dynamic heights, manual wheel override followed by another layout change, and immediate silent paused navigation.

**Native/source coordinate investigation:**
- Native `ScrollView.render(width)` returns the **whole child document**, not the viewport slice; its marker index is document-relative. `layout.js` lays out at `getContentWidth(width)`, updates content/viewport heights, then translates the child by `-scrollTop`. Editor/footer VStack rows reduce viewport height rather than becoming document rows. Thus subtracting footer height from the document marker would be wrong. The one-row addition in `e060772` changes available height, but the reproduction does not require active preprocessing; width drift returns even after height-triggered cache invalidation.
- Existing layout keys include width, content height and viewport height; the new test exercises height invalidation with cache enabled. It does not prove every same-total-height content replacement or asynchronous live layout sequence correct. The `a5cb7b8` gesture adapter is unchanged: installed native forced-render search, deferred drag, manual bottom landings, End/banner and tail restoration all still pass.
- Source identity remains a limitation of the existing path: NarrationProgress matches Markdown by text/type (thinking also uses displayOffset), not session-message ID; the adapter takes the first full-document marker. Identical source blocks could therefore be ambiguous. Native assistant rendering trims text, groups adjacent thinking blocks and supports configurable output padding, whereas local anchor Markdown uses padding one and assistant type. Thinking without a local marker falls back to the full document; code descriptions inject their own markers. These are source-inspection limits, **not a reproduced diagnosis of the user's target**, and this small width fix does not claim to resolve them. No speculative last-marker selection or API change was made.

Validation: `npm run check` passed; full `npm test` **507 passed, 1 known native-banner dependency skip, 0 failed (508 total)**, log `/tmp/pi-voice-viewport-tests.log`; installed native TUI **11/11 passed**, including native banner. No language server configured. `git diff --check` passed. All fixtures are synthetic; no live clients/SSH/settings/restarts, real inference, application-provider calls or private exports. `ISSUES.md` preserved. Remaining live isolation needs terminal columns/rows, whether the target is prose/thinking/code or repeated text, and whether failure starts at explicit preview or only later words, ideally a nonprivate minimal reproduction.

## Latest UX — explicit word counts, playback state, formatted sentence boundaries

**New LIVE positive evidence from the user:** paused and unpaused navigation work; flicker is gone. Preserve the proven follow/progress behavior. This implementation was tested offline, not reloaded into those live sessions.

- Counts now say `Word timing: 1/3 estimated` on their own row (fully refined: `0/3 estimated`). The denominator is actual applicable source words in the selected record's timed units, including a selected suffix—not messages, sparse navigation checkpoints, or an inferred count from aggregate quality. Count before the 0.4-second navigation thinning and first-word exclusion. Unknown provenance, registered-but-untimed units and sparse-only restored/recovered snapshots show `Word timing: unknown/pending`; code-description coordinates are excluded because they are not Markdown source words. Compatible in-memory variants retain counts. Newly arriving words may change the denominator; no claim of full future streaming coverage.
- Alignment updates remain metadata-only while paused. A native 32-column probe found `1000/1000` → `0/1000` could remove a wrapped row; non-breaking leading count padding now preserves the count token width for a fixed denominator. Widths 20/32/40 are covered. Unknown→known or growing totals can still legitimately change wrapped height; no background-row clearing/reinsertion or forced render was introduced. Input → playback → descriptions → timing precedence remains intact.
- Startup and missing-timing branches share explicit `○ Idle`, `◷ Waiting`, `⏯ Paused`, `▶ Playing` labels. Selection alone is not playing. Removed the clock estimate from this compact widget rather than implying that it establishes word refinement.
- **Reproduced sentence root:** plain `494 tests passed; native-TUI checks 10/10. Run /reload, then test paused navigation after manually scrolling away and watch the timing row for flicker.` already split correctly. The shared regex did not accept Markdown emphasis closers or copied narration markers between punctuation and whitespace. Formatted text therefore merged the sentences, including streamed delta splits. Both prose navigation (`PlaybackHistory` → `SpeakableStream`) and code navigation (`chunkCodeNarration` → `findSentenceCut`) consume the same boundaries; no separate digit-before-dot navigation heuristic exists. Closers/markers are now accepted; line-start ordered prefixes remain attached, abbreviations/backticks remain guarded, decimal/version dots between digits remain unsplit, and lowercase continuations require no capitalization wait. Tests assert UTF-16 source offsets and every split of the formatted report.
- Spoken unit boundaries genuinely changed, so narration render identity advances v3→v4 to reject stale timing restores. Description identities and independent audio-cache content keys are unchanged.
- Validation: `npm run check`; full suite **506 passed, 1 native-banner compatibility skip (507 total)**; installed native TUI **10/10 passed**; `git diff --check`. Logs `/tmp/pi-voice-ux-final-tests.log`, `/tmp/pi-voice-ux-native.log`. LSP unavailable. No provider/model/hardware calls, configuration changes, live reloads/restarts, or transcript exports. `ISSUES.md` preserved untracked.

## Live UX follow-up — native follow, stable progress and quality provenance

Implemented in `aa0aa40` (quality), `b588661` (follow), `8e4638f` (progress).

**LIVE evidence supplied by the user:** second-pass ASR is intuitive; UI is much faster; restart cache checks are instant; Stop/draft cancellation is not currently reproducible. Keep confirmed explicit `/voice attention` play. The accidental Escape is not crash evidence. No new cross-project attention behavior was implemented.

### Root causes established by source and regressions

- **Follow:** `flushNarrationRender()` called `requestRender(true)`. Native `TUI.requestRender` invokes `TuiAltScreen.resetRenderState`, which clears `currentLayout`; `getPrimaryScrollView()` then returns the implicit fallback instead of Pi's real primary transcript view. The immediate auto-scroll request observes that wrong geometry as manual movement and cancels freshly armed follow. A fake requestRender no-op could not reproduce this. Use ordinary requested rendering after targeted Markdown invalidation. Native input observation reuses existing manual-follow state, so programmatic layout movement cannot cancel it. ⏯ now frames on pause as well as resume, before asynchronous microphone/device work; later browsing still wins. Regression uses an actual explicit primary ScrollView and unmodified native requestRender, plus real wheel/End/banner dispatch. Existing final-next/tail restoration regressions remain passing.
- **Blinking:** background phase/finally callbacks synchronously rebuilt the unified widget, and job/batch settlement cleared its rows before adjacent preparation produced replacement content. Retain the last displayed description/timing values while their batch promises remain active, replace background content on the existing 80 ms cadence, and clear once settled. First status and input/playback are immediate; ordering, cancellation and teardown stay intact. The integration test invokes actual `InteractiveMode.setExtensionWidget`/widget-container rendering with inert UI, checking constant row count through three adjacent jobs (including a fast middle job), then a single settled clear. Transient sub-frame phases are coalesced, not separately flashed.
- **Quality, not work:** background recovery explicitly generates duration-weighted word estimates; bounded/partial playback alignment can legitimately remain mixed. `PlaybackHistory.status()` aggregates the selected record, including saved units, not all session messages. Found a distinct stale-metadata defect: `setTimingQuality()` located complete saved checkpoints by regenerated playback time, unlike word-checkpoint refinement's source/ordinal lookup. A saved second sentence at 5.0 s replayed at 4.8 s left the old estimated checkpoint alongside the refined unit, producing mixed quality even after successful alignment. Use saved source offset/sentence ordinal for complete records; regression verifies mixed before the alignment event, refined only afterward, and the corrected snapshot after restart. UI now says **word timing quality**; new previews also reset the previous transport-clock estimate. This proves a possible stale-label cause, not that it caused the user's particular live label or that every played message should become CTC-refined.

### Pre-reload native-follow review correction

Synchronous input comparison missed search reveal during render and selection autoscroll on its native timer. The shared adapter now observes `refreshSearch`'s actual-move result (including forced-render layout resets) and timer-driven selection movement as well as input-driven movement. Explicit native End/banner calls have their own intent counter: PageDown, wheel and scrollbar moves landing at bottom suspend narration follow even when native `isFollowingEnd` becomes true. Arbitrary layout/programmatic movement remains excluded. All six new native regressions fail against the pre-fix source; installed native search, forced-render search, timed selection drag and all three bottom-landing cases pass with the fix. Existing paused navigation, immediate controls, End/banner restoration and timing-batch checks remain passing.

### Boundaries and verification

`/voice stop` requires a command at the beginning of the editor; nonempty-draft ergonomics remain an acknowledged gap. No invented shortcut, Escape binding or draft discard; explicit playback still finishes microphone capture. No live clients/settings/SSH/session restarts, provider/inference calls or private exports. Untracked `ISSUES.md` preserved.

No LSP server configured. `npm run check` passed; `npm test`: **494 passed, 1 known native-banner compatibility skip, 0 failures (495 total)**. Installed Pi native TUI: **10/10 passed, no skips**, using an inert terminal, no live session. Whitespace check passed. Logs: `/tmp/voice-full-test.log`, `/tmp/voice-installed-native.log`; pre-fix reproduction: `/tmp/voice-native-before.log`. Still require user LIVE validation of cold/manual/paused follow and batch visual comfort; physical device and real-model alignment accuracy are not established by these tests.

## UX follow-up — fast `0/605` restart counter (`5b11e76`; source + synthetic evidence)

**User correction:** the counter is fast and alignment looks good. Do not treat restart or a reset counter as evidence of cache loss/regeneration. This is a newly authorized UX task; prior playback, draft ownership, stop-proof and manual-scroll agreements remain in force.

### What the old counter actually counted

1. `session_start` restores validated descriptions from `pi-voice.code-description` entries (`getEntries`), prepares eligible target identities, synchronizes playback records, then restores version-3 `pi-voice.playback-timing` entries from the active branch. Targets use the transcript entry ID plus a content-index suffix for later blocks. None of these checks performs synthesis or alignment.
2. `scheduleMissingTimings` prepares/synchronizes again, filters the configured historical scope, and tests `hasCompleteTimingFor`. **Only a nonempty missing list produced the former “Speech timing … ready” counter.** It started at total minus missing and incremented after a complete recovered snapshot was restored/persisted. Thus the old `0/605` label was not emitted by a pure snapshot-validation loop. Its denominator also included out-of-scope targets; the new recovery denominator uses eligible scoped targets.
3. Each recovery lane resolves the spoken text/code plan, reuses compatible retained timing units, and calls `measureSegment` only for missing units. In the real worker, a readable Opus hit is decoded with ffmpeg, then duration is PCM sample count / sample rate: **no Kokoro inference**. A miss uses Kokoro, optionally writes/decodes Opus, then measures it. Background prose word checkpoints are duration-weighted **estimates**, not Wav2Vec2 forced alignment. Playback alignment is a separate path and can preserve/refine quality in saved checkpoints.
4. Timing identity hashes version, source, TTS model/dtype, voice, speed, narration mode, PCM/Opus representation/bitrate and actual spoken code-plan dependencies. Description identity hashes source/context and narration/prompt version, not the chosen editing model; legacy aliases remain guarded. Current records survive the bounded historical-variant pool trimming. Old/incompatible identities, unavailable maps or unresolved descriptions can require recovery; none was established as the user's live cause.

**Conclusion:** the source establishes exactly what the counter measures, not which cache branches ran in that historical live session. Fast recovery can be cached decode/measurement or retained-unit reuse; speed alone cannot prove that, synthesis, or cache loss. No persistence/compatibility fix was justified or applied.

### UX and checks

- Existing progress widget now distinguishes `↺ Checking saved timing · 109/605 targets checked` from `↺ Recovering speech timing · 109/605 targets ready · decoding cached audio: 2`. Active-lane counts also name waiting slots, preparation, retained-unit restore, speech generation and word estimates. Description targets are **processed**, not falsely all “ready” after omissions. Failed measurements remain incomplete and produce one batch recovery notice.
- Audited widget/footer, input phases, notices/errors, setter confirmations, read-only queries, grouped status/help, and inline retry callouts. Native Pi theme/severity stays authoritative; no extra severity icons or ANSI. Symbols supplement words, microphone hints use effective bindings, and progress drops percentages/decimal elapsed seconds. Paused/waiting/stopping/blocked states and retained-ownership recovery are explicit. Termux actions remain 🎙/↺/⏯/⏮/⏭/↶/↷, Alt+V and Alt+T.
- Synthetic fresh-host test serializes/restores 605 targets with seven conversation-context descriptions and one refined-timing fixture. Cold setup uses **7 mocked provider calls and 612 mocked measurements**; compatible restart (including a different editing model) uses **0 provider, 0 measurement, 0 playback/synthesis dispatch, 0 alignment calls**, while invoking snapshot restoration. Speed change correctly requires 612 new measurements, reuses descriptions, and displays synthesis when the mocked worker reports it. A failed follow-up pass persists no successful maps and reports 605 failures once.
- Separate real-worker control-flow fixtures use synthetic PCM and mocked ffmpeg/Kokoro: one cache hit decodes once without generation; one uncached request generates once; neither enters alignment or physical playback. Worker-client progress is request-scoped and ignores completed/cancelled requests. Message tests retain native severity, readable text without glyphs/theme, narrow monospace wrapping, query immutability and status precedence.
- `npm run check`, `npm test`: **485 passed, 1 skipped, 0 failed** (486 total); `git diff --check` passed. The known skip targets a newer native TUI banner API than the project dependency provides. No LSP server is configured. Final suite log: `/tmp/voice-ux-final.log`. No live run was restarted or claimed confirmed by mocks; no paid calls, inference, runtime configuration changes, hardware use or transcript dumps. Untracked `ISSUES.md` remains untouched.

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
