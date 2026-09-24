# Pi Voice — implemented agreements and live-validation handoff

## Current checkpoint — phase 2 and durable recovery (offline)

- Phase 2 points **1–6 plus handoff/off presentation are implemented**, validated offline: Queued for incomplete/resource-blocked narration; neutral unknown-total bars with reliable elapsed time only; one foreground source for phase/time/message index; stable mounted progress widget with content updates and no reserved blank rows when off; responsive status/time/device layout; lease-free live intent through normal prompt submission and temporary-to-persisted source IDs. Unread ownership-blocked output is Queued, never live. Handoff shows Connecting, then intentional Paused or genuine Idle; opening/cancelling the picker is read-only.
- **Phase 1 remains partial, with a narrower remaining gap:** original saved remote input/output scopes now have durable retries, reconstructed diagnostics and scoped receipts. Explicit `/voice reconnect` retries saved scopes for the original device identity, not a replacement selection. **Durable admission/local-child proof coverage is still missing; the orphan fence is never automatically reclaimed, even if all saved receipts succeed.** The broader proof/admission protocol is separate work, not an unsafe unblock. Restart, missing journal, expired heartbeat and receipt success for only saved scopes cannot establish complete stop proof.
- **Phase 3 timing commands are next and approved, not implemented.** Current `/voice timing` and `/voice timing-preprocess [auto|<1..8>]` remain unchanged; proposed `timing workers`/`timing retry` and removal of the old command are not available yet.
- Final implementation validation: typecheck passed; full checkout **1015 passed / 33 compatibility skips / zero failures**; full installed-native **1048 passed / zero skips or failures**. Logs: `/tmp/phase2-final2-{check,test,native}.log`. Final regressions also cover persisted user-entry ordering and paused yield-mode A→B selection. Earlier repeated cold-history performance failures also reproduced on baseline; the minimal fix uses bounded background yields and avoids synchronous cold preparation during progress rendering. No performance limits were relaxed. See [testing](docs/testing.md).
- User clarified that the previous PC crash was user-caused, not product-attributed, and explicitly removed `docs/assets/demo*`; leave those assets removed. This supersedes the earlier unknown-cause preservation note without erasing it. `ISSUES.md` remains untracked/untouched.
- Topic commits: `2dddb0a` (durable scoped recovery), `8ef1dd7` (phase 2 display/live coherence). No push, live/hardware/provider/inference work, runtime configuration/private-data access, or Pi/SSH/client/session restart. Offline evidence does not prove the original random live-disappearance cause or universal recovery.

## Historical phase 1 checkpoint — highlighting and stop safety (partial)

- User authorized the complete discussion after the USERPC crash; this implementation is restricted to phase 1. The historical “no implementation yet” statements below describe the earlier discussion, not current authorization.
- Highlighting implemented: native intensity resets and recreated Markdown leaves no longer remove narration paint; streamed/final native AssistantMessage frames assert effective first/continuation-line styling with audio independently active. Syntax/layout/markers/manual-scroll and unmappable fallback remain covered.
- Queue safety implemented: failure of any current queued utterance cancels the queue; matching paused-source abort/error cannot be revived by F8, including after reconnect/device adoption. Retired ordinary errors and unrelated historical selection remain separate. Newer stop uncertainty blocks older cleanup from releasing ownership.
- Retained input/output diagnostics now identify the blocking device and recovery action, survive Ready/Idle, coalesce reconnect notices and clear only on matching proof. Original-handle retries and ambiguous selection are mock-tested. Durable speech fences now survive heartbeat expiry/process death rather than treating either as proof.
- **Phase 1 is not fully complete:** process restart still loses in-memory opaque cleanup handles and diagnostic episodes. The durable fence prevents unsafe acquisition but does not provide automatic recovery or reconstructed warning UI after restart. Do not delete the fence or restart Pi as a recovery shortcut. This remaining persistence/recovery work needs completion before claiming the whole C contract.
- Phase 2 UI points 1–6, handoff presentation and timing command/retry changes remain pending; none were implemented here.
- Validation: typecheck; checkout **994 passed / 33 compatibility skips**; installed-native full suite **1027 passed / zero skips**, no failures. Actual native rendering, synthetic events and mocked transport only; no live/provider/hardware/restart validation. See FINDINGS and docs/testing.md.
- `ISSUES.md` remains untracked/untouched. The initially untracked `docs/assets/demos/` directory is now absent; review found no deletion in the diff or inspected test cleanup, but the cause is unproven. Preservation cannot honestly be claimed for those missing assets.

## Approved discussion — display coherence and timing retry (historical pre-implementation notes)

