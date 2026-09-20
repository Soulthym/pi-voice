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

Validation for this change: 506 passed, one dependency-native-banner compatibility skip;
installed Pi TUI viewport tests 10/10 passed against an inert terminal. This is not live
phone evidence. The user separately confirmed working paused/unpaused navigation and no flicker.

Node test options are forwarded before the test glob, for example:

```sh
npm test -- --test-name-pattern='test runner'
npm test -- --test-concurrency=1
```
