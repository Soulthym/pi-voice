# Tests

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