- Work is being approved point by point; the audit is not blanket authorization to implement all findings.
- Point 1 approved: use Queued for active narration awaiting complete source/context or ownership/resources; retain genuine Idle, explicit Paused precedence, and unpaused chronological Playing/live. Display changes must not force incomplete synthesis or acquire ownership early. Implementation pending.
- Timing command unification approved: `/voice timing` reports quality, latency and worker limits; `/voice timing workers` queries concurrency; `/voice timing workers auto|<1..8>` sets it; `/voice timing retry current|all|<min>-<max>|<message-id>` silently retries estimated alignment for the selected message, all eligible messages in the current session branch, an inclusive 1-based displayed playback-message range, or an exact stable message ID. Resolve and snapshot targets when invoked; reject invalid/out-of-bounds ranges and unknown/ambiguous IDs rather than guessing. Remove the old `/voice timing-preprocess` command from parsing, help, autocomplete and active docs, with NO deprecated alias: the user explicitly permits this CLI compatibility break. Keep the underlying configuration setting unless a separate migration is approved. Implementation pending.
- Silent retry scope: use cached audio, preserve already-refined timing and playing/paused state, selection, highlight position, viewport and drafts. Never start audible playback; report improvements, still-estimated portions and missing cached audio rather than silently regenerating speech. Bound work even for an explicit `all`/range batch, yield to active playback, and let Stop cancel remaining retry work. Whole-session retry runs only on explicit `all`, never automatically. This is an approved requirement, not an available command.
- Current workaround: optionally `/voice setup`, then select a message and replay with F5 to attempt alignment again; `/voice timing` reports results. Refinement is not guaranteed. Background timing recovery produces estimates, not forced alignment.
- Point 2 approved: unknown totals use a neutral bar without a false zero-position marker; streaming/incomplete totals show reliable elapsed time only, not a completion fraction. Complete totals show normal progress and elapsed/total. Unpaused caught-up live shows red `● live` instead of time. Never substitute the previous message's clock for unavailable current timing. Implementation pending.
- Point 3 approved: derive status, timing and message index from one consistent playback context. While A plays, describe A regardless of preparation for B. After A finishes and playback awaits B, describe B's preparation with its own timing or unknown timing. Paused selection and position remain stable. Implementation pending.
- Point 4 approved: keep widgets mounted in a consistent order and update their contents without removal/reinsertion. Show/hide controls only when availability actually changes; do not reserve unnecessary blank rows. This addresses reproduced row movement, not a proven cause of the original disappearance. Implementation pending.
- Point 5 approved: retain status, time/live and right-aligned `[🎧:device]`; shrink the bar on narrow terminals, shorten message numbering to `671/671` and omit it if necessary. Truncate long names while retaining emoji/brackets; prefer one row where feasible and no shortcut hints. Implementation pending.
- New highlighting TODOs, to implement only after the point-by-point discussion: highest priority is retaining dimming/highlighting after the final model render while audio still plays; second is eliminating dimming/native-color flicker during streaming. Preserve syntax colors, layout and manual scrolling. These are user-reported symptoms, not yet diagnosed or fixed.
- User explicitly clarified: no implementation yet, including these highlighting bugs. The interrupted investigation left no implementation changes.
- Point 6 approved: preserve lease-free live-follow intent between responses and through normal prompt submission; unread output blocked on ownership is Queued, not live. Preserve intent across temporary-to-persisted source identity changes. Pause, Stop and backward navigation exit live display appropriately; viewport scrolling alone does not change chronological intent. Implementation pending.
- Additional user observation for the deferred dimming investigation: loss of dimming appears limited to the first displayed line of each sentence; in a multi-line comment, lines after the first still dim/highlight correctly. Treat this as a reproduction clue, not a confirmed cause; compare first versus continuation lines during streaming and final rendering.
- Terminal queue-failure cleanup approved: recognize terminal failure of any utterance in the current playback queue, cancel that queue and update the UI promptly. Release ownership only after confirmed stop. Ignore ordinary retired-playback errors without discarding unresolved stop evidence. Implementation pending.
- Paused-source cancellation approved: process abort/error cancellation before paused-source queueing returns; F8 must not revive cancelled playback. Preserve unrelated paused historical playback and position, retain ownership until affected transport stop is confirmed, and do not delete the saved transcript. Implementation pending.
- Persistent stop warnings and recovery approved: keep input/output stop-unconfirmed diagnostics visible until matching proof, identifying the blocking device and directing the user to restore its connection and retry `/voice reconnect`. Verify reconnect retries both resources with the original handles. Ordinary Ready/Idle events, disconnects and Pi restarts must not clear uncertainty or release ownership; no unsafe force-release bypass and no repeated notification spam. Implementation pending.
- Handoff presentation approved: display Connecting during a device handoff, not Paused merely because an internal transport is paused. Paused follows deliberate playback-pause intent, including the agreed silent post-switch state for previously active playback; an idle session stays idle after switching. Opening/cancelling the picker changes neither state nor ownership. Implementation pending.
- Point-by-point decisions are recorded above, including timing command spelling, scope and the deliberate CLI compatibility break. All implementation remains deferred pending the user's instruction to start; highlighting TODOs retain their stated priority.

