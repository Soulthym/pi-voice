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

`Ctrl+Shift+V` toggles spoken output. `/voice stop` hard-cancels speech and dictation decoding/editing; late results cannot overwrite the editor or submit. After proven stop, one eligible waiting-project announcement is permitted without reenabling autoplay or capture. Device cleanup continues separately, retaining ownership until stop is confirmed. Explicit playback actions instead stop capture and finalize captured dictation into the editor before playback, without auto-submitting it. Read-only queries do neither. A second microphone tap during acquisition cancels startup; there may be no audio yet.

## Playback controls

Desktop order: **F4 microphone, F5 replay, F6 previous message, F7 previous sentence, F8 pause/resume, F9 next sentence, F10 next message**. Pi's documented and installed native default bindings do not reserve F4 or F5. User keybindings and other extensions can still conflict; desktop environments, terminals, multiplexers and Fn/media-key modes may intercept keys before Pi receives them. This is not a claim of universal OS support.

| Key | Action |
| --- | --- |
| `F5` (↺) | Replay this project's selected/waiting response; never switch projects |
| `F6` (⏮) | Select the previous eligible live or completed transcript target |
| `F7` (↶) | Select the previous sentence/newline unit, crossing eligible targets; clamp at the transcript start |
| `F8` | Pause or resume narration; retain the playhead across a waiting-project announcement |
| `F9` (↷) | Select the next sentence/newline unit; cross eligible targets, then enter playback Tail |
| `F10` (⏭) | Select the next eligible live or completed transcript target; after the latest, enter playback Tail |
| `Alt+V` | Re-anchor the current narrated position (`/voice scroll-to`) |
| `Alt+T` | Pin to transcript end and follow new output (`/voice bottom`) |
| `Alt+S` | Open the native device picker (`/voice devices`) |

F7/F9 use source sentences and actual newlines, never terminal soft wraps. They work before durations are known and retain pause intent. Code-description sentences are separate steps, with existing focus cues preserved; terminal omissions are skipped. F7 from playback Tail selects the final available unit of the last eligible message.

Live speech, replay, ⏮/⏭ and ↶/↷ use the same mode-filtered transcript order. Each assistant text content block is a target; `all` also includes each thinking block in its actual position. Tool calls separate targets but are not spoken. No artificial thinking/answer alternation is imposed, and text separated by tools is not joined. Timings and source highlights belong to those exact targets. F6/F10 navigate this history; merely scrolling the terminal viewport does not change that selection. Navigation is available while Pi is idle. The destination message is highlighted and exposed immediately, before regenerated audio starts, and Pi Voice invalidates any marker cached in the previously selected message before locating the destination.

Pause intent is sticky: incoming output and background work do not restart playback. At the transcript bottom, F8 still pauses an active or startup-pending player even after the model turn has finished; model completion is not audio completion. Changes that dirty the current spoken asset pause it immediately, retain ownership and never auto-resume; unrelated settings do not pause it.

F8 re-arms follow and frames the narrated position before toggling pause/resume, so it can move the viewport after manual browsing. It preserves the current audio connection and highlighting position. Because the paused sink still owns the physical output resource, it retains the cross-session device lease until resume, seek, or stop. It does not restore bottom-follow merely because playback paused. A waiting-project announcement may retire that sink after confirmed stop. Explicit Resume then uses the saved device-confirmed offset only with the identical decoded cached PCM; missing/estimated timing, changed audio or a cache miss conservatively repeats the retained sentence/code unit. It never skips ahead on a guessed offset. Destructive final-text edits invalidate the old checkpoint before Resume, even before transcript insertion; removed blocks are not replayed. Append-only text retains a valid checkpoint. Choosing a different target immediately retires the previous announcement's Resume intent. Other lost transports retain their existing source-unit fallback. At a completed chronological live edge, the audio lease is released but following intent remains: F8 pauses it without creating a transport, new responses queue, and one F8 resumes them. From initial/stopped idle at an explicitly pinned viewport end, F8 can replay the selected response; this does not require chronological playback Tail.

