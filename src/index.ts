import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	loadVoiceConfig,
	normalizeEditModel,
	normalizeModelDtype,
	normalizeModelId,
	normalizeTalkShortcut,
	normalizeVoiceInput,
	normalizeVoiceOutput,
	saveVoiceConfig,
	type VoiceConfig,
	type VoiceEditMode,
	type VoiceMode,
	type VoiceSubmitMode,
} from "./config.js";
import { LiveTranscriptionSession } from "./live-transcription.js";
import { PhoneInputClient } from "./phone-input.js";
import { applySpokenEdit } from "./prompt-editor.js";
import { Vocalizer } from "./vocalizer.js";
import { isVoice, VOICES } from "./voices.js";
import type { WorkerEvent } from "./worker-client.js";

type VoiceState = "downloading" | "error" | "idle" | "listening" | "loading" | "speaking";
type InputPhase = "idle" | "recording" | "transcribing";

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return "";
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => {
			return (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			);
		})
		.map(block => block.text)
		.join("\n");
}

function assistantStopReason(message: unknown): string | undefined {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return undefined;
	return "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : undefined;
}

function parseMode(value: string): VoiceMode | undefined {
	return value === "all" || value === "assistant" || value === "yield" ? value : undefined;
}

function parseSubmitMode(value: string): VoiceSubmitMode | undefined {
	return value === "auto" || value === "review" ? value : undefined;
}

function parseEditMode(value: string): VoiceEditMode | undefined {
	return value === "append" || value === "smart" ? value : undefined;
}

function appendDictation(base: string, speech: string): string {
	if (!speech) return base;
	if (!base) return speech;
	return `${base}${/\s$/.test(base) ? "" : " "}${speech}`;
}