## Previous handoff — completed chronological live follow

- User clue: the latest finished response showed `○ Idle · [full bar] 0:35 / 0:35 · message 669/669`; red live appeared only while the assistant was working. Completion discarded follow intent with the audio lease; viewport restoration also incorrectly decided chronological Tail.
- Completion now retains existing playback-tail intent and navigation Tail at the latest eligible source while releasing the lease normally. F8 pauses/resumes that intent without requiring a transport; paused incoming responses queue. Stop, historical replay and manual viewport controls retain their separate semantics.
- Validation: typecheck passed; full checkout **971 passed / 33 compatibility skips**, installed-native **1004 passed / no skips**, no failures. No LSP configured. Logs and limitations: [testing](docs/testing.md).
- Offline full-completion regressions cover message_end → turn_end → worker finish, released ownership, mounted Playing/live, paused-next-response/single resume, historical Idle and F6/F7 chronology. No new tail flag or client changes. Operator: host `/reload` when ready, not performed here.

## Previous handoff — four review fixes ready for user reload

- Root shared clock excludes starvation before new PCM submission; real feedback anchors fallback and estimated positions never establish stop proof.
- Describing means actual foreground description API work (including active shared producers); context/next-fence/resource waits are Queued, cached plans are free. Other compact labels and paused precedence remain unchanged.
- Separate consumed-code frontier handles final description units, cached/persisted skipUnits and terminal omissions without moving highlights. Closed silent fences are excluded by shared parser state; genuinely unfinished/pending work stays non-live. Red `● live` remains time-only, unpaused and chronological, never viewport-derived.
- Final validation: typecheck; checkout **971 passed / 33 skips**; installed-native **1004 passed / no skips**, no failures. Details and initial backfill-test synchronization correction: [testing](docs/testing.md).
- Host `/reload` only when the user is ready; not performed here. No providers/inference/hardware/session restarts/config changes. Headphones/mouse, ISSUES/demo assets and prior discussion notes preserved. No new live reliability claim.

## Previous handoff — compact playback phases and first-line VoiceUI

- Playback phases: Idle, Playing, Paused, Synthesizing, Loading, Describing, Connecting, Queued; paused intent wins. Separate native error-red `● live` replaces time only at the unpaused chronological playback edge, including caught-up next-output wait. Older replay, unread/queued audio and paused playback are not live; End/Alt+T only control the viewport. Unknown times stay `--:-- / --:--`, not invented durations.
- `[🎧:device]` sits at the right end of the first VoiceUI line, including idle status. Identity is reserved before status/hints; narrow names truncate with a closed badge (omitted below six available columns). Alt+S and supported widget clicks open the picker; no idle-footer click claim. Pi's footer and other extension statuses remain intact.
- New offline evidence: real native mounting/rendered-frame checks with synthetic events and mocked transport deliberately make `PlaybackHistory.status()` unavailable during active streaming/Tail. This exercises a missing-history playbar gap and its fallback; it is **not a diagnosis of the original random live disappearance**. Finished idle/Stop must not fabricate a transport row. Earlier narrower evidence is retained below as historic.
- Final serial validation: typecheck passed; full checkout **956 passed / 33 compatibility skips**, full installed-native **989 passed / no skips**, no failures. Review regressions include pending/exhausted streaming work, terminal queue failure, partial/silent source tails and split pointer events. These are offline checks, not new live confirmation. See [testing](docs/testing.md).
- This diff is host-only: clients unchanged; operator `/reload` when ready, not performed here. No hardware, provider calls, real inference, live Pi/SSH/client restart or runtime-settings changes. This handoff makes no new hardware/live reliability claim. `ISSUES.md`, assets and discussion notes are preserved; no commit in this docs sync.

## Historic checkpoints and discussion

The remaining entries preserve their original evidence, counts and proposals. Older Waiting labels, plain badges and idle-footer placement describe earlier implementations, not the current UI above; historical operator instructions apply only to their named migrations.

## Historic integration handoff — picker and routing lifecycle