F7/F9 select sentence/newline source units independently of timing availability; alignment refines playback highlighting without redefining the navigation units. Unchanged messages reuse valid timing maps and cached Opus segments. Message and time movement preserves the transport's paused versus unpaused state: while paused it updates the highlighted position and queues the replacement sink in paused state; from idle, message replay starts unpaused.

**Playback Tail** is the cursor position after the latest eligible target, including an active stream. F10 beyond that target or F9 beyond its last available unit enters Tail and pins the viewport. It preserves playing/paused intent, not necessarily the old sink: historical playback/preparation is retired; an active source continues from the captured tail boundary, retaining unfinished text and future deltas in order. Paused Tail queues silently until explicit resume. Closed source blocks do not retain an unfinished suffix.

From Tail, the first F6 selects the last eligible message (not its predecessor); F7 selects its last available sentence/newline unit. Subsequent movement follows transcript order. Rapid mixed controls preserve the provisional selection and pause intent through asynchronous cancellation/acquisition and canonical message finalization. At genuinely caught-up Tail, F9/F10 are no-ops: no seek, synthesis, lease change or viewport-follow reset. This also applies while an OPEN stream has consumed all available audio, including after Pause; it does not invent whole-message completion or authorize an announcement. A highlighted final word is not proof that its audio finished. A later real target remains navigable. **Alt+T / `/voice bottom` is viewport-only**: it does not select playback Tail, seek, pause or resume audio.

## Device picker

