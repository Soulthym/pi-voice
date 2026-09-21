# Tests

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
forwarding, v2 playback hello and admission-ticket cancellation/ACK. No server-local
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
Playback is hello-only; the player is a tripwire, not a virtual playback smoke test.

Cleanup traps remove the dependent client **before** its server, then the run's
image tag and temporary keys. Failures retain their exit status and print bounded
synthetic-only diagnostics (last 4096 bytes per log); cleanup failures also fail the
run. Containers carry `io.pi-voice.ssh-desktop=<run-name>`. After an untrappable
SIGKILL, inspect ownership before removing only that run's resources:

```sh
podman ps -a --filter label=io.pi-voice.ssh-desktop
# Substitute the exact inspected run name; never use prune or kill host sshd.
run='pi-voice-test-<pid>-<random>'
podman rm -f "$run-client"
podman rm -f "$run-server"
podman rmi "$run"
```

Validated: **12/12 SSH cases passed**, deliberate harness TERM returned **124** with
both containers removed, and final `npm test` **872 passed / 3 compatibility skips /
0 failed (875 total)**; typecheck passed. The three skips remain the older project
TUI's MouseRegion/banner cases. No test containers remained.

### Desktop client fix deployment

The corrected `pw-record` invocation uses `-` for raw stdout, **not `--raw`**
(unsupported by Ubuntu's PipeWire 1.0.5). The bridge now exits on TERM rather than
restarting listeners during final-wrapper cleanup. Both regressions fail against
`4965fce`; hardware causality remains unconfirmed.

Update **all `client/pi-voice-*` scripts on the local desktop**, not just the remote
host extension. After confirming capture/playback stopped, close that desktop's
voice wrappers and reconnect when convenient; retain the remote tmux session.
Do not delete stop-proof state or restart host sshd. Host `/reload` alone cannot
fix an older client executable. See [installation](installation.md) for copying
scripts and migration safety.

## Fixture suite

Run `npm test` for the fixture-based suite and `npm run check` for type checking.
The test runner defaults to four concurrent test processes and keeps the existing
`test/*.test.ts` selection. It removes `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`,
`TMUX`, `TMUX_PANE`, and `PI_VOICE_*` from the child environment, except explicit
`PI_VOICE_TEST_*` opt-ins (such as `PI_VOICE_TEST_TUI_MODULE`). Other environment
variables and the invoking shell are unchanged. Tests provide their own mocked
providers, devices, and temporary configuration; this is not a live-device test.

Latest UX regression coverage includes actual source-word counts before checkpoint thinning,
paused mixed→refined metadata updates without cursor/scroll movement, explicit startup and
pending playback states, native 20/32/40-column count wrapping (including four-digit totals),
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

Installed-native rerun (adjust the global installation path on other hosts; unlike `npm test`, this direct command does not remove arbitrary `PI_VOICE_*` variables—use a clean environment, retaining only the test override):

```sh
env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY -u TMUX -u TMUX_PANE \
  PI_VOICE_TEST_TUI_MODULE=/home/curiosithy/.nvm/versions/node/v26.7.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js \
  node --import tsx --test --experimental-test-module-mocks --test-concurrency=4 \
  test/index-native-scroll.test.ts test/narration-marker-native.test.ts
```

Node test options are forwarded before the test glob, for example:

```sh
npm test -- --test-name-pattern='test runner'
npm test -- --test-concurrency=1
```
