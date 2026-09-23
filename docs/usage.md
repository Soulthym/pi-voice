# Usage and keybindings

[← README](../README.md) · [Commands](commands.md) · [Configuration](configuration.md)

## Client device name

`pi-voice-ssh --set-device-name` opens a visible local prompt, even if already named. `pi-voice-ssh --set-device-name "My device"` sets it headlessly. Both are standalone: no SSH target or other options. Normal first connections also prompt visibly. Names are validated before atomic saving; the ID is retained. After confirmed playback/capture stop, close all client wrappers and reconnect to use a renamed label; no implicit restart occurs. See [setup, errors and upgrades](installation.md#install-a-device-name).

## Dictation

Press `Alt+M` or F4 to begin recording. Pi Voice streams Ogg/Opus from the selected device, performs host-side voice activity detection, and shows a revisable Whisper preview in the editor.

Recording ends after approximately 1.35 seconds of trailing silence. Press the same key again to stop manually. A recording with no detected speech times out after 12 seconds, and the host enforces a 120-second safety limit.

The default `submitMode` is `review`: the final prompt remains in the editor for correction or extension, and you press Enter to submit it. `auto` submits immediately.

`/voice off` disables spoken output, not dictation. Set `input` to `disabled` or `talkShortcut` to `disabled` if microphone input must be unavailable. Disabling `talkShortcut` also disables the automatic F4 microphone alias, but leaves F5 replay registered. The default Alt+M and any custom microphone shortcut are unchanged; custom `f4` is registered only once, and custom `f11` remains allowed. F5 is no longer an automatic microphone alias; F11 is no longer automatic replay. Explicit shortcut collisions retain Pi's existing registration/override rules.

## Candidate resolution and spoken editing

Live and final transcription request up to `sttCandidates` hypotheses. The editor shows a compact, user-only preview with shared phrases and nested alternatives, factored at word boundaries. Every actual candidate remains covered; the display can admit incidental combinations and is not a new ASR hypothesis. The unchanged `<asr_candidates_json>`-wrapped JSON array—not this display—is sent to `editModel`. Independently decoded live segments remain separate; the final whole-utterance preview replaces them while resolution runs.

`editModel` resolves technical ambiguity using the original editor draft and a bounded, text-only excerpt of recent user/assistant context. Tool output is excluded. Candidate markup is only a preview: normal completion replaces it with resolved prose before any automatic submission. If you manually edit the preview or draft, Pi Voice preserves your edits and does not auto-submit that capture. Stop also cancels pending live decoding/resolution and fences late results. If the editor still contains Voice's untouched preview, cancellation restores the pre-recording draft; manually edited text survives. `/voice stop` must begin the editor input to be recognized; access with a nonempty draft remains a usability limitation.

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

Desktop order: **F4 microphone, F5 replay, F6 previous message, F7 previous sentence, F8 pause/resume, F9 next sentence, F10 next message**. Pi's documented and installed native default bindings do not reserve F4 or F5. User keybindings and other extensions can still conflict; desktop environments, terminals, multiplexers and Fn/media-key modes may intercept keys before Pi receives them. This is not a claim of universal OS support.

| Key | Action |
| --- | --- |
| `F5` (↺) | Replay this project's selected/waiting response; never switch projects |
| `F6` (⏮) | Select the previous eligible live or completed transcript target |
| `F7` (↶) | Select the previous sentence/newline unit, crossing eligible targets; clamp at the transcript start |
| `F8` | Pause or resume the existing audio player |
| `F9` (↷) | Select the next sentence/newline unit; cross eligible targets, then enter playback Tail |
| `F10` (⏭) | Select the next eligible live or completed transcript target; after the latest, enter playback Tail |
| `Alt+V` | Re-anchor the current narrated position (`/voice scroll-to`) |
| `Alt+T` | Pin to transcript end and follow new output (`/voice bottom`) |
| `Alt+D` | Open the native device picker (`/voice devices`) |

F7/F9 use source sentences and actual newlines, never terminal soft wraps. They work before durations are known and retain pause intent. Code-description sentences are separate steps, with existing focus cues preserved; terminal omissions are skipped. F7 from playback Tail selects the final available unit of the last eligible message.

Live speech, replay, ⏮/⏭ and ↶/↷ use the same mode-filtered transcript order. Each assistant text content block is a target; `all` also includes each thinking block in its actual position. Tool calls separate targets but are not spoken. No artificial thinking/answer alternation is imposed, and text separated by tools is not joined. Timings and source highlights belong to those exact targets. F6/F10 navigate this history; merely scrolling the terminal viewport does not change that selection. Navigation is available while Pi is idle. The destination message is highlighted and exposed immediately, before regenerated audio starts, and Pi Voice invalidates any marker cached in the previously selected message before locating the destination.

Pause intent is sticky: incoming output and background work do not restart playback. Changes that dirty the current spoken asset pause it immediately, retain ownership and never auto-resume; unrelated settings do not pause it.

F8 re-arms follow and frames the narrated position before toggling pause/resume, so it can move the viewport after manual browsing. It preserves the current audio connection and highlighting position. Because the paused sink still owns the physical output resource, it retains the cross-session device lease until resume, seek, or stop. It does not restore bottom-follow merely because playback paused. If no live paused transport survives, resume falls back to regeneration from the retained source-unit start (or code-description ordinal). From idle at an explicitly pinned viewport end, F8 can replay the selected response; this does not require chronological playback Tail.

F7/F9 select sentence/newline source units independently of timing availability; alignment refines playback highlighting without redefining the navigation units. Unchanged messages reuse valid timing maps and cached Opus segments. Message and time movement preserves the transport's paused versus unpaused state: while paused it updates the highlighted position and queues the replacement sink in paused state; from idle, message replay starts unpaused.

**Playback Tail** is the cursor position after the latest eligible target, including an active stream. F10 beyond that target or F9 beyond its last available unit enters Tail and pins the viewport. It preserves playing/paused intent, not necessarily the old sink: historical playback/preparation is retired; an active source continues from the captured tail boundary, retaining unfinished text and future deltas in order. Paused Tail queues silently until explicit resume. Closed source blocks do not retain an unfinished suffix.

From Tail, the first F6 selects the last eligible message (not its predecessor); F7 selects its last available sentence/newline unit. Subsequent movement follows transcript order. Rapid mixed controls preserve the provisional selection and pause intent through asynchronous cancellation/acquisition and canonical message finalization. **Alt+T / `/voice bottom` is viewport-only**: it does not select playback Tail, seek, pause or resume audio.

## Device picker

Click the existing `[device]` badge on the **first** Voice progress line (or the built-in idle Voice footer), or press **Alt+D**. Both open a native SelectList overlay: click/tap an option to choose, or use arrows and Enter; Escape cancels. An existing extension select/confirm remains underneath with its promise and focus intact. If another floating overlay is already open, dismiss it before opening the picker. Changing terminal height cancels the picker; reopen at the new size. Stop, newer playback/device controls, and session shutdown cancel the picker. If the underlying prompt expires or another overlay takes focus, the picker dismisses without typing through to the draft. `/voice devices` is the command alternative; `/voice device` remains a read-only report.

The snapshot lists valid, apparently available registered devices plus **Local (host audio)**. The current candidate is marked; numbered labels and short IDs distinguish duplicate names without interpreting display text as an ID. Missing/disconnected pins are not inserted as available choices. Registration and endpoint availability are not audio-readiness proof. Reopen to see newly connected devices. Choice revalidates identity/generation/endpoints, including after stop; stale sessions, shutdown and newer controls cannot apply an old choice.

Opening/cancelling does not stop capture/playback, claim ownership, change pins, or explicitly move the viewport. Choosing uses the same confirmed-stop, sticky, silent-paused transition as `/voice device <id>` and preserves the draft/playback cursor. Explicit endpoint overrides still win.

The idle footer reserves room for primary activity and a closed, width-bounded device badge before optional voice information and key hints; other extension statuses and Pi's footer remain in place.

Mouse/touch needs fullscreen Pi with native `MouseRegion` support and a terminal emitting SGR mouse events. Regular/older TTYs retain the plain label and Alt+D hint (space permitting), not an emulated button. Custom footers that replace Pi's built-in footer use Alt+D. Touch follows the same terminal protocol; physical phone gestures have not been validated. No SSH-wrapper key interception or client upgrade is needed.

**Shortcut conflict:** Pi actually defaults Alt+D to `tui.editor.deleteWordForward`; this extension deliberately replaces it, while **Alt+Delete** remains the default deletion alternative. Pi reports built-in/other-extension shortcut conflicts and may skip a reserved custom binding. If `talkShortcut`, `scrollToShortcut`, or `scrollBottomShortcut` is already Alt+D, Voice preserves that control, warns, and leaves `/voice devices` and supported mouse clicks available. Change bindings only if desired, then `/reload`.

## Highlighting and status

Unread prose is dimmed. The active sentence/newline unit receives a subtle background after native wrapping, and each reached word returns to the normal foreground. The playback line shows **Idle**, **Waiting**, **Playing**, or **Paused**, position, duration, and selected message. A separate final row shows `Word timing: n/total estimated` or `unknown/pending`; this is not a device-clock accuracy indicator.

Background status intentionally separates session work from selected-message state:

```text
○ Idle · message 280/605 · timing pending
↺ Checking saved timing · 109/605 targets checked
```

Checks restore compatible saved maps without inference. Actual recovery uses a separate `Recovering speech timing` line naming cached-audio decoding, synthesis or word-timing estimates. `/voice help` lists controls; `/voice status` groups settings by task. Notices use `Voice · …` with Pi's native severity styling; icons supplement readable words.

See [Narration and highlighting](narration-and-highlighting.md) and [Preprocessing and cache](preprocessing-and-cache.md).

## Multiple projects and attention

Only interactive Pi TUI sessions participate in voice coordination. The first project with speakable output owns playback. Other projects record attention only when they produce content that would actually be spoken; tool-only responses, raw tool results, and headless child/subagent sessions do not request attention.

Waiting attention does not interrupt current speech, and waiting audio never starts automatically. When user-audible playback switches sessions, Pi announces the newly active project once; reacquiring, seeking, pausing, or replaying in the same session does not repeat its name. Run `/voice attention` to explicitly attend the oldest eligible waiting session, including an already-announced wait. If that session is current, or none is waiting, it replays this project's response. F5 always stays in the current project. Disabled voice does not transfer attention. The command finalizes captured dictation into the editor without submitting, waits for confirmed player/microphone stop, and sends a coordinator request carrying the origin terminal's freshly resolved device identity. The waiting pane adopts that pin without guessing an old detached tmux attachment. Stop or newer playback actions cancel pending requests; stale requests are rejected.

Manual prompt submission, replay controls, F5, and `/voice attention` take priority. Cross-process replay waits asynchronously for the current player to acknowledge shutdown; controls remain responsive, newer navigation supersedes the pending target, and F8 preserves its intended paused state. A displaced response is paused and returned to the attention queue rather than automatically resumed.

## Optional Termux function-key row

The extended row is exactly `F4🎙 | F6⏮ | F7↶ | F8⏯ | F9↷ | F10⏭ | F5↺`.

The screenshot below is historical: it predates the current F4 microphone/F5 replay mapping and sentence buttons `↶` and `↷` without numbers.

![Older Termux extended keyboard row with microphone, message navigation, playback controls and replay](assets/pi-voice-ssh-termux-extended-kb.jpg)

In a **local Termux shell**, edit `extra-keys` in `~/.termux/termux.properties` on the phone, not on the SSH host. No row generator is provided. For an existing Voice row, change its microphone key from F5 to F4 and replay from F11 to F5, preserving other keys. To add a row, insert this before the configuration's final `]]`:

```properties
  ], [\
    {key: 'F4',  display: '🎙'},\
    {key: 'F6',  display: '⏮'},\
    {key: 'F7',  display: '↶'},\
    {key: 'F8',  display: '⏯'},\
    {key: 'F9',  display: '↷'},\
    {key: 'F10', display: '⏭'},\
    {key: 'F5', display: '↺'}\
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

The row maps to microphone, previous message, previous sentence, pause/resume, next sentence, next message, and current-project replay. F4 is registered only when `talkShortcut` is not `disabled`.
