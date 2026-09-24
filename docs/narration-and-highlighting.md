# Narration and highlighting

[← README](../README.md) · [Preprocessing and cache](preprocessing-and-cache.md) · [Models](models-and-privacy.md)

## Prose and Markdown

Pi Voice buffers streaming Markdown until a complete sentence or literal newline is available. It does not force early clause/word cuts or flush unfinished sentences during a generation stall. Terminal soft wrapping is not a boundary; message end drains the final unterminated unit. Mocked streaming tests demonstrate first prose submission before message end, not measured real-device start latency. Pool preload warms asynchronously rather than blocking playback; its completion cannot reset speaking UI. Historical descriptions yield priority to foreground speech, and an abandoned description aborts when its last consumer leaves (shared consumers keep it alive).

The playback worker generates up to three sentences concurrently by default and delivers their audio in source order. Lookahead is bounded to the selected worker count even while paused; Stop cancels queued inference and interrupts busy model processes. Cached Opus can play without launching a TTS model process. `/voice tts-workers <1..8>` tunes and persists this host-side limit live (default 3, selected by historical production-pool q8 CPU benchmarks, not measured live phone throughput). Persisted `ttsWorkers` takes precedence over the legacy `PI_VOICE_TTS_WORKERS` fallback. Decreases limit new lookahead immediately but retain already-started results in order, retiring excess workers as they become idle; increases expand lookahead without restarting audio. Concurrency does not invalidate cached assets or alter pause/ownership state. Microphone transcription is not parallelized.

Kokoro cannot infer more than roughly 510 phonemes in one call. Long sentences are phonemized without truncation, generated in internal windows, then joined into one playback/alignment unit. This avoids dropped endings, but very long sentences take longer before playback begins and internal seams may affect prosody. Units longer than 30 seconds receive bounded overlapping CTC windows (30 seconds, 24-second stride), merged into ordered word timestamps without splitting sentence navigation. Duration-weighted estimates remain wherever refinement is unavailable or unreliable. Alignment accepts at most 16 MiB of PCM and 32,768 text characters per unit, bounds buffered work and skips overloaded requests rather than delaying playback. Long windows refine only confidently recognized, uniquely matched source phrases; remaining windows yield to newly queued segments. Long units are not guaranteed complete refinement.

Sentence cuts recognize numeric endings such as `10/10. Run /reload`, including Markdown closers and invisible narration markers, without splitting decimals, versions or dotted identifiers such as `src/index.ts`. Streaming synthesis and sentence navigation share these boundaries and original UTF-16 source offsets.

It avoids reading most Markdown syntax, normally speaks link labels and shortens bare URLs to host names; terminal styling leaves fence markers and link destinations untouched. This is a lightweight speech parser, not full CommonMark: punctuation inside link labels or double-backtick spans can split early, and parenthesized link destinations may leak into speech. Use unindented three-character fences; longer/indented fences and ordered markers over three digits are not fully supported.

Markdown table rows are newline-delimited narration units. Cell separators become spoken pauses and separator-only rows stay silent.

Fences tagged `text`, `txt`, `plain`, `plaintext`, `md`, `markdown`, or `mdown` are treated as prose and receive normal sentence/word highlighting.

## Code and patch descriptions

Other fenced blocks are semantic narration requests. In `block-only` mode, requests begin at the closing fence. In `conversation` mode, generation waits until the next fence opens (excluding that opening and everything after it), or the containing assistant message ends. Following prose is included, even across thinking/text/tool-call content blocks. Preceding prose can play while waiting; the description and subsequent prose remain in transcript order.

The generated description:

- explains purpose and meaningful behavior rather than reading punctuation;
- is rendered in a bordered callout below the original fence;
- is keyed by the concerned block in default `block-only` mode, or by a compact hash of the deterministic structured context through the same next-fence/message-end boundary in `conversation` mode, and stored in a non-context-injecting Pi custom entry; generator/model selection alone does not invalidate it;
- is reused for the same block and selected context mode by timing/audio preprocessing;
- falls back to a local structural description if the model is unavailable or returns an invalid plan.

Shell installation/update blocks and patches have semantic local fallbacks. Generic unsupported code may fall back to language and structure information.

Descriptions are generated for fenced blocks in eligible assistant text (and thinking in `all` mode), not raw tool result patches. Description preprocessing itself does not acquire speech ownership or request attention. Written descriptions continue to be filled while spoken output is disabled.