export default async function (pi: ExtensionAPI) {
	let config = await loadVoiceConfig();
	let activeContext: ExtensionContext | null = null;
	let state: VoiceState = "idle";
	let downloadPercent: number | undefined;
	let lastError = "";
	let inputInProgress = false;
	let inputPhase: InputPhase = "idle";
	let inputProgressTimer: NodeJS.Timeout | null = null;
	let inputStartedAt = 0;
	let contextEpoch = 0;

	const setInputProgress = (message: string | undefined): void => {
		activeContext?.ui.setWidget("pi-voice-input", message ? [message] : undefined, { placement: "belowEditor" });
	};

	const clearInputProgress = (): void => {
		inputInProgress = false;
		inputPhase = "idle";
		if (inputProgressTimer) clearInterval(inputProgressTimer);
		inputProgressTimer = null;
		setInputProgress(undefined);
	};

	const beginInputProgress = (): void => {
		inputInProgress = true;
		inputPhase = "recording";
		inputStartedAt = Date.now();
		const update = (): void => {
			const elapsed = Math.floor((Date.now() - inputStartedAt) / 1000);
			setInputProgress(`🎙 Listening: ${elapsed}s — stops on silence; Alt+M to finish`);
		};
		update();
		inputProgressTimer = setInterval(update, 1_000);
		inputProgressTimer.unref?.();
	};

	const refreshStatus = (): void => {
		const ctx = activeContext;
		if (!ctx) return;
		if (!config.enabled) {
			ctx.ui.setStatus("pi-voice", undefined);
			return;
		}
		let label = `voice: ${config.voice}`;
		let color: "accent" | "dim" | "error" | "success" | "warning" = "dim";
		if (state === "loading") {
			label = "voice: loading Kokoro";
			color = "warning";
		} else if (state === "downloading") {
			label = `voice: downloading${downloadPercent === undefined ? "" : ` ${downloadPercent}%`}`;
			color = "warning";
		} else if (state === "speaking") {
			label = `voice: speaking (${config.voice})`;
			color = "accent";
		} else if (state === "listening") {
			label = "voice: listening on phone";
			color = "accent";
		} else if (state === "error") {
			label = "voice: error";
			color = "error";
		} else {
			color = "success";
		}
		ctx.ui.setStatus("pi-voice", ctx.ui.theme.fg(color, label));
	};

	const handleWorkerEvent = (event: WorkerEvent): void => {
		switch (event.type) {
			case "loading":
				state = "loading";
				downloadPercent = undefined;
				break;
			case "progress":
				if (inputInProgress) {
					state = "listening";
					setInputProgress(
						event.percent === undefined
							? "♬ Loading local speech recognition…"
							: `♬ Downloading speech recognition: ${event.percent}%`,
					);
				} else {
					state = "downloading";
					downloadPercent = event.percent;
				}
				break;
			case "ready":
			case "idle":
				if (!inputInProgress) state = "idle";
				downloadPercent = undefined;
				break;
			case "speaking":
				state = "speaking";
				break;
			case "transcribing":
				inputPhase = "transcribing";
				state = "listening";
				if (inputProgressTimer) clearInterval(inputProgressTimer);
				inputProgressTimer = null;
				setInputProgress("♬ Transcribing locally…");
				break;
			case "transcript":
				if (!event.preview) {
					clearInputProgress();
					state = "idle";
				}
				break;
			case "error":
				if (event.preview) break;
				state = "error";
				if (event.message !== lastError) {
					lastError = event.message;
					activeContext?.ui.notify(`Voice mode: ${event.message}`, "error");
				}
				break;
		}
		refreshStatus();
	};

	const vocalizer = new Vocalizer(() => config, handleWorkerEvent);
	const phoneInput = new PhoneInputClient();

	const updateConfig = async (next: VoiceConfig): Promise<void> => {
		const wasEnabled = config.enabled;
		await saveVoiceConfig(next);
		config = next;
		if (wasEnabled && !config.enabled) vocalizer.clear();
		state = "idle";
		refreshStatus();
	};

	const toggle = async (ctx: ExtensionContext): Promise<void> => {
		await updateConfig({ ...config, enabled: !config.enabled });
		ctx.ui.notify(`Voice mode ${config.enabled ? "enabled" : "disabled"}`, "info");
	};

	const talk = async (ctx: ExtensionContext): Promise<void> => {
		const talkEpoch = contextEpoch;
		if (config.input === "disabled") {
			ctx.ui.notify("Phone microphone is disabled. Configure /voice input tcp://127.0.0.1:8766", "warning");
			return;
		}
		if (inputPhase === "recording") {
			setInputProgress("🎙 Stopping phone recording…");
			try {
				await phoneInput.stop(config.input);
			} catch (error) {
				ctx.ui.notify(`Phone microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return;
		}
		if (inputPhase === "transcribing") {
			ctx.ui.notify("The previous phone recording is still being transcribed", "info");
			return;
		}
		beginInputProgress();
		vocalizer.clear();
		state = "listening";
		refreshStatus();
		const editorBase = ctx.ui.getEditorText();
		let committedSpeech = "";
		let partialSpeech = "";
		const renderPreview = (): void => {
			const speech = [committedSpeech, partialSpeech].filter(Boolean).join(" ");
			ctx.ui.setEditorText(appendDictation(editorBase, speech));
		};
		const live = new LiveTranscriptionSession(audio => vocalizer.transcribePcm(audio), {
			onPartial: text => {
				partialSpeech = text;
				renderPreview();
			},
			onSegment: text => {
				committedSpeech = [committedSpeech, text].filter(Boolean).join(" ");
				partialSpeech = "";
				renderPreview();
			},
		});
		try {
			const capture = await phoneInput.capture(config.input, {
				onProgress: progress => {
					const elapsed = progress.elapsedSeconds.toFixed(1);
					setInputProgress(
						progress.speechDetected
							? `🎙 Live dictation: ${elapsed}s — stops after silence; Alt+M to finish`
							: `🎙 Waiting for speech: ${elapsed}s — Alt+M to finish`,
					);
				},
				onAudio: audio => live.push(audio),
			});
			inputPhase = "transcribing";
			if (inputProgressTimer) clearInterval(inputProgressTimer);
			inputProgressTimer = null;
			setInputProgress("♬ Finalizing transcript…");
			if (talkEpoch !== contextEpoch || !activeContext) {
				live.cancel();
				return;
			}
			let liveTranscript = "";
			try {
				liveTranscript = (await live.finish()).trim();
			} catch {
				// The final whole-utterance pass below remains available as a fallback.
			}
			const transcript =
				capture.type === "audio" ? (await vocalizer.transcribe(capture.data)).trim() || liveTranscript : capture.data.trim();
			if (talkEpoch !== contextEpoch || !activeContext) return;
			clearInputProgress();
			state = "idle";
			refreshStatus();
			if (!transcript) {
				ctx.ui.setEditorText(editorBase);
				ctx.ui.notify("No speech recognized", "warning");
				return;
			}
			let prompt = appendDictation(editorBase, transcript);
			if (config.editMode === "smart" && editorBase.trim()) {
				const editingModel = config.editModel === "current" ? (ctx.model?.id ?? "the current model") : config.editModel;
				setInputProgress(`✎ Applying spoken edit with ${editingModel}…`);
				try {
					prompt = await applySpokenEdit(ctx, editorBase, transcript, config.editModel);
				} catch (error) {
					ctx.ui.notify(
						`Smart voice edit failed; appended dictation instead: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				} finally {
					setInputProgress(undefined);
				}
			}
			if (talkEpoch !== contextEpoch || !activeContext) return;
			if (config.submitMode === "review") {
				ctx.ui.setEditorText(prompt);
				ctx.ui.notify("Dictation ready to review — press Enter to submit", "info");
				return;
			}
			ctx.ui.setEditorText("");
			if (ctx.isIdle()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "steer" });
		} catch (error) {
			live.cancel();
			if (talkEpoch !== contextEpoch || !activeContext) return;
			clearInputProgress();
			state = "error";
			refreshStatus();
			ctx.ui.notify(`Phone microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		contextEpoch += 1;
		activeContext = ctx;
		refreshStatus();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		contextEpoch += 1;
		ctx.ui.setStatus("pi-voice", undefined);
		clearInputProgress();
		activeContext = null;
		phoneInput.cancel();
		await vocalizer.shutdown();
	});

	pi.on("input", () => {
		vocalizer.clear();
	});

	pi.on("before_agent_start", () => {
		vocalizer.clear();
	});

	pi.on("message_update", event => {
		if (!config.enabled || config.mode === "yield") return;
		const delta = event.assistantMessageEvent;
		if (delta.type === "text_delta") {
			vocalizer.pushDelta(delta.delta);
		} else if (delta.type === "thinking_delta" && config.mode === "all") {
			vocalizer.pushDelta(delta.delta);
		}
	});

	pi.on("message_end", event => {
		if (!config.enabled || assistantStopReason(event.message) === undefined) return;
		const stopReason = assistantStopReason(event.message);
		if (stopReason === "aborted" || stopReason === "error") {
			vocalizer.clear();
		} else if (config.mode !== "yield") {
			vocalizer.flush();
		}
	});

	pi.on("turn_end", event => {
		if (!config.enabled || config.mode !== "yield") return;
		const stopReason = assistantStopReason(event.message);
		if (stopReason === "aborted" || stopReason === "error" || stopReason === undefined) return;
		const text = assistantText(event.message);
		if (text) vocalizer.speak(text);
	});

	pi.registerShortcut("ctrl+shift+v", {
		description: "Toggle Kokoro voice mode",
		handler: async ctx => toggle(ctx),
	});

	if (config.talkShortcut !== "disabled") {
		pi.registerShortcut(config.talkShortcut, {
			description: "Start or stop a prompt with the phone microphone",
			handler: ctx => {
				void talk(ctx);
			},
		});
	}

	pi.registerCommand("voice", {
		description: "Control local Kokoro voice mode",
		getArgumentCompletions: prefix => {
			const values = [
				"on",
				"off",
				"toggle",
				"status",
				"stop",
				"setup",
				"test",
				"talk",
				"mode",
				"voice",
				"speed",
				"output",
				"input",
				"shortcut",
				"submit",
				"edit",
				"tts-model",
				"tts-dtype",
				"stt-model",
				"stt-dtype",
				"edit-model",
			];
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length <= 1) {
				return values.filter(value => value.startsWith(parts[0] ?? "")).map(value => ({ value, label: value }));
			}
			if (parts[0] === "tts-model") {
				return ["onnx-community/Kokoro-82M-v1.0-ONNX"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `tts-model ${value}`, label: value }));
			}
			if (parts[0] === "stt-model") {
				return [
					"onnx-community/whisper-tiny.en",
					"onnx-community/whisper-base.en",
					"onnx-community/whisper-small.en",
					"onnx-community/whisper-tiny",
					"onnx-community/whisper-base",
					"onnx-community/whisper-small",
				]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `stt-model ${value}`, label: value }));
			}
			if (parts[0] === "tts-dtype" || parts[0] === "stt-dtype") {
				return ["fp32", "q8", "q4"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `${parts[0]} ${value}`, label: value }));
			}
			if (parts[0] === "edit-model") {
				return ["current"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `edit-model ${value}`, label: value }));
			}
			if (parts[0] === "mode") {
				return ["assistant", "all", "yield"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `mode ${value}`, label: value }));
			}
			if (parts[0] === "voice") {
				return VOICES.filter(voice => voice.id.startsWith(parts[1] ?? "")).map(voice => ({
					value: `voice ${voice.id}`,
					label: voice.id,
					description: voice.label,
				}));
			}
			if (parts[0] === "output") {
				return [
					{ value: "output local", label: "local", description: "Play through this machine's speakers" },
					{
						value: "output tcp://127.0.0.1:8765",
						label: "tcp://127.0.0.1:8765",
						description: "Stream raw audio through an SSH reverse tunnel",
					},
				];
			}
			if (parts[0] === "edit") {
				return ["smart", "append"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `edit ${value}`, label: value }));
			}
			if (parts[0] === "submit") {
				return ["review", "auto"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `submit ${value}`, label: value }));
			}
			if (parts[0] === "shortcut") {
				return ["alt+m", "ctrl+shift+m", "f8", "disabled"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `shortcut ${value}`, label: value }));
			}
			if (parts[0] === "input") {
				return [
					{ value: "input disabled", label: "disabled" },
					{
						value: "input tcp://127.0.0.1:8766",
						label: "tcp://127.0.0.1:8766",
						description: "Use Termux speech recognition through an SSH reverse tunnel",
					},
				];
			}
			return null;
		},
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			const [action = "status", value = ""] = args.split(/\s+/, 2);
			switch (action.toLowerCase()) {
				case "on":
					await updateConfig({ ...config, enabled: true });
					ctx.ui.notify("Voice mode enabled", "info");
					return;
				case "off":
					await updateConfig({ ...config, enabled: false });
					ctx.ui.notify("Voice mode disabled", "info");
					return;
				case "toggle":
					await toggle(ctx);
					return;
				case "stop":
					vocalizer.clear();
					if (inputPhase === "recording") {
						setInputProgress("🎙 Stopping phone recording…");
						void phoneInput.stop(config.input).catch(error =>
							ctx.ui.notify(`Phone microphone: ${error instanceof Error ? error.message : String(error)}`, "error"),
						);
					}
					state = inputInProgress ? "listening" : "idle";
					refreshStatus();
					return;
				case "talk":
					void talk(ctx);
					return;
				case "setup":
					ctx.ui.notify(`Preparing ${config.ttsModel} (${config.ttsDtype})…`, "info");
					try {
						await vocalizer.preload();
						ctx.ui.notify("Text-to-speech model is ready", "info");
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				case "tts-model":
				case "stt-model": {
					const model = normalizeModelId(value);
					if (!model) {
						ctx.ui.notify(`Usage: /voice ${action} <huggingface-repo>`, "error");
						return;
					}
					vocalizer.clear();
					if (action.toLowerCase() === "tts-model") await updateConfig({ ...config, ttsModel: model });
					else await updateConfig({ ...config, sttModel: model });
					ctx.ui.notify(`${action.toUpperCase()} set to ${model}; it will download on first use`, "info");
					return;
				}
				case "tts-dtype":
				case "stt-dtype": {
					const dtype = normalizeModelDtype(value.toLowerCase());
					if (!dtype) {
						ctx.ui.notify(`Usage: /voice ${action} fp32|q8|q4`, "error");
						return;
					}
					vocalizer.clear();
					if (action.toLowerCase() === "tts-dtype") await updateConfig({ ...config, ttsDtype: dtype });
					else await updateConfig({ ...config, sttDtype: dtype });
					ctx.ui.notify(`${action.toUpperCase()} set to ${dtype}`, "info");
					return;
				}
				case "edit-model": {
					const model = normalizeEditModel(value);
					if (!model) {
						ctx.ui.notify("Usage: /voice edit-model current|provider/model-id", "error");
						return;
					}
					if (model !== "current") {
						const separator = model.indexOf("/");
						if (!ctx.modelRegistry.find(model.slice(0, separator), model.slice(separator + 1))) {
							ctx.ui.notify(`Editing model is not available in Pi: ${model}`, "error");
							return;
						}
					}
					await updateConfig({ ...config, editModel: model });
					ctx.ui.notify(`Smart editing model set to ${model}`, "info");
					return;
				}
				case "mode": {
					const mode = parseMode(value.toLowerCase());
					if (!mode) {
						ctx.ui.notify("Usage: /voice mode assistant|all|yield", "error");
						return;
					}
					vocalizer.clear();
					await updateConfig({ ...config, mode });
					ctx.ui.notify(`Voice mode set to ${mode}`, "info");
					return;
				}
				case "voice": {
					let selected = value;
					if (!selected && ctx.hasUI) {
						const label = await ctx.ui.select(
							"Kokoro voice",
							VOICES.map(voice => `${voice.id} — ${voice.label}`),
						);
						selected = label?.split(" — ", 1)[0] ?? "";
					}
					if (!isVoice(selected)) {
						ctx.ui.notify("Unknown voice. Run /voice voice and choose from the picker.", "error");
						return;
					}
					vocalizer.clear();
					await updateConfig({ ...config, voice: selected });
					ctx.ui.notify(`Kokoro voice set to ${selected}`, "info");
					return;
				}
				case "speed": {
					const speed = Number(value);
					if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
						ctx.ui.notify("Usage: /voice speed <0.5..2>", "error");
						return;
					}
					await updateConfig({ ...config, speed });
					ctx.ui.notify(`Voice speed set to ${speed}`, "info");
					return;
				}
				case "output": {
					const output = normalizeVoiceOutput(value);
					if (!output) {
						ctx.ui.notify("Usage: /voice output local|tcp://host:port", "error");
						return;
					}
					vocalizer.clear();
					await updateConfig({ ...config, output });
					ctx.ui.notify(`Voice output set to ${output}`, "info");
					return;
				}
				case "edit": {
					const editMode = parseEditMode(value.toLowerCase());
					if (!editMode) {
						ctx.ui.notify("Usage: /voice edit smart|append", "error");
						return;
					}
					await updateConfig({ ...config, editMode });
					ctx.ui.notify(`Spoken prompt editing set to ${editMode}`, "info");
					return;
				}
				case "submit": {
					const submitMode = parseSubmitMode(value.toLowerCase());
					if (!submitMode) {
						ctx.ui.notify("Usage: /voice submit review|auto", "error");
						return;
					}
					await updateConfig({ ...config, submitMode });
					ctx.ui.notify(`Voice dictation submit mode set to ${submitMode}`, "info");
					return;
				}
				case "shortcut": {
					const shortcut = normalizeTalkShortcut(value);
					if (!shortcut) {
						ctx.ui.notify("Usage: /voice shortcut <key|disabled> (for example alt+m, ctrl+shift+m, or f8)", "error");
						return;
					}
					await updateConfig({ ...config, talkShortcut: shortcut });
					ctx.ui.notify(
						`Phone microphone shortcut set to ${shortcut}. Run /reload to apply it.`,
						"info",
					);
					return;
				}
				case "input": {
					const input = normalizeVoiceInput(value);
					if (!input) {
						ctx.ui.notify("Usage: /voice input disabled|tcp://host:port", "error");
						return;
					}
					phoneInput.cancel();
					await updateConfig({ ...config, input });
					ctx.ui.notify(`Voice input set to ${input}`, "info");
					return;
				}
				case "test": {
					if (!config.enabled) {
						ctx.ui.notify("Enable voice mode first with /voice on", "warning");
						return;
					}
					const text = args.slice(action.length).trim() || "Pi voice mode is ready.";
					vocalizer.clear();
					vocalizer.speak(text);
					return;
				}
				case "status":
				case "":
					ctx.ui.notify(
						`Voice ${config.enabled ? "on" : "off"}; mode=${config.mode}; voice=${config.voice}; speed=${config.speed}; tts=${config.ttsModel}@${config.ttsDtype}; stt=${config.sttModel}@${config.sttDtype}; editModel=${config.editModel}; output=${config.output}; input=${config.input}; shortcut=${config.talkShortcut}; submit=${config.submitMode}; edit=${config.editMode}`,
						"info",
					);
					return;
				default:
					ctx.ui.notify(
						"Usage: /voice [on|off|toggle|status|stop|setup|test|talk|mode|voice|speed|tts-model|tts-dtype|stt-model|stt-dtype|edit-model|output|input|shortcut|submit|edit]",
						"error",
					);
			}
		},
	});
}
