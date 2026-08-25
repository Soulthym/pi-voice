# Narration and highlighting

[← README](../README.md) · [Preprocessing and cache](preprocessing-and-cache.md) · [Models](models-and-privacy.md)

## Prose and Markdown

Pi Voice converts streaming Markdown into bounded speech segments. It starts with a short first segment, then uses sentence and clause boundaries so Kokoro inputs stay manageable.

It avoids reading most Markdown syntax, preserves link labels while shortening URLs to useful host names, and leaves fence markers and link destinations untouched during terminal styling.

Markdown tables are narrated cell by cell. Each `|` ends a spoken sentence, separator cells stay silent, and highlighting advances through the rendered row.

Fences tagged `text`, `txt`, `plain`, `plaintext`, `md`, `markdown`, or `mdown` are treated as prose and receive normal sentence/word highlighting.

## Code and patch descriptions

Other fenced blocks are semantic narration requests. Requests begin when the closing fence arrives, allowing model work to overlap already queued speech without changing spoken order.

The generated description:

- explains purpose and meaningful behavior rather than reading punctuation;
- is rendered in a bordered callout below the original fence;
- is keyed by the concerned block alone in the default `block-only` context mode, or by the deterministic provider-compatible context through that block plus the effective system/tool prefix when the active model is reused in `conversation` mode, and stored in a non-context-injecting Pi custom entry;
- is reused for the same block and selected context mode by timing/audio preprocessing;
- falls back to a local structural description if the model is unavailable or returns an invalid plan.

Shell installation/update blocks and patches have semantic local fallbacks. Generic unsupported code may fall back to language and structure information.

Descriptions are generated for fenced blocks in completed assistant text, not raw tool result patches. Description preprocessing itself does not acquire speech ownership or request attention. Written descriptions continue to be filled while spoken output is disabled.

Set `codeDescriptionContext` to `conversation` for the best discussion-specific descriptions. This opt-in can send Pi's provider-compatible history—including images, tool calls, and tool results—to a remote `editModel`; when that is the active model, the normal system prompt and tool-schema prefix is also reused for provider caching. The privacy-safe default is `block-only`.

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
- The active sentence or clause receives a continuous background, including whitespace.
- Reached words return to normal.
- Guided code operations activate against playback time.

Wav2Vec2 forced alignment improves word timestamps but never delays synthesis. If alignment is late or unavailable, duration-weighted word estimates remain active. If network player feedback is missing, Pi shows a `~` and uses a pause-aware fallback clock.

Subsequent assistant messages do not reset earlier message styling while queued speech is still playing. Pause freezes audio and highlighting at the same position; resume continues both.

## Auto-scroll

With `autoScroll: true` (the default), Pi Voice attaches an invisible location marker to the **currently timed word** and finds that marker in Pi's rendered TUI document. Starting or seeking narration places that word 20% down from the top of the viewport. Near the start or end of the transcript, the target is clamped to the available scroll range instead of creating nonexistent space.

After that initial placement, no scrolling occurs while the word remains in the 20–80% visible band. Each time a new spoken word moves past the 80% mark, it is re-anchored at 20%. F6/F7/F9/F10/F11 replay and seek actions, F8 resume, `/voice attention`, and the follow shortcut all re-arm this behavior.

Manual scrolling is accepted while the spoken word remains inside the 20–80% band, so you can adjust its framing without an immediate snap. A small hint below the editor offers `Ctrl+E` (or the configured `scrollBottomShortcut`) to restore the canonical 20% anchor immediately. Otherwise tracking stays armed and snaps only when a spoken word crosses a band edge. `/voice bottom` has the same re-anchor behavior during narration; outside active narration, the shortcut and command scroll directly to the transcript bottom.

## Timing diagnostics

`/voice timing` reports two latency measurements for recent segments:

- audio metadata to active-background state;
- active-background state to TUI render.

It does not log narrated text. Use it when player feedback appears delayed relative to highlighting.