- Preserved and separately committed the inherited routing fixes as `8d665ce`: paused same-route reconnect retires the sink and retains the exact streaming suffix; fresh mic/input-only ownership does not become playback pause intent. Confirmed-stop barriers, review-only dictation finalization, public context/session facades and sticky selection remain intact.
- Wired `e44775d`'s `devicePickerLabels` into the actual picker: raw names and full-ID mapping survive; number/current/short-ID precede long names and the initial choice now matches the available current ID (Local only when current or no current candidate is available). Confirming the same healthy route pins manually without audio interruption. Actual 40-column native host integration checks duplicate Unicode names, colliding clipped IDs, visible current marker, pointer selection to the full ID, and default keyboard selection.
- `/voice device` and no-argument settings queries remain read-only; exact ID/unique name/next/prev/local select sticky pins, successful reconnect/auto returns to attachment routing. Alt+S or supported badge clicks open the keyboard/pointer selector overlay without replacing an underlying select/confirm. Narrow badges remain closed/visible; regular/frame-mode or older TUI keeps keyboard access. Alt+D retains native forward-delete-word; Alt+S is unused by checked Pi/Voice defaults. Desktop F4 mic/F5 replay and configured conflicts are unchanged. No sender authentication or SSH-wrapper key interception is claimed.
- Current checkpoint after `7a63f7e`: `npm run check`; full default suite **942 passed, 29 optional native compatibility skips, 0 failed (971 total)**; full installed-native suite **971 passed, 0 skipped/failed** (not only the picker subset). Logs and commands: [testing](docs/testing.md). LSP unavailable; TypeScript substitutes for diagnostics. No container, hardware, inference/provider call, live configuration/session/SSH change or push.
- Latest picker/routing feature is **not live-validated**; earlier positive user feedback remains scoped to earlier features. Operator only: `/reload` when ready, then validate live behavior. No client update/reconnect is required for this host-only integration. `ISSUES.md`, demos and historical discussion remain untouched.

## Previous handoff — explicit shared-terminal device routing and first-row badge

- Authorized alternative to key-sender detection: `/voice device` is read-only current selection plus registered candidates; exact IDs and unique exact names (including quoted spaces) select a sticky per-session pin. Duplicate names report IDs, not a guess. `next`/`prev` wrap in stable ID order; zero/one/missing-current cases are defined. Only valid registrations with best-effort endpoint availability participate; local and synthetic legacy entries are not cycled. No network probes or inactivity TTL; wrapper registration/forward lifetime is authoritative where observable.
- Existing custom session entries persist manual versus auto mode across reload. Ordinary mic/replay/navigation and attention-origin requests honor manual selection without tmux attachment lookup. Successful `/voice reconnect` or `/voice device auto` restores auto mode; failure leaves the old mode/pin. Shared-terminal users may command-select devices; names are not credentials and the sender is not identified. No key interception, new credential/channel, global config or dependency.
- Switches supersede obsolete playback/acquisition; both old transports must prove stop before pin commit. Recording finalizes into the draft without submission, preserving manual edits; forced reconnect now uses the same safe finalization. Stop remains cancellation. Failed proof retains the old selection and ownership/retry handles. Successful handoff preserves the canonical cursor and manual viewport, selects silently/paused, and requires explicit playback; endpoint overrides remain unchanged and are reported.
- The effective selection's bounded name (fallback short ID; `local`/`no device` when applicable) appears once at the end of the first existing progress row. Input → playback → descriptions → timing precedence remains; no progress uses the existing Voice footer, not a new row. Native-width rendering reserves badge space without extra wrapping, retaining widget margins. Failed handoff keeps the old tag. Client wrapper identity now says `Connected as <name>`; host selection notices still disclaim audio readiness.
- Validation: `npm run check`; full `npm test` **923 passed, 3 existing compatibility skips, 0 failed (926 total)**; installed-native inert-terminal key/scroll/marker suite **307/307 passed**. Native widget first-row/32-column checks and wide-name precedence tests are also in the full suite. Shell syntax and `git diff --check` passed. No LSP configured. Logs: `/tmp/voice-final-tests-2.log`, `/tmp/voice-final-native.log`. Optional isolated real-SSH suite was not rerun (client change is identity text only); no live microphone/audio, real inference/provider calls, settings changes, SSH/Pi/client restarts or pushes.
- Operator: update the host checkout and `/reload` at the user's chosen time. Already compatible registered clients need no reconnect for manual selection. Recopy installed desktop/Termux wrappers only to get the new client identity wording on future connections; preserve all outstanding stop-recovery state. Existing installation/client-copy instructions remain authoritative. `ISSUES.md` and untracked `docs/assets/demos/` remain untouched and unstaged.

## Previous handoff — visible names and standalone setup/rename

