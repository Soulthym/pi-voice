# Tests

## Current replay lifecycle validation — host-only, undeployed

Source `bea1612` fixes the three request-lifecycle holes reported against `b370350`. The original regression file against archived `b370350` reports **43 passed / 4 failed** (`/tmp/v3holes.oKzp/baseline-full.log`):

- Live F5's cancel ACK admits playback while independent handoff termination proof is still pending. The fake worker rejects attempted dispatch during cleanup; ACK and termination are separately controlled.
- Owning cold F5 dispatches **7 rather than 4** segments after disconnect, both with an unavailable registration and with its priority row removed. Cached metadata alone must not admit I/O.
- Scoped cleanup retry adopts the new route but emits **zero** replay sentences. Route selection alone was an insufficient assertion; recovery now asserts exactly-once current audio.

Lifecycle contract: `waiting` describes a running continuation and is cleared in `finally` on every exit. Retryable routing/transport intent retains the selected source, Tail prefix, pause state and epoch independently; unrelated preparation failure is not automatically retried. Admission drains the newest route/rebind/output/input barriers after asynchronous steps, then synchronously checks request identity, availability and pending manual routing. Only handoff-owned replay bypasses its own routing flight. Dormant recovery starts one replacement continuation without automatic foreign preemption. Pause clones retained intent rather than lending a cancelled coroutine its new epoch. Existing sink leases survive disconnected WAIT; newly acquired unused leases are released on cancellation or deferred retry. Authoritative custom/local output semantics are unchanged.

Independent static review found and drove additional regressions/corrections: manual retries bypassing the first routing fence and then the post-acquisition fence; duplicate later blocks for explicit and nonexplicit live recovery; paused Tail metadata lost on continuation retirement and after failed rebind; physical Pause missing for the retained disconnected sink; automatic scoped cleanup not waking dormant intent; post-acquisition cancellation stranding a lease; fresh F5 inheriting nonexplicit authority; insufficient original-lease assertions during WAIT; and deferred manual disconnect retaining an unused acquired lease. All reported findings were addressed. The final parent read-through confirmed the last lease correction; this is scoped static review, not exhaustive interleaving proof. Existing assertions were preserved; the scoped-proof test was parameterized to exercise both event-driven and timer-driven recovery, with audio assertions added.

Final isolated validation: `npm run check` passed; routing **57/57**; routing/queue/live-tail/transcript/device lifecycle plus backfill/cache/render/cold-history budget focus **114/114**. Full default **1486 passed / 45 skipped / zero failures**; installed-native **1529 passed / 2 skipped / zero failures**, **1531 total each**. Logs: `/tmp/vlife/{check,focus-final,default-final,native-final}.log`. An intermediate full run exposed eight timing regressions from unconditional extra async yields; synchronous admission predicates removed those yields, and both final full suites passed without weakening assertions. The original three-hole baseline above was recorded before those corrections; no failing-baseline claim is made for every later review-added test. After checkpoint-document updates, typecheck, documentation checks **3/3** and `git diff --check` passed (`/tmp/vlife/{check-docs,docs}.log`); these were documentation-only changes after the final full suites.

All runs used `env -i`, private HOME/TMPDIR/XDG/Pi directories, and installed agent/TUI/keybindings module overrides for native tests. LSP is unavailable; TypeScript supplies diagnostics. No user caches/settings, providers/models/inference, hardware/device probes, live Pi/SSH/client sessions, runtime settings, deployment or push were touched. No transport/client/helper changes or helper update required. This remains host-only synthetic validation, not live hardware confirmation; a safe host reload is later operator work. Root TODO/HANDOFF, ISSUES and demos remain untouched.

## Historical combinatorial priority validation — host-only, undeployed

Source `90f056b` adds six regression cases without changing existing pause assertions. Against archived unfixed `6dd8e19`, the final routing file reports **5 failures / 39 passes** (`/tmp/vf/baseline-final.log`):

- Gated cold preparation + foreign owner + higher arrival loses explicit F5 authority (**0 takeovers, expected 1**). Rerouted Pause before preparation finishes instead issues an unwanted takeover (**1, expected 0**); Stop already passed.
- Historical A acquiring + streaming B + arrival + Pause + B completion + Resume loses B (**no segments, expected both sentences after A**).
- Disconnect + removal of registration and priority metadata while foreign proof is pending dispatches **4 segments, expected 0**, rather than retaining WAIT. Both same-device return and newer explicit selection are covered.

Contracts now exercised: only a current, still-waiting explicit request survives automatic rerouting throughout preparation/rebind/acquisition; completed/expired requests and lease-free paused Tail confer no takeover authority. An undefined retry source means historical identity, never the mutable current live source. A missing selected row is unavailable for auto-route admission, without changing authoritative explicit endpoints or the local fallback row. Original scoped proof still gates replacement IO; A and B each play once, in order.

The new cold fixture initially expected the appended history message instead of the already-selected message; recorded segments demonstrated that mistake, so its content assertion now uses the actual selected source. The missing-registration fixture now restores resolution when simulating return/new selection, rather than incorrectly leaving every returning device unresolvable. Neither correction changes prior pause assertions. The final corrected tests were rerun against the archived baseline and retained all five reported failures.

Final isolated `npm run check` passed; routing/queue/live-tail/navigation focus **151/151**. Full default `npm test`: **1473 passed / 45 skipped / zero failures**. Installed-native: **1516 passed / 2 skipped / zero failures**, **1518 total each**. Logs: `/tmp/vf/{check,focus,default,native}.log`. Tests use `env -i` and private HOME/TMPDIR/XDG/Pi directories; native overrides are `PI_VOICE_TEST_{AGENT,TUI,KEYBINDINGS}_MODULE` pointing to the installed agent modules. LSP is unavailable; TypeScript supplies diagnostics. After status-document synchronization, typecheck, documentation checks **3/3** and `git diff --check` also passed (`/tmp/vf/{check-final,docs}.log`); the full suites above ran on the same source/tests before these documentation-only edits.

TODO6 and the earlier pending-acquisition F5 edge are implemented; evidence below retains their historical status. Independent parent follow-review remains outstanding. No real cache/settings, device probes, providers/models/inference, live sessions, restart, deployment or push. No transport/client/helper changes; no new helper update required, and previous migrations remain applicable. This is host-only synthetic validation, not live phone/hardware confirmation; a safe host reload is later operator work.

## Historical explicit takeover across automatic routing — host-only, undeployed

Seven added real-coordinator/fake-worker regressions cover one pending F5 preemption across a higher arrival, Stop/Pause/session/source cancellation, disconnected-route return, and independent streaming B draining after A. The preemption file must remain identical until owner release; replay uses only the winning route, with one content utterance (the existing project announcement is separate). Existing lease-free paused-Tail zero-acquisition, stale manual-event, source-queue and delayed-handoff paused-preparation assertions remain unchanged.

Failing-first: initial takeover cases **2/2 failed** because routing removed the authorized preemption file (`/tmp/ve/baseline.log`). Final seven regressions against archived `8a577ba`: **6 failed / 1 passed** (`/tmp/ve/baseline-final.log`); disconnected-route return was already green. Read-only review caught independent-source loss and disconnected admission in the intermediate fix; both were reproduced before correction (`/tmp/ve/{queue-review,disconnect-before}.log`). Follow-up static review found no actionable issues.

Final isolated typecheck passed; focused routing/queue/live-tail/delayed-handoff **59/59**. Full default **1467 passed / 45 skipped**, installed-native **1510 passed / 2 skipped**, zero failures, **1512 total each**. Logs: `/tmp/ve/{check,focus,default,native}.log`. An intermediate default run exposed 16 failures from an overbroad disconnected-route guard and changed ordinary paused preparation; narrowing to actually rerouted requests restored all unchanged tests. The first native run had one cold-history heartbeat failure (**100.7ms**); the unchanged full rerun passed. An earlier default invocation was interrupted by the tool's 120-second timeout, not a completed result.

Runs used `env -i`, private HOME/TMPDIR/XDG/Pi directories, and installed agent/TUI/keybindings test overrides for native validation. LSP is unavailable; TypeScript supplies diagnostics. No live caches/settings, hardware, providers, models/inference, SSH/Pi/client restarts, probes, deployment or push. No client/helper/protocol changes.

## Historical priority review follow-up — host-only, undeployed

Eight added cases preserve all prior pause regressions. Baseline evidence:

- Lease-free paused Tail with a second real coordinator: acquisition count **1 instead of 0**. Queued premanual priority arrival: selected **d1 instead of d3**. Clean baseline run **2 failed / 1 passed**, `/tmp/vr-baseline.log`.
- Independently streaming B behind historical A: baseline produced **no B segments** after A EOF instead of both expected sentences. Original assertions retained; expanded to four playing/paused and F8-during-proof combinations.
- Review follow-ups: idle manual adoption lost a postmanual event (**local instead of d3**), `/tmp/vr-review-baseline.log`; postmanual higher arrival admitted obsolete output before reranking, `/tmp/vr-admission-baseline.log`. Both reproduced before their fixes.

The first two-case baseline invocation had incorrect second-coordinator teardown ordering and timed out retrying cleanup after fixture removal. Moving shutdown into `finally` before fixture cleanup fixed the harness; assertions were unchanged, and the clean run above reproduced both production failures.

Final typecheck passed (`/tmp/vr-check.log`). Focused priority/queue/live-tail-pause **51/51** (`/tmp/vr-focus.log`). Full default **1460 passed / 45 skipped / zero failures**, installed-native **1503 passed / 2 skipped / zero failures**, **1505 total each** (`/tmp/vr-{default,native}.log`). Tests used private HOME, TMPDIR, XDG cache/config/data/state/runtime and Pi directories; inherited PI/SSH/tmux settings were removed. Native opt-ins used the installed agent/TUI/keybindings modules through `PI_VOICE_TEST_{AGENT,TUI,KEYBINDINGS}_MODULE`. LSP is not configured.

No live devices, SSH sessions, inference, providers, runtime configuration, helpers or deployment changed at this checkpoint. The then-open explicit-acquisition/rerouting edge is fixed and validated in the newer section above.

## Historical TODO6 fixed-source validation — host-only, undeployed

Original regression (corrected fixture, unchanged assertions): **16/16 passed**.
Combined focused checks: **110/110 passed**, log `/tmp/vp6/focused-pass.log`.
Run with `env -i`, PATH retained solely for installed tools, private
HOME/TMPDIR/XDG_CONFIG_HOME/XDG_CACHE_HOME/XDG_DATA_HOME/XDG_STATE_HOME/
XDG_RUNTIME_DIR under `/tmp/vp6`, and no inherited PI/SSH settings:

```sh
node --import tsx --test --experimental-test-module-mocks --test-concurrency=4 \
  test/index-live-tail-pause.test.ts test/index-transcript.test.ts \
  test/index-replay-tail.test.ts test/index-auto-scroll.test.ts \
  test/index-lifecycle.test.ts test/index-device-switch-lifecycle.test.ts \
  test/index-priority-routing.test.ts test/index-input-cancellation.test.ts \
  test/index-dictation-playback.test.ts test/worker-pause-startup.test.ts \
  test/worker-playback-clock.test.ts test/vocalizer-phases.test.ts
```

