# Custom endpoint protocol

[← README](../README.md) · [Devices and SSH](devices-and-ssh.md)

This is an advanced reference for replacing the bundled client bridge. Managed `pi-voice-ssh` users do not need to implement it.

Endpoints may use `tcp://host:port` or `unix:///absolute/path`. Explicit TCP is plaintext; put it behind SSH or another authenticated encrypted tunnel.

## Output connection

For each utterance, the Pi host opens an output connection and writes mono little-endian Float32 PCM at 24 kHz. The byte stream has no audio header.

The client keeps the same socket open in the reverse direction and sends newline-delimited JSON:

```json
{"type":"session","id":"12345"}
{"type":"playback","position":1.234}
```

`position` is the player's actual position in seconds from the beginning of that connection. The session ID identifies the client player for pause/resume control.

The host appends approximately one second of silent PCM before clean EOF so Android output buffers do not clip the last word. The client should drain normal EOF and close after playback completes.

## Pause/resume control connection

A second short connection to the same output endpoint starts with exactly 16 ASCII bytes followed by a command and player ID:

```text
PI_VOICE_CONTROLpause 12345\n
PI_VOICE_CONTROLresume 12345\n
PI_VOICE_CONTROLstop 12345\n
```

The bundled client maps pause/resume to mpv's `pause` property and stop to mpv's `quit` command. Control connections carry no PCM and close immediately. Starting a new audio stream also atomically replaces any previous Pi Voice player on that endpoint, preventing buffered stale audio from overlapping rapid seeks.

## Input commands

The host opens a separate input endpoint and writes one UTF-8 line:

```text
record\n
```

or:

```text
stop\n
```

### Streaming recording

The preferred response is:

```text
stream\n
<encoded audio bytes until EOF>
```

The bundled clients stream Ogg/Opus. Host-side FFmpeg/VAD consumes the growing stream, and a second `stop` connection asks the recorder to finalize and close the original stream. Recording ownership is acquired with an atomic per-device lock; a concurrent second `record` request is rejected rather than sharing or replacing microphone state.

### Single-response recording

A bridge may return one encoded recording on a single line:

```text
audio <base64-encoded-audio>\n
```

### Text or status response

Status payloads are base64-encoded UTF-8:

```text
ok <base64-text>\n
error <base64-error-message>\n
```

For `stop`, `ok` means the stop request was accepted. For `record`, an `ok` response is treated as direct recognized text for compatibility.

## Limits

The host rejects microphone responses larger than 32 MB, ends no-speech capture after 12 seconds, and enforces a 120-second recording timeout. Streaming encoded audio is decoded as 16 kHz mono for voice detection and Whisper.