- Both SSH wrapper copies accept only `--set-device-name ["Device name"]` as a standalone first-argument mode. No-name mode always opens a visible `/dev/tty` prompt, including existing names; the positional form is headless. Extra arguments/options fail before configuration mutation or SSH. Flags in remote commands remain remote arguments.
- Setter validation and bounded flock/private-temp/atomic-rename reuse the `80aca1d` publication fix, with explicit name replacement only; no ID creation or modification, SSH config query, network, bridge, runtime files or restart. Normal first-run publication remains first-writer-wins. Direct client/phone and stream helpers remain non-prompting.
- The byte reader retains malformed UTF-8 newline/EOF handling and safe terminal restoration. It displays safe complete UTF-8 prefixes, spaces and Unicode, redraws for Backspace without cell-width arithmetic, and never echoes supplied control/bidi sequences. SSH stdin remains untouched.
- Official unattended provisioning and rename use the CLI, not manual file writes. Confirm stop, close all client wrappers, update installed desktop/Termux copies and reconnect; renamed registrations apply next connection, never implicitly restart existing sessions. Retain the device ID and recovery state.
- Validation: `npm run check`; full suite **917 passed, 3 existing compatibility skips, 0 failed (920 total)**; isolated synthetic real-SSH **12/12 cases passed**, now provisioning through the setter. PTY/headless coverage includes visibility before Enter, Unicode/Backspace, cancellation/invalid UTF-8, ID preservation, concurrency, strict arity, no TTY and no network/runtime activity. No LSP configured; no live sessions, provider/model/hardware calls, settings or `ISSUES.md` changes.

## Previous clarification — persistent client names replace environment naming

- The first interactive desktop/Termux SSH connection prompts for a name before SSH, registration or daemon launch; future connections read `${XDG_CONFIG_HOME:-$HOME/.config}/pi-voice/device-name`, beside the stable `device-id`. This entirely supersedes the previous environment/hostname naming design, including inherited obsolete exports. Existing installations prompt on their next interactive connection when the file is missing; unattended first runs fail with provisioning instructions.
- Private atomic first-writer publication keeps concurrent first launches on one ID/name without holding a lock across a prompt. `/dev/tty` leaves SSH stdin intact; invalid names/cancellation/EOF do not connect. Direct client/phone bridges do not register metadata and remain non-prompting.
- Names remain display-only: duplicate names do not route/authenticate. Fresh verified SSH attachment identity and existing session-pin/confirmed-stop adoption barriers are unchanged; no automatic mid-playback repin.
- Validation: typecheck; full suite **917 passed, 3 existing TUI compatibility skips, 0 failed (920 total)**; real isolated SSH **12/12 cases passed**, client-only ephemeral name configuration. PTY checks cover both wrappers, first save/reuse, EOF/Ctrl+C, Unicode/quotes, private permissions, preserved stdin/legacy ID, concurrent prompts/ID creation and configuration errors. No extension UI/API changes; native TUI rerun not required.
- Operator: confirm playback/capture stop, close all client wrappers, install the updated complete client script set (including separately installed Termux copies), reconnect and answer the prompt, then `/reload` on the host. To rename, confirm stop/close wrappers first and use the standalone setter described above; never regenerate the ID. No live sessions/settings/provider/model calls or user files were changed; `ISSUES.md` preserved. See `docs/installation.md` and the current ledger entry.

## Current A keyboard handoff

- Current mapping: Alt+M/custom mic unchanged; automatic F4 unless `talkShortcut=disabled`, deduplicating custom F4. F5 own-project replay remains registered with mic shortcuts disabled. No automatic F11; custom F11 allowed; existing collision rules retained. Desktop order: F4 mic, F5 replay, F6 previous message, F7 previous sentence, F8 pause/resume, F9 next sentence, F10 next message.
- Termux: `F4🎙 | F6⏮ | F7↶ | F8⏯ | F9↷ | F10⏭ | F5↺`; manually edit local phone `termux.properties`, no generator. Historical F11/F5 audit references below retain their original meaning.
- **User LIVE evidence now recorded:** Linux Mint capture/transcription succeeded; earlier pending-confirmation statements are historical. This is user-reported prior success, not a new live test of A or proof of the original failure cause.
- No live restart, provider/inference call, user settings/cache, ISSUES or archive edits. Apply host changes with `/reload` when the user chooses; update the optional Termux row locally. Device-name support also requires updating client wrappers together as documented in `docs/installation.md`. OS/terminal/Fn and custom-binding conflicts are not ruled out by native default checks.

## Desktop SSH recovery — 2026-09-21

