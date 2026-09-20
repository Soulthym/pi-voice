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

Final docs reconciliation against source `d4ce9c9`: typecheck passed; **858 passed,
3 skipped, 0 failed (861 total)**. The older project TUI skips two MouseRegion button
cases and the native banner. Installed Pi TUI checks: **300 passed, no skips/failures**
against an inert terminal, including actual click dispatch, glyph-stable post-wrap
highlighting, tables/graphemes and baseline-preserving unmappable probes. Navigation
checks cover one live/completed cursor, Tail, pause intent and asynchronous source
finalization. Worker/provider mocks cover nonblocking preload, first prose before
message end, foreground priority, last-consumer abort and scoped cleanup episodes.
These are not live phone, real inference or end-to-end latency measurements. Earlier
user confirmations cover windowed follow, ASR, fast UI and no flicker; the newest batch
is not live-tested.

Installed-native rerun (adjust the global installation path on other hosts):

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