`npm run check` passed (`/tmp/vp6/check-final.log`). Full default `npm test`:
**1452 passed / 45 skipped / zero failures (1497 total)**,
`/tmp/vp6/default.log`. Installed-native `npm test`: **1495 passed / 2 skipped /
zero failures (1497 total)**, `/tmp/vp6/native.log`. Native opt-ins used the
installed agent's `dist/index.js`, its `node_modules/@earendil-works/pi-tui/dist/index.js`
and `dist/core/keybindings.js` for the existing `PI_VOICE_TEST_{AGENT,TUI,KEYBINDINGS}_MODULE`
variables; all other isolation remained identical. Documentation checks **3/3**
(`/tmp/vp6/docs.log`) and `git diff --check` passed. LSP diagnostics:
`No language server found`.

The existing replay-tail fixture had two failures after the fix: its second
iteration tried idle F8 Replay while F7 audio from the first was still active.
Each manual-scroll scenario now has its own idle host (12 instead of 6 tests),
retaining every assertion. A Stop-based setup was rejected because Stop carries
attention suppression; a synthetic EOF alone also did not model the seek state.
No production semantics were weakened to satisfy the fixture.

Focused coverage includes ordinary replay, streaming versus completed turns,
started versus startup-pending audio, additional paused chunks, provisional ID
canonicalization, late ready/playback frames, frozen source/position, explicit
single Resume, Stop/session supersession, routing rebind and input barriers.
No worker/transport/client helper changes. Real mpv and SSH were not rerun for
this host-only guard; synthetic checks do not establish live phone behavior.
No runtime/provider/inference/hardware operations, deployment or restart.

## Historical TODO6 regression baseline — source `0d898ef` (before fix)

Fixture correction, retaining every original assertion: recorded mock segments
carry `type: "segment"`; spreading them **after** `type: "segment-audio"`
overrode the simulated audio event. Moving `type` after the spread makes the
started-audio cases real. Corrected regression SHA-256:
`f33e0a840c61430ec4b1123645cb11e9cdf970c5c0babe358acb00c92cf21579`.
Rerun against an isolated archive of regression commit `21eda82` (unchanged
`0d898ef` implementation): the same **12 pass / 4 fail**, including the same
`5 !== 3` restart assertion. The two added source/position cases in
`index-transcript.test.ts` also fail specifically on replacement audio
(live `5 !== 3`, ordinary replay `7 !== 5`); combined **28 pass / 6 fail**.
Evidence: `/tmp/vp6/baseline-corrected-final.log`.

The supplemental position test initially used `resumeTarget()`, which **mutates**
the cursor to its sentence boundary rather than observing the playhead. It now
reads `status()` and compares only message ID/position. Full-status comparison
was a demonstrated test mistake: background timing completion legitimately
changed duration 10→11 and timing metadata while position stayed 3. These
fixture corrections do not weaken the no-restart or frozen-position contract.
The original 16-case regression assertions are unchanged.


`test/index-live-tail-pause.test.ts`: **12 passed / 4 failed** under private
HOME/XDG/TMP roots and an `env -i` environment. Command: `node --import tsx
--test --experimental-test-module-mocks test/index-live-tail-pause.test.ts`.
Raw local evidence: `/tmp/vp6/baseline-final.log` (not a deployment log).
Frozen test SHA-256: `715b257a772e46c9511c45eb70ae258484137cba0af195ec37707de36ba81e43`.

Original failure output, with workspace paths omitted:

```text
canonical before: true, bottom: true, turn ended: true, audio started: true/false
AssertionError: Pause must not restart the message by sending replacement segments from zero
5 !== 3
canonical before: false, bottom: true, turn ended: true, audio started: true/false
AssertionError: Pause must pause the existing autoplay sink
actual: undefined; expected: true
```

The first four cases (no explicit bottom framing) passed on current source and
in an isolated `git archive c02bd7e^` temporary source copy; logs
`/tmp/vp6/{baseline,parent}.log`. No history or runtime was changed. Additional
bottom-framing cases reproduced the defect on current source (6/8 passed in
`baseline-bottom.log`); adding canonical-before-pause cases proved actual
replacement segments, not merely a missing pause or invalid replay fixture.
No assertions were relaxed or replaced. The final 16-case matrix is frozen
before source changes. It includes ongoing streaming versus ended turns,
started versus pending audio, and provisional versus canonical source IDs.

Root trace: F8's transcript-tail shortcut uses **model turn completion** to
choose Replay even while the same audio owner/sink remains active. Canonical
history supplies a zero-offset replay; without it, Replay is unavailable and
Pause still never reaches the worker. Ordinary non-tail and ongoing-streaming
cases already pass. Existing pause propagation in Vocalizer → worker-client
(sticky startup pause) → worker/playback clock is not the failing boundary.
LSP reports no configured language servers; callers were traced by text.

## Historical priority integration — UNDEPLOYED at checkpoint

Final source: `bcb185a`, following fixture updates `c8c2c9b` / `f6ea1a6`. The earlier five reviewer findings remain fixed; the second independent review's three findings now have failing-first regressions: latest queued pin supersedes admission, untracked speech releases its lease, and paused historical playback releases its lease at EOF. The final independent focused code reviewer confirmed all three resolved with no remaining actionable defects in scope; that review was **static only**.

Fresh isolated final validation: `npm run check` passed; full default **1428 passed / 45 skipped / zero failures**; installed-native **1471 passed / 2 skipped / zero failures** (**1473 total each**). Logs: `/tmp/vH92C/{check,default,native}.log`. LSP diagnostics were unavailable: `No language server found`. Earlier counts below are historical.

Initial full default validation had **26 failures**: 22 obsolete per-replay identity fixture gates were repaired with real reconnect barriers and assertions; four UNIX socket paths exceeded 108 bytes and passed with a short private TMPDIR. The initial native run's one stale picker fixture was fixed. Final runs have no failures; no transport/helper changes were needed in this routing batch.

`test/index-priority-routing.test.ts` covers the exact 3→2/disconnect/return/manual-3/2-return sequence at the current cursor, WAIT versus lower fallback/higher arrival, pause/Stop/new-source/session supersession, growing/finalized live sources, explicit endpoints, pin/order races, forgetting without blacklisting, delayed ASR/manual draft preservation without submission, and picker snapshot freshness. Real temporary StopRecovery scopes test wrong identity and partial cleanup retaining ownership; only matching proof admits replacement. `test/device-priorities.test.ts` and `test/device-routing.test.ts` cover shared order, discovery dates, offline numbering, Local sentinel/manual placement, persistence and heartbeat-stable cached events.

This host-only priority batch changes no transport or client helpers/protocol. Earlier isolated real SSH **12/12** and mpv **0.35.1 / 0.40.0, 14 scenarios each**, remain prior stability evidence, **not freshly rerun**. **At this historical checkpoint TODO6 remained unimplemented and deferred to the parent; it is now fixed, as recorded above.** It is **UNDEPLOYED and not live-validated**; no microphone auto-start or draft auto-submit is authorized by routing. Explicit reconnect never resumes playback. Prior helper/protocol migrations still apply if absent. These synthetic checks are not phone/tmux/hardware/inference tests. No live operations or runtime changes were performed for documentation.

This final documentation-only update also passed `npm run check`, `test/documentation.test.ts` **3/3**, and `git diff --check`, with private HOME/TMPDIR/XDG roots and a sanitized environment. Logs: `/tmp/vdoc.4mAt/{check,docs}.log`. Full suites were not repeated for this docs-only edit; the final source results above replace the prior pending-full status.

## Historical binding-v4 pidfd proof coverage

New native playback bindings use `binding-v4` and the matching shell, Lua and
`pi-voice-native-proof.py` helpers. Both install globs (`client/pi-voice-*` and
`termux/pi-voice-*`) currently contain **7 files**. Desktop and Termux native
playback require Python 3 with stdlib `ctypes` and working kernel pidfds.
When Python lacks `os.pidfd_open`, the proof helper uses libc `pidfd_open` through
`ctypes`; it never sends signals or falls back to numeric-PID signals.