- Recovered and inspected the interrupted client change and all four harness files before editing. Preserved `ISSUES.md` and historical notes. Identified the three prior orphan test servers by exact container names/images, `/work/sshd_config`, mount inspection and matching init-parent PIDs; removed only owned test resources. No signals to user sshd 1266, live SSH 1818336/1818339, or parent Pi 1097452.
- Proven defects: Ubuntu PipeWire 1.0.5 rejects `pw-record --raw` before capture; raw stdout requires only `-`. The old bridge TERM handler cleaned listeners then resumed supervision instead of exiting. Retained/completed the interrupted termination fix and removed the unsupported flag; both new regressions fail against `4965fce`.
- Completed opt-in two-Ubuntu real-SSH harness: 12 capture/routing/environment cases, private networking/keys, synthetic PulseAudio and PipeWire sources, production wrapper/listeners/tickets/encoder/decoder. Existing Termux and strict router fixtures complement it. No physical audio, provider/inference, live restart, or settings changes. Playback hello only, no new playback infrastructure.
- Final validation: **12/12 real-SSH cases passed**; intentional harness TERM **124**, cleanup verified; typecheck passed; `npm test` **872 passed, 3 compatibility skips, 0 failed (875 total)**. Final container inventory empty. Initial harness cleanup removed client/server in one Podman call and could leave the dependent server; now deletion is ordered and failures are visible. See `FINDINGS.md` and `docs/testing.md` for exact coverage/commands.
- **User action:** update local desktop `client/pi-voice-*` scripts, then after confirmed stop close/reopen its voice wrappers at the user's chosen time. No host sshd restart, live tool-driven reconnect, or stop-state deletion. Host reload alone cannot repair an old client. The user now identifies Linux Mint and Alt+M failure before recording; the actual installed backend/version/environment and hardware cause are still unknown. Concurrent wrappers deliberately retain the first bridge's launch environment; no automatic active-session restart was added.

## Current documentation audit — source `d4cf759`

- Audited the 2026-09-13–2026-09-20 window (149 commits, `3e66cb1` through `d4cf759`), broadening to the September 12 routing migration `1ed15dc` and earlier relevant protocol/control history. Compared current implementation with README, all 13 docs, example config, configuration validation and command help; no production/test changes.
- **New user LIVE evidence:** the newest batch “seems fixed”; native bottom-follow/banner behavior is now confirmed. Earlier navigation, Jump-to-voice, ASR, fast UI and no-flicker feedback remains valid. This supersedes the pending-live language in historical checkpoints below, not all hardware/error paths. Original EPIPE cause remains unobserved and real start latency unmeasured.
- Documented automatic exact-bottom native End adoption, resize re-evaluation, chronological Tail separation and manual/paused guards; corrected old phase/word-count/clock UI prose, F8 framing, cache/priority, routing/Stop, environment and migration guidance. Coverage and remaining implementation limits are in the current `FINDINGS.md` entry.
- Validation: typecheck passed; final full suite **865 passed, 3 compatibility skips, 0 failed**; installed-native **306 passed, no skips/failures**. Two earlier audit full runs hit an intermittent render-cost widget-write assertion; targeted and final full reruns passed. No test fixes or universal-green claim. Documentation links and whitespace checked.
- This latest batch remains host-only since `ade0670`: host update + `/reload`, no routine client copy/reconnect/SSH restart. Older installed bridges must still match the earlier protocol migration. No live processes, user settings, provider/model calls or private exports touched; untracked `ISSUES.md` preserved.

## Historical native automatic-bottom handoff — ready for reload at that checkpoint

- User LIVE feedback: Voice following now lands at the actual bottom; remaining bug is Pi's native “Jump to latest” banner/end-follow state. Preserve the earlier positive navigation, Jump-to-voice, windowed-follow and flicker feedback; this fix itself is offline-validated only.
- Completed the interrupted `src/index.ts` / native-test diff. Unpaused automatic arrival at exact maximum scroll now reconciles native end-follow even when the word stays in the 20–80% band, and remembers final-tail restoration. No playback Tail/cursor or pause-state action; manual bottom gestures and paused anchors retain ownership. Subsequent growth still restores the speech window when needed.
- Validation: `npm run check` passed; full suite **863 passed, 3 compatibility skips, 0 failed (866 total)**; installed-native suite **305 passed, no skips/failures**. Includes clamped start, ongoing arrival, in-band suppression, future output, navigation, manual bottom and paused background refinement. No LSP configured.
- Host `/reload` ready; no client copy, SSH restart, reconnect or settings change required. No live/provider/inference calls or transcript inspection; `ISSUES.md` untouched. Evidence and logs in `FINDINGS.md` below.

