import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CodeDescriptionCache, type CodeDescriptionCacheSnapshot } from "./code-description-cache.js";
import { codeDescriptionCacheKey, describeCodeBlock, fallbackCodeDescription } from "./code-describer.js";
import {
	loadVoiceConfig,
	normalizeEditModel,
	normalizeModelDtype,
	normalizeModelId,
	normalizeSttCandidates,
	normalizeTalkShortcut,
	normalizeVoiceInput,
	normalizeVoiceOutput,
	saveVoiceConfig,
	type VoiceConfig,
	type VoiceEditMode,
	type VoiceMode,
	type VoiceSubmitMode,
} from "./config.js";
import { chunkCodeNarration, plainCodeNarration, type CodeNarrationPlan } from "./code-narration.js";
import { LiveTranscriptionSession } from "./live-transcription.js";
import { NarrationProgress } from "./narration-progress.js";
import {
	PlaybackHistory,
	type PlaybackMessage,
	type PlaybackTarget,
	type PlaybackTimingSnapshot,
} from "./playback-history.js";
import { PhoneInputClient } from "./phone-input.js";
import { SpeakableStream, type FencedCodeBlock, type SpeakableSourceRange } from "./speakable.js";
import { applySpokenEdit, resolveDictationCandidates } from "./prompt-editor.js";
import { Vocalizer } from "./vocalizer.js";
import { isVoice, VOICES } from "./voices.js";
import type { WorkerEvent } from "./worker-client.js";

type VoiceState = "downloading" | "error" | "idle" | "listening" | "loading" | "speaking";
type InputPhase = "idle" | "recording" | "transcribing";
type PreprocessingProgress = { label: string; current: number; total: number };

const PLAYBACK_TIMING_ENTRY = "pi-voice.playback-timing";
const CODE_DESCRIPTION_CACHE_ENTRY = "pi-voice.code-description";

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

function completedAssistantMessages(ctx: ExtensionContext, mode: VoiceMode): PlaybackMessage[] {
	const messages: PlaybackMessage[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const stopReason = assistantStopReason(entry.message);
		if (stopReason === undefined || stopReason === "aborted" || stopReason === "error") continue;
		// Yield mode only speaks the final response, not intermediate text attached to tool/edit calls.
		if (mode === "yield" && stopReason === "toolUse") continue;
		const text = assistantText(entry.message);
		if (text) messages.push({ id: entry.id, text });
	}
	return messages;
}

function playbackTimingSnapshots(ctx: ExtensionContext): PlaybackTimingSnapshot[] {
	const snapshots: PlaybackTimingSnapshot[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== PLAYBACK_TIMING_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1) continue;
		snapshots.push(data as PlaybackTimingSnapshot);
	}
	return snapshots;
}

function codeDescriptionSnapshots(ctx: ExtensionContext): unknown[] {
	const snapshots: unknown[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === CODE_DESCRIPTION_CACHE_ENTRY) snapshots.push(entry.data);
	}
	return snapshots;
}

function timingItems(text: string): Array<{ text: string; source: SpeakableSourceRange }> {
	const stream = new SpeakableStream();
	return [...stream.push(text), ...stream.flush()].map(item => ({
		text: item.kind === "speech" ? item.text : fallbackCodeDescription(item.block),
		source: item.source,
	}));
}