Restricted procfs (`hidepid=1`/`hidepid=2`) is supported **only** with a successful
kernel pidfd probe, syscall/proc PID alignment and the full private scope, boot,
UID and namespace contract. Legacy `binding-v3` still uses unrestricted-procfs
absence/reuse proof; old bindings are not upgraded. Required read failures,
identity mismatch, denied namespace links and unavailable pidfds remain fenced.
See the [current proof contract](endpoint-protocol.md#native-watchdog-and-proof-limits).

Run the focused proof checks without starting a player or using audio hardware:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p test_native_proof.py
node --import tsx --test test/documentation.test.ts
```

`test/test_native_proof.py` uses private synthetic bindings and mocked Android 5.4
procfs/libc inputs for missing Python API fallback, ESRCH versus EPERM/ENOSYS,
namespace/boot/UID mismatch, PID reuse, pidfd polling, private-file validation and
overlay rejection. Its Linux pidfd check uses only the test process and an owned
short-lived Python child; this is not an Android check. Documentation tests check
install glob counts and the dependency/proof distinctions.

Final validation: **10 Python checks** passed; default `npm test` passed
**1385 / 35 skips**, and the installed-native run passed **1418 / 2 skips**
(1420 total each, zero failures). The two opt-in sandbox cases were run separately.
`npm run check`, workspace TypeScript diagnostics, Bash syntax, helper parity and
`git diff --check` passed. Logs: `/tmp/voice-v4-{check,default-final,native-final}.log`.

Disposable real mpv **0.35.1 and 0.40.0 passed 14 scenarios each** with null output;
isolated real SSH passed **12/12**. The test-only proc view models hidepid=2,
Android 5.4 uname, denied osrelease, absent PID/time namespaces and readable mnt.
Python's `os.pidfd_open` is removed in the Android model; libc pidfd calls and
native player processes remain real. Coverage includes renewal, position events,
healthy EOF, guardian SIGKILL followed by lease expiry and pidfd retirement,
native SIGKILL without a waiter, and proc/kernel PID mismatch rejection.
No host proc mounts or runtime settings were changed. Logs:
`/tmp/voice-test-v4-rerun/{mpv-bookworm,mpv-trixie,ssh,python,check}.log`.

Review caught and fixed a restricted-proc polling guard, non-ASCII unrelated
mount paths, and an obsolete zombie-proc-presence assertion. Final independent
code review found no remaining blockers; parent review is still pending.

**No end-to-end Android validation is claimed.** The reported Android 5.4 libc
self-pidfd probe succeeded despite Python lacking `os.pidfd_open`; that confirms
only kernel-handle capability. Synthetic layouts and Linux software tests do not
establish phone playback or physical audio behavior.
The historical checkpoints below preserve their original test counts and limits;
their binding-v3/nonzero-hidepid restrictions describe that earlier implementation,
not the conditional binding-v4 support above. The new real-mpv results above
exercise this binding format with simulated proc capabilities, not phone hardware.

## Mountinfo literal question-mark regression

Both shell helpers now detect actual NUL delimiters with Bash `read -d ''`
without reserving a valid filename character. Bounded pipeline status, empty and
truncated input rejection, full mountinfo parsing, hidepid checks and current
namespace proof remain enforced for startup and recovery. Shared shell/Lua
fixtures accept an unrelated mount path containing `?`, reject an actual NUL in
that path, and reject empty input and malformed records after the valid mounts.
Existing read-error-after-valid-prefix and other malformed/protection cases remain.

In a disposable network-disabled container, the new valid-path case failed on
both original shell copies; Lua accepted it. After the fix, **6/6 focused tests
passed**, zero skips or failures: both shell recovery matrices, both Lua capability
matrices, and both stopped-live-PID namespace guards. Typecheck, Bash syntax,
helper parity and whitespace checks passed; LSP was unavailable. The full suite,
real mpv and SSH were not rerun. No live sessions, providers, inference, runtime
settings or deployment were used. Actual Android namespace-listing evidence,
including actual PID-namespace absence proof, remains pending parent review;
synthetic fixtures do not establish it.

## Native EOF exit-status race after namespace portability

The previously intermittent mpv 0.35.1 full-host EOF failure was a production Lua
race, not missing stdout drainage or temporary configuration. One uninstrumented
baseline host run failed; five diagnostic host runs yielded three failures and
two passes. The captured native trace showed natural EOF, `quit(0)`, then a queued
callback issuing `quit(1)` before shutdown completed. Shell tracing confirmed
feeder status zero and player status one. The helper therefore correctly withheld
`complete`; TCP closure caused the host's unconfirmed-playback error even though
scoped stop recovery subsequently obtained native exit proof.

Both watchdog copies now retain the terminal quit code across queued callbacks.
Successful EOF remains zero; expiry and callback failures remain nonzero, renewal
cannot revive a terminal lease, and failed quit still attempts stop plus quit.
No timeout, admission rule, native proof, host assertion or TCP protocol was relaxed.
The deterministic EOF-then-timer/renew/start/end regression failed on **both copies
before the fix**; both existing deadline cases passed. The full-host harness remains
unchanged: it drains helper stdout into parsed replies and TCP, with private
container HOME/XDG/runtime directories and fresh worker scopes.

Post-fix validation: **45/45 focused tests**; full default **1,383 passed / 35
skipped**; installed-native Pi **1,416 passed / 2 skipped**; zero failures.
Typecheck, Lua syntax, helper parity and whitespace checks passed; LSP is
unavailable. The full-suite skips still include both opt-in real-mpv tests.
Isolated real SSH passed **12/12 cases**, with both no-player tripwires intact.
Actual mpv **0.35.1 and 0.40.0 each passed 10/10 repetitions** of both sandbox
suites: eight native plus four full-host scenarios per repetition, **120/120
scenarios per version (240 total)**, zero skips or failures. Every repetition
exercised hello/preparation/durable host grant/commit, paused readiness before PCM,
cancel, resumed PCM/EOF, delayed startup, and native namespace failure/recovery.
Natural host EOF required `complete`, scoped release, native disappearance and
exit receipt with no unconfirmed error. Native cases retained lease expiry,
renewal, guardian-crash recovery and synthetic Android EOF checks.

These are isolated Linux software checks, **not real Android validation**.
Namespace proof was not changed. Live namespace-directory evidence remains
pending from the user; no absent live PID namespace is inferred. No actual phone,
provider calls, inference, hardware audio, live-session restart, runtime-setting
change or deployment was used. Existing cached mpv images were reused; the SSH
harness used its disposable public-package image and private loopback network.

## Android 5.4 namespace capability portability

At this historical checkpoint, both helper copies and Lua used validated `uname -r`
and binding-v3 capability identities. Synthetic Android 5.4-vendor layouts deny the osrelease leaf, omit PID
and time entries, and retain readable mount identity. Actual mpv null-output
checks exercise native binding, normal PCM/EOF and guardian-crash recovery using
that controlled namespace view. These are **not actual Android hardware results**.

Shared shell/Lua fixtures cover present-but-denied PID/time links, denied listings,
missing mount identity, failed/malformed/oversized uname, backported time identity,
changed modern time identity, malformed/NUL/truncated directory output, legacy
bindings, hidepid and identity overlays. Mount checks include failed reads after
a valid prefix, identical procfs subtree binds, and unrelated binfmt mounts.
Static checks forbid osrelease reads in both production Lua copies. Existing
startup-error, callback and EOF checks remain enabled.

Final isolated validation: typecheck passed; default **1,381 passed / 35 skipped**;
installed-native Pi **1,414 passed / 2 skipped**; zero failures. Isolated real SSH
**12/12 passed**. The full-suite skips include the two explicitly opted-in mpv
container tests. LSP is unavailable. Logs: `/tmp/bf.PWVD`; earlier logs:
`/tmp/v3-*.log`.

After adding an explicit unpaused Android-fixture API EOF/completion regression,
actual mpv **0.40.0 passed all 12 scenarios**; **0.35.1 passed all eight native
scenarios**, including Android EOF and guardian crash, but the full-host delayed
startup EOF check failed on its final run. Earlier 0.35.1 runs passed all previous
11 scenarios; that checkpoint was **not green**. The production EOF race is
resolved and revalidated in the follow-up section above. A first new EOF assertion
also failed before the fixture waited for stream closure rather than just process
exit. Final logs:
`/tmp/ae.eGaV`. Typecheck/syntax checks were repeated; full default/native suites
were not rerun after this opt-in sandbox-only addition.

Public-package builds used isolated containers; runtimes had no host audio/home/
device mounts. No live sessions, inference, providers, models, deployment, runtime
settings or fence clearing were used. Owned containers/images were removed.
At that checkpoint, nonzero hidepid and present-but-denied namespace links failed
before PCM. Current binding-v4 conditionally supports hidepid as described above;
present-but-denied required links still fail, and phone compatibility remains unverified.
Independent review identified the mount-read and subtree-bind issues corrected
here; final parent review is still required.

## Phased v4 startup and native diagnostics

Fixed two source-proven startup defects: a single 5-second timer covered network,
device preparation, host durable grant, commit locks and native binding; structured
client errors were ignored and eventually mislabeled as upgrade failures. This
establishes software defects, **not the cause of any particular live device failure**.
No live hardware or Android/Termux kernel was inspected or validated.

Final isolated full suites: default **1,381 passed / 35 skipped / zero failures**;
installed-native Pi **1,414 passed / 2 skipped / zero failures**. Typecheck passed;
LSP is unavailable. Default skips include 33 native-UI compatibility cases; both
full runs skip the two explicitly opted-in mpv container tests. Full runs used
private network/PID/home/XDG/temp sandboxes with read-only source and synthetic
user/host records. An earlier run had two stale diagnostic-message assertions;
those assertions now check structured native-bind errors and the final runs pass.

Separately, both actual-mpv suites passed without skips on **0.35.1 and 0.40.0**:
the existing five native scenarios plus four full-host scenarios through
`VoiceWorkerClient → worker → TCP transport → actual shell/Lua → mpv --ao=null`.
The new fixture covers paused startup and cancel/resume, session readiness before
PCM, 5.6 seconds of cumulative hello/prepare/grant/commit delay, and injected
namespace-read failure reaching the client promptly with zero PCM and a recoverable
sealed-nonadmission receipt. Synthesis/alignment are mocked; the player, FIFO,
IPC, binding and receipt paths are real. Readiness does not wait for file-loaded
or PCM. Existing native tests retain frozen/unknown-process refusal coverage.

The real SSH harness passed **12/12** on current source. Its cancelled-grant socket
now drains the structured rejection before awaiting close. Earlier simultaneous
SSH/mpv runs had EOF failures; sequential reruns passed, and that transient cause
was not established. Container package/build networking was permitted; runtimes
had no host home/audio/device mounts. No live session, endpoint, provider, model,
real inference, settings change, deployment or physical playback was used.

This fix requires host transport **and complete matching client/Termux shell/Lua
helpers**; host-only installation improves budgets but cannot add native diagnostics.
Nothing was deployed or restarted. See the [startup contract](endpoint-protocol.md#startup-deadlines-and-errors)
and existing confirmed-stop installation instructions before any later rollout.

## Native renewal ACK compatibility (P1)

Renewal now uses a private, ephemeral exact-nonce file atomically renamed by Lua,
with ACK I/O and callback/timer setup validated before binding. Native failures
are guarded, seal further admission and attempt stop plus quit; deterministic Lua
fixtures cover startup, timer, renewal, start, end-file and shutdown failures.
Both helper variants reject missing, stale, substring and newline-suffixed ACKs.

Validation: typecheck, Bash/Lua/JS syntax, helper parity and whitespace checks
passed. Network/PID-isolated focused tests: **28 passed, 1 skipped** (real mpv
requires an explicitly selected cached container image; it was not run here).
No devices, inference, live sessions or runtime settings were used. Existing
Bash-job PID fixes remain intact. The subsequent time-domain fix uses versioned
bindings; deterministic Lua/helper fixtures cover unsupported pre-5.6 kernels,
unreadable metadata, legacy versions and changed reader namespaces. A stopped-live-PID
regression also exercises actual user/time namespace offsets when unshare is allowed.
Time-domain validation: `npm run check`, syntax/parity/whitespace checks and both
network/PID-isolated full suites passed: default **1375 passed / 34 skipped**;
installed-Pi **1408 passed / 1 skipped**, zero failures. Actual time-namespace offset
fixtures ran successfully for both helper variants. LSP is unavailable. No devices,
providers, inference or live sessions were used. Real old/new mpv compatibility
validation for this format change remains separate (the real-mpv test was skipped).

## Native watchdog v4 validation

Final rerun including the recovery and cleanup regressions:
`npm run check` passed; full default **1369 passed, 34 skipped (1403 total)**;
installed-native **1402 passed, 1 skipped (1403 total)**; zero failures in both.
Both used `npm test -- --test-timeout=120000` in
Bubblewrap with private network/PID namespaces, synthetic `/etc/hosts` and user
records, isolated HOME/TMPDIR/XDG/PI directories, read-only source/toolchain, and
no host audio, devices, home/config/cache, providers or inference. Native here means
installed Pi TUI with inert terminals, **not mpv**. LSP is unavailable; tsc is the
type check. An earlier sandbox lacked localhost/user records, causing a hang and
two extra SSH failures; all three passed after correcting that sandbox, without
production changes.

Both `client/pi-voice-ssh` and `termux/pi-voice-ssh` now require the exact v4
native-watchdog capability reply; the earlier eight wrapper failures are resolved
in both full runs. Old/malformed and incomplete-v4 replies remain rejected.
This is synthetic validation, not deployment approval.

Device fixtures now negotiate `PI_VOICE_PREPARE 4`, publish synthetic foreground
native binding before PCM, and assert explicit `native-process-exit` receipts.
Legacy receipt cleanup, numeric/unknown-scope rejection, uncertain-admission fences,
unknown-boot refusal, lost ACK, delayed exit, fsync failure and cancellation races
remain covered. Latest regressions exercise locked `sealed-nonadmission` for marked
pre-intent scopes (including committed prebinding crashes), journal-before-commit
reservation recovery, owned-job cleanup without reusable-PID signals, and independent
output-barrier retirement while input proof remains pending or times out. These
fakes do not validate real mpv/Lua runtime compatibility.
The SSH desktop fixture's control-only hello and cancelled preparation use v4;
its player tripwire still forbids playback.

### ACK compatibility and reader-time binding validation

After both fixes, typecheck passed; the default suite passed **1,375 tests** and
installed-Pi mode passed **1,408 tests**. Actual unshared time-namespace regressions
passed. Native fixtures cover callback/I/O failures and distinguish proven
pre-5.6 namespace absence from unreadable namespace metadata; an actual old kernel
and fault-injected real mpv were not tested.

Real rootless audio-null runs passed **5/5 scenarios each**, without skips, on
Debian bookworm mpv **0.35.1-4** and Debian trixie mpv **0.40.0-3+deb13u1**.
These exercise the production atomic nonce ACK and versioned native binding,
not the removed shared-script-property API. The isolated SSH desktop harness was
rerun after both helper changes: **12/12 cases passed**. Public package builds
changed no host packages; temporary containers and images were removed. No host
home/device mounts, physical audio, providers, inference, live-session changes or
deployment were involved. Independent source review found no actionable issues.

### Real mpv audio-null and SSH validation after `4d8f0d5`

Final isolated runs: **real SSH 12/12 cases passed**; **real mpv 5/5 scenarios
passed** inside one Node test (zero skips); **20/20 focused helper tests passed**;
`npm run check`, shell syntax, helper parity and whitespace checks passed. No full
suite rerun is claimed here; counts above belong to the preceding checkpoint.
LSP is unavailable. The real SSH run was repeated successfully after the production
renewal fix. Its cancelled-prepare fixture now requires `sealed-nonadmission`.

Real execution found a production renewal ACK bug: mpv 0.37 exposes
`shared-script-properties` as a map, but rejects the `/pi-voice-renewed` subpath.
Lua renewed correctly while the shell reported failure. The interim helper fix
queried the whole map; that approach is now superseded by the private atomic
nonce ACK file because newer mpv versions removed the shared-property API.
At that checkpoint, the original direct Lua fixture's substring ACK assertion
could match a broadcast containing the nonce; it was changed to require the
parsed property map. The real production-API regression failed
before the fix and passed afterward. Production changes require review; these runs
are not deployment approval.

`test/audio-mpv-sandbox.test.ts` creates a rootless networkless container from an
explicitly selected cached image. It copies the fixture, production shell helper
and Lua script, uses a private writable `/work` tmpfs and isolated HOME/XDG/PI paths,
and drops capabilities with no-new-privileges. Container init reaps actual orphan
children. There are no host home/audio/device mounts or published ports.
`--pull=never` prevents downloads during the test itself.

Five scenarios use real mpv with Lua, `--no-config --load-scripts=no --ao=null` and
synthetic PCM: natural EOF; paused expiry despite wrong-scope renewal; matching
renewal beyond the initial deadline then IPC disconnect; production API startup
and expiry receipt; production API renewal followed by guardian SIGKILL. The last
case verifies native mpv remains alive (not a zombie), no premature exit receipt,
actual eventual process disappearance and a recovery-issued `native-process-exit`
receipt. Lua writes its own binding before PCM; PID/start-time/UID/namespaces are
checked against actual procfs. No proof files or kernel oracles are overridden.
The sole player wrapper execs real mpv with null audio, pause and a diagnostic log.
The fixed production 30-second lease is not shortened.

Public Ubuntu 24.04 packages were downloaded into private rootless container
storage with explicit authorization, not installed on the host. Runtime versions:
Node 18.19.1 and mpv 0.37.0. A minimal temporary image recipe is:

```Dockerfile
FROM docker.io/library/ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs mpv coreutils socat util-linux python3 && rm -rf /var/lib/apt/lists/*
```

Build it with `podman build -t pi-voice-real-mpv <temporary-build-directory>`, then:

```bash
PI_VOICE_TEST_MPV_IMAGE=localhost/pi-voice-real-mpv \
  node --import tsx --test test/audio-mpv-sandbox.test.ts
bash scripts/test-ssh-desktop.sh
```

Validation used `env -i` with private HOME/TMPDIR/XDG/PI and Podman storage paths.
The first build failed with `sd-bus call: Access denied` because no user systemd
session was available; a **temporary test-only** containers.conf selecting
`cgroup_manager="cgroupfs"` resolved it. No host service/sysctl/SSH configuration or
privileged workaround was used. An initial image lacked a writable `/work`; the
fixture now supplies its own tmpfs. Focused tests/typecheck ran in network/PID-
isolated Bubblewrap with private HOME/XDG/PI, synthetic user/localhost records and
read-only source/toolchain. Owned containers and image tags were removed.

No live endpoints/sessions, provider/model calls, weights, real inference, host
cache inspection, runtime settings, deployment or push were used. These Linux
null-audio checks do not establish Android support, physical speaker drain,
OS/player-freeze behavior or universal recovery.


## Bounded output stop and covered-ledger diagnostics

Typecheck passed. Focused transport/helper/recovery tests: **83 passed**;
final mounted recovery rerun (including the retained-output case): **37 passed**.
Full default suite: **1324 passed, 33 compatibility skips, zero failures**;
full installed-native suite: **1357 passed, zero skips/failures**. LSP is unavailable.
Runs used `env -i`, private HOME/TMPDIR/XDG roots, network-isolated bubblewrap,
synthetic transports/players and inert native UI. Final full runs also isolated
process IDs and masked host SSH configuration. An initial full run had two wrapper
fixture failures from SSH system-config ownership inside the sandbox; both passed
with that unrelated configuration masked. No live device/SSH/session calls,
provider calls, real inference, hardware, settings changes or deployment occurred.

Regression coverage exercises real delayed matching receipts beyond 1.5 seconds,
startup stop beyond the former prepare timer, wrong/dropped/silent/trickling peers,
and retained fences on the absolute deadline. Both production shell helpers run
against synthetic owned mpv/socat children: queued kernel flock plus actual delayed
child exit succeeds, committed scope without wait receipt sends no ACK, and a
main-body scope lock held beyond 5 seconds rejects without inventing proof. The
real worker cancellation path also survives the former 2-second helper kill timer.
Mounted extension and journal tests distinguish complete covered admission awaiting
receipts from legacy/unknown coverage and preserve the actual failed-retry reason.
The v4 idle-input/covered-output orphan regression retains its original boot-fenced
scope across a failed receipt at the same registered device's moved endpoint,
then retires it only after an exact matching receipt.
These tests do not diagnose the phone's still-missing receipt; local durable scope
and boot evidence remains pending. No journal reinitialization, coverage promotion
or same-boot PID-absence heuristic was introduced.

## User-deployed phone migration check — 2026-09-29

The user restarted Pi/wrappers and supplied local Termux checks. All five installed
`client/pi-voice-*` hashes match the updated checkout. No listed legacy microphone
runtime paths were found; `/proc/sys/kernel/random/boot_id` is readable. Read-only
host inspection found one live Pi instance using the v4 recovery ledger, no old
dead-owner fence, and a covered output scope that retired during inspection.

This confirms installation/state migration only. Microphone operation and live
SSH-disconnect/phone-reboot recovery have not been validated by these checks;
other clients remain unverified. No test recording, playback probe, provider call,
settings change or assistant-initiated restart was performed.

## Shared input-release lifecycle after `263959c`

Input-owned release requests now survive rebind and stop-proof barriers independently
of retained-handle recovery. A single deferred request replaces `recoveredInput`;
input/lease/session epochs, current input/reservation state and actual playback
ownership fence its consumption. Cancellation carries only the matching input's
request forward. Completion retires the reservation without waiting for adoption;
failed stop proof keeps ownership until recovery, including across retry.

Source review traced all `releaseSpeechOwnership` callers, normal/empty/manual-edit/
review/error/cancel input completion, automatic submission, playback/attention,
manual/adopt/reconnect recovery and session lifecycle paths. Four independent static
reviews found no concrete introduced source defect. The testing review identified
that the playback fixture initially started playback only after old lease removal
(`test/index-stop-recovery.test.ts`, then lines 347–353); it now requests playback
while the old rebind barrier is pending and verifies ownership after cleanup and an
unrelated identity error. This is scoped source review, not exhaustive race proof.

Ten new synthetic socket/worker cases exercise manual switching during capture and
reconnect during ASR after normal handle retirement: success, identity error,
withheld output-stop proof plus retry, superseding input and queued explicit playback.
Both success cases fail on `263959c` at the missing lease-removal assertion. Existing
healthy retained-handle/manual-draft cases continue passing. No real ASR is run.

Final validation: `npm run check` passed; focused **113 passed / zero failures**;
full default **1309 passed / 33 compatibility skips / zero failures (1342 total)**;
full installed-native **1342 passed / zero skips/failures**. Final suites ran
sequentially with `env -i`, private HOME/TMPDIR/XDG roots and inert native UI.
Logs: `/tmp/lr.2FSX/{check-final,focus-final,full-final,native-final,regression-before}.log`.
The initial full run had one Unix-socket-path-length failure under the longer temp
root; shortening the private TMPDIR fixed it, and both final full suites passed.
LSP is unavailable; TypeScript and whitespace checks used instead. No helpers or
protocols changed; SSH was not rerun. No live device/session/SSH/config/cache changes,
provider/inference calls, issue-file/demo edits, deployment or push were performed.

## Healthy reconnect lease release after `bc2fed5`

A finished capture now retires its input reservation only while its input/session
identity still matches. The existing rebind barrier and stop-proof guards release
the lease afterward, including when deferred attachment resolution fails; newer
input and actual playback ownership remain protected. No stop proof was relaxed.
Real PhoneInput retained-handle/socket regressions preserve review/manual drafts,
assert `speech.lock/lease.json` removal on same-route success and identity failure,
and retain ownership for superseding input. Without the fix, all four release
assertions fail; the two newer-input cases pass.

Validation: typecheck passed; focused **24/24 passed**; full default **1299 passed /
33 compatibility skips / zero failures (1332 total)**; installed-native **1332
passed / zero skips/failures**. Final runs used `env -i`, private HOME/TMPDIR/XDG
roots, synthetic transports and inert native UI, sequentially. Logs:
`/tmp/vh.Ed6C/{check,focus,full,native,regression-before}.log`. LSP unavailable;
TypeScript and diff checks used instead. SSH was not rerun: helpers/protocols are
unchanged. No live paths/sessions, hardware, providers/inference, runtime settings,
push or `ISSUES.md` changes.

## Integrated host/helper recovery after `eac9b9e`

Final typecheck passed; full default suite **1295 passed / 33 compatibility skips /
zero failures (1328 total)**; full installed-native suite **1328 passed / zero
skips/failures**. Isolated real SSH: **12/12 synthetic cases passed**, including
normal/Stop/Cancel input and v3 cancelled output preparation; no player invocation.
Logs: `/tmp/vf.JR6u/{check,full,native,ssh}.log`.

Both host admission fixtures now send JSON-quoted `"A"`, matching the nullable
identity protocol; no assertions were relaxed. The initial SSH run failed with no
decodable audio: its minimal image lacked the desktop recorder's new Python 3
runtime requirement. Adding `python3` to that image fixed the actual prerequisite;
`ssh-missing-python.log` preserves the failure. Installation docs explicitly cover
local Linux hosts and desktop capture clients; Termux's Android path is unchanged.

All runs used `env -i`, private HOME/TMPDIR and XDG config/cache/data/state/runtime
roots. Full suites ran sequentially; installed-native UI was inert. Rootless SSH
containers used private networking, synthetic PulseAudio/PipeWire sources, no host
mounts/audio devices, ephemeral keys and isolated container storage. Owned containers
and run image were removed; the harness used its scoped SIGKILL cleanup fallback.
LSP unavailable; typecheck, shell syntax, helper parity and diff checks passed.
No live sessions/configuration, providers/inference, hardware, deployment or push.

Host regressions cover original-route retired/journal-only scope replay, durable
clear failure, healthy capture review/manual-edit preservation and clearing proved
input cancellation barriers. Helper checks cover pidfd cancellation, durable retirement
replay, saved canonical recording paths and absent versus literal `"null"` identity.
Fresh phone-style network input/output are covered for completed normal start/stop
and eligible same-device changed-boot proof, not all failure schedules. Local OUTPUT
accounting remains unsupported; unknown Android same-boot dispatch stays fenced.
Unknown saved/current kernel boot is receipt-stop-only, and uncertain/legacy journals
are never promoted. These are synthetic checks, not installed-phone/reboot evidence.

## Live-owner remote output reconnect

Explicit reconnect now passes the shared durable StopRecovery route proof into
worker shutdown, after queued delivery/grants and owned descendants are closed.
Temporary socket/journal tests cover a moved endpoint, changed kernel boot,
foreign identity refusal, concurrent termination/cancellation, a late prepared
handle, withheld late grants, delayed scoped receipts and stale cancellation ACKs.
An extension-host regression verifies the reconnect wiring, original-device cleanup
before an ambiguous new-attachment lookup, and blocked foreground replay until
proof, without resuming playback. Local output uncertainty and legacy
exact-endpoint cleanup are unchanged; no helper/wire protocol changed.

Validation: typecheck passed; full checkout **1214 passed / 33 compatibility skips**;
installed-native full suite **1247 passed / zero skips**, both with zero failures.
Logs: `/tmp/vl.qPJMtm/{check,full,native}.log`. Final runs used `env -i`, owned
HOME/XDG roots and a short owned TMPDIR. The first full run exceeded a Unix socket
path limit; shortening the temporary root passed without a production change.
LSP is unavailable. Isolated SSH was not rerun because the protocol/helpers are
unchanged. No live sessions/devices, providers, inference or runtime settings were
used; native UI and worker transports were synthetic. These checks do not establish
hardware reboot behavior or upgrade uncertain admission into complete coverage.

## Local desktop input wait receipts (partial desktop coverage)

Fresh v4 host journals cover the bundled Linux **local input** path: durable
pre-helper pending accounting, exact scope retention before record, per-child
PID/start-time publication before device exec, cancellation fencing and durable
parent-owned wait receipts. Real helper tests use synthetic children and cover
non-admission, delayed device checks, missing/mismatched evidence, legacy refusal,
guardian death before/after spawn, receipt fsync failure, and recovery after durable
wait publication but before shared idle state. Coordinator tests require matching
owner/generation and both directions idle; uncertain local output still blocks.
Network desktop and Termux input remain host-uncertain; existing journals are never
migrated. Local output is **not implemented** in this stage. The inspected existing
remote guardian and precise local adapter/ownership boundary are documented in
[remaining gaps](endpoint-protocol.md#stage-b-scope-and-remaining-gaps).

Final typecheck passed; full checkout **1210 passed / 33 compatibility skips / zero
failures (1243 total)**; installed-native full suite **1243 passed, zero skips/failures**.
Isolated rootless SSH harness: **12/12 synthetic cases**, no speaker/player invocation.
SSH exercises the unchanged network input contract, not complete input coverage.
Logs: `/tmp/vi.ELouXy/{check,full-short,native,ssh}.log`. Runs used `env -i`, owned
temporary HOME/TMPDIR/XDG roots and inert native UI. The first full run exceeded a
Unix socket path limit; using the shorter owned TMPDIR passed without production
changes. Early focused tests caught a test-string escape and crash-injection hook;
the final real sync-boundary crash fixture passes. LSP is not configured; Bash
syntax and diff whitespace checks passed. Only temporary containers, synthetic
PCM and test-owned configuration were used; no live sessions, devices, application
providers/inference, deployment, settings changes or pushes occurred.


## Stage C review safety fixes

Typecheck passed; isolated full checkout **1175 passed / 33 compatibility skips / zero
failures**; installed-native full suite **1208 passed / zero skips or failures**.
Logs: `/tmp/vr.5rBz04/{check,full}.log`, `/tmp/vn.T3rIvw/native.log`.
Runs used `env -i` and owned temporary HOME/TMPDIR/XDG roots, mocked transports and
inert native UI. An initial full run found an obsolete four-field Termux fixture;
the updated fixture and both final full runs pass. LSP unavailable; Bash syntax,
helper-copy parity and diff whitespace checks passed.

New regressions cover lost Termux ownership before and during stop, old ticket files
without dispatch proof, interrupted desktop ancestor publication and retry sync failure,
and a completed Android start plus idle snapshot while quit remains outstanding.
No live endpoints, SSH, devices, providers/inference, deployment, session restarts or
runtime settings were used. These are synthetic dispatch schedules, not Android
hardware or power-loss validation; no new host orphan-recovery guarantee is claimed.
The earlier SSH results below were not rerun for this follow-up.

## Stage C microphone validation (partial recovery coverage)

Final typecheck passed; full checkout **1168 passed / 33 compatibility skips / zero failures**;
installed-native full suite **1201 passed / zero skips or failures**. Logs:
`/tmp/voice-stage-c-{check,full3,native}.log`. Runs used `env -i`, short temporary
HOME/TMPDIR/XDG state/cache/config/runtime roots, synthetic transports/audio and
inert native UI. LSP unavailable; Bash syntax, helper-copy parity and diff whitespace
checks passed. Initial full validation found old bootless socket fixtures (one hung
suite); the next run found one overlong temporary Unix socket path. Updated fixtures
and a shorter isolated root yielded the final clean runs.

Tests cover durable tickets/runtime loss, actual boot lookup failure and simulated
changed boot, old/mismatched START, stop-before-start, private state, failed syncing,
legacy refusal, direct child wait and early FIFO cancellation, host retention before
START, persistence failure, malformed boot/upgrade rejection, immutable scope identity,
and intentionally uncertain host input after retirement. Android deferred-start tests
now retain the fence after failed/timed-out/interrupted/unknown completion even with
idle info; recognized successful API completion plus actual stop retires normally.

Final isolated synthetic SSH **12/12 passed**, including boot-bound microphone
forwarding/cancellation and unchanged v3 output fences; no server-local capture or
player invocation. Log: `/tmp/pi-voice-ssh-desktop-final.se19EX.log`. Owned containers,
image tag and temporary runtime were cleaned up. No real endpoints, devices,
providers/inference, deployment or session restarts. No Android native cancellation,
hardware power-loss behavior, complete input all-idle accounting or host-level reboot
reclamation is established by these checks.

## Output resilience final validation

Stage A durable output receipts and Stage B remote prepare/grant/covered-ledger validation: `npm run check` passed; full checkout **1114 passed, 33 compatibility skips, zero failures (1147 total)**; installed-native full suite **1147 passed, zero skips/failures**. Logs: `/tmp/voice-output-{check,test,native}.log`. All final runs used `env -i` and owned temporary HOME/TMPDIR/XDG roots. LSP is not configured. An initial run exposed an obsolete raw-playback fixture and an overlong temporary Unix socket path; the v3 fixture and short-root reruns pass.

Isolated synthetic SSH: **12/12 cases passed**, now checking v3 preparation, durable pre-commit cancellation and rejection of late commit as well as microphone forwarding; player invocation remains a tripwire. Log: `/tmp/voice-output-ssh.log`. Podman used temporary HOME/config/cache/data/runtime/state and private container networking, with no host mounts or devices. An initial isolated build required test-only `cgroupfs` configuration; a subsequent run exposed and fixed the wrappers' obsolete v2 readiness check. Final owned containers/image tag were removed by the harness. No live sessions, caches, devices, settings, provider calls or inference were used.

Remaining limitations are explicit: local-output/input all-idle resource coverage, verified same-device reboot discharge, and endpoint-owner death after possible dispatch remain fenced. Non-admission receipts are distinct from actual child-wait receipts. These tests do not establish physical playback latency or Android hardware behavior.

## Scoped output reboot/null-boot follow-up

Production output now accepts a genuine kernel UUID or explicit `null` through preparation, durable host journaling, grant, commit and receipt cleanup. Reboot retirement additionally requires the saved `boot_fenced` capability and the original registered device identity resolved to its current endpoint, with independent matching helper identity at both preparation and recovery. Stale registration/reused-port and missing-identity sentinel collisions are rejected. Tests reject custom/legacy endpoint inference, missing capabilities, mismatched receipts and unknown boots; historical uncertainty remains fenced. Both desktop and Termux helper copies carry the guard. Earlier reboot-gap notes below describe their historical checkpoints.

Validation used `env -i` and owned temporary HOME/TMPDIR/XDG roots: typecheck passed; checkout suite **1193 passed, 33 compatibility skips (1226 total)**; installed-native suite **1226 passed, zero skips/failures**; isolated rootless SSH harness **12 synthetic cases passed**, with no speaker/player invocation. Logs: `/tmp/v.z9CW5Z/{check,test,native,ssh}.log`. LSP is unavailable. No real inference, providers, live devices/sessions, deployment or runtime configuration changes were used. Boot-change and unavailable-procfs tests use controlled temporary fixtures, not real machine reboot or non-Linux hardware. An intermediate run caught a stale prepared-line test parser, corrected before final validation. Running both full suites concurrently caused wrapper lock/registration test interference; the final sequential runs above passed (intermediate logs retained as `*-concurrent.log`).

Local output is deliberately **not complete**: existing process-group cleanup has no durable pre-dispatch per-player reservation/grant and no durable guardian-owned child-wait receipt. Its replacement/draining resources and possible queued dispatch need the full journal/grant/retirement chain before host coverage can be marked complete. Input all-idle coverage also remains uncertain. Same-boot guardian loss after possible dispatch stays fenced; reboot proof does not upgrade unknown admission. Null-boot protocol support does not remove the helpers' existing Bash/GNU tools/flock/mpv requirements or establish general macOS/Windows support.

## Stage B remote-output covered ledger

The v3 ledger now covers every remote output grant and supports durable all-idle retirement and generation-locked dead-owner reclamation. Focused ledger tests use temporary journals and a Unix-socket fake receipt service: multiple scopes, persistence failure, pre-prepare death, stale generation, mismatched boot, exact receipt, untouched input, and legacy/local/input uncertainty. Local-output/input all-idle accounting and reboot discharge remain fenced. Final validation: `npm run check` passed; **120 focused tests passed, zero failures/skips** across output-ledger, StopRecovery, idle orphan, index recovery/stop-proof/input-cancellation, physical admission and coordinator durability tests. The test run used `env -i`, temporary HOME/TMPDIR/XDG roots and `node --experimental-test-module-mocks --import tsx --test`; log: `/tmp/output-ledger-tests.log`. LSP is unavailable. No inference, provider calls or live session changes. Parent-owned helper/harness and full-suite validation are separate.

## Earlier Stage B remote-output prepare/grant checkpoint (partial)

Typecheck passed; **122 focused tests passed, zero failures/skips** using `node --experimental-test-module-mocks --import tsx --test` with the audio-session, TCP playback, worker grant/network/non-admission/recovery/transport, StopRecovery, coordinator and index stop-proof/recovery files. Final runs used `env -i`, temporary HOME/XDG roots and short temporary socket paths. Logs: `/tmp/pi-voice-stage-b-{check,focused}.log`. An initial sanitized run exceeded Unix socket path limits; the short-root rerun passed. LSP is not configured.

Tests use fake mpv/socat, mocked synthesis, temporary journals and loopback/Unix sockets. They cover prepare without player I/O, journal fsync failure withholding grants, boot mismatch, delayed grants after cancellation, old/raw-client rejection, host death before commit, stop-before-commit, possible-dispatch crash fencing, durable receipts and lost ACKs. Earlier exploratory focused runs inherited the harness environment; only the final run is claimed environment-sanitized. No real inference, provider calls, hardware, live session restarts or deployment occurred.

That earlier checkpoint did **not** include complete dispatch/all-idle accounting. Remote-output accounting is now implemented above; local-output resource journaling and verified same-device reboot recovery remain fenced gaps. See [protocol scope](endpoint-protocol.md#stage-b-scope-and-remaining-gaps). Full npm/native/isolated SSH validation is left to the parent review.

## Current checkpoint — never-admitted orphan recovery

`npm run check` passed. Final isolated checkout `npm test`: **1098 passed / 33 compatibility skips / zero failures (1131 total)**. Full installed-native suite: **1131 passed / zero skips or failures**. Logs: `/tmp/voice-idle-final-{check,test,native}.log`. LSP is unavailable. Native checks use inert terminals and mocked providers/transports, not live hardware or real inference.

Regressions distinguish disconnected F5 before dispatch from uncertain/admitted work, suppress false input warnings only with durable idle proof, preserve legacy fences, reject stale owner/generation comparisons, and cover alias-root locking, lock-holder death, deferred release, journal/fsync failure, transient failure in prose/description batches, unsupported locking, Android platform gating and caught heartbeat/attention failures. Independent review found and drove these fixes. At that checkpoint, complete per-scope worker/endpoint admission and retirement accounting was unimplemented. V3 remote-output coverage now supports reclamation; successful saved receipts still do not reclaim an unknown/uncertain owner.

Final runs used short isolated HOME, TMPDIR, XDG config/cache/runtime roots. An initial isolated run exceeded the Unix socket path limit; rerunning with a shorter TMPDIR passed without changing production code. An earlier delegated full run did not isolate HOME and may have created directories in the real model cache through worker imports; it is not claimed to have been cache-write-free. No live Pi/SSH/client restart, lease mutation, device stop, deployment, real inference or provider call was performed. The existing legacy fence remains unresolved; see [incident evidence](troubleshooting.md#disconnected-replay-incident-2026-09-27).

## Historical checkpoint — compact playback UI after `e1511af`

`npm run check` passed; full checkout `npm test`: **1055 passed / 33 compatibility skips / zero failures (1088 total)**; full installed-native `npm test`: **1088 passed / zero skips or failures**. Logs: `/tmp/voice-ui-trim-tests.log`, `/tmp/voice-ui-trim-native.log`. LSP unavailable; TypeScript supplies diagnostics.

Mounted native frames at 40/80/120 columns keep the right-aligned badge and omit the word-quality row, pre-bar separator and `message ` label. At 80 columns the live content is `▶ Playing [━━━━━━━━━━━━━━━━━━━━━━━●] ● live · 702/702`, padded before `[🎧:dev]`; at 40 columns it is `▶ Playing [●] ● live · 702/702 [🎧:dev]`. Narrow timed rows may still omit the count to preserve time and device identity. Progress-layout tests verify one fewer row; `/voice timing` still verifies unknown, estimated, mixed, refined and restored coverage. Retry/refinement behavior and badge/picker controls are unchanged.

These are inert native frames and mocked transport/provider checks, not hardware or live-session proof. No runtime settings or sessions were changed. Operator: run `/reload` in the host Pi session to load this checkout; no client/SSH restart is needed for this UI-only change.

## Historical checkpoint — final review 5 after `fad21f4`

`npm run check` passed; full checkout `npm test`: **1052 passed / 33 compatibility skips / zero failures (1085 total)**; full installed-native `npm test`: **1085 passed / zero skips or failures**. Logs: `/tmp/fix5-check.log`, `/tmp/fix5-test.log`, `/tmp/fix5-native.log`. LSP unavailable; TypeScript supplies diagnostics.

Regressions cover unresolved preemption fencing and retained-scope reconnect, verified deferred handoff, missing-only recovery hydration (including checkpoint-only snapshots), and reconstructable mixed-word retry with exact refined-time preservation and commit-time revalidation. Unknown sparse provenance remains a conservative skip. Review identified the checkpoint-only hydration omission; a focused follow-up fixed it before these final serial suites.

These are mocked transport/alignment and inert native UI checks, not real restart/device proof. Durable restart ownership/proof gaps remain fail-closed as documented in PLAN.md. No hardware, inference, providers, live sessions, settings or SSH changes; `ISSUES.md` and removed demos untouched.

## Previous checkpoint — final review fixes after `fa80347`

`npm run check` passed; full checkout `npm test`: **1038 passed / 33 compatibility skips / zero failures (1071 total)**; full installed-native `npm test`: **1071 passed / zero skips or failures**. Logs: `/tmp/fix4-check.log`, `/tmp/fix4-test-final.log`, `/tmp/fix4-native.log`. LSP is unavailable; TypeScript supplies diagnostics.

- Stop-journal tests cover late admission followed by matching release and cancel ACK, unreleased late scopes, and preemption retaining ownership until matching proof. ACK alone never retires remote handles (`73b4f27`, `e846d98`).
- Actual PhoneInput and filesystem-backed recovery with fake sockets cover accepted single-response AUDIO/OK retirement, completed custom endpoint A followed by active B and restart recovery, plus rejection/EOF without proof (`32d8da6`).
- Automatic recovery stays enabled while deferred other-unit and same-unit measurements race retries. Reload preserves refined quality and all word coverage; estimated retries leave original pending CTC eligible, stale identity remains rejected, and paused highlight/scroll state stays unchanged (`4fb16b9`, `e5232cd`). Coverage expectation updates: `33969ed`.

The initial full run exposed three obsolete unknown-coverage assertions, updated for intentionally persisted word counts. A focused preemption run also reported a handoff failure that its agent reproduced before that change; both final serial full suites above pass. These are synthetic transports/measurements and inert installed-native UI tests, not real restart/device proof. Orphan ownership still fails closed: saved remote receipts do not establish complete durable admission/local-child proof, and no unsafe unlock was added. No providers, models, hardware, live Pi/SSH/client restarts, runtime settings or private exports were used; `ISSUES.md` and user-removed demos remain untouched. The already-landed large retry feature was not rewritten; follow-up fixes remain separate logical commits.

## Historical checkpoint — phase 3 timing retry

Timing reports, worker commands and silent cached-audio alignment retry are implemented. Documentation-pass validation: `npm run check` passed; the four targeted retry files (`index-timing-retry`, `playback-timing-retry`, `worker-client-timing-retry`, `worker-timing-retry`) passed **5/5 tests**, no skips (`/tmp/phase3-docs-retry-tests.log`). LSP is unavailable. These checks use mocked inference/transport and cover command scope, metadata persistence, paused-state preservation, cancellation, bounded cache reads and the no-synthesis path; no real alignment accuracy or live behavior is established. This documentation pass did not rerun the full suite. Earlier suite counts below are historical, not current validation.

## Historical checkpoint — phase 2 and durable scoped recovery

Final implementation validation: `npm run check` passed; full checkout `npm test` **1015 passed / 33 compatibility skips / zero failures (1048 total)**; full installed-native `npm test` **1048 passed / zero skips or failures**. Logs: `/tmp/phase2-final2-{check,test,native}.log`. Final regressions cover persisted user-entry count invalidation and paused yield-mode foreground selection. The separately staged recovery topic also passed typecheck and **78/78** targeted tests (`/tmp/phase2-recovery-staged-validation.log`). No LSP is configured; TypeScript supplies diagnostics.

Phase 2 points **1–6 plus handoff/off presentation** are implemented. Offline tests cover neutral unknown/incomplete-total bars and elapsed-only time, consistent foreground phase/clock/index across A→B preparation, stable paused selection, mounted progress updates without reinsertion, responsive closed badges and pointer targets, normal-prompt/canonical-ID live continuity, ownership-blocked unread Queued state, Connecting during handoff, idle versus silent-paused completion and off without blank rows. Native frame tests use real Pi rendering with synthetic events and mocked transport; they do not establish the original random live-disappearance cause or physical terminal behavior.

Fresh-host recovery fixtures and synthetic socket receipts cover durable original input/output scopes, reconstructed warnings without startup stop I/O, explicit retry through original device identity after endpoint change, wrong-scope receipts, malformed/missing journals, changed configuration, matching retirement and newer-generation protection. **Phase 1 remains partial:** durable admission/local-child proof coverage is missing, and the orphan fence is never automatically reclaimed, even after every saved receipt succeeds. Broader protocol work is separate, not an unsafe unblock.

Earlier repeated cold-history performance failures also reproduced on baseline. The minimal fix avoids synchronous cold preparation in progress rendering and adds bounded background yields; no performance limits were relaxed. Both final full suites above pass after that fix. Phase 3 timing commands were still pending at that checkpoint; the current implementation is described above.

No live/provider/inference/hardware validation, runtime configuration/private-data access, Pi/SSH/client/session restart or push. User clarification: the prior PC crash was user-caused, not product-attributed; `docs/assets/demo*` was explicitly removed by the user and stays removed. Untracked `ISSUES.md` remains untouched. Historical notes/counts below retain their original checkpoint scope.

## Historical phase 1 checkpoint — highlighting and safety

Final serial validation: `npm run check` passed; `npm test` **994 passed / 33 compatibility skips / zero failures**; installed-native full `npm test` **1027 passed / zero skips or failures**. Logs: `/tmp/phase1-final-{check,test,native}.log`. No LSP configured. Native overrides use installed Pi `dist/index.js` for `PI_VOICE_TEST_AGENT_MODULE`, its `node_modules/@earendil-works/pi-tui/dist/index.js` for `PI_VOICE_TEST_TUI_MODULE`, and `dist/core/keybindings.js` for `PI_VOICE_TEST_KEYBINDINGS_MODULE`. An initial incorrect agent-module override failed imports, then was corrected.

Native AssistantMessage tests assert effective intensity on first and continuation lines through streaming/final rendering with audio independently active. Mock integration covers any-current-utterance failure, withheld ACK ownership, matching proof, newer failure races, paused source abort after device adoption, persistent device warning rows and original-handle reconnect. These are offline tests, not live hardware/inference confirmation. No runtime settings or live sessions were changed.

Phase 1 remains partial: durable speech fencing survives process expiry, but restarted-process opaque-handle recovery and diagnostic reconstruction are not implemented. UI 1–6 and timing changes remain pending. See PLAN/FINDINGS for the missing-untracked-demo preservation limitation.

## Previous checkpoint — completed live-follow intent

The user clarified that the historical output `○ Idle · [full bar] 0:35 / 0:35 · message 669/669` after the latest response was wrong: caught-up unpaused playback must remain Playing + red `● live` between turns. The mounted regression now runs full message_end → turn_end → worker finish and checks released audio ownership with persistent live, lease-free F8 pause, queued next-response single-F8 resume, F6 last-message selection and completed historical Idle. F7 completion checks are viewport-independent. Earlier completed-Idle assertions below describe superseded behavior, not the current contract.

Validation: `npm run check` passed; full checkout **971 passed, 33 compatibility skips, no failures**; full installed-native **1004 passed, no skips/failures**. Logs: `/tmp/voice-live-final.log`, `/tmp/voice-live-native-final.log`. No LSP server configured; typecheck substitutes for diagnostics. All transport/provider behavior was mocked; native terminals were inert. No hardware, real inference, provider calls, live session restarts or runtime settings changed. Operator: host `/reload` only, when ready; not performed here.

## Previous checkpoint — playback clock and truthful live/work frontiers

`npm run check` passed. Full checkout: **971 passed, 33 compatibility skips, no failures**; full installed-native: **1004 passed, no skips/failures**. Logs: `/tmp/pi-voice-review-fixed-full.log`, `/tmp/pi-voice-review-native-final2.log`. No LSP server configured; TypeScript and diff checks used instead.

- Shared worker-clock fake-time regression: 1 second consumed, 9 seconds starved, append 2 seconds, then 125 ms reports **1.125 seconds**, not 3. New PCM cannot inherit empty-buffer wall time; fallback reanchors to real device feedback. Pause/drain/seek and estimated-not-stop-proof tests remain passing.
- Production host tests distinguish canonical-context/coordinator waits (Queued), actual description API dependencies (Describing), active coalesced joins, cancellation, cache replay and rejected attempt budgets. Context-only replay no longer flashes Describing.
- Separate consumption tracks final description-unit completion, including cached/persisted replay with skipped units, without changing zero-length highlight ranges. Earlier/unplayed/pending units and paused playback remain non-live. Terminal omissions consume silence; closed empty text/code fences use the same parser state as speech, while unfinished fences remain pending.
- Initial full runs exposed a backfill test synchronization assumption: the added activity-cleanup promise turn can send live work through the coordinator's existing 100 ms retry. Clean baseline passed; the test now boundedly awaits both expected requests instead of only immediate turns. Final full runs above pass.

All evidence is offline synthetic clock/transport or inert native UI. No providers, real inference, hardware, live Pi/SSH/client restart or runtime settings were used. Headphone badge/mouse behavior and short phase labels remain unchanged. Host `/reload` is left to the user; no client update is needed.

## Previous checkpoint — compact phases and native-frame history gap

Final serial reruns: `npm run check` passed; full checkout `npm test` **956 passed, 33 compatibility skips, no failures**; full installed-native `npm test` **989 passed, no skips/failures**. Logs: `/tmp/pi-voice-ui-final.log`, `/tmp/pi-voice-ui-native-final.log`. Native run sets `PI_VOICE_TEST_TUI_MODULE`, `PI_VOICE_TEST_AGENT_MODULE` and `PI_VOICE_TEST_KEYBINDINGS_MODULE` to the installed Pi modules (command pattern below). LSP diagnostics were unavailable (no server); TypeScript and whitespace checks passed. Direct focused runs without the test runner's environment sanitization failed route/style assertions; the sanitized focused and both final full runs passed.

`test/index-live-progress.test.ts` mounts the real native widget lifecycle and captures rendered frames with synthetic events/mocked transport. New checks deliberately remove `PlaybackHistory.status()` during streaming and chronological Tail to exercise the missing-history playbar gap and retained active-intent bar; initial/stopped idle without history must not fabricate one; completed live follow retains its intent-backed bar. This is an offline controlled reproduction, **not a diagnosis of the original user's random live disappearance**. Phase propagation, paused precedence, known/unknown timing, separate native error-red `● live`, block/tool boundaries, first-line headphone badge, stop warnings and resizing are covered by mocked tests. No physical terminal write timing, arbitrary dock pressure, real provider preparation or hardware behavior is established.

Review regressions also cover consumed streaming audio with pending versus exhausted work, stale multi-utterance terminal failures, partial prose/fence arrivals without unrelated worker events, silent Markdown tails, partially consumed historical Tail, retained stop warnings and native pointer press→progress update→release.

Presentation at this historical checkpoint: Idle, Playing, Paused, Synthesizing, Loading, Describing, Connecting, Queued; `● live` replaces time only at the unpaused chronological edge, including caught-up next-output waits. End/Alt+T is viewport-only. `[🎧:device]` is at the right end of the first VoiceUI line, including idle status—not an idle-footer click target. See [usage](usage.md#highlighting-and-status).

No hardware, provider calls, real inference, live Pi/SSH/client restart or runtime-setting changes. Clients are unchanged in this UI diff; user host `/reload` only, not performed here. Historical counts and evidence below remain checkpoint-specific.

## Historic checkpoints

The remaining sections preserve earlier validation, not current suite counts or UI claims. Old Waiting labels, plain badges, idle-footer targets and earlier picker shortcuts describe their original checkpoints.

## Historic checkpoint — restored-pin current confirmation

`npm run check` passed. Full checkout: **949 passed, 29 compatibility skips, 0 failures (978 total)**. Full installed-native: **978 passed, no skips/failures**. Logs: `/tmp/pi-voice-restore-full.log`, `/tmp/pi-voice-restore-native.log`. No LSP server configured.

Fresh extension-host/session-restore regressions cover same-current confirmation during fake playback and recording, changed endpoints/generations, unknown/unavailable registrations and failed cleanup. Restored route snapshots use metadata only, after startup cleanup succeeds; they neither start I/O nor claim readiness. Active current-selection descriptions were checked; the obsolete Local-default sentence in usage was removed. No live sessions, inference/providers, user configuration, ISSUES or demo assets changed.

## Alt+S/current selection after `7a63f7e`

`npm run check` passed. Full checkout: **942 passed, 29 compatibility skips, 0 failures (971 total)**. Full installed-native: **971 passed, no skips/failures**. Logs: `/tmp/pi-voice-alts-full.log`, `/tmp/pi-voice-alts-native.log`. No LSP server configured.

Alt+S replaces the picker shortcut, not native Alt+D deletion; configured Voice collisions retain precedence. Exact current ID initializes native selection, including the visible window for a 50-item list; mounted tests exercise Enter/arrows near the final item, duplicate-name ID mapping and unchanged mouse hitboxes. Non-TUI display ordering preserves values. Routing tests cover unavailable current and same-current confirmation (manual sticky pin without stopping/pausing). Badge hints remain absent. Earlier shortcut/default-selection statements below are historical.

Validation iterations caught the old Local-default assertion. Concurrent full suites collided on their fixed test port, so final suites ran serially. One serial checkout run hit the existing render-cost timing assertion (4 widget builds versus 3); the full rerun passed without changing that test. No live inference/provider/audio/SSH/session/config changes; untracked ISSUES/demo assets preserved. Operator action: host extension `/reload` only; no client update/restart. Physical terminal/mobile behavior remains unvalidated.

## Native device badge picker

Streaming progress follow-up after `36d9b3b`: `npm run check` passed; full checkout suite **940 passed, 29 compatibility skips**, full installed-native suite **969 passed, no skips**, no failures. `test/index-live-progress.test.ts` mounts the extension widget callback/replacement path with mocked transport: pending/live text growth, warm-state events, block boundaries, ticks, pause, Stop, finish and shutdown. It reproduces premature Idle labeling, **not the reported literal disappearance**; live cause remains unconfirmed. Progress/footer badges no longer display shortcut hints; Alt+D binding/help remain unchanged. Logs: `/tmp/pi-voice-live-progress-tests.log`, `/tmp/pi-voice-live-progress-native.log`.

Final integration after `e44775d`: `npm run check` passed; full `npm test`: **939 passed, 29 compatibility skips, 0 failed (968 total)**. The **full installed-native `npm test`** passed **968 tests, no skips/failures**, including all optionally gated cases, not only the 27 picker tests. No LSP server is configured; TypeScript and diff checks passed. Logs: `/tmp/pi-voice-integration-full.log`, `/tmp/pi-voice-integration-native.log`.

The actual `index.ts` picker is exercised in a mounted 40-column native screen: long duplicate Unicode names, colliding short IDs, visible current marker before the name, pointer selection persisting the full ID, and Enter's default local choice. Streaming route-switch checks retain the exact suffix through paused same-route reconnect; input-only switching finalizes review-only dictation without pausing the next manually submitted turn's automatic narration.

Picker tests cover read-only open/cancel, duplicate names/short-ID prefixes, invalid names, current marking, expiry both before choice and during stop, actual stop barriers/failure, sticky silent selection, retained draft/viewport, newer controls, dynamic session replacement and shutdown. Native tests send SGR press/release bytes through `handleTerminalInput`, including Unicode/truncated badges, changing input/progress rows and the real built-in footer; both badge opening and option selection use mounted SGR press/release, and arrows/Enter/Escape use Pi's native SelectList overlay. Installed InteractiveMode/ExtensionSelector integration covers pending select/confirm preservation, cancel/commit/abort focus restoration, nested overlays, prompt expiry, and 40-column Unicode footer badges. These tests use the real installed lifecycle methods and renderer without starting a live session or inference. A playing-host test verifies badge clicks do not pause, start audio or disable narration following. Alt+D default deletion semantics and configured microphone/follow-shortcut conflicts are checked.

The checkout's older TUI skips 25 optional picker/lifecycle cases and four viewport mouse/banner cases (29 total); the installed newer TUI executes all 29. Touch uses the same SGR path, but physical phone gestures were not tested. This latest picker/routing feature has not been live-validated; earlier positive user reports apply only to their earlier features. No live SSH/client/audio session, inference, provider calls, personal keybinding changes or client upgrades were used. Only the host extension needs `/reload`; see [operator steps](installation.md#sticky-device-selection-and-selected-device-badge).

## Explicit device routing and first-row selection badge

Final `npm run check` passed; full `npm test`: **923 passed, 3 existing compatibility skips, 0 failed (926 total)**. Installed-native inert-terminal key/scroll/marker tests: **307 passed, no skips/failures**. Shell syntax/diff checks passed; no LSP configured.

New fake-device checks cover name/ID selection under ambiguous attachments, sticky ordinary controls/reload, auto-mode return, deterministic wrapping/empty/one/missing/duplicate cycles, non-submitting capture finalization and manual draft preservation, confirmed-stop failure retaining pin/tag/lease, canonical cursor/new endpoint, read-only queries and unchanged custom endpoints. Attention requests carry the manual origin pin without identity guessing and retain cancellation/ownership checks. Native widget-factory tests verify first-physical-row placement, idle footer exclusivity, bounded wide names, precedence and stable mobile rows. Existing navigation, paused code-preview, stale-context, opaque-handle and scroll tests remain passing.

No live tmux/SSH/client session, hardware microphone/audio, inference or provider calls were used. The optional isolated real-SSH suite was not rerun: client changes only replace the identity wording with `Connected as`. Logs: `/tmp/voice-final-tests-2.log`, `/tmp/voice-final-native.log`. See [operator steps](installation.md#sticky-device-selection-and-selected-device-badge).

## Persistent client-name validation (previous handoff)


Latest clarification replaces environment/hostname naming with a first-interactive-run prompt and a local persisted file. `npm run check` passed; full `npm test`: **917 passed, 3 existing TUI compatibility skips, 0 failed (920 total)**. Isolated real SSH: **12/12 cases passed**; only the client receives `/work/device-config/pi-voice/device-name`, through a wrapper-scoped `XDG_CONFIG_HOME`. No UI/API changes or new native-TUI run.

The normal suite invokes `test/device-name-pty.py` using **Python 3's standard library** (test-only dependency). Both wrapper copies are tested with real controlling PTYs and fake SSH: first prompt/save/reuse, Ctrl+C/EOF, hidden invalid controls, Unicode/quotes, preserved SSH stdin and legacy ID, private permissions, configuration errors, concurrent first prompts and 12-way new-ID publication. Other wrapper tests validate file boundaries, ignored obsolete environment values, fail-fast noninteractive behavior and registration failures; router tests prove duplicate names cannot select or repin devices. No hardware, inference, live sessions or user configuration is touched. See [upgrade/operator steps](installation.md#upgrade-device-name-support).

## Device-setting review follow-up

`npm run check` passed. Full `npm test`: **915 passed, 3 existing TUI compatibility skips, 0 failed (918 total)**. Installed-native key/scroll/marker tests: **307 passed, no skips/failures**.

Command tests now use distinct command/event context wrappers sharing a session facade. Setter regressions cover same-session success, session-epoch replacement and a dynamic session-ID change during a wait; these are synthetic checks, not live SDK identity proof. Input-only changes preserve delayed replay acquisition and usable F8 controls, while capture-stop confirmation still precedes application. Existing output/device rebind and failed-stop checks remain covered. No live configuration, SSH/client session, hardware, inference or provider calls were used. Reload and client-update instructions are unchanged.

## A keyboard mapping validation

Synthetic validation: `npm run check` passed; full `npm test` **910 passed, 3 existing TUI compatibility skips, 0 failed (913 total)**. Installed-native key/scroll/marker tests **307 passed, no skips/failures**, using inert terminals. `test/native-keys.test.ts` checks actual native F4/F5 byte decoding and default-binding conflicts without loading personal keybindings. Registration tests cover default/custom/disabled microphone bindings, F4 deduplication, custom F5 collision/F11 support and independent F5 replay; mocked capture starts through F4. No new live capture, inference or OS-wide compatibility claim.

The user previously confirmed successful Linux Mint capture/transcription; that prior LIVE result is now recorded in `FINDINGS.md` and `PLAN.md`, not presented as a test of this keyboard change.

## B device-selection review validation

`npm run check` passed. `npm test`: **914 passed, 3 existing TUI compatibility skips, 0 failed (917 total)**. The installed-native command below (with inherited `PI_VOICE_*` variables removed first) passed **307 tests, no skips/failures**. `bash scripts/test-ssh-desktop.sh` passed all **12 synthetic cases**; owned client/server containers and the run image were removed (container stop required the script's scoped SIGKILL fallback).

Regressions cover stale setters across input cancellation, metadata waits and session replacement; persistent failed input-stop barriers and explicit reconnect recovery; metadata-only lookup failures versus stop failures; safe local-hostname notices; full desktop/Termux wrapper rejection before SSH/bridge activity, including NBSP/BOM-only names; and byte-for-byte config immutability for query/reconnect after setters. Tests use synthetic inputs only, with no inference, provider calls or live-session changes.

## Opt-in desktop → SSH → server test

With rootless Podman and the checkout's npm dependencies installed:

```sh
bash scripts/test-ssh-desktop.sh
npm run check
npm test
```

The opt-in script builds **two Ubuntu 24.04 containers** (initial build downloads
Ubuntu packages), then uses the production `pi-voice-ssh` wrapper, client listeners,
ticket protocol and host `PhoneInputClient`/ffmpeg decoder. Runtime networking is a
shared **private** loopback namespace: no published ports, host networking, home
mounts, audio devices, or host sockets. SSH keys/known-host pinning are ephemeral;
only the client receives the login private key. No inference or application-provider
calls. Container Node 18 receives a test-only `Promise.withResolvers` polyfill.

**12 cases:** real PulseAudio synthetic source (timer completion, explicit Stop,
Cancel), dead input endpoint/no local fallback, concurrent-wrapper environment
drift, rejected monitor source, unavailable PulseAudio, real PipeWire synthetic
source, unavailable audio-server environment, finite synthetic PCM/natural EOF,
empty source, and startup failure. The last three substitute only `pw-record`;
SSH, protocol, encoder and decoder remain real. Every case checks dynamic reverse
forwarding, v4 playback prepare/cancel/late-commit rejection and admission-ticket cancellation/ACK. No server-local
recorder invocation is allowed. Natural EOF must decode all 240,000 synthetic
samples; successful live virtual sources require finite, nonzero-energy PCM.

The drift case documents that a concurrent wrapper reuses the existing bridge's
**launch environment**, not its new `PULSE_SERVER`. Fresh bridges inherit the local
wrapper environment, not the remote server's environment. No active bridge is
silently restarted to apply environment changes. PipeWire selection is attempted
first when its default source is available; `PULSE_SERVER` controls PulseAudio,
not that PipeWire selection. Neither unavailable endpoint nor capture error permits
server-local fallback. Router/identity/tmux policy and Termux parity are separately
covered by the existing `npm test` fixtures (`device-router`, `connection-device`,
`ssh-wrapper`, `client-scripts`, `recorder-stop`, `phone-input`). These are **not** an
Android emulator, real microphone, ASR accuracy, or Mint hardware-cause test.
Playback exercises hello and cancelled preparation only; the player is a tripwire, not a virtual playback smoke test.

Cleanup traps remove the dependent client **before** its server, then the run's
image tag and temporary keys. Failures retain their exit status and print bounded
synthetic-only diagnostics (last 4096 bytes per log, 10-second command deadline);
removals have 15-second deadlines (plus one second before forced termination).
Cleanup ignores subsequent INT/TERM, disables EXIT recursion, and removes only
this run's names and temporary directory; cleanup failures also fail the run. Containers carry `io.pi-voice.ssh-desktop=<run-name>`. After an untrappable
SIGKILL, inspect ownership before removing only that run's resources:

```sh
podman ps -a --filter label=io.pi-voice.ssh-desktop
# Substitute the exact inspected run name; never use prune or kill host sshd.
run='pi-voice-test-<pid>-<random>'
podman rm -f "$run-client"
podman rm -f "$run-server"
podman rmi "$run"
```

Review validation: **12/12 SSH cases passed** on real PipeWire **1.0.5** / PulseAudio
**16.1**, with both owned containers, image tag and temporary keys removed.
Six isolated repeated-signal cleanup regressions passed. Final `npm test`:
**902 passed / 3 compatibility skips / 0 failed (905 total)**; typecheck passed. The three skips remain the older project
TUI's MouseRegion/banner cases. No test containers remained.

### Desktop client fix deployment

`pw-record` help is probed with bounded time/output before recording, outside the
admission fence; cancellation is rechecked under the fence before launch. Use
`--raw` when advertised, otherwise the older native writer's implicit raw stdout.
No semver guessing: newer libsndfile defaults can be WAV (1.4.0) or AU (1.4.9/1.6.8),
not PCM suitable for ffmpeg's raw input. New-family coverage is **fixtures only**:
argv-sensitive writers, header traps and real encoder/decoder sample counts, plus
failed/oversized/timed-out help and meaningful recorder startup failures. No second
PipeWire image/version was tested. Ticket-line tests fragment actual TCP writes
and cover trailing buffered bytes, size bounds, timeout and EOF.
The bridge exits on TERM rather than restarting listeners; hardware causality
remains unconfirmed.

Update **all `client/pi-voice-*` scripts on the local desktop**, not just the remote
host extension. After confirming capture/playback stopped, close that desktop's
voice wrappers and reconnect when convenient; retain the remote tmux session.
Do not delete stop-proof state or restart host sshd. Host `/reload` alone cannot
fix an older client executable. See [installation](installation.md) for copying
scripts and migration safety. From a **local desktop terminal**, after verified
capture stop (if unconfirmed, restore the original route and retry Stop; do not
force-clear leases), close all that desktop's voice wrappers normally, then:

```sh
VOICE_HOST='your-ssh-host' # existing SSH alias or user@hostname of the server
VOICE_REPO='/absolute/path/to/pi-voice' # checkout on that server, not the local client
CLIENT_BIN="$HOME/.local/bin" # local helper directory used by PATH/custom launcher
mkdir -p "$CLIENT_BIN"
scp "$VOICE_HOST:$VOICE_REPO/client/pi-voice-*" "$CLIENT_BIN/"
chmod 755 "$CLIENT_BIN"/pi-voice-*
"$CLIENT_BIN/pi-voice-ssh" "$VOICE_HOST"
```

Replace the example host and server checkout; override `CLIENT_BIN` for your local installation. The quoted SCP wildcard matches remote files, not local ones.
Use the usual SSH options/remote command if required; reattach the existing remote
tmux session. This copies the **host checkout**, not unpushed GitHub content. Update
custom installed script paths too. Wrapper restart is required after verified stop;
no lease/fence deletion, host-service restart or live update was performed here.

## Fixture suite

Run `npm test` for the fixture-based suite and `npm run check` for type checking.
The test runner defaults to four concurrent test processes and keeps the existing
`test/*.test.ts` selection. It removes `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`,
`TMUX`, `TMUX_PANE`, and `PI_VOICE_*` from the child environment, except explicit
`PI_VOICE_TEST_*` opt-ins (such as `PI_VOICE_TEST_TUI_MODULE`). Other environment
variables and the invoking shell are unchanged. Worker imports can create directories under HOME even with inference mocked: for a cache-isolated run, set HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME and XDG_RUNTIME_DIR to an owned temporary root, and use a **short** TMPDIR (Unix socket paths are length-limited). Setting only `PI_VOICE_CACHE_DIR` is insufficient because the runner removes it. Tests provide their own mocked
providers, devices, and temporary configuration; this is not a live-device test.

Latest UX regression coverage includes actual source-word counts before checkpoint thinning,
paused mixed→refined metadata updates without cursor/scroll movement, explicit startup and
pending playback states, native 20/32/40-column `/voice timing` report wrapping (including four-digit totals),
and stable background rows. Sentence tests cover the reported `10/10. Run /reload` text,
Markdown/invisible markers, every formatted delta split, shared code/prose navigation,
ordered prefixes, decimals/versions, lowercase continuations and UTF-16 offsets.

Documentation audit against source `d4cf759`: typecheck passed; **865 passed,
3 skipped, 0 failed (868 total)** in the final full rerun. The older project TUI skips two MouseRegion button
cases and the native banner. Two earlier audit full runs each failed the widget-write count in `index-render-cost.test.ts:68`; its targeted rerun and the final full run passed. This intermittent failure remains unresolved, with no test/source changes.

Installed Pi TUI checks: **306 passed, no skips/failures**
against an inert terminal, including actual click dispatch, glyph-stable post-wrap
highlighting, tables/graphemes and baseline-preserving unmappable probes. Navigation
checks cover one live/completed cursor, Tail, pause intent and asynchronous source
finalization. Worker/provider mocks cover nonblocking preload, first prose before
message end, foreground priority, last-consumer abort and scoped cleanup episodes.
Automatic-bottom tests cover exact arrival, in-band suppression, growth, resize and manual/paused guards; delayed-acquisition return-tail coverage uses a fake viewport. They do not combine natural cached-Markdown arrival, reflow and delayed acquisition into one end-to-end case.

These fixture tests use inert terminals, temporary files, subprocesses and some loopback sockets, not live phone sessions, real inference or end-to-end latency measurements. The user now reports the newest batch “seems fixed” and confirms native bottom-follow/banner behavior, supplementing earlier windowed-follow, ASR, fast-UI and no-flicker feedback. This is limited live confirmation, not all-device/error-cause validation.

Full installed-native rerun on the test machine: `PI_AGENT_ROOT` auto-discovers global Pi in the active Node environment; override it with the installed package root if Pi lives elsewhere. `npm test` sanitizes inherited connection/voice variables while retaining test overrides:

```sh
PI_AGENT_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY -u TMUX -u TMUX_PANE \
  PI_VOICE_TEST_TUI_MODULE="$PI_AGENT_ROOT/node_modules/@earendil-works/pi-tui/dist/index.js" \
  PI_VOICE_TEST_KEYBINDINGS_MODULE="$PI_AGENT_ROOT/dist/core/keybindings.js" \
  npm test
```

Node test options are forwarded before the test glob, for example:

```sh
npm test -- --test-name-pattern='test runner'
npm test -- --test-concurrency=1
```