## Final documentation reconciliation — source `d4ce9c9`

This historical checkpoint superseded older current-status/reload headings below; the current audit above now takes precedence. Historical agreements and evidence remain preserved. Documentation only: no source, test, client, Termux or settings changes. `ISSUES.md` remains untouched.

- **User LIVE evidence already positive:** windowed follow, paused/unpaused navigation, intuitive ASR alternatives, fast UI and fixed flicker. Earlier failures below are historical reports, not evidence these confirmations were withdrawn. **The newest batch after `ade0670` has NOT been live-tested.**
- **One chronological cursor:** F6/F10 move messages; F7/F9 move source sentences/literal newlines, including active streaming targets and enabled thinking in actual transcript order. Tail is after the latest eligible target; back selects the last message/unit, not the penultimate. Navigation and Tail preserve paused/playing intent; active Tail retains unfinished text/future deltas and source closure through asynchronous waits. Alt+T/native bottom is viewport-only, distinct from playback Tail. Immediate previews retain the selected source's context; later ticks/finalization must not steal them.
- **Native rendering:** highlight after wrapping against a stable baseline; clip per line including tables, preserve glyph positions, syntax colors, graphemes, original source offsets and table-cell membership. Bounded two-leaf caches survive native rebuilds/ticks. Real native Jump-to-voice mouse dispatch re-arms follow without resume or focus changes. Unmappable probes preserve the exact baseline; narrow-table reference-link URL mapping remains limited, not falsely painted/proven universal.
- **Start path:** mocked first prose reaches the worker before message end. Code conversation context still deliberately waits for next-fence/message-end boundaries and retains speech order. Pool preload no longer blocks foreground playback or resets speaking UI; background descriptions yield foreground priority; last-consumer cancellation aborts abandoned provider work. No real start-latency measurement or inference claim.
- **Stop safety:** original EPIPE cause remains UNOBSERVED. Retained original opaque endpoint/stream handles and exact receipts permit cleanup retry after helper/worker loss; no EOF/kill/timeout substitutes for stop proof. Per-resource error episodes deduplicate notices independently and reset only on matching confirmed cleanup; older proof cannot clear newer failure.
- **Validation rerun:** `npm run check` passed; `npm test`: **858 passed, 3 skipped, 0 failed (861 total)**. Installed global Pi native TUI: **300 passed, 0 skipped/failed**, inert terminal. Earlier source checkpoints reported 822 then 858 passing; these current counts are freshly rerun, not copied. Three default skips are two MouseRegion button cases and the native banner on the older project TUI. No LSP configured. Logs: `/tmp/pi-voice-finaldocs-{check,test,native}.log`; native module path/command in `docs/testing.md`.
- **Operator handoff:** update host checkout and run `/reload` when ready. `git diff ade0670 d4ce9c9 -- client termux` is empty: no client recopy, wrapper/SSH restart or `/voice reconnect` required for this batch. Earlier protocol migrations below still apply only if outstanding; unconfirmed cleanup still requires recovery, not bypass. Then validate live streaming/Tail in both pause states, native click/re-follow, wrapping and perceived speech startup when authorized.

## Historical checkpoints (superseded where noted)

### Current-session evidence follow-up — still ready for user reload