**Current priority integration is UNDEPLOYED and not live-validated.** Select is temporary; Pin is a separate session-persisted priority-0 override. Genuine connection/ranking/configuration events may replace a selection; cached heartbeat/label-only updates do not. Connected 0 wins, including over another manual selection. See [priority, WAIT and proof rules](devices-and-ssh.md#priority-routing-undeployed).

Click the `[🎧:device]` badge at the **right end of the first VoiceUI line**, including its idle status line, or press **Alt+S**. Both open a native SelectList overlay: click/tap a device row or use arrows and Enter to open its actions; Escape closes. Choose **Select (temporary)** to switch, or **Pin/Unpin**, promote/move/set priority, reset, or Back. An existing extension select/confirm remains underneath with its promise and focus intact. If another floating overlay is already open, dismiss it before opening the picker. Changing terminal height cancels the picker; reopen at the new size. Stop, newer playback/device controls, and session shutdown cancel the picker. If the underlying prompt expires or another overlay takes focus, the picker dismisses without typing through to the draft. `/voice devices` is the command alternative; `/voice device` remains a read-only report.

The cached snapshot includes remembered offline devices and **Local (host audio)**. Row number, priority, `S` selected, `P` pinned and `!` offline markers precede the short ID/name. Row numbers distinguish clipped IDs; actions map to full IDs. Offline rows cannot be selected but can be pinned/reordered/reset. Manual order is a prefix before the chronological discovery-date tail; offline devices retain positive positions. Local -1 is a last-resort sentinel, not the best number; promoting Local gives it a positive manual position. Reset removes manual order, not dates or pin. A changed snapshot invalidates stale choices. Registration/availability is not readiness proof; selection revalidates generation/endpoints and stop proof.

Opening/cancelling does not stop capture/playback, claim ownership, change pins, or explicitly move the viewport. Selecting a changed route uses the same confirmed-stop temporary transition as `/voice device <id>` and preserves the draft/playback cursor; pin/order actions trigger routing separately. During the handoff the row shows Connecting, not an internal transport pause. Outside disconnect WAIT, existing playback then stays silently paused; an idle session returns to Idle, and input-only ownership does not pause future automatic narration. WAIT clearing can resume retained playing intent from the current cursor after proof; paused or superseded intent stays silent. No routing action starts capture or submits a draft. Explicit reconnect never resumes playback. Explicit endpoint overrides still win.

VoiceUI keeps playback status and time/live visible, shrinking the bar and shortening message numbering to `671/671`, then omitting numbering/bar as needed. The closed `[🎧:device]` badge stays right-aligned where space permits; long names truncate with an ellipsis. At very narrow widths the badge can be omitted and essential status/time can wrap rather than invent a shortened clock. The idle Voice status now lives in this widget, not Pi's footer; other extension statuses and Pi's footer remain in place.

Mouse/touch needs fullscreen Pi with native `MouseRegion` support and a terminal emitting SGR mouse events. Regular/frame-mode and older TTYs retain the keyboard selector overlay and plain label, not an emulated button. The badge shows no picker shortcut hint; Alt+S remains available and listed in help. There is no idle-footer click target. Touch follows the same terminal protocol; physical phone gestures have not been validated. No SSH-wrapper key interception or client upgrade is needed.

The current device is initially highlighted by exact ID (including offline rows), scrolled into view; Enter opens its actions. If absent, the first ranked row is highlighted. Non-TUI selectors without initial-index support display that choice first. **Select (temporary)** on the same healthy unchanged route does not stop playback, finalize recording or implicitly pin, including after restore. Changed generation/endpoints or unconfirmed cleanup still require the safe transition. Explicit `/voice device …` commands retain their transition semantics.

**Shortcut conflict:** Alt+S is unused in checked Pi 0.84.2/installed 0.85.1 and Voice defaults. **Alt+D** and **Alt+Delete** retain native forward-delete-word. Pi reports built-in/other-extension shortcut conflicts and may skip a reserved custom binding. If `talkShortcut`, `scrollToShortcut`, or `scrollBottomShortcut` is already Alt+S, Voice preserves that control, warns, and leaves `/voice devices` and supported mouse clicks available. Change bindings only if desired, then `/reload`.

## Highlighting and status

Unread prose is dimmed. The active sentence/newline unit receives a subtle background after native wrapping, and each reached word returns to the normal foreground. The compact playback phases are **Idle**, **Playing**, **Paused**, **Synthesizing**, **Loading**, **Describing**, **Connecting**, and **Queued**. Deliberate paused intent takes precedence outside a device handoff, which shows Connecting; preparation reports its actual phase rather than a generic Waiting state: Describing means an actual foreground description API dependency is running (including a joined, already-active background producer). Canonical-context/next-fence waits, replay context preparation and resource/ownership waits are Queued; cache hits never enter Describing or charge an attempt. Device handoff is Connecting. Loading is worker/model initialization, Synthesizing is active TTS generation, Playing is audible/submitted playback or the caught-up live edge, and Idle means no playback intent or completed historical playback behind the latest eligible response. Phase, time and message index describe the same foreground source: preparing B cannot replace audible A, and B cannot inherit A's clock after A finishes. Paused selection and position stay stable. Complete known totals use a normal progress bar and `m:ss / m:ss`; streaming/incomplete totals use a neutral bar without a position marker and reliable elapsed time only, or `--:--` when unavailable, with `timing pending`. Progress contents update in place without remounting/reordering the widget; off leaves no reserved blank rows.

A separate **`● live`**, styled with Pi's native `error` red, replaces the time only at the unpaused chronological playback edge, including caught-up waiting for next output, which shows `▶ Playing [bar] ● live · 703/702 [🎧:dev]` when waiting after 702 eligible entries (badge right-aligned). The waiting placeholder is the next ordinal, not an additional denominator entry; audible/streaming entry 702 remains 702/702. Empty reservations and untracked announcements never add entries. This includes the gap after the full assistant message/turn and audio finish: following survives normal prompt submission and temporary-to-persisted source identity changes without holding another project's audio lease. New unread output blocked by another owner shows Queued, not live or the previous message's time. Pause shows the retained time, Stop clears live intent immediately, and seek-back/session change leaves the edge. Completion is independent of manual viewport scrolling. Actual latency keeps its preparation phase, not Playing. It is not a phase or a synonym for Playing: older replay, queued/unread audio and paused playback are not live. Native End, Alt+T and `/voice bottom` change viewport follow only, never establish live playback. Word-quality details appear only in `/voice timing`: `Word timing: n/total estimated` or `unknown/pending`, not a persistent row or a device-clock accuracy indicator.

Background status intentionally separates session work from selected-message state (badge spacing depends on terminal width):

```text
○ Idle [━━━━━━━━━━━━━━━━━━━━━━━━] --:-- · 280/605 · timing pending    [🎧:local]
↺ Checking saved timing · 109/605 targets checked
```

Checks restore compatible saved maps without inference. Actual recovery uses a separate `Recovering speech timing` line naming cached-audio decoding, synthesis or word-timing estimates. `/voice help` lists controls; `/voice status` groups settings by task. Notices use `Voice · …` with Pi's native severity styling; icons supplement readable words.

`/voice timing` reports quality, latency and worker limits; `/voice timing workers` queries the limit without changing state. Set it with `/voice timing workers 2` or `/voice timing workers auto`. Use `/voice timing retry current` for the selected completed target, `all` for the current branch, an inclusive 1-based playback-message range such as `2-5`, or an exact message ID. Retry only uses existing audio and spoken plans; missing assets are reported, not generated. Only wholly estimated units are eligible; refined, mixed and unknown timing are skipped. Playback, selection, paused highlights, viewport and drafts stay unchanged. Stop, session replacement/shutdown or a newer valid retry cancels it; `/voice timing` reports progress. See [retry limits](preprocessing-and-cache.md#silent-timing-retry).

See [Narration and highlighting](narration-and-highlighting.md) and [Preprocessing and cache](preprocessing-and-cache.md).

## Multiple projects and attention

Only interactive Pi TUI sessions participate in voice coordination. The first project with speakable output owns playback. Other projects record attention only when they produce content that would actually be spoken; tool-only responses, raw tool results, and headless child/subagent sessions do not request attention.

Waiting attention does not interrupt current speech, and waiting audio never starts automatically. Matching live presence retains a waiting generation beyond eight seconds. On the same verified output identity (or intentional local output), the owner says “Project … requires attention next” once after the entire logical message and its final physical audio EOF, before later local responses. Individual sentence/content-block EOF, model completion alone and synthesis gaps are not that boundary. Pause, Stop and navigation can offer one announcement after the original output has stopped: a pause/cancel ACK alone is insufficient; all original scoped receipts must arrive first. An idle same-output session may announce only after ordinary acquisition of a free lease, never a foreign takeover. Cancellation returns that notification-only loan after stop proof, without releasing active user playback/input or a replacement generation. Temporary registry loss preserves the last verified origin for the same selection/configuration; another device cannot inherit an existing waiting generation.

Announcements use separate untracked playback, preserve local source/counters/drafts and do not change project focus. Pause retains its confirmed checkpoint and remains paused after the prompt; only explicit Resume continues the original source, including its remaining blocks. Stop stays stopped, including when new output arrives during its one permitted announcement; those responses remain in the transcript but cannot drain automatically at a later response's EOF. A completion notice also leaves native Tail framing intact rather than following the completed message's head. Navigation continues its chosen target only if still current. New actions/routes/sessions cancel stale continuations; failed delivery remains unannounced, and stale EOF cannot acknowledge a replacement waiting generation. When user-audible playback switches sessions, Pi announces the newly active project once; reacquiring, seeking, pausing, or replaying in the same session does not repeat its name. Run `/voice attention` to explicitly attend the oldest eligible waiting session, including an already-announced wait. If that session is current, or none is waiting, it replays this project's response. F5 always stays in the current project. Disabled voice does not transfer attention. The command finalizes captured dictation into the editor without submitting, waits for confirmed player/microphone stop, and sends a coordinator request carrying the origin terminal's freshly resolved device identity. The request carries manual selection when set, otherwise fresh attachment identity; receiver selection and connected-pin guards still apply, without guessing an old detached tmux attachment. Stop or newer playback actions cancel pending requests; stale requests are rejected.

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