function describableCodeBlocks(text: string): FencedCodeBlock[] {
	const stream = new SpeakableStream();
	return [...stream.push(text), ...stream.flush()]
		.filter(item => item.kind === "code")
		.map(item => item.block);
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

function formatPlaybackTime(seconds: number): string {
	const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
	const minutes = Math.floor(whole / 60);
	return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function playbackBar(position: number, duration: number, width = 24): string {
	const ratio = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
	const cursor = Math.min(width - 1, Math.round(ratio * (width - 1)));
	return `[${Array.from({ length: width }, (_value, index) => (index === cursor ? "●" : "━")).join("")}]`;
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
	let narrationTui: { invalidate(): void; requestRender(force?: boolean): void } | null = null;
	let narrationRenderTimer: NodeJS.Timeout | null = null;
	let livePlaybackId: string | undefined;
	let nextLivePlaybackId = 0;
	let playbackPaused = false;
	let playbackPositionEstimated = false;
	let playbackTimelineTimer: NodeJS.Timeout | null = null;
	let codePreprocessingProgress: PreprocessingProgress | undefined;
	let timingPreprocessingProgress: PreprocessingProgress | undefined;
	const playbackHistory = new PlaybackHistory();
	const codeDescriptionCache = new CodeDescriptionCache();
	const codeDescriptionText = new Map<string, string>();
	const pendingCodeDescriptions = new Map<string, CodeDescriptionCacheSnapshot>();

	const requestNarrationRender = (): void => {
		if (!narrationTui || narrationRenderTimer) return;
		narrationRenderTimer = setTimeout(() => {
			narrationRenderTimer = null;
			narrationTui?.invalidate();
			narrationTui?.requestRender();
		}, 80);
		narrationRenderTimer.unref?.();
	};
	const narration = new NarrationProgress(requestNarrationRender);

	const refreshPreprocessingProgress = (): void => {
		const ctx = activeContext;
		if (!ctx) return;
		const lines = [codePreprocessingProgress, timingPreprocessingProgress]
			.filter((progress): progress is PreprocessingProgress => progress !== undefined)
			.map(progress =>
				ctx.ui.theme.fg("dim", `${progress.label}: message ${progress.current}/${progress.total}`),
			);
		ctx.ui.setWidget("pi-voice-preprocessing", lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
	};

	const descriptionText = (plan: CodeNarrationPlan): string =>
		chunkCodeNarration(plan)
			.map(chunk => chunk.text)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();

	const requestCodeDescription = (ctx: ExtensionContext, block: FencedCodeBlock): Promise<CodeNarrationPlan> => {
		const editModel = config.editModel;
		const narrationMode = config.codeNarration;
		const key = codeDescriptionCacheKey(ctx, block, editModel, narrationMode);
		return codeDescriptionCache
			.getOrCreate(
				key,
				() =>
					describeCodeBlock(ctx, block, editModel, narrationMode).catch(() =>
						plainCodeNarration(fallbackCodeDescription(block)),
					),
				snapshot => {
					if (activeContext !== ctx) return;
					if (ctx.isIdle()) pi.appendEntry(CODE_DESCRIPTION_CACHE_ENTRY, snapshot);
					else pendingCodeDescriptions.set(snapshot.key, snapshot);
				},
			)
			.then(plan => {
				if (activeContext === ctx) {
					codeDescriptionText.set(key, descriptionText(plan));
					requestNarrationRender();
				}
				return plan;
			});
	};

	let codeDescriptionPreprocessing: Promise<void> | undefined;
	const scheduleMissingCodeDescriptions = (ctx: ExtensionContext): void => {
		if (codeDescriptionPreprocessing) return;
		const epoch = contextEpoch;
		const queuedKeys = new Set<string>();
		const queuedMessages: FencedCodeBlock[][] = [];
		for (const message of completedAssistantMessages(ctx, "assistant").reverse()) {
			const blocks: FencedCodeBlock[] = [];
			for (const block of describableCodeBlocks(message.text)) {
				try {
					const key = codeDescriptionCacheKey(ctx, block, config.editModel, config.codeNarration);
					if (!codeDescriptionCache.get(key) && !queuedKeys.has(key)) {
						queuedKeys.add(key);
						blocks.push(block);
					}
				} catch {
					// A missing edit model is handled by the local fallback when requested directly.
				}
			}
			if (blocks.length > 0) queuedMessages.push(blocks);
		}
		if (queuedMessages.length === 0) return;
		codeDescriptionPreprocessing = (async () => {
			for (let index = 0; index < queuedMessages.length; index += 1) {
				if (epoch !== contextEpoch || activeContext !== ctx) break;
				codePreprocessingProgress = {
					label: "Code descriptions",
					current: index + 1,
					total: queuedMessages.length,
				};
				refreshPreprocessingProgress();
				for (const block of queuedMessages[index]) await requestCodeDescription(ctx, block);
			}
		})().finally(() => {
			codeDescriptionPreprocessing = undefined;
			codePreprocessingProgress = undefined;
			refreshPreprocessingProgress();
		});
	};

	const scheduleCodeDescriptionsInText = (ctx: ExtensionContext, text: string): void => {
		for (const block of describableCodeBlocks(text)) void requestCodeDescription(ctx, block);
	};

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType === "user") return markdown;
		return narration.transform(
			markdown,
			context.messageType,
			text => (config.playbackHighlight ? (activeContext?.ui.theme.fg("dim", text) ?? text) : text),
			text => (config.playbackHighlight ? (activeContext?.ui.theme.bg("selectedBg", text) ?? text) : text),
			block => {
				const ctx = activeContext;
				if (!ctx) return undefined;
				try {
					const key = codeDescriptionCacheKey(ctx, block, config.editModel, config.codeNarration);
					const existing = codeDescriptionText.get(key);
					if (existing !== undefined) return existing;
					const plan = codeDescriptionCache.get(key);
					if (!plan) return undefined;
					const text = chunkCodeNarration(plan)
						.map(chunk => chunk.text)
						.join(" ");
					codeDescriptionText.set(key, text);
					return text;
				} catch {
					return undefined;
				}
			},
			config.enabled && config.playbackHighlight,
		);
	});

	const refreshPlaybackTimeline = (): void => {
		const ctx = activeContext;
		if (!ctx || !config.enabled) {
			ctx?.ui.setWidget("pi-voice-playback", undefined);
			return;
		}
		const playback = playbackHistory.status();
		if (!playback) {
			ctx.ui.setWidget("pi-voice-playback", undefined);
			return;
		}
		const messageLabel =
			playback.messageIndex >= 0 ? ` · message ${playback.messageIndex + 1}/${playback.messageCount}` : "";
		if (!playback.hasTimings || playback.duration <= 0) {
			ctx.ui.setWidget(
				"pi-voice-playback",
				[ctx.ui.theme.fg("dim", `○ timing preprocessing${messageLabel}`)],
				{ placement: "belowEditor" },
			);
			return;
		}
		const icon = playbackPaused ? "⏸" : state === "speaking" ? "▶" : "■";
		const estimate = playbackPositionEstimated ? "~" : "";
		const timeline = `${icon} ${playbackBar(playback.position, playback.duration)} ${estimate}${formatPlaybackTime(playback.position)} / ${formatPlaybackTime(playback.duration)}${messageLabel}`;
		ctx.ui.setWidget("pi-voice-playback", [ctx.ui.theme.fg(state === "speaking" ? "accent" : "dim", timeline)], {
			placement: "belowEditor",
		});
	};

	const requestPlaybackTimeline = (): void => {
		if (playbackTimelineTimer) return;
		playbackTimelineTimer = setTimeout(() => {
			playbackTimelineTimer = null;
			refreshPlaybackTimeline();
		}, 80);
		playbackTimelineTimer.unref?.();
	};

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
				if (!inputInProgress) state = "idle";
				downloadPercent = undefined;
				break;
			case "idle":
				if (!inputInProgress) state = "idle";
				downloadPercent = undefined;
				playbackHistory.finishUtterance(event.utterance);
				playbackPositionEstimated = false;
				if (event.utterance !== undefined) {
					const snapshot = playbackHistory.snapshotForUtterance(event.utterance);
					if (snapshot) pi.appendEntry(PLAYBACK_TIMING_ENTRY, snapshot);
				}
				narration.finishUtterance(event.utterance);
				break;
			case "speaking":
				state = "speaking";
				playbackPaused = false;
				break;
			case "segment-audio":
				narration.setSegmentAudio(event.segmentId, event.start, event.duration);
				playbackHistory.setSegmentAudio(event.segmentId, event.start, event.duration);
				requestPlaybackTimeline();
				return;
			case "alignment":
				narration.setAlignment(event.segmentId, event.words);
				return;
			case "playback":
				narration.setPlayback(event.utterance, event.position);
				playbackHistory.setPlayback(event.utterance, event.position);
				playbackPositionEstimated = event.estimated === true;
				requestPlaybackTimeline();
				return;
			case "alignment-error":
				// Duration-weighted word timing remains active as a fallback.
				return;
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
		requestPlaybackTimeline();
	};

	const vocalizer = new Vocalizer(
		() => config,
		handleWorkerEvent,
		(block, _signal) => {
			const ctx = activeContext;
			if (!ctx) return Promise.reject(new Error("No active Pi context for code description"));
			return requestCodeDescription(ctx, block);
		},
		segment => {
			narration.registerSegment(segment);
			playbackHistory.registerSegment(segment);
		},
	);
	const phoneInput = new PhoneInputClient();

	const playTarget = (target: PlaybackTarget, recordTimings: boolean): void => {
		const sourceOffset = Math.max(0, Math.min(target.text.length, target.sourceOffset));
		const suffix = target.text.slice(sourceOffset);
		if (!suffix.trim()) return;
		vocalizer.clear();
		narration.finish();
		narration.begin();
		narration.setCompletedText(target.text);
		playbackHistory.beginCapture(target.id, target.text, target.time, recordTimings);
		playbackPaused = false;
		playbackPositionEstimated = false;
		refreshPlaybackTimeline();
		vocalizer.speakFrom(suffix, sourceOffset);
	};

	const syncPlaybackMessages = (ctx: ExtensionContext, selectLatest = false): PlaybackMessage[] => {
		const messages = completedAssistantMessages(ctx, config.mode);
		playbackHistory.sync(messages, selectLatest);
		return messages;
	};

	const finalizePlaybackMessage = (
		ctx: ExtensionContext,
		playbackId: string,
		text: string,
		attempt = 0,
	): void => {
		playbackHistory.updateText(playbackId, text);
		const messages = completedAssistantMessages(ctx, config.mode);
		const completed = messages.findLast(message => message.text === text);
		if (completed) {
			playbackHistory.rename(playbackId, completed);
			playbackHistory.sync(messages);
			return;
		}
		if (attempt >= 5) return;
		const epoch = contextEpoch;
		const timer = setTimeout(
			() => {
				if (epoch === contextEpoch && activeContext === ctx) finalizePlaybackMessage(ctx, playbackId, text, attempt + 1);
			},
			[0, 20, 100, 250, 500][attempt] ?? 500,
		);
		timer.unref?.();
	};

	let timingPreprocessing: Promise<void> | undefined;
	const scheduleMissingTimings = (ctx: ExtensionContext): void => {
		if (!config.enabled || timingPreprocessing) return;
		const epoch = contextEpoch;
		const missing = syncPlaybackMessages(ctx)
			.filter(message => !playbackHistory.hasTimingFor(message.id))
			.reverse();
		if (missing.length === 0) return;
		timingPreprocessing = (async () => {
			for (let index = 0; index < missing.length; index += 1) {
				if (epoch !== contextEpoch || activeContext !== ctx || !config.enabled) break;
				const message = missing[index];
				timingPreprocessingProgress = {
					label: "Speech timing",
					current: index + 1,
					total: missing.length,
				};
				refreshPreprocessingProgress();
				const checkpoints: PlaybackTimingSnapshot["checkpoints"] = [];
				let time = 0;
				try {
					for (const item of timingItems(message.text)) {
						const duration = await vocalizer.measureSegment(item.text);
						if (epoch !== contextEpoch || activeContext !== ctx) return;
						if (!Number.isFinite(duration) || duration <= 0) continue;
						checkpoints.push({ time, duration, sourceOffset: item.source.start });
						time += duration;
					}
				} catch {
					// Live speech and microphone actions preempt low-priority timing work.
					break;
				}
				if (checkpoints.length === 0) continue;
				const snapshot: PlaybackTimingSnapshot = {
					version: 1,
					messageId: message.id,
					duration: time,
					checkpoints,
				};
				playbackHistory.restore([snapshot]);
				requestPlaybackTimeline();
				pi.appendEntry(PLAYBACK_TIMING_ENTRY, snapshot);
			}
		})().finally(() => {
			timingPreprocessing = undefined;
			timingPreprocessingProgress = undefined;
			refreshPreprocessingProgress();
		});
	};

	const warmModels = async (): Promise<void> => {
		await vocalizer.warm();
	};

	const updateConfig = async (next: VoiceConfig): Promise<void> => {
		const previous = config;
		const wasEnabled = config.enabled;
		await saveVoiceConfig(next);
		config = next;
		if (wasEnabled && !config.enabled) {
			vocalizer.clear();
			narration.finish();
		}
		state = "idle";
		refreshStatus();
		refreshPlaybackTimeline();
		if (activeContext) scheduleMissingCodeDescriptions(activeContext);
		if (
			config.enabled &&
			(!wasEnabled ||
				previous.ttsModel !== config.ttsModel ||
				previous.ttsDtype !== config.ttsDtype ||
				previous.alignmentModel !== config.alignmentModel ||
				previous.alignmentDtype !== config.alignmentDtype)
		) {
			void warmModels().catch(error =>
				activeContext?.ui.notify(`Voice model warm-up failed: ${error instanceof Error ? error.message : String(error)}`, "warning"),
			);
		}
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
			let candidates =
				capture.type === "audio" ? await vocalizer.transcribe(capture.data) : [capture.data.trim()];
			candidates = [...new Set(candidates.map(candidate => candidate.replace(/\s+/g, " ").trim()).filter(Boolean))];
			if (candidates.length === 0 && liveTranscript) candidates = [liveTranscript];
			if (talkEpoch !== contextEpoch || !activeContext) return;
			clearInputProgress();
			state = "idle";
			refreshStatus();
			if (candidates.length === 0) {
				ctx.ui.setEditorText(editorBase);
				ctx.ui.notify("No speech recognized", "warning");
				return;
			}
			const editingModel = config.editModel === "current" ? (ctx.model?.id ?? "the current model") : config.editModel;
			const candidateLabel = `${candidates.length} ASR candidate${candidates.length === 1 ? "" : "s"}`;
			setInputProgress(
				config.editMode === "smart" && editorBase.trim()
					? `✎ Resolving ${candidateLabel} and applying spoken edits with ${editingModel}…`
					: `✎ Resolving ${candidateLabel} with ${editingModel}…`,
			);
			let prompt = appendDictation(editorBase, candidates[0]);
			try {
				if (config.editMode === "smart" && editorBase.trim()) {
					prompt = await applySpokenEdit(ctx, editorBase, candidates, config.editModel);
				} else {
					const resolved = await resolveDictationCandidates(ctx, editorBase, candidates, config.editModel);
					prompt = appendDictation(editorBase, resolved);
				}
			} catch (error) {
				ctx.ui.notify(
					`Voice dictation resolution failed; used the primary ASR candidate: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			} finally {
				setInputProgress(undefined);
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
		pendingCodeDescriptions.clear();
		codeDescriptionText.clear();
		codeDescriptionCache.restore(codeDescriptionSnapshots(ctx));
		scheduleMissingCodeDescriptions(ctx);
		syncPlaybackMessages(ctx, true);
		playbackHistory.restore(playbackTimingSnapshots(ctx));
		refreshPlaybackTimeline();
		if (config.enabled) {
			scheduleMissingTimings(ctx);
			void warmModels().catch(error =>
				ctx.ui.notify(`Voice model warm-up failed: ${error instanceof Error ? error.message : String(error)}`, "warning"),
			);
		}
		if (ctx.mode === "tui") {
			ctx.ui.setWidget("pi-voice-render-driver", tui => {
				narrationTui = tui;
				return {
					render: () => [],
					invalidate: () => {},
					dispose: () => {
						if (narrationTui === tui) narrationTui = null;
					},
				};
			});
		}
		refreshStatus();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		contextEpoch += 1;
		pendingCodeDescriptions.clear();
		ctx.ui.setStatus("pi-voice", undefined);
		ctx.ui.setWidget("pi-voice-render-driver", undefined);
		ctx.ui.setWidget("pi-voice-playback", undefined);
		ctx.ui.setWidget("pi-voice-preprocessing", undefined);
		codePreprocessingProgress = undefined;
		timingPreprocessingProgress = undefined;
		clearInputProgress();
		if (narrationRenderTimer) clearTimeout(narrationRenderTimer);
		narrationRenderTimer = null;
		if (playbackTimelineTimer) clearTimeout(playbackTimelineTimer);
		playbackTimelineTimer = null;
		narrationTui = null;
		narration.finish();
		activeContext = null;
		phoneInput.cancel();
		await vocalizer.shutdown();
	});

	pi.on("input", () => {
		vocalizer.clear();
		narration.finish();
	});

	pi.on("before_agent_start", () => {
		vocalizer.clear();
		narration.finish();
	});

	pi.on("message_start", event => {
		if (
			config.enabled &&
			config.mode !== "yield" &&
			typeof event.message === "object" &&
			event.message !== null &&
			"role" in event.message &&
			event.message.role === "assistant"
		) {
			narration.finish();
			narration.begin();
			playbackPaused = false;
			livePlaybackId = `live:${++nextLivePlaybackId}`;
			playbackHistory.beginCapture(livePlaybackId, "", 0, true);
			refreshPlaybackTimeline();
		}
	});

	pi.on("message_update", event => {
		if (!config.enabled || config.mode === "yield") return;
		const delta = event.assistantMessageEvent;
		if (delta.type === "text_delta") {
			narration.pushDelta("assistant", delta.contentIndex, delta.delta);
			vocalizer.pushDelta(delta.delta);
		} else if (delta.type === "thinking_delta" && config.mode === "all") {
			narration.pushDelta("assistant-thinking", delta.contentIndex, delta.delta);
			vocalizer.pushDelta(delta.delta);
		}
	});

	pi.on("message_end", event => {
		const completedText = assistantText(event.message);
		const stopReason = assistantStopReason(event.message);
		if (completedText && stopReason !== undefined && stopReason !== "aborted" && stopReason !== "error" && activeContext) {
			scheduleCodeDescriptionsInText(activeContext, completedText);
			if (livePlaybackId) finalizePlaybackMessage(activeContext, livePlaybackId, completedText);
			livePlaybackId = undefined;
		}
		if (!config.enabled || stopReason === undefined) return;
		if (stopReason === "aborted" || stopReason === "error") {
			vocalizer.clear();
			narration.finish();
			livePlaybackId = undefined;
		} else if (config.mode !== "yield") {
			vocalizer.flush();
		}
	});

	pi.on("turn_end", (event, ctx) => {
		if (config.enabled && config.mode === "yield") {
			const stopReason = assistantStopReason(event.message);
			if (stopReason !== "aborted" && stopReason !== "error" && stopReason !== undefined) {
				const text = assistantText(event.message);
				if (text) {
					const messages = completedAssistantMessages(ctx, config.mode);
					const completed = messages.findLast(message => message.text === text);
					if (completed) {
						playbackHistory.sync(messages, true);
						playbackHistory.beginCapture(completed.id, completed.text, 0, true);
					}
					narration.setCompletedText(text);
					vocalizer.speak(text);
				}
			}
		}
		scheduleMissingTimings(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (activeContext !== ctx) return;
		for (const snapshot of pendingCodeDescriptions.values()) {
			pi.appendEntry(CODE_DESCRIPTION_CACHE_ENTRY, snapshot);
		}
		pendingCodeDescriptions.clear();
		scheduleMissingCodeDescriptions(ctx);
	});

	pi.registerShortcut("ctrl+shift+v", {
		description: "Toggle Kokoro voice mode",
		handler: async ctx => toggle(ctx),
	});

	const canNavigatePlayback = (ctx: ExtensionContext): boolean => {
		if (!config.enabled) {
			ctx.ui.notify("Voice mode is disabled", "warning");
			return false;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current assistant response before navigating playback", "warning");
			return false;
		}
		return true;
	};

	const replaySelected = (ctx: ExtensionContext): void => {
		if (!canNavigatePlayback(ctx)) return;
		syncPlaybackMessages(ctx);
		const target = playbackHistory.restartTarget();
		if (!target) {
			ctx.ui.notify("There is no completed assistant message to replay yet", "warning");
			return;
		}
		playTarget(target, !playbackHistory.hasTimings());
	};

	pi.registerShortcut("f6", {
		description: "Play the previous assistant message",
		handler: ctx => {
			if (!canNavigatePlayback(ctx)) return;
			syncPlaybackMessages(ctx);
			const message = playbackHistory.move(-1);
			if (message) playTarget({ ...message, time: 0, sourceOffset: 0 }, !playbackHistory.hasTimings());
		},
	});

	pi.registerShortcut("f7", {
		description: "Regenerate playback from about 10 seconds earlier",
		handler: ctx => {
			if (!canNavigatePlayback(ctx)) return;
			const target = playbackHistory.seekTarget(-10);
			if (target) playTarget(target, false);
			else {
				scheduleMissingTimings(ctx);
				ctx.ui.notify("Timing preprocessing for this message has not finished yet", "warning");
			}
		},
	});

	pi.registerShortcut("f8", {
		description: "Pause or resume regenerated voice playback",
		handler: ctx => {
			if (!canNavigatePlayback(ctx)) return;
			if (playbackPaused) {
				const target = playbackHistory.resumeTarget();
				if (target) playTarget(target, false);
				return;
			}
			if (!playbackHistory.selected()) {
				ctx.ui.notify("There is no assistant message playing", "warning");
				return;
			}
			vocalizer.clear();
			narration.finish();
			playbackPaused = true;
			state = "idle";
			refreshStatus();
			refreshPlaybackTimeline();
		},
	});

	pi.registerShortcut("f9", {
		description: "Regenerate playback from about 10 seconds later",
		handler: ctx => {
			if (!canNavigatePlayback(ctx)) return;
			const target = playbackHistory.seekTarget(10);
			if (target) playTarget(target, false);
			else {
				scheduleMissingTimings(ctx);
				ctx.ui.notify("Timing preprocessing for this message has not finished yet", "warning");
			}
		},
	});

	pi.registerShortcut("f10", {
		description: "Play the next assistant message",
		handler: ctx => {
			if (!canNavigatePlayback(ctx)) return;
			syncPlaybackMessages(ctx);
			const message = playbackHistory.move(1);
			if (message) playTarget({ ...message, time: 0, sourceOffset: 0 }, !playbackHistory.hasTimings());
		},
	});

	pi.registerShortcut("f11", {
		description: "Restart the selected assistant message from the beginning",
		handler: replaySelected,
	});

	if (config.talkShortcut !== "disabled") {
		const registerTalkShortcut = (key: Exclude<VoiceConfig["talkShortcut"], "disabled">): void => {
			pi.registerShortcut(key, {
				description: "Start or stop a prompt with the phone microphone",
				handler: ctx => {
					void talk(ctx);
				},
			});
		};
		registerTalkShortcut(config.talkShortcut);
		if (config.talkShortcut !== "f5") registerTalkShortcut("f5");
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
				"stt-candidates",
				"alignment-model",
				"alignment-dtype",
				"edit-model",
				"highlight",
				"timing",
				"code-narration",
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
			if (parts[0] === "alignment-model") {
				return ["onnx-community/wav2vec2-base-960h-ONNX"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `alignment-model ${value}`, label: value }));
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
			if (parts[0] === "stt-candidates") {
				return ["1", "2", "3", "4", "5", "6", "7", "8"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `stt-candidates ${value}`, label: value }));
			}
			if (parts[0] === "tts-dtype" || parts[0] === "stt-dtype" || parts[0] === "alignment-dtype") {
				return ["fp32", "q8", "q4"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `${parts[0]} ${value}`, label: value }));
			}
			if (parts[0] === "code-narration") {
				return ["guided", "summary"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `code-narration ${value}`, label: value }));
			}
			if (parts[0] === "highlight") {
				return ["on", "off"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `highlight ${value}`, label: value }));
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
					ctx.ui.notify("Preparing speech synthesis and alignment models…", "info");
					try {
						await warmModels();
						ctx.ui.notify("Speech synthesis and alignment models are resident in RAM", "info");
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				case "tts-model":
				case "stt-model":
				case "alignment-model": {
					const model = normalizeModelId(value);
					if (!model) {
						ctx.ui.notify(`Usage: /voice ${action} <huggingface-repo>`, "error");
						return;
					}
					vocalizer.clear();
					if (action.toLowerCase() === "tts-model") await updateConfig({ ...config, ttsModel: model });
					else if (action.toLowerCase() === "stt-model") await updateConfig({ ...config, sttModel: model });
					else await updateConfig({ ...config, alignmentModel: model });
					ctx.ui.notify(`${action.toUpperCase()} set to ${model}; it will download on first use`, "info");
					return;
				}
				case "tts-dtype":
				case "stt-dtype":
				case "alignment-dtype": {
					const dtype = normalizeModelDtype(value.toLowerCase());
					if (!dtype) {
						ctx.ui.notify(`Usage: /voice ${action} fp32|q8|q4`, "error");
						return;
					}
					vocalizer.clear();
					if (action.toLowerCase() === "tts-dtype") await updateConfig({ ...config, ttsDtype: dtype });
					else if (action.toLowerCase() === "stt-dtype") await updateConfig({ ...config, sttDtype: dtype });
					else await updateConfig({ ...config, alignmentDtype: dtype });
					ctx.ui.notify(`${action.toUpperCase()} set to ${dtype}`, "info");
					return;
				}
				case "stt-candidates": {
					const count = normalizeSttCandidates(Number(value));
					if (!count) {
						ctx.ui.notify("Usage: /voice stt-candidates <1..8>", "error");
						return;
					}
					await updateConfig({ ...config, sttCandidates: count });
					ctx.ui.notify(`Final ASR candidate count set to ${count}`, "info");
					return;
				}
				case "code-narration": {
					const narrationMode = value.toLowerCase();
					if (narrationMode !== "guided" && narrationMode !== "summary") {
						ctx.ui.notify("Usage: /voice code-narration guided|summary", "error");
						return;
					}
					await updateConfig({ ...config, codeNarration: narrationMode });
					ctx.ui.notify(`Code narration mode set to ${narrationMode}`, "info");
					return;
				}
				case "highlight": {
					const normalized = value.toLowerCase();
					if (normalized !== "on" && normalized !== "off") {
						ctx.ui.notify("Usage: /voice highlight on|off", "error");
						return;
					}
					await updateConfig({ ...config, playbackHighlight: normalized === "on" });
					if (normalized === "off") narration.finish();
					ctx.ui.notify(`Spoken-word highlighting ${normalized === "on" ? "enabled" : "disabled"}`, "info");
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
					ctx.ui.notify(`Dictation resolution model set to ${model}`, "info");
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
					ctx.ui.notify(
						editMode === "smart"
							? "Spoken corrections enabled after ASR candidate resolution"
							: "Resolved dictation will be appended without executing spoken corrections",
						"info",
					);
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
				case "timing":
					ctx.ui.notify(narration.timingSummary(), "info");
					return;
				case "status":
				case "":
					ctx.ui.notify(
						`Voice ${config.enabled ? "on" : "off"}; mode=${config.mode}; voice=${config.voice}; speed=${config.speed}; tts=${config.ttsModel}@${config.ttsDtype}; stt=${config.sttModel}@${config.sttDtype}; sttCandidates=${config.sttCandidates}; alignment=${config.alignmentModel}@${config.alignmentDtype}; editModel=${config.editModel}; highlight=${config.playbackHighlight ? "on" : "off"}; codeNarration=${config.codeNarration}; output=${config.output}; input=${config.input}; shortcut=${config.talkShortcut}; submit=${config.submitMode}; edit=${config.editMode}`,
						"info",
					);
					return;
				default:
					ctx.ui.notify(
						"Usage: /voice [on|off|toggle|status|stop|setup|test|talk|mode|voice|speed|tts-model|tts-dtype|stt-model|stt-dtype|stt-candidates|alignment-model|alignment-dtype|edit-model|highlight|timing|code-narration|output|input|shortcut|submit|edit]",
						"error",
					);
			}
		},
	});
}
