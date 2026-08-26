# Usage and keybindings

[← README](../README.md) · [Commands](commands.md) · [Configuration](configuration.md)

## Dictation

Press `Alt+M` or F5 to begin recording. Pi Voice streams Ogg/Opus from the selected device, performs host-side voice activity detection, and shows a revisable Whisper preview in the editor.

Recording ends after approximately 1.35 seconds of trailing silence. Press the same key again to stop manually. A recording with no detected speech times out after 12 seconds, and the host enforces a 120-second safety limit.

The default `submitMode` is `review`: the final prompt remains in the editor for correction or extension, and you press Enter to submit it. `auto` submits immediately.

`/voice off` disables spoken output, not dictation. Set `input` to `disabled` or `talkShortcut` to `disabled` if microphone input must be unavailable. Disabling `talkShortcut` also disables F5.

## Candidate resolution and spoken editing

Final transcription requests up to `sttCandidates` hypotheses. `editModel` resolves technical ambiguity using the existing editor draft and a bounded, text-only excerpt of recent user/assistant context. Tool output is excluded.

Both edit modes use the model:

- `append` chooses the best ASR interpretation and appends it literally.
- `smart` can also execute corrections against text that was already in the editor when recording began.

Examples for smart mode include “replace port 8000 with 8080,” “scratch the last sentence,” and “make the second paragraph shorter.” With an empty editor, there is no existing draft to revise.

## Spoken output modes

- `assistant` speaks streaming assistant text. This is the default.
- `all` additionally speaks thinking content.
- `yield` waits for the completed final response and excludes intermediate tool-use responses.

`Ctrl+Shift+V` toggles spoken output. `/voice stop` cancels speech and also asks an active recording to stop.

## Playback controls

| Key | Action |
| --- | --- |
| `F6` | Select and play the previous completed assistant message |
| `F7` | Seek approximately 10 seconds backward |
| `F8` | Pause or resume the existing audio player |
| `F9` | Seek approximately 10 seconds forward |
| `F10` | Select and play the next completed assistant message |
| `F11` | Play this session's waiting response, route attention to the oldest waiting project, or replay the selected message |
| `Alt+V` | Scroll to and follow the current narrated position (`/voice scroll-to`) |
| `Alt+T` | Pin to transcript end and follow new output (`/voice bottom`) |

F6/F10 navigate Pi Voice's selected-message history; merely scrolling the terminal viewport does not change that selection. Navigation is available while Pi is idle.

F8 preserves the current audio connection, highlighting position, and transcript viewport around the paused word. Because the paused sink still owns the physical output resource, it retains the cross-session device lease until resume, seek, or stop. It does not restore bottom-follow merely because playback paused. If no live paused transport survives, resume falls back to regenerating from the nearest persisted timing checkpoint.

F7/F9 use duration estimates first and replace them with aligned source-word checkpoints when alignment arrives, usually landing within a fraction of the requested ten seconds. Unchanged messages reuse valid timing maps and cached Opus segments. Message and time movement never changes play/pause state: while paused it updates the highlighted position and queues the replacement sink in paused state.

## Highlighting and status

Unread prose is dimmed. The active sentence or clause receives a subtle background, and each reached word returns to the normal foreground. The playback line shows player state, position, duration, and selected message. A `~` indicates estimated playback position.

Background status intentionally separates session work from selected-message state:

```text
Preprocessing · speech timing: 109/284 ready
○ Playback · message 280/284: speech timing pending
```

See [Narration and highlighting](narration-and-highlighting.md) and [Preprocessing and cache](preprocessing-and-cache.md).

## Multiple projects and attention

Only interactive Pi TUI sessions participate in voice coordination. The first project with speakable output owns playback. Other projects record attention only when they produce content that would actually be spoken; tool-only responses, raw tool results, and headless child/subagent sessions do not request attention.

When the owner finishes, Pi announces the oldest waiting project. Waiting audio never starts automatically. When user-audible playback actually switches sessions, Pi announces the newly active project once; reacquiring, seeking, pausing, or replaying again in the same session does not repeat its name. In the waiting project, press F11 or run `/voice attention`. Running either action in another project sends a cross-process request to the waiting session and force-preempts current playback.

Manual prompt submission, replay controls, F11, and `/voice attention` take priority. A displaced response is paused and returned to the attention queue rather than automatically resumed.

## Optional Termux function-key row

Add a third row to `extra-keys` in `~/.termux/termux.properties`. Insert this before the configuration's final `]]`:

```properties
  ], [\
    {key: 'F5',  display: '🎙'},\
    {key: 'F6',  display: '⏮'},\
    {key: 'F7',  display: '↶10'},\
    {key: 'F8',  display: '⏯'},\
    {key: 'F9',  display: '10↷'},\
    {key: 'F10', display: '⏭'},\
    {key: 'F11', display: '↺'}\
  ]]
```

Apply it with:

```bash
termux-reload-settings
```

The row maps to microphone, previous, rewind, pause/resume, forward, next, and attention/restart. F5 is registered only when `talkShortcut` is not `disabled`.
