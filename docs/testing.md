# Tests

Run `npm test` for the fixture-based suite and `npm run check` for type checking.
The test runner defaults to four concurrent test processes and keeps the existing
`test/*.test.ts` selection. It removes `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`,
`TMUX`, `TMUX_PANE`, and `PI_VOICE_*` from the child environment, except explicit
`PI_VOICE_TEST_*` opt-ins (such as `PI_VOICE_TEST_TUI_MODULE`). Other environment
variables and the invoking shell are unchanged. Tests provide their own mocked
providers, devices, and temporary configuration; this is not a live-device test.

Node test options are forwarded before the test glob, for example:

```sh
npm test -- --test-name-pattern='test runner'
npm test -- --test-concurrency=1
```
