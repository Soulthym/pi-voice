# Usage and keybindings

[← README](../README.md) · [Commands](commands.md) · [Configuration](configuration.md)

## Dictation

Press `Alt+M` or F5 to begin recording. Pi Voice streams Ogg/Opus from the selected device, performs host-side voice activity detection, and shows a revisable Whisper preview in the editor.

Recording ends after approximately 1.35 seconds of trailing silence. Press the same key again to stop manually. A recording with no detected speech times out after 12 seconds, and the host enforces a 120-second safety limit.

The default `submitMode` is `review`: the final prompt remains in the editor for correction or extension, and you press Enter to submit it. `auto` submits immediately.

`/voice off` disables spoken output, not dictation. Set `input` to `disabled` or `talkShortcut` to `disabled` if microphone input must be unavailable. Disabling `talkShortcut` also disables F5.

## Candidate resolution and spoken editing

Live and final transcription request up to `sttCandidates` hypotheses. The editor shows a compact, user-only preview with shared phrases and nested alternatives, factored at word boundaries. Every actual candidate remains covered; the display can admit incidental combinations and is not a new ASR hypothesis. The unchanged `<asr_candidates_json>`-wrapped JSON array—not this display—is sent to `editModel`. Independently decoded live segments remain separate; the final whole-utterance preview replaces them while resolution runs.

`editModel` resolves technical ambiguity using the original editor draft and a bounded, text-only excerpt of recent user/assistant context. Tool output is excluded. Candidate markup is only a preview: normal completion replaces it with resolved prose before any automatic submission. If you manually edit the preview or draft, Pi Voice preserves your edits and does not auto-submit that capture. Stop also cancels pending live decoding/resolution and fences late results.

Both edit modes use the model:

- `append` chooses the best ASR interpretation and appends it literally.
- `smart` can also execute corrections against text that was already in the editor when recording began.

Examples for smart mode include “replace port 8000 with 8080,” “scratch the last sentence,” and “make the second paragraph shorter.” With an empty editor, there is no existing draft to revise.

## Spoken output modes

- `assistant` speaks streaming assistant text. This is the default.
- `all` additionally speaks thinking content, regardless of whether thinking is expanded in the UI.
- `yield` waits for the completed final response and excludes intermediate tool-use responses.

`Ctrl+Shift+V` toggles spoken output. `/voice stop` hard-cancels speech, dictation decoding/editing and queued automatic attention; late results cannot overwrite the editor or submit. Device cleanup continues separately, retaining ownership until stop is confirmed. Explicit playback actions instead stop capture and finalize captured dictation into the editor before playback, without auto-submitting it. Read-only queries do neither. A second microphone tap during acquisition cancels startup; there may be no audio yet.

## Playback controls

| Key | Action |
| --- | --- |
| `F6` (⏮) | Select and play the previous eligible completed transcript target |
| `F7` (↶) | Play the previous sentence/newline unit, crossing eligible targets; clamp at the transcript start |
| `F8` | Pause or resume the existing audio player |
| `F9` (↷) | Play the next sentence/newline unit; advance to the next eligible target or pause and follow the latest transcript tail |
| `F10` (⏭) | Select and play the next eligible completed transcript target; from the latest target, pause and follow the transcript tail |
| `F11` (↺) | Replay this project's selected/waiting response; never switch projects |
| `Alt+V` | Re-anchor the current narrated position (`/voice scroll-to`) |
| `Alt+T` | Pin to transcript end and follow new output (`/voice bottom`) |

F7/F9 use source sentences and actual newlines, never terminal soft wraps. They work before durations are known and retain pause intent. Code-description sentences are separate steps, with existing focus cues preserved; terminal omissions are skipped. F7 from transcript-tail follow selects the final unit of the selected message.

Live speech, replay, ⏮/⏭ and ↶/↷ use the same mode-filtered transcript order. Each assistant text content block is a target; `all` also includes each thinking block in its actual position. Tool calls separate targets but are not spoken. No artificial thinking/answer alternation is imposed, and text separated by tools is not joined. Timings and source highlights belong to those exact targets. F6/F10 navigate this history; merely scrolling the terminal viewport does not change that selection. Navigation is available while Pi is idle. The destination message is highlighted and exposed immediately, before regenerated audio starts, and Pi Voice invalidates any marker cached in the previously selected message before locating the destination.

Pause intent is sticky: incoming output and background work do not restart playback. Changes that dirty the current spoken asset pause it immediately, retain ownership and never auto-resume; unrelated settings do not pause it.

