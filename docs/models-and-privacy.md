# Models and privacy

[← README](../README.md) · [Configuration](configuration.md) · [Preprocessing and cache](preprocessing-and-cache.md)

## Model roles

Pi Voice uses three specialized local audio models and one configurable text model:

| Role | Default | Purpose |
| --- | --- | --- |
| TTS | `onnx-community/Kokoro-82M-v1.0-ONNX@q8` | Synthesizes assistant/code narration. Kokoro cannot recognize speech. |
| STT | `onnx-community/whisper-tiny.en@fp32` | Transcribes microphone audio and creates final ASR alternatives. |
| Alignment | `onnx-community/wav2vec2-base-960h-ONNX@q8` | Force-aligns known synthesized text to clean Kokoro audio. It does not transcribe dictation. |
| Editing/narration | `current` | Resolves ASR candidates, performs smart edits, and describes fenced code. |

Kokoro, Whisper, and Wav2Vec2 execute on the Pi host through local ONNX runtimes. Weights download lazily into `~/.cache/pi-voice/models`.

Approximate first-use downloads are 100 MB for Kokoro q8, 150 MB for Whisper Tiny FP32, and 100 MB for Wav2Vec2 q8. Repository contents can change.

`/voice setup` explicitly warms Kokoro and alignment. Whisper still loads on first transcription. Main workers are lazy and may shut down after an idle period rather than remaining resident for the full Pi process lifetime.

## Compatible repositories

- `ttsModel` must be compatible with `kokoro-js`.
- `sttModel` must expose a Transformers.js automatic-speech-recognition pipeline.
- `alignmentModel` must expose a Transformers.js English CTC pipeline.
- The selected `fp32`, `q8`, or `q4` variant must actually exist in the repository.

Suggested Whisper repositories from lighter to heavier:

- `onnx-community/whisper-tiny.en`
- `onnx-community/whisper-base.en`
- `onnx-community/whisper-small.en`
- `onnx-community/whisper-large-v3-turbo`
- `distil-whisper/distil-large-v3.5-ONNX`

Remove `.en` when a compatible multilingual variant is desired. Larger models may make live CPU previews much slower and consume several gigabytes.

`sttCandidates` defaults to 3. Candidate one is deterministic; additional candidates are low-temperature samples because Transformers.js 3.x does not expose multiple beam-search outputs. Duplicates are removed, so fewer than the requested number may remain. Some ASR architectures return only one candidate.

## Editing model

`editModel: "current"` follows Pi's active model. Use `provider/model-id` to pin another authenticated model in Pi's registry. No model family is assumed.

The model receives isolated requests for:

- ASR alternatives;
- the editor draft present when recording started;
- a bounded text-only excerpt of recent user/assistant/compaction context for dictation;
- the concerned fenced block for code descriptions.

`codeDescriptionContext` defaults to `block-only`, which sends no preceding discussion with a fence. For the best context-specific narration, explicitly choose `conversation`; Pi Voice then also sends Pi's resolved historical discussion—including the applicable compaction summary—before the concerned fence. That discussion may include retained textual tool results. The concerned block itself is sent exactly once.

Tool output is excluded from candidate-resolution context. In `conversation` mode, the stable description-cache identity covers the complete transcript through the closing fence; `block-only` identities contain no discussion context. Requests do not become conversation messages. Pi Voice checks each isolated request against the selected model's context window; if the complete request cannot fit, it reports the condition and uses local structural narration rather than silently truncating context.

If `editModel` is remote, this text is sent to its provider. Pin a local Pi-registered model to keep model-assisted text operations local. Kokoro, Whisper, and Wav2Vec2 remain local regardless.

## Audio and network privacy

Raw PCM is used transiently for synthesis/playback/alignment and is never retained. Optional cache files are Opus. Microphone Ogg/Opus is streamed to the Pi host, decoded for VAD/Whisper, and discarded after processing.

Managed `pi-voice-ssh` endpoints bind to local ports on the client and private Unix sockets on the host; SSH provides transport encryption. Explicit TCP endpoints can leave loopback and are unencrypted unless the operator supplies a secure tunnel.

Client playback returns player session IDs and playback positions over the existing full-duplex connection. Microphone data uses a separate bridge.

See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) for dependency/model attribution and licenses.