- Authorized read-only inspection positively identified the interactive parent using process ancestry, fresh coordinator PID/session/cwd metadata and matching JSONL header (not the delegated agent's session ID). Saved user entry 18042 contains one legacy invisible marker in a four-line quoted-message structure; original anchor at 17996 is marker-free. Intervening entries are one assistant, 42 timing records and two device-selection records. Only structural aggregates/codepoint signatures are recorded in `FINDINGS.md`.
- Parent PTY currently reports **120×50**. JSONL does **not** establish incident-time or in-memory viewport geometry, selected playback target, or live causality. Saved timing schemas/hex-key aggregates are evidence of persistence only, not current compatibility or a new cache defect.
- Added only missing synthetic four-line/single-marker and 120-column/50-row coverage; existing source-change, dynamic-height, replay and manual-follow checks remain. No production/cache changes. Typecheck passed; full suite **514 passed, 1 known banner skip, 0 failures**; installed native TUI **16/16 passed**. No LSP configured. No live writes/reloads/restarts, hardware/provider/inference calls or transcript exports; `ISSUES.md` untouched.
- **`ec68eb4` remains ready for user `/reload`, without SSH restart.** The saved contamination is proven; whether it caused the reported live failure still needs user confirmation after reload.

## Atomic marker integration — ready for user reload

- **Version clarification:** the user’s reported viewport failure was on a version **before `5882cff`**, not evidence that its narrow-width fix had already been loaded and failed. Earlier restart observations below remain historical evidence; do not infer the running code version from a restart alone. User was told to wait; this handoff now permits their reload after validation. No live session was restarted here.
- Selection-scoped, zero-width markers now drive both local/full transcript lookup and absolute-anchor cache identity. New selections/replays retire old identities; live deltas and canonical source finalization retain the current one. Legacy/copied markers remain byte-for-byte in user/tool/source text but cannot anchor a new selection. No source-offset stripping or remapping.
- **Proven offline path, not diagnosed LIVE cause:** a raw quotation of an old marker precedes the actual narrated assistant; the old global find-first selects that quotation. Native fixtures now verify the current spoken target, not merely any marker. Widths 28/100, screen heights 24/32/40/52, separate editor/progress/footer heights, initial 20% with both end clamps, 45 playback checkpoints, manual override, silent paused navigation, replay, native tail/search/drag/banner controls all pass.
- Cache fix **`9e59d32` is already committed**, not reimplemented: exact resolved timing assets are recovered across restarts/branches, including fallback identities after bounded-pool eviction. Sentence-boundary render identity **3→4 still requires one expected invalidation**; unchanged version-4 restarts should reuse compatible saved maps.
- Latest validation: `npm run check`; full `npm test` **512 passed, 1 dependency-banner skip, 0 failed (513 total)** in 42.5s; installed native TUI **14/14 passed**, including banner and quoted-marker probes. Logs: `/tmp/voice-marker-final-full.log`, `/tmp/voice-marker-installed-native.log`. No LSP configured; whitespace check clean. Prior concurrent cache-test timeout did not reproduce with the full standard runner. A new native fixture’s redundant per-line source rendering caused heap exhaustion; fixed the fixture’s repeated lookup and retained mock histories, then reran the full suite successfully (no runner/runtime setting changes).
- `ISSUES.md` and previous discussion preserved. No inference/provider calls, live process/SSH/client actions, settings changes, or private exports. **Ready for user reload**; actual live symptom resolution still requires user confirmation. Identical source blocks remain a text-identity limitation, not claimed solved.

## Viewport follow-up — narrow native cached coordinates

User still observes LIVE playback pinning narrated text out of view **after timing recovery finished and Pi restarted**. This remains valid unresolved live evidence, not a preprocessing explanation.

- Reproduced a narrower, deterministic cause offline: native 28-column Markdown wrapped at 28 while Voice's cached local marker wrapped at a minimum of 40. On checkpoint 35 the real marker was row 1570, outside viewport rows 1543–1568. Removed only the artificial 40-column minimum; no adapter/API or gesture changes.
- Added a cache-enabled native regression with 1,500 history rows, an initially offscreen target, actual Markdown, and a VStack footer/editor simulation growing by one timing row and five editor rows. Checks initial 20%, continuing 20–80%, manual override across layout changes, and synchronous silent paused navigation. Existing tail, banner, forced-render/search/drag and controls tests remain intact.
- Validation: `npm run check`; full `npm test` **507 passed, 1 dependency-banner skip, 0 failed (508 total)**; installed native TUI **11/11 passed**. No LSP configured. No live sessions/settings/SSH, provider/inference calls, or private exports; `ISSUES.md` untouched.
- **Still unknown:** whether the user's terminal content width was below 40, and whether this explains that live failure. Wider terminals, duplicate source text, thinking/code targets and nondefault output padding are not established fixed by this regression. Need a nonprivate fixture plus terminal dimensions, target kind and exact control/manual sequence if it persists; do not claim recovery/restart resolved it. See `FINDINGS.md` for coordinate/source limits.

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

## Earlier protocol deployment and safety — only if migration is outstanding

These are the earlier migration requirements, not additional deployment work for the host-only `ade0670`→`d4ce9c9` batch.

The transport/recorder protocol changed for real stop confirmation. Old clients are deliberately rejected, not silently trusted. The user saw `Audio client closed without v2 readiness/completion proof`; that means a client update or forward repair is required, not an automatic replay.

Copy **all** client scripts from the current host checkout in a **local Termux shell**, not the remote shell:

```sh
mkdir -p "$HOME/.local/bin"
scp 'curiosithy@zero:/home/curiosithy/code/pi/pi-voice/client/pi-voice-*' "$HOME/.local/bin/"
chmod 755 "$HOME"/.local/bin/pi-voice-*
```

At this earlier checkpoint the protocol commits had not been pushed; fetching GitHub was not equivalent. If that migration is still outstanding, copy the final compatible versions from the host checkout. Close all voice SSH wrappers on that device and reconnect; the remote tmux session can remain running. Then `/reload` and `/voice reconnect` in Pi.

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