Set `codeDescriptionContext` to `conversation` for discussion-specific descriptions. The narrator is asked to explain the latest included code block and complement surrounding prose, retaining guided highlights; original prose is still spoken, so semantic deduplication is not guaranteed. This opt-in sends available provider-compatible history—including thinking, images, tool calls/results—and the available system prompt and active tool schemas even to a different pinned `editModel`. See [context reconstruction and limits](models-and-privacy.md#editing-model). The privacy-safe default remains `block-only`.

## Guided mode

`codeNarration: "guided"` asks `editModel` for compact `operations|speech` records:

- `L+`/`L-` add and remove independent bright line groups.
- `B+`/`B-` add and remove independent bold ranges.
- unrelated code remains dim while normal language syntax colors remain visible;
- all original code returns to normal when narration completes.

JavaScript/TypeScript-family fences use Tree-sitter target IDs so the model selects validated syntax nodes instead of guessing coordinates. Supported aliases include JavaScript, JSX, TypeScript, TSX, `js`, `jsx`, `ts`, `tsx`, `mjs`, `cjs`, `mts`, and `cts`. Other languages use validated line/column coordinates.

`summary` produces a plain spoken/written description without guided code focus.

## Playback highlighting

For each spoken segment, Pi Voice retains source ranges, synthesized duration, optional CTC word alignment, and actual player position.

- Unread words are dim.
- The active sentence/newline unit receives one clipped background zone on each visible wrapped line, including inter-word whitespace but excluding list/quote prefixes and trailing padding. Voice paints the existing native Markdown rows after wrapping, so activating a highlight cannot move glyphs or add ANSI-only blank rows. Native syntax colors and grapheme boundaries remain intact.
- Reached words return to normal.
- Guided code operations activate against playback time.

Wav2Vec2 forced alignment improves word timestamps but never delays synthesis. If alignment is late or unavailable, duration-weighted word estimates remain active. If network player feedback is missing, playback uses a pause-aware fallback clock. The word-timing row describes source-word estimates, not device-clock accuracy.

Subsequent assistant messages do not reset earlier message styling while queued speech is still playing. Pause freezes audio and highlighting at the same position; resume continues both.

## Auto-scroll

With `autoScroll: true` (the default), Pi Voice attaches an invisible location marker to the **currently timed word** and finds that marker in Pi's rendered TUI document. Playback starts and explicit message/sentence navigation frame the target immediately at 20% down from the top, even if already in the 20–80% band, before generation or ownership acquisition completes. Audio readiness does not cause a second jump or override subsequent manual scrolling. F8 explicitly re-anchors before toggling pause/resume; after pausing, background work does not move the viewport. Timeline movement while paused updates highlighting and framing without resuming audio. Near the start or end of the transcript, targets are clamped to the available scroll range instead of creating nonexistent space.

After that initial placement, Voice normally leaves the viewport alone while the word remains in the 20–80% visible band (native end-follow is the exception below). Each time a new spoken word moves past the 80% mark, it is re-anchored at 20%. F6/F7/F9/F10/F5 replay and seek actions, F8 pause/resume, `/voice attention`, and `/voice scroll-to` all re-arm this behavior. The first marker lookup establishes the active message's transcript position; subsequent words reuse that anchor until layout or target changes invalidate it, rather than periodically rendering the whole transcript.

Manual scrolling overrides automatic motion, even outside the band, until an explicit follow/navigation action. While a narrated position exists, the **Jump to voice location** button below the editor runs the same action as `Alt+V` (or the configured `scrollToShortcut`) and `/voice scroll-to`: restore the canonical 20% anchor without resuming paused audio, including with auto-scroll disabled. Clicking does not move keyboard focus or print another notice. Fullscreen Pi versions with native `MouseRegion` support provide clicks; regular terminal mode and older Pi retain the existing shortcut/command fallback. Voice does not add another jump-to-latest banner. `/voice bottom` is deliberately separate: it pins the transcript to its end and resumes transcript-end following; the default shortcut is `Alt+T`. It does not change the playback cursor. Separately, F10 beyond the latest message or F9 beyond its last available sentence/newline enters **playback Tail**, preserving playing/paused intent and active-stream continuation. F6 from Tail selects the last eligible message; F7 selects its last available unit. See [playback controls](usage.md#playback-controls).

Pi's native End/Bottom follow and `/voice bottom` pin immediately. Unpaused automatic Voice following also adopts native end-follow when it reaches the **exact** bottom—even if the word is still in-band—and clears Pi's “Jump to latest” banner. Near-bottom proximity alone does not activate it. This changes neither the chronological playback cursor nor playing/paused intent, and does not override manual scrolling or paused framing. It cannot establish the separate native error-red `● live` time indicator: that requires the unpaused chronological playback edge, including caught-up next-output wait. Paused playback and older replay are not live; unknown times remain unknown. See [compact playback phases and status](usage.md#highlighting-and-status).

Automatic arrival re-evaluates the speech window after resize/layout changes as well as new output; small growth can retain native follow, while an out-of-band word restores windowed following. Explicit End instead keeps its pin through resize until output grows. Both remember final-tail restoration, including across delayed replay ownership acquisition. Manual browsing cancels that intent; explicit replay/navigation establishes its own framing. Queued next-message playback frames that message directly, without bouncing through the tail. Paused navigation previews without resuming, and background timing never moves the paused highlight or viewport.

### Native UI integration

The button uses Pi's documented [`setWidget` placement](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/tui.md#pattern-5-widgets-abovebelow-editor) and [`MouseRegion` click dispatch](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/tui.md#mouse-input), not an overlay or a replacement editor. The installed implementations are `pi-tui/dist/components/mouse-region.js`, `components/markdown.js` (`Markdown.render`), and `utils.js` (`wrapTextWithAnsi`). The extension wraps affected Markdown leaves' render/invalidation hooks; it does not patch Pi or replace its Markdown parser. A private tagged probe maps narration spans onto an immutable native baseline, and painting happens only after layout. A bounded two-leaf cache retains baseline/source-map layouts across native leaf rebuilds, not a second transcript history. Stable word ticks reuse both layouts; resize, theme and source changes rebuild them. Selection-scoped APC markers are inserted at the final timed glyph, preserving UTF-16 source offsets, syntax colors, and copied historical markers. Table cell spans, escaped pipes, nested syntax and ANSI-split graphemes map back to original source coordinates; active zones clip per rendered line without changing baseline glyphs. If a native probe cannot map safely, Voice preserves the exact styled/padded baseline instead of guessing, so highlighting or the voice anchor may be unavailable there. Narrow tables containing reference-link URL output remain a known mapping limit; this is not a claim of universal Markdown coverage.

## Timing diagnostics

`/voice timing` reports two latency measurements for recent segments:

- audio metadata to active-background state;
- active-background state to TUI render.

It does not log narrated text. Use it when player feedback appears delayed relative to highlighting.