F8 preserves the current audio connection, highlighting position, and transcript viewport around the paused word. Because the paused sink still owns the physical output resource, it retains the cross-session device lease until resume, seek, or stop. It does not restore bottom-follow merely because playback paused. If no live paused transport survives, resume falls back to regenerating from the nearest persisted timing checkpoint.

F7/F9 select sentence/newline source units independently of timing availability; alignment refines playback highlighting without redefining the navigation units. Unchanged messages reuse valid timing maps and cached Opus segments. Message and time movement preserves the transport's paused versus unpaused state: while paused it updates the highlighted position and queues the replacement sink in paused state; from idle, message replay starts unpaused.

Transcript-tail following acts as the timeline position after the latest completed message. F10 while that message is selected, or F9 from its final known sentence/newline unit, pauses active playback before behaving like `Alt+T`/`/voice bottom`: it snaps to the transcript end and follows new output without restarting or regenerating audio. If playback is already paused or complete, the transport is left untouched.

## Highlighting and status

Unread prose is dimmed. The active sentence or clause receives a subtle background, and each reached word returns to the normal foreground. The playback line shows player state in words, position, duration, and selected message. `playback clock: estimated` identifies an estimated device clock separately from word-timing quality.

Background status intentionally separates session work from selected-message state:

```text
○ Playback · message 280/605 · timing pending
↺ Checking saved timing · 109/605 targets checked
```

Checks restore compatible saved maps without inference. Actual recovery uses a separate `Recovering speech timing` line naming cached-audio decoding, synthesis or word-timing estimates. `/voice help` lists controls; `/voice status` groups settings by task. Notices use `Voice · …` with Pi's native severity styling; icons supplement readable words.

See [Narration and highlighting](narration-and-highlighting.md) and [Preprocessing and cache](preprocessing-and-cache.md).

## Multiple projects and attention

Only interactive Pi TUI sessions participate in voice coordination. The first project with speakable output owns playback. Other projects record attention only when they produce content that would actually be spoken; tool-only responses, raw tool results, and headless child/subagent sessions do not request attention.

Waiting attention does not interrupt current speech, and waiting audio never starts automatically. When user-audible playback switches sessions, Pi announces the newly active project once; reacquiring, seeking, pausing, or replaying in the same session does not repeat its name. Run `/voice attention` to explicitly attend the oldest eligible waiting session, including an already-announced wait. If that session is current, or none is waiting, it replays this project's response. F11 always stays in the current project. Disabled voice does not transfer attention. The command finalizes captured dictation into the editor without submitting, waits for confirmed player/microphone stop, and sends a coordinator request carrying the origin terminal's freshly resolved device identity. The waiting pane adopts that pin without guessing an old detached tmux attachment. Stop or newer playback actions cancel pending requests; stale requests are rejected.

Manual prompt submission, replay controls, F11, and `/voice attention` take priority. Cross-process replay waits asynchronously for the current player to acknowledge shutdown; controls remain responsive, newer navigation supersedes the pending target, and F8 preserves its intended paused state. A displaced response is paused and returned to the attention queue rather than automatically resumed.

## Optional Termux function-key row

The extended row provides one-tap access to dictation and every F6–F11 playback control:

The screenshot below is from the older time-jump layout; current sentence buttons use `↶` and `↷` without numbers.

![Older Termux extended keyboard row with microphone, message navigation, playback controls and replay](assets/pi-voice-ssh-termux-extended-kb.jpg)

Add the row to `extra-keys` in `~/.termux/termux.properties`. Insert this before the configuration's final `]]`:

```properties
  ], [\
    {key: 'F5',  display: '🎙'},\
    {key: 'F6',  display: '⏮'},\
    {key: 'F7',  display: '↶'},\
    {key: 'F8',  display: '⏯'},\
    {key: 'F9',  display: '↷'},\
    {key: 'F10', display: '⏭'},\
    {key: 'F11', display: '↺'}\
  ]]
```

Apply it with:

```bash
termux-reload-settings
```

Updated clients automatically replace the old `↶10`/`10↷` labels on their next start, without replacing your keyboard layout. To update the existing row immediately in a local Termux shell (no SSH reconnect needed):

```bash
sed -i --follow-symlinks 's/↶10/↶/g; s/10↷/↷/g' ~/.termux/termux.properties
termux-reload-settings
```

The row maps to microphone, previous message, previous sentence, pause/resume, next sentence, next message, and current-project replay. F5 is registered only when `talkShortcut` is not `disabled`.
