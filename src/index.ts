import type { Message, Tool } from "@earendil-works/pi-ai";
import { highlightCode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasSpeakableAudio, requiresVoiceAttention } from "./attention.js";
import {
	contextualAssistantMessages,
	contextualAssistantMessagesThroughText,
	resolvedSessionContext,
	structuredContextIdentity,
	type ResolvedCodeContext,
} from "./code-context.js";
import { CodeDescriptionCache, type CodeDescriptionCacheSnapshot } from "./code-description-cache.js";
import {
	codeDescriptionCacheKey,
	CodeDescriptionBudgetExhaustedError,
	CodeDescriptionContextOverflowError,
	codeDescriptionUsesActivePrompt,
	describeCodeBlock,
	fallbackCodeDescription,
} from "./code-describer.js";
import {
	loadVoiceConfig,
	normalizeAudioCacheBitrate,
	normalizeBackfillBudget,
	normalizeEditModel,
	normalizeModelDtype,
	normalizeModelId,
	normalizePreprocessConcurrency,
	normalizePreprocessScope,
	normalizeSttCandidates,
	normalizeWorkerCount,
	normalizeTalkShortcut,
	normalizeVoiceInput,
	normalizeVoiceOutput,
	saveVoiceConfig,
	type VoiceConfig,
	type VoiceBackfillBudget,
	type VoiceEditMode,
	type VoiceMode,
	type VoiceSubmitMode,
} from "./config.js";
import { chunkCodeNarration, plainCodeNarration, type CodeNarrationPlan } from "./code-narration.js";
import { DeviceRouter, type VoiceDeviceSelection } from "./device-router.js";
import { LiveTranscriptionSession } from "./live-transcription.js";
import { NarrationProgress } from "./narration-progress.js";
import {
	PlaybackHistory,
	type PlaybackMessage,
	type PlaybackTarget,
	type PlaybackTimingSnapshot,
} from "./playback-history.js";
import { PhoneInputClient } from "./phone-input.js";
import { prioritizeFromCurrent, processConcurrently, resolveTimingConcurrency } from "./preprocessing.js";
import { SpeakableStream, type FencedCodeBlock, type SpeakableSourceRange } from "./speakable.js";
import { pendingPlaybackTiming, voiceProgressLines } from "./status-text.js";
import { applySpokenEdit, resolveDictationCandidates } from "./prompt-editor.js";
import { narrationRenderKey } from "./render-identity.js";
import { SessionCoordinator, type WaitingSession } from "./session-coordinator.js";
import { supportsInteractiveVoice } from "./session-mode.js";
import { Vocalizer } from "./vocalizer.js";
import { isVoice, VOICES } from "./voices.js";
import { VoiceWorkerClient, type WorkerEvent } from "./worker-client.js";

type VoiceState = "downloading" | "error" | "idle" | "listening" | "loading" | "speaking";
type InputPhase = "idle" | "recording" | "transcribing";
type PreprocessingProgress = { label: string; processed: number; total: number };
type SpeechPurpose = "turn" | "replay" | "notification";

const PLAYBACK_TIMING_ENTRY = "pi-voice.playback-timing";
const CODE_DESCRIPTION_CACHE_ENTRY = "pi-voice.code-description";
const DEVICE_SELECTION_ENTRY = "pi-voice.device-selection";

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

type ContextualPlaybackMessage = PlaybackMessage & {
	conversationMessages: Message[];
	assistantMessage: unknown;
};

const conversationBeforeCache = new WeakMap<object, Map<string, ResolvedCodeContext>>();

function contextBeforeEntry(ctx: ExtensionContext, parentId: string | null): ResolvedCodeContext {
	let cache = conversationBeforeCache.get(ctx.sessionManager);
	if (!cache) {
		cache = new Map();
		conversationBeforeCache.set(ctx.sessionManager, cache);
	}
	const key = parentId ?? "<root>";
	const existing = cache.get(key);
	if (existing !== undefined) return existing;
	const resolved = resolvedSessionContext(ctx.sessionManager.getEntries(), parentId);
	cache.set(key, resolved);
	return resolved;
}

function liveConversationBefore(ctx: ExtensionContext): ResolvedCodeContext {
	const branch = ctx.sessionManager.getBranch();
	const leaf = branch.at(-1);
	const leafId =
		leaf?.type === "message" && assistantStopReason(leaf.message) === undefined &&
		typeof leaf.message === "object" && leaf.message !== null && "role" in leaf.message && leaf.message.role === "assistant"
			? leaf.parentId
			: (leaf?.id ?? null);
	return resolvedSessionContext(ctx.sessionManager.getEntries(), leafId);
}

function completedAssistantMessages(ctx: ExtensionContext, mode: VoiceMode): ContextualPlaybackMessage[] {
	const messages: ContextualPlaybackMessage[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const stopReason = assistantStopReason(entry.message);
		if (stopReason === undefined || stopReason === "aborted" || stopReason === "error") continue;
		// Yield mode only speaks the final response, not intermediate text attached to tool/edit calls.
		if (mode === "yield" && stopReason === "toolUse") continue;
		const text = assistantText(entry.message);
		if (text) {
			const before = contextBeforeEntry(ctx, entry.parentId);
			messages.push({
				id: entry.id,
				text,
				conversationMessages: before.messages,
				assistantMessage: entry.message,
			});
		}
	}
	return messages;
}

function playbackTimingSnapshots(ctx: ExtensionContext): PlaybackTimingSnapshot[] {
	const snapshots: PlaybackTimingSnapshot[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== PLAYBACK_TIMING_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("version" in data) || data.version !== 2) continue;
		snapshots.push(data as PlaybackTimingSnapshot);
	}
	return snapshots;
}

function sessionDeviceSelection(ctx: ExtensionContext): VoiceDeviceSelection {
	let selection: VoiceDeviceSelection = "auto";
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== DEVICE_SELECTION_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("selection" in data) || typeof data.selection !== "string") continue;
		if (data.selection === "auto" || data.selection === "local" || /^[a-zA-Z0-9._-]{1,128}$/.test(data.selection)) {
			selection = data.selection;
		}
	}
	return selection;
}

function codeDescriptionSnapshots(ctx: ExtensionContext): unknown[] {
	const snapshots: unknown[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === CODE_DESCRIPTION_CACHE_ENTRY) snapshots.push(entry.data);
	}
	return snapshots;
}

interface DescribableCodeItem {
	block: FencedCodeBlock;
	beforeBlock: string;
	throughBlock: string;
}

function describableCodeItems(text: string): DescribableCodeItem[] {
	const stream = new SpeakableStream();
	return [...stream.push(text), ...stream.flush()]
		.filter(item => item.kind === "code")
		.map(item => ({
			block: item.block,
			beforeBlock: text.slice(0, item.source.start),
			throughBlock: text.slice(0, item.source.end),
		}));
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
	let interactiveVoiceSession = false;
	let coordinator: SessionCoordinator | null = null;
	const deviceRouter = new DeviceRouter();
	let deviceSelection: VoiceDeviceSelection = "auto";
	let activeDeviceId: string | undefined;
	let ownsSpeech = false;
	let speechPurpose: SpeechPurpose | undefined;
	let ownerTurnEnded = false;
	let lastOwnerUtterance: number | undefined;
	let projectPrefixUtterance: number | undefined;
	let completedOwnerUtterance: number | undefined;
	let ownerContentExpected = false;
	let speechReservedForInput = false;
	let projectAnnouncementPending = false;
	let pendingNotification: WaitingSession | undefined;
	let pausedForAttention = false;
	let speechBlocked = false;
	let blockedMessageHasSpeech = false;
	let blockedWarningIssued = false;
	let blockedSpeechText = "";
	let ownedSpeechText = "";
	let speechConversationMessages: Message[] = [];
	let speechAssistantMessage: unknown;
	let completingOwnerSpeech = false;
	let attentionPollTimer: NodeJS.Timeout | null = null;
	let voiceWorkerIdleTimer: NodeJS.Timeout | null = null;
	let handleCoordinatedIdle: (utterance: number | undefined) => void = () => {};
	let playRequestedAttention: (ctx: ExtensionContext) => void = () => {};
	let releaseSpeechOwnership: (announceNext?: boolean) => void = () => {};
	let state: VoiceState = "idle";
	let downloadPercent: number | undefined;
	let lastError = "";
	let inputInProgress = false;
	let activeInputEndpoint: string | undefined;
	let inputPhase: InputPhase = "idle";
	let inputProgressTimer: NodeJS.Timeout | null = null;
	let inputProgressMessage: string | undefined;
	let inputStartedAt = 0;
	let contextEpoch = 0;
	let narrationTui: { invalidate(): void; requestRender(force?: boolean): void } | null = null;
	let narrationRenderTimer: NodeJS.Timeout | null = null;
	let livePlaybackId: string | undefined;
	let liveTurnNarrationActive = false;
	let nextLivePlaybackId = 0;
	let playbackPaused = false;
	let pausedOwnerUtterance: number | undefined;
	let playbackPositionEstimated = false;
	let playbackTimelineTimer: NodeJS.Timeout | null = null;
	let codePreprocessingProgress: PreprocessingProgress | undefined;
	let timingPreprocessingProgress: PreprocessingProgress | undefined;
	const playbackHistory = new PlaybackHistory();
	const codeDescriptionCache = new CodeDescriptionCache();
	const codeDescriptionText = new Map<string, string>();
	const pendingCodeDescriptions = new Map<string, CodeDescriptionCacheSnapshot>();
	const reportedDescriptionOverflows = new Set<string>();
	let scheduleMissingTimings: (ctx: ExtensionContext) => void = () => {};

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

	const routedVoiceConfig = (claim = false): VoiceConfig => {
		const pinnedSelection = activeDeviceId && (ownsSpeech || inputInProgress) ? activeDeviceId : deviceSelection;
		const device = claim ? deviceRouter.claim(deviceSelection) : deviceRouter.resolve(pinnedSelection);
		activeDeviceId = device?.id;
		return {
			...config,
			output: config.output === "auto" ? (device?.audioEndpoint ?? "local") : config.output,
			input: config.input === "auto" ? (device?.inputEndpoint ?? "local") : config.input,
		};
	};

	const claimOutputDevice = (): VoiceConfig => {
		const routed = routedVoiceConfig(true);
		refreshStatus();
		return routed;
	};

	const refreshProgressWidget = (): void => {
		const ctx = activeContext;
		if (!ctx) return;
		try {
			const playback = config.enabled ? playbackHistory.status() : undefined;
			let playbackLine: string | undefined;
			if (playback) {
				if (!playback.hasTimings || playback.duration <= 0) {
					playbackLine = `○ ${pendingPlaybackTiming(playback.messageIndex, playback.messageCount)}`;
				} else {
					const messageLabel =
						playback.messageIndex >= 0 ? ` · message ${playback.messageIndex + 1}/${playback.messageCount}` : " · current response";
					const icon = playbackPaused ? "⏸" : state === "speaking" ? "▶" : "■";
					const estimate = playbackPositionEstimated ? "~" : "";
					playbackLine = `${icon} ${playbackBar(playback.position, playback.duration)} ${estimate}${formatPlaybackTime(playback.position)} / ${formatPlaybackTime(playback.duration)}${messageLabel}`;
				}
			}
			const preprocessing = [codePreprocessingProgress, timingPreprocessingProgress].filter(
				(progress): progress is PreprocessingProgress => progress !== undefined,
			);
			const lines = voiceProgressLines(inputProgressMessage, playbackLine, preprocessing).map(line =>
				line.kind === "input"
					? line.text
					: ctx.ui.theme.fg(line.kind === "playback" && state === "speaking" ? "accent" : "dim", line.text),
			);
			ctx.ui.setWidget("pi-voice-progress", lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
		} catch {
			// The active context can become stale just before session shutdown runs.
		}
	};

	const refreshPreprocessingProgress = refreshProgressWidget;

	const descriptionText = (plan: CodeNarrationPlan): string =>
		chunkCodeNarration(plan)
			.map(chunk => chunk.text)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();

	const activePromptTools = (): Tool[] => {
		const available = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
		return pi.getActiveTools().flatMap(name => {
			const tool = available.get(name);
			return tool ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }] : [];
		});
	};

	const contextualCodeDescription = (ctx: ExtensionContext, context: string): string => {
		if (config.codeDescriptionContext !== "conversation") return "";
		if (!codeDescriptionUsesActivePrompt(ctx, config.editModel)) return context;
		return JSON.stringify({ context, systemPrompt: ctx.getSystemPrompt(), tools: activePromptTools() });
	};

	const descriptionCacheKey = (ctx: ExtensionContext, block: FencedCodeBlock, identityContext: string): string =>
		codeDescriptionCacheKey(
			ctx,
			block,
			config.editModel,
			config.codeNarration,
			contextualCodeDescription(ctx, identityContext),
			config.codeDescriptionContext,
		);

	const requestCodeDescription = async (
		ctx: ExtensionContext,
		block: FencedCodeBlock,
		identityContext: string,
		providerMessagesThroughBlock: readonly Message[],
		options?: { chargeBackfill?: () => boolean },
): Promise<CodeNarrationPlan> => {
		const fallback = plainCodeNarration(fallbackCodeDescription(block));
		try {
			const editModel = config.editModel;
			const narrationMode = config.codeNarration;
			const contextMode = config.codeDescriptionContext;
			const reusesActivePrompt =
				contextMode === "conversation" && codeDescriptionUsesActivePrompt(ctx, editModel);
			const systemPrompt = reusesActivePrompt ? ctx.getSystemPrompt() : undefined;
			const tools = reusesActivePrompt ? activePromptTools() : undefined;
			const contextualIdentity =
				contextMode === "conversation"
					? reusesActivePrompt
						? JSON.stringify({ context: identityContext, systemPrompt, tools })
						: identityContext
					: "";
			const conversation =
				contextMode === "conversation"
					? {
							messages: providerMessagesThroughBlock,
							...(reusesActivePrompt
								? {
										normalPrompt: {
											systemPrompt: systemPrompt!,
											tools: tools!,
											sessionId: ctx.sessionManager.getSessionId(),
										},
									}
								: {}),
						}
					: undefined;
			const key = codeDescriptionCacheKey(
				ctx,
				block,
				editModel,
				narrationMode,
				contextualIdentity,
				contextMode,
			);
			return await codeDescriptionCache
				.getOrCreate(
					key,
					() => {
						// Every provider attempt is metered; cache hits and coalesced
						// duplicates never reach describeCodeBlock at all.
						const generate = () =>
							describeCodeBlock(
								ctx,
								block,
								editModel,
								narrationMode,
								conversation,
								undefined,
								{
									onAttempt: () => {
										if (options?.chargeBackfill && !options.chargeBackfill()) {
											throw new CodeDescriptionBudgetExhaustedError();
										}
									},
								},
							).catch(error => {
								if (error instanceof CodeDescriptionBudgetExhaustedError) throw BACKFILL_EXHAUSTED;
								if (error instanceof CodeDescriptionContextOverflowError) {
									const overflowId = `${editModel}:${error.contextWindow}`;
									if (!reportedDescriptionOverflows.has(overflowId)) {
										reportedDescriptionOverflows.add(overflowId);
										try {
											if (activeContext === ctx) {
												ctx.ui.notify(
													`Voice used local code narration because ${editModel} has insufficient context (${error.estimatedInputTokens} estimated input tokens; ${error.availableInputTokens} available)`,
													"warning",
												);
											}
										} catch {
											// Session replacement can invalidate the captured UI before generation settles.
										}
									}
								}
								return fallback;
							});
						return coordinator
							? coordinator.withResource("code", config.codeDescriptionPreprocessConcurrency, generate)
							: generate();
					},
					snapshot => {
						if (activeContext !== ctx) return;
						try {
							if (ctx.isIdle()) pi.appendEntry(CODE_DESCRIPTION_CACHE_ENTRY, snapshot);
							else pendingCodeDescriptions.set(snapshot.key, snapshot);
						} catch {
							// Session replacement invalidates captured contexts before background work settles.
						}
					},
				)
				.then(plan => {
					if (activeContext === ctx) {
						codeDescriptionText.set(key, descriptionText(plan));
						requestNarrationRender();
					}
					return plan;
				});
		} catch (outerError) {
			if (outerError === BACKFILL_EXHAUSTED) throw outerError;
			return fallback;
		}
	};

	const timingItemsFor = async (
		ctx: ExtensionContext,
		text: string,
		conversationMessages: readonly Message[],
		assistantMessage: unknown,
	): Promise<Array<{ text: string; source: SpeakableSourceRange }>> => {
		const stream = new SpeakableStream();
		const result: Array<{ text: string; source: SpeakableSourceRange }> = [];
		for (const item of [...stream.push(text), ...stream.flush()]) {
			if (item.kind === "speech") {
				result.push({ text: item.text, source: item.source });
				continue;
			}
			const providerMessages = contextualAssistantMessagesThroughText(
				conversationMessages,
				assistantMessage,
				item.source.end,
			);
			const plan = await requestCodeDescription(
				ctx,
				item.block,
				structuredContextIdentity(providerMessages),
				providerMessages,
				{ chargeBackfill: chargeBackfillUnit },
			);
			let chunks = chunkCodeNarration(plan);
			if (chunks.length === 0) chunks = chunkCodeNarration(plainCodeNarration(fallbackCodeDescription(item.block)));
			for (const chunk of chunks) result.push({ text: chunk.text, source: item.source });
		}
		return result;
	};

	let codeDescriptionPreprocessing: Promise<void> | undefined;
	let codeWorkEpoch = 0;
	/** Session-runtime backfill allowance; defaults from config until topped up. */
	let backfillAllowance: VoiceBackfillBudget = config.codeDescriptionPreprocessBudget;
	let backfillUsed = 0;
	let backfillExhaustionReported = false;
	/** Sentinel that stops a backfill batch without caching filler. */
	const BACKFILL_EXHAUSTED = Symbol("pi-voice.backfill-exhausted");

	/** Reserves one historical-backfill unit; live and replay requests never call this. */
const chargeBackfillUnit = (): boolean => {
		if (backfillAllowance === "unlimited") return true;
		if (backfillUsed >= backfillAllowance) return false;
		backfillUsed += 1;
		backfillExhaustionReported = false;
		return true;
	};

	/** Message ids retained by the latest compaction, or null when nothing was compacted. */
	const retainedMessageIds = (ctx: ExtensionContext): Set<string> | null => {
		const branch = ctx.sessionManager.getBranch();
		let lastCompactionIndex = -1;
		branch.forEach((entry, index) => {
			if (entry.type === "compaction") lastCompactionIndex = index;
		});
		if (lastCompactionIndex < 0) return null;
		return new Set(branch.slice(lastCompactionIndex).map(entry => entry.id));
	};

	/** Background work honors the scope; playback and replay always see everything. */
	const scopedCompletedMessages = (ctx: ExtensionContext, mode: VoiceMode): ContextualPlaybackMessage[] => {
		const all = completedAssistantMessages(ctx, mode);
		if (config.codeDescriptionPreprocessScope !== "since-compaction") return all;
		const retained = retainedMessageIds(ctx);
		return retained ? all.filter(message => retained.has(message.id)) : all;
	};

	const scheduleMissingCodeDescriptions = (ctx: ExtensionContext): void => {
		if (codeDescriptionPreprocessing) return;
		const epoch = contextEpoch;
		const workEpoch = codeWorkEpoch;
		backfillUsed = 0;
		backfillExhaustionReported = false;
		const queuedMessages: Array<
			Array<{ block: FencedCodeBlock; identityContext: string; providerMessagesThroughBlock: Message[] }>
		> = [];
		let totalMessages = 0;
		let processedMessages = 0;
		let missingBlocks = 0;
		const currentId = playbackHistory.status()?.messageId;
		for (const message of prioritizeFromCurrent(scopedCompletedMessages(ctx, "assistant"), currentId)) {
			const keyedBlocks = new Map<
				string,
				{ block: FencedCodeBlock; identityContext: string; providerMessagesThroughBlock: Message[] }
			>();
			for (const item of describableCodeItems(message.text)) {
				try {
					const providerMessages = contextualAssistantMessagesThroughText(
						message.conversationMessages,
						message.assistantMessage,
						item.throughBlock.length,
					);
					const identityContext = structuredContextIdentity(providerMessages);
					const key = descriptionCacheKey(ctx, item.block, identityContext);
					keyedBlocks.set(key, { block: item.block, identityContext, providerMessagesThroughBlock: providerMessages });
				} catch {
					// A missing edit model is handled by the local fallback when requested directly.
				}
			}
			if (keyedBlocks.size === 0) continue;
			totalMessages += 1;
			const missing = [...keyedBlocks].filter(([key]) => !codeDescriptionCache.get(key)).map(([, item]) => item);
			missingBlocks += missing.length;
			if (missing.length === 0) processedMessages += 1;
			else queuedMessages.push(missing);
		}
		if (queuedMessages.length === 0) return;
		codePreprocessingProgress = {
			label:
				backfillAllowance === "unlimited"
					? "Code descriptions"
					: `Code descriptions (${backfillUsed}/${backfillAllowance} budget)`,
			processed: processedMessages,
			total: totalMessages,
		};
		refreshPreprocessingProgress();
		const concurrency = config.codeDescriptionPreprocessConcurrency;
		codeDescriptionPreprocessing = processConcurrently(queuedMessages, concurrency, async items => {
			if (epoch !== contextEpoch || workEpoch !== codeWorkEpoch || activeContext !== ctx) return;
			for (const item of items) {
				if (epoch !== contextEpoch || workEpoch !== codeWorkEpoch || activeContext !== ctx) return;
				try {
					await requestCodeDescription(ctx, item.block, item.identityContext, item.providerMessagesThroughBlock, { chargeBackfill: chargeBackfillUnit });
				} catch (error) {
					if (error === BACKFILL_EXHAUSTED || error instanceof CodeDescriptionBudgetExhaustedError) {
						if (!backfillExhaustionReported) {
							backfillExhaustionReported = true;
							ctx.ui.notify(
								`Voice code-description backfill stopped at its budget of ${backfillAllowance} requests; run /voice code-budget unlimited for this session`,
								"warning",
							);
						}
						return;
					}
					throw error;
				}
			}
			if (workEpoch !== codeWorkEpoch) return;
			processedMessages += 1;
			codePreprocessingProgress = {
				label:
					backfillAllowance === "unlimited"
						? "Code descriptions"
						: `Code descriptions (${backfillUsed}/${backfillAllowance} budget)`,
				processed: processedMessages,
				total: totalMessages,
			};
			refreshPreprocessingProgress();
		})
			.catch(() => {
				// Reload/session replacement cancels captured-context preprocessing.
			})
			.finally(() => {
				codeDescriptionPreprocessing = undefined;
				codePreprocessingProgress = undefined;
				refreshPreprocessingProgress();
				if (epoch === contextEpoch && workEpoch !== codeWorkEpoch && activeContext === ctx) {
					scheduleMissingCodeDescriptions(ctx);
				}
			});
	};

	const scheduleCodeDescriptionsInText = (ctx: ExtensionContext, text: string): void => {
		const message = completedAssistantMessages(ctx, "assistant").findLast(candidate => candidate.text === text);
		if (!message) return; // agent_settled retries after the session entry is committed
		for (const item of describableCodeItems(text)) {
			const providerMessages = contextualAssistantMessagesThroughText(
				message.conversationMessages,
				message.assistantMessage,
				item.throughBlock.length,
			);
			void requestCodeDescription(ctx, item.block, structuredContextIdentity(providerMessages), providerMessages);
		}
	};

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType === "user") return markdown;
		return narration.transform(
			markdown,
			context.messageType,
			text => (config.playbackHighlight ? (activeContext?.ui.theme.fg("dim", text) ?? text) : text),
			text => (config.playbackHighlight ? (activeContext?.ui.theme.bg("selectedBg", text) ?? text) : text),
			(block, messageThroughBlock) => {
				const ctx = activeContext;
				if (!ctx) return undefined;
				try {
					const completed = completedAssistantMessages(ctx, "assistant").findLast(message => message.text === markdown);
					const providerMessages = completed
						? contextualAssistantMessagesThroughText(
								completed.conversationMessages,
								completed.assistantMessage,
								messageThroughBlock.length,
							)
						: speechAssistantMessage
							? contextualAssistantMessagesThroughText(
									speechConversationMessages,
									speechAssistantMessage,
									messageThroughBlock.length,
								)
							: [];
					const key = descriptionCacheKey(ctx, block, structuredContextIdentity(providerMessages));
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
			(code, language) => highlightCode(code, language),
		);
	});

	const refreshPlaybackTimeline = refreshProgressWidget;

	const requestPlaybackTimeline = (): void => {
		if (playbackTimelineTimer) return;
		playbackTimelineTimer = setTimeout(() => {
			playbackTimelineTimer = null;
			refreshPlaybackTimeline();
		}, 80);
		playbackTimelineTimer.unref?.();
	};

	const setInputProgress = (message: string | undefined): void => {
		inputProgressMessage = message;
		refreshProgressWidget();
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
		if (pausedForAttention) {
			label = `voice: waiting (${coordinator?.projectLabel() ?? "project"})`;
			color = "warning";
		} else if (state === "loading") {
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
				if (ownerTurnEnded && event.utterance !== undefined && event.utterance === lastOwnerUtterance) {
					narration.finish();
				} else {
					narration.finishUtterance(event.utterance);
				}
				handleCoordinatedIdle(event.utterance);
				if (event.utterance !== undefined && activeContext) scheduleMissingTimings(activeContext);
				break;
			case "speaking":
				state = "speaking";
				// Coordinator project/attention prompts are separate from the selected
				// message transport and must not turn a paused message back into playing.
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
		() => routedVoiceConfig(),
		handleWorkerEvent,
		(block, sourceContext, _signal) => {
			const ctx = activeContext;
			if (!ctx) return Promise.reject(new Error("No active Pi context for code description"));
			const providerMessages = sourceContext.providerMessages
				? [...sourceContext.providerMessages]
				: speechAssistantMessage
					? contextualAssistantMessagesThroughText(
							speechConversationMessages,
							speechAssistantMessage,
							sourceContext.sourceEnd,
						)
					: [];
			return requestCodeDescription(ctx, block, structuredContextIdentity(providerMessages), providerMessages);
		},
		segment => {
			if (ownsSpeech) {
				lastOwnerUtterance = segment.utterance;
				ownerContentExpected = true;
			}
			narration.registerSegment(segment);
			const base = segment.sourceBase ?? 0;
			playbackHistory.registerSegment({
				...segment,
				source: { start: segment.source.start - base, end: segment.source.end - base },
				code: segment.code
					? {
						...segment.code,
						blockSource: {
							start: segment.code.blockSource.start - base,
							end: segment.code.blockSource.end - base,
						},
					}
					: undefined,
				codeDescription: segment.codeDescription
					? {
						...segment.codeDescription,
						blockSource: {
							start: segment.codeDescription.blockSource.start - base,
							end: segment.codeDescription.blockSource.end - base,
						},
					}
					: undefined,
			});
		},
	);
	const phoneInput = new PhoneInputClient();
	const timingWorkers: VoiceWorkerClient[] = [];
	let timingWorkEpoch = 0;
	let timingRescheduleRequested = false;

	const ensureTimingWorkers = (count: number): VoiceWorkerClient[] => {
		while (timingWorkers.length < count) timingWorkers.push(new VoiceWorkerClient(() => {}));
		return timingWorkers.slice(0, count);
	};

	const cancelTimingWorkers = (): void => {
		timingWorkEpoch += 1;
		for (const worker of timingWorkers) worker.cancel();
	};

	const relinquishSpeech = (): void => {
		coordinator?.releaseSpeech();
		ownsSpeech = false;
		liveTurnNarrationActive = false;
		speechPurpose = undefined;
		ownerTurnEnded = false;
		lastOwnerUtterance = undefined;
		projectPrefixUtterance = undefined;
		completedOwnerUtterance = undefined;
		ownerContentExpected = false;
		speechReservedForInput = false;
		projectAnnouncementPending = false;
		pendingNotification = undefined;
		completingOwnerSpeech = false;
		if (!inputInProgress) state = "idle";
		refreshStatus();
		if (voiceWorkerIdleTimer) clearTimeout(voiceWorkerIdleTimer);
		voiceWorkerIdleTimer = null;
		if (!inputInProgress) {
			voiceWorkerIdleTimer = setTimeout(() => {
				voiceWorkerIdleTimer = null;
				if (!ownsSpeech && !inputInProgress) void vocalizer.shutdown().catch(() => {});
			}, 60_000);
			voiceWorkerIdleTimer.unref?.();
		}
	};

	const speakAttentionNotification = (waiting: WaitingSession): void => {
		if (!coordinator) return;
		speechPurpose = "notification";
		ownerTurnEnded = true;
		pendingNotification = waiting;
		lastOwnerUtterance = undefined;
		projectPrefixUtterance = undefined;
		completedOwnerUtterance = undefined;
		ownerContentExpected = true;
		narration.finish();
		lastOwnerUtterance = vocalizer.speakUntracked(
			`Project ${coordinator.projectLabel(waiting.cwd)} requires attention next.`,
		);
	};

	releaseSpeechOwnership = (announceNext = true): void => {
		if (!ownsSpeech || !coordinator) return;
		if (announceNext) {
			const waiting = coordinator.nextUnannouncedWaiting();
			if (waiting) {
				speakAttentionNotification(waiting);
				return;
			}
		}
		relinquishSpeech();
	};

	const completeOwnerSpeech = (): void => {
		const expectedUtterance = ownerContentExpected ? lastOwnerUtterance : projectPrefixUtterance;
		if (!ownsSpeech || !ownerTurnEnded || completingOwnerSpeech) return;
		if (expectedUtterance === undefined) {
			projectAnnouncementPending = false;
			releaseSpeechOwnership(true);
			return;
		}
		if (completedOwnerUtterance !== expectedUtterance) return;
		completingOwnerSpeech = true;
		if (speechPurpose === "notification") {
			if (pendingNotification) coordinator?.markAnnounced(pendingNotification.instanceId);
			relinquishSpeech();
			return;
		}
		completingOwnerSpeech = false;
		releaseSpeechOwnership(true);
	};

	handleCoordinatedIdle = utterance => {
		if (!ownsSpeech || utterance === undefined) return;
		completedOwnerUtterance = utterance;
		completeOwnerSpeech();
	};

	const acquireSpeech = (
		purpose: "turn" | "replay",
		announceProject = true,
		force = false,
	): boolean => {
		if (!coordinator) return true;
		const alreadyOwned = ownsSpeech && coordinator.ownsSpeech();
		if (!alreadyOwned) {
			const acquired = force ? coordinator.forceAcquireSpeech() : coordinator.tryAcquireSpeech();
			if (!acquired) return false;
		}
		claimOutputDevice();
		if (voiceWorkerIdleTimer) clearTimeout(voiceWorkerIdleTimer);
		voiceWorkerIdleTimer = null;
		cancelTimingWorkers();
		const shouldAnnounce = announceProject && (!coordinator.attentionIsCurrent() || projectAnnouncementPending);
		ownsSpeech = true;
		speechPurpose = purpose;
		ownerTurnEnded = false;
		lastOwnerUtterance = undefined;
		projectPrefixUtterance = undefined;
		completedOwnerUtterance = undefined;
		ownerContentExpected = false;
		speechReservedForInput = false;
		projectAnnouncementPending = shouldAnnounce;
		ownedSpeechText = "";
		pendingNotification = undefined;
		completingOwnerSpeech = false;
		pausedForAttention = false;
		speechBlocked = false;
		blockedMessageHasSpeech = false;
		blockedSpeechText = "";
		coordinator.clearWaiting();
		refreshStatus();
		return true;
	};

	const announceProjectForSpeech = (): void => {
		if (!coordinator) return;
		const changed = coordinator.claimAttention();
		if (!projectAnnouncementPending || !changed) {
			projectAnnouncementPending = false;
			return;
		}
		projectAnnouncementPending = false;
		projectPrefixUtterance = vocalizer.speakUntracked(`Project ${coordinator.projectLabel()}.`);
	};

	const reserveSpeechForInput = (): void => {
		if (!config.enabled || !coordinator) return;
		if (!acquireSpeech("turn", false, true)) return;
		speechReservedForInput = true;
		projectAnnouncementPending = !coordinator.attentionIsCurrent();
	};

	const handleSpeechPreemption = (): void => {
		const interruptedPurpose = speechPurpose;
		const wasComplete = ownerTurnEnded;
		vocalizer.clear();
		narration.finish();
		relinquishSpeech();
		if (interruptedPurpose === "turn" || interruptedPurpose === "replay") {
			pausedForAttention = true;
			if (wasComplete || interruptedPurpose === "replay") coordinator?.markWaiting();
			refreshStatus();
		}
	};

	const pollWaitingAttention = (): void => {
		if (!coordinator) return;
		if (coordinator.hasAttentionRequest() && activeContext) {
			try {
				if (activeContext.isIdle() && coordinator.consumeAttentionRequest()) {
					playRequestedAttention(activeContext);
					return;
				}
			} catch {
				// Session replacement will create a fresh coordinator and discard this request.
			}
		}
		const owner = coordinator.speechOwner();
		if (ownsSpeech && owner?.instanceId !== coordinator.instanceId) handleSpeechPreemption();
		if (owner && owner.instanceId !== coordinator.instanceId) {
			if (timingPreprocessing) cancelTimingWorkers();
			return;
		}
		if (!owner && activeContext && !timingPreprocessing) scheduleMissingTimings(activeContext);
		if (!config.enabled || ownsSpeech) return;
		// The waiting session may be the only process polling after the previous
		// owner releases. Let it announce its own wait rather than leaving the
		// response silent until manual interaction.
		const waiting = coordinator.tryAcquireWaitingAnnouncement();
		if (!waiting) return;
		claimOutputDevice();
		if (voiceWorkerIdleTimer) clearTimeout(voiceWorkerIdleTimer);
		voiceWorkerIdleTimer = null;
		cancelTimingWorkers();
		ownsSpeech = true;
		completingOwnerSpeech = false;
		speakAttentionNotification(waiting);
	};

	const playTarget = (target: PlaybackTarget, recordTimings: boolean): void => {
		const sourceOffset = Math.max(0, Math.min(target.text.length, target.sourceOffset));
		const suffix = target.text.slice(sourceOffset);
		if (!suffix.trim()) return;
		codeWorkEpoch += 1;
		if (activeContext) scheduleMissingCodeDescriptions(activeContext);
		cancelTimingWorkers();
		vocalizer.clear();
		narration.finish();
		if (!acquireSpeech("replay", true, true)) {
			pausedForAttention = true;
			refreshStatus();
			activeContext?.ui.notify("Another Pi project currently owns voice playback; this replay remains paused", "warning");
			return;
		}
		narration.begin();
		narration.setCompletedText(target.text);
		playbackHistory.beginCapture(target.id, target.text, target.time, recordTimings);
		const contextual = activeContext
			? completedAssistantMessages(activeContext, config.mode).find(message => message.id === target.id)
			: undefined;
		speechConversationMessages = contextual?.conversationMessages ?? [];
		speechAssistantMessage = contextual?.assistantMessage;
		playbackPaused = false;
		pausedOwnerUtterance = undefined;
		playbackPositionEstimated = false;
		refreshPlaybackTimeline();
		ownerContentExpected = hasSpeakableAudio(suffix);
		if (ownerContentExpected) announceProjectForSpeech();
		vocalizer.speakFrom(suffix, sourceOffset);
		ownerTurnEnded = true;
		completeOwnerSpeech();
	};

	const renderKeyFor = (ctx: ExtensionContext, message: ContextualPlaybackMessage): string => {
		const codeDependencies: string[] = [];
		for (const item of describableCodeItems(message.text)) {
			const providerMessages = contextualAssistantMessagesThroughText(
				message.conversationMessages,
				message.assistantMessage,
				item.throughBlock.length,
			);
			const identity = structuredContextIdentity(providerMessages);
			try {
				const key = descriptionCacheKey(ctx, item.block, identity);
				codeDependencies.push(JSON.stringify([key, codeDescriptionCache.get(key) ?? "missing"]));
			} catch {
				codeDependencies.push(`fallback:${item.block.language}:${contextualCodeDescription(ctx, identity)}`);
			}
		}
		return narrationRenderKey(message.text, config, codeDependencies);
	};

	const playbackMessages = (ctx: ExtensionContext): PlaybackMessage[] =>
		completedAssistantMessages(ctx, config.mode).map(message => ({
			id: message.id,
			text: message.text,
			renderKey: renderKeyFor(ctx, message),
		}));

	const syncPlaybackMessages = (ctx: ExtensionContext, selectLatest = false): PlaybackMessage[] => {
		const messages = playbackMessages(ctx);
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
		const messages = playbackMessages(ctx);
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
				if (epoch !== contextEpoch || activeContext !== ctx) return;
				try {
					finalizePlaybackMessage(ctx, playbackId, text, attempt + 1);
				} catch {
					// Ignore a timer that races session replacement.
				}
			},
			[0, 20, 100, 250, 500][attempt] ?? 500,
		);
		timer.unref?.();
	};

	let timingPreprocessing: Promise<void> | undefined;
	scheduleMissingTimings = (ctx: ExtensionContext): void => {
		if (timingPreprocessing) return;
		if (coordinator?.speechOwner()) return;
		const epoch = contextEpoch;
		const scoped = scopedCompletedMessages(ctx, config.mode);
		const contextualById = new Map(scoped.map(message => [message.id, message]));
		const scopedIds = new Set(scoped.map(message => message.id));
		const messages = syncPlaybackMessages(ctx);
		const ordered = prioritizeFromCurrent(messages, playbackHistory.status()?.messageId).filter(message =>
			scopedIds.has(message.id),
		);
		const missing = ordered.filter(message => !playbackHistory.hasTimingFor(message.id));
		if (missing.length === 0) return;
		let processedMessages = messages.length - missing.length;
		timingPreprocessingProgress = {
			label: "Speech timing",
			processed: processedMessages,
			total: messages.length,
		};
		refreshPreprocessingProgress();
		const concurrency = resolveTimingConcurrency(config.timingPreprocessConcurrency, config.ttsDtype);
		const workEpoch = timingWorkEpoch;
		const workers = ensureTimingWorkers(concurrency);
		const measurementConfig = config;
		timingPreprocessing = processConcurrently(missing, concurrency, async (message, lane) => {
			const processMessage = async (): Promise<void> => {
				if (epoch !== contextEpoch || workEpoch !== timingWorkEpoch || activeContext !== ctx) return;
				const contextual = contextualById.get(message.id);
				if (!contextual) return;
				const checkpoints: PlaybackTimingSnapshot["checkpoints"] = [];
				let time = 0;
				try {
					for (const item of await timingItemsFor(
						ctx,
						message.text,
						contextual.conversationMessages,
						contextual.assistantMessage,
					)) {
						const duration = await workers[lane].measureSegment(item.text, measurementConfig);
						if (epoch !== contextEpoch || workEpoch !== timingWorkEpoch || activeContext !== ctx) return;
						if (!Number.isFinite(duration) || duration <= 0) continue;
						checkpoints.push({ time, duration, sourceOffset: item.source.start });
						time += duration;
					}
				} catch {
					// Live speech and microphone actions preempt low-priority timing work.
					return;
				}
				if (checkpoints.length === 0 || epoch !== contextEpoch || activeContext !== ctx) return;
				try {
					const resolvedRenderKey = renderKeyFor(ctx, contextual);
					if (resolvedRenderKey !== message.renderKey) {
						message.renderKey = resolvedRenderKey;
						playbackHistory.sync(playbackMessages(ctx));
					}
					const snapshot: PlaybackTimingSnapshot = {
						version: 2,
						messageId: message.id,
						renderKey: resolvedRenderKey,
						duration: time,
						checkpoints,
					};
					playbackHistory.restore([snapshot]);
					requestPlaybackTimeline();
					pi.appendEntry(PLAYBACK_TIMING_ENTRY, snapshot);
					processedMessages += 1;
					timingPreprocessingProgress = {
						label: "Speech timing",
						processed: processedMessages,
						total: messages.length,
					};
					refreshPreprocessingProgress();
				} catch {
					// Session replacement can invalidate ctx between the epoch check and access.
				}
			};
			if (coordinator) await coordinator.withResource("timing", concurrency, processMessage);
			else await processMessage();
		})
			.catch(() => {
				// Reload/session replacement cancels captured-context preprocessing.
			})
			.finally(() => {
				timingPreprocessing = undefined;
				timingPreprocessingProgress = undefined;
				const completedWorkers = timingWorkers.splice(0);
				void Promise.all(completedWorkers.map(worker => worker.terminate())).catch(() => {});
				refreshPreprocessingProgress();
				if (timingRescheduleRequested && epoch === contextEpoch && activeContext === ctx) {
					timingRescheduleRequested = false;
					scheduleMissingTimings(ctx);
				}
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
		const renderDependenciesChanged =
			previous.ttsModel !== config.ttsModel ||
			previous.ttsDtype !== config.ttsDtype ||
			previous.voice !== config.voice ||
			previous.speed !== config.speed ||
			previous.codeNarration !== config.codeNarration ||
			previous.editModel !== config.editModel ||
			previous.audioCache !== config.audioCache ||
			previous.audioCacheBitrate !== config.audioCacheBitrate;
		if (renderDependenciesChanged) {
			timingRescheduleRequested = true;
			cancelTimingWorkers();
		}
		backfillAllowance = config.codeDescriptionPreprocessBudget;
		backfillUsed = 0;
		backfillExhaustionReported = false;
		if (wasEnabled && !config.enabled) {
			vocalizer.clear();
			narration.finish();
			releaseSpeechOwnership(false);
		}
		state = "idle";
		refreshStatus();
		refreshPlaybackTimeline();
		if (activeContext) {
			syncPlaybackMessages(activeContext);
			scheduleMissingCodeDescriptions(activeContext);
			if (!timingPreprocessing) {
				timingRescheduleRequested = false;
				scheduleMissingTimings(activeContext);
			}
		}
	};

	const toggle = async (ctx: ExtensionContext): Promise<void> => {
		await updateConfig({ ...config, enabled: !config.enabled });
		ctx.ui.notify(`Voice mode ${config.enabled ? "enabled" : "disabled"}`, "info");
	};

	const talk = async (ctx: ExtensionContext): Promise<void> => {
		const talkEpoch = contextEpoch;
		const routed = claimOutputDevice();
		if (routed.input === "disabled") {
			ctx.ui.notify("Voice microphone input is disabled", "warning");
			return;
		}
		if (inputPhase === "recording") {
			setInputProgress("🎙 Stopping voice recording…");
			try {
				await phoneInput.stop(activeInputEndpoint ?? routed.input);
			} catch (error) {
				ctx.ui.notify(`Voice microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return;
		}
		if (inputPhase === "transcribing") {
			ctx.ui.notify("The previous voice recording is still being transcribed", "info");
			return;
		}
		beginInputProgress();
		cancelTimingWorkers();
		vocalizer.clear();
		narration.finish();
		releaseSpeechOwnership(false);
		reserveSpeechForInput();
		activeInputEndpoint = routed.input;
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
			const capture = await phoneInput.capture(routed.input, {
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
			activeInputEndpoint = undefined;
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
				releaseSpeechOwnership(false);
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
				releaseSpeechOwnership(false);
				ctx.ui.setEditorText(prompt);
				ctx.ui.notify("Dictation ready to review — press Enter to submit", "info");
				return;
			}
			ctx.ui.setEditorText("");
			if (ctx.isIdle()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "steer" });
		} catch (error) {
			activeInputEndpoint = undefined;
			releaseSpeechOwnership(false);
			live.cancel();
			if (talkEpoch !== contextEpoch || !activeContext) return;
			clearInputProgress();
			state = "error";
			refreshStatus();
			ctx.ui.notify(`Voice microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		contextEpoch += 1;
		interactiveVoiceSession = supportsInteractiveVoice(ctx.mode);
		activeContext = interactiveVoiceSession ? ctx : null;
		coordinator?.shutdown();
		if (!interactiveVoiceSession) {
			coordinator = null;
			return;
		}
		coordinator = new SessionCoordinator(ctx.cwd, ctx.sessionManager.getSessionId());
		coordinator.start();
		deviceSelection = sessionDeviceSelection(ctx);
		activeDeviceId = deviceRouter.resolve(deviceSelection)?.id;
		inputProgressMessage = undefined;
		// Remove progress widgets from versions before the unified, ordered display.
		ctx.ui.setWidget("pi-voice-input", undefined);
		ctx.ui.setWidget("pi-voice-playback", undefined);
		ctx.ui.setWidget("pi-voice-preprocessing", undefined);
		if (attentionPollTimer) clearInterval(attentionPollTimer);
		attentionPollTimer = setInterval(pollWaitingAttention, 200);
		attentionPollTimer.unref?.();
		pendingCodeDescriptions.clear();
		codeDescriptionText.clear();
		reportedDescriptionOverflows.clear();
		codeDescriptionCache.restore(codeDescriptionSnapshots(ctx));
		syncPlaybackMessages(ctx, true);
		playbackHistory.restore(playbackTimingSnapshots(ctx));
		scheduleMissingCodeDescriptions(ctx);
		refreshPlaybackTimeline();
		scheduleMissingTimings(ctx);
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
		if (!interactiveVoiceSession) {
			activeContext = null;
			return;
		}
		interactiveVoiceSession = false;
		pendingCodeDescriptions.clear();
		clearInputProgress();
		ctx.ui.setStatus("pi-voice", undefined);
		ctx.ui.setWidget("pi-voice-render-driver", undefined);
		ctx.ui.setWidget("pi-voice-progress", undefined);
		ctx.ui.setWidget("pi-voice-input", undefined);
		ctx.ui.setWidget("pi-voice-playback", undefined);
		ctx.ui.setWidget("pi-voice-preprocessing", undefined);
		codePreprocessingProgress = undefined;
		timingPreprocessingProgress = undefined;
		if (attentionPollTimer) clearInterval(attentionPollTimer);
		attentionPollTimer = null;
		if (voiceWorkerIdleTimer) clearTimeout(voiceWorkerIdleTimer);
		voiceWorkerIdleTimer = null;
		coordinator?.shutdown();
		coordinator = null;
		ownsSpeech = false;
		pausedForAttention = false;
		if (narrationRenderTimer) clearTimeout(narrationRenderTimer);
		narrationRenderTimer = null;
		if (playbackTimelineTimer) clearTimeout(playbackTimelineTimer);
		playbackTimelineTimer = null;
		narrationTui = null;
		narration.finish();
		activeContext = null;
		phoneInput.cancel();
		const workers = timingWorkers.splice(0);
		await Promise.all([...workers.map(worker => worker.terminate()), vocalizer.shutdown()]);
	});

	pi.on("input", () => {
		if (!interactiveVoiceSession) return;
		coordinator?.clearWaiting();
		pausedForAttention = false;
		speechBlocked = false;
		blockedMessageHasSpeech = false;
		blockedSpeechText = "";
		cancelTimingWorkers();
		vocalizer.clear();
		narration.finish();
		releaseSpeechOwnership(false);
		reserveSpeechForInput();
	});

	pi.on("before_agent_start", () => {
		if (!interactiveVoiceSession) return;
		speechBlocked = false;
		blockedMessageHasSpeech = false;
		blockedWarningIssued = false;
		blockedSpeechText = "";
		cancelTimingWorkers();
		vocalizer.clear();
		narration.finish();
		if (!speechReservedForInput) releaseSpeechOwnership(false);
	});

	pi.on("message_start", event => {
		if (
			interactiveVoiceSession &&
			config.enabled &&
			config.mode !== "yield" &&
			typeof event.message === "object" &&
			event.message !== null &&
			"role" in event.message &&
			event.message.role === "assistant"
		) {
			blockedWarningIssued = false;
			if (activeContext) {
				const before = liveConversationBefore(activeContext);
				speechConversationMessages = before.messages;
			}
			speechAssistantMessage = event.message;
			const continuingTurn =
				liveTurnNarrationActive && ownsSpeech && speechPurpose === "turn" && (coordinator?.ownsSpeech() ?? true);
			if (!continuingTurn && !acquireSpeech("turn")) {
				speechBlocked = true;
				blockedMessageHasSpeech = false;
				blockedSpeechText = "";
				livePlaybackId = undefined;
				refreshStatus();
				return;
			}
			ownerTurnEnded = false;
			completedOwnerUtterance = undefined;
			ownedSpeechText = "";
			const sourceOffset = continuingTurn ? narration.startMessage() : 0;
			if (!continuingTurn) {
				narration.finish();
				narration.begin();
				liveTurnNarrationActive = true;
			}
			vocalizer.setNarrationSourceOffset(sourceOffset);
			playbackPaused = false;
			livePlaybackId = `live:${++nextLivePlaybackId}`;
			playbackHistory.beginCapture(livePlaybackId, "", 0, true);
			refreshPlaybackTimeline();
		}
	});

	pi.on("message_update", event => {
		if (!interactiveVoiceSession || !config.enabled || config.mode === "yield") return;
		speechAssistantMessage = event.message;
		vocalizer.setCodeDescriptionMessages(contextualAssistantMessages(speechConversationMessages, event.message));
		const delta = event.assistantMessageEvent;
		const speakableDelta =
			delta.type === "text_delta" || (delta.type === "thinking_delta" && config.mode === "all")
				? delta.delta
				: undefined;
		if (!ownsSpeech) {
			if (speechBlocked && speakableDelta !== undefined) {
				blockedSpeechText += speakableDelta;
				if (hasSpeakableAudio(blockedSpeechText)) {
					blockedMessageHasSpeech = true;
					pausedForAttention = true;
					refreshStatus();
				}
			}
			return;
		}
		if (speakableDelta !== undefined) {
			ownedSpeechText += speakableDelta;
			if (hasSpeakableAudio(ownedSpeechText)) announceProjectForSpeech();
		}
		if (delta.type === "text_delta") {
			narration.pushDelta("assistant", delta.contentIndex, delta.delta);
			vocalizer.pushDelta(delta.delta);
		} else if (delta.type === "thinking_delta" && config.mode === "all") {
			narration.pushDelta("assistant-thinking", delta.contentIndex, delta.delta);
			vocalizer.pushDelta(delta.delta);
		}
	});

	pi.on("message_end", event => {
		if (!interactiveVoiceSession) return;
		const completedText = assistantText(event.message);
		const stopReason = assistantStopReason(event.message);
		if (completedText && stopReason !== undefined && stopReason !== "aborted" && stopReason !== "error" && activeContext) {
			scheduleCodeDescriptionsInText(activeContext, completedText);
			if (livePlaybackId) finalizePlaybackMessage(activeContext, livePlaybackId, completedText);
			livePlaybackId = undefined;
		}
		if (config.enabled && speechBlocked && requiresVoiceAttention(completedText, config.mode, stopReason)) {
			blockedMessageHasSpeech = true;
			pausedForAttention = true;
			refreshStatus();
		}
		if (!config.enabled || stopReason === undefined || !ownsSpeech) return;
		if (stopReason === "aborted" || stopReason === "error") {
			vocalizer.clear();
			narration.finish();
			livePlaybackId = undefined;
			releaseSpeechOwnership(true);
		} else if (config.mode !== "yield") {
			ownerContentExpected = ownerContentExpected || hasSpeakableAudio(completedText);
			if (ownerContentExpected) announceProjectForSpeech();
			vocalizer.flush();
		}
	});

	pi.on("turn_end", (event, ctx) => {
		if (!interactiveVoiceSession) return;
		const stopReason = assistantStopReason(event.message);
		const completedTurn = stopReason !== "aborted" && stopReason !== "error" && stopReason !== undefined;
		if (config.enabled && config.mode === "yield" && completedTurn) {
			const text = assistantText(event.message);
			if (text && acquireSpeech("turn")) {
				const contextual = completedAssistantMessages(ctx, config.mode).findLast(message => message.text === text);
				const messages = playbackMessages(ctx);
				const completed = messages.findLast(message => message.text === text);
				if (completed) {
					playbackHistory.sync(messages, true);
					playbackHistory.beginCapture(completed.id, completed.text, 0, true);
				}
				speechConversationMessages = contextual?.conversationMessages ?? [];
				speechAssistantMessage = contextual?.assistantMessage;
				narration.setCompletedText(text);
				ownerContentExpected = hasSpeakableAudio(text);
				if (ownerContentExpected) announceProjectForSpeech();
				vocalizer.speak(text);
			} else if (requiresVoiceAttention(text, config.mode, stopReason)) {
				speechBlocked = true;
				blockedMessageHasSpeech = true;
				blockedSpeechText = text;
				pausedForAttention = true;
			}
		}
		if (config.enabled && completedTurn) {
			if (ownsSpeech && speechPurpose === "turn") {
				ownerTurnEnded = true;
				completeOwnerSpeech();
			} else if (blockedMessageHasSpeech) {
				coordinator?.markWaiting();
				pausedForAttention = true;
				speechBlocked = false;
				blockedMessageHasSpeech = false;
				blockedSpeechText = "";
				if (!blockedWarningIssued) {
					blockedWarningIssued = true;
					ctx.ui.notify("Voice response paused behind another project; run /voice attention or press F11 to play it", "warning");
				}
				refreshStatus();
			} else if (speechBlocked) {
				speechBlocked = false;
				blockedSpeechText = "";
				pausedForAttention = coordinator?.isWaiting() ?? false;
				refreshStatus();
			}
		}
		scheduleMissingTimings(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!interactiveVoiceSession || activeContext !== ctx) return;
		for (const snapshot of pendingCodeDescriptions.values()) {
			pi.appendEntry(CODE_DESCRIPTION_CACHE_ENTRY, snapshot);
		}
		pendingCodeDescriptions.clear();
		syncPlaybackMessages(ctx);
		scheduleMissingCodeDescriptions(ctx);
		scheduleMissingTimings(ctx);
	});

	pi.registerShortcut("ctrl+shift+v", {
		description: "Toggle Kokoro voice mode",
		handler: async ctx => toggle(ctx),
	});

	// Playback controls act on completed assistant snapshots and never mutate a
	// response that is still generating. Manual controls are also how users
	// preempt speech ownership, so they must stay available while Pi streams.
	const requireEnabledVoice = (ctx: ExtensionContext): boolean => {
		if (!config.enabled) {
			ctx.ui.notify("Voice mode is disabled", "warning");
			return false;
		}
		return true;
	};

	const replaySelected = (ctx: ExtensionContext): void => {
		if (!requireEnabledVoice(ctx)) return;
		syncPlaybackMessages(ctx, pausedForAttention);
		const target = playbackHistory.restartTarget();
		if (!target) {
			ctx.ui.notify("There is no completed assistant message to replay yet", "warning");
			return;
		}
		playTarget(target, !playbackHistory.hasTimings());
	};

	playRequestedAttention = ctx => {
		pausedForAttention = true;
		replaySelected(ctx);
	};

	const attendNextProject = (ctx: ExtensionContext): void => {
		if (!coordinator) {
			replaySelected(ctx);
			return;
		}
		const waiting = coordinator.waitingSessions();
		const own = waiting.find(session => session.instanceId === coordinator?.instanceId);
		if (own) {
			playRequestedAttention(ctx);
			return;
		}
		const next = waiting[0];
		if (!next) {
			replaySelected(ctx);
			return;
		}
		vocalizer.clear();
		narration.finish();
		releaseSpeechOwnership(false);
		coordinator.requestAttention(next.instanceId);
		ctx.ui.notify(`Switching voice attention to project ${coordinator.projectLabel(next.cwd)}`, "info");
	};

	pi.registerShortcut("f6", {
		description: "Play the previous assistant message",
		handler: ctx => {
			if (!requireEnabledVoice(ctx)) return;
			syncPlaybackMessages(ctx);
			const message = playbackHistory.move(-1);
			if (message) playTarget({ ...message, time: 0, sourceOffset: 0 }, !playbackHistory.hasTimings());
		},
	});

	pi.registerShortcut("f7", {
		description: "Regenerate playback from about 10 seconds earlier",
		handler: ctx => {
			if (!requireEnabledVoice(ctx)) return;
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
			if (!requireEnabledVoice(ctx)) return;
				if (playbackPaused) {
				if (pausedOwnerUtterance === undefined) {
					const target = playbackHistory.resumeTarget();
					if (target) playTarget(target, false);
					return;
				}
				if (!acquireSpeech("replay", false, true)) return;
				lastOwnerUtterance = pausedOwnerUtterance;
				ownerContentExpected = true;
				ownerTurnEnded = true;
				completedOwnerUtterance = undefined;
				vocalizer.setPlaybackPaused(false);
				playbackPaused = false;
				pausedOwnerUtterance = undefined;
				state = "speaking";
				refreshStatus();
				refreshPlaybackTimeline();
				return;
			}
			if (!playbackHistory.selected()) {
				ctx.ui.notify("There is no assistant message playing", "warning");
				return;
			}
			pausedOwnerUtterance = lastOwnerUtterance;
			vocalizer.setPlaybackPaused(true);
			playbackPaused = true;
			releaseSpeechOwnership(false);
			state = "idle";
			refreshStatus();
			refreshPlaybackTimeline();
		},
	});

	pi.registerShortcut("f9", {
		description: "Regenerate playback from about 10 seconds later",
		handler: ctx => {
			if (!requireEnabledVoice(ctx)) return;
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
			if (!requireEnabledVoice(ctx)) return;
			syncPlaybackMessages(ctx);
			const message = playbackHistory.move(1);
			if (message) playTarget({ ...message, time: 0, sourceOffset: 0 }, !playbackHistory.hasTimings());
		},
	});

	pi.registerShortcut("f11", {
		description: "Play this or the next waiting project's response",
		handler: attendNextProject,
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
				"attention",
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
				"code-budget",
				"code-preprocess",
				"timing-preprocess",
				"audio-cache",
				"audio-bitrate",
				"device",
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
			if (parts[0] === "device") {
				return [
					{ value: "device auto", label: "auto", description: "Use this SSH client, then the latest connected device" },
					{ value: "device local", label: "local", description: "Use devices on the machine running Pi" },
					...deviceRouter.connected().map(device => ({
						value: `device ${device.id}`,
						label: device.name,
						description: `${device.platform} · ${device.id}`,
					})),
				].filter(candidate => candidate.label.startsWith(parts[1] ?? "") || candidate.value.includes(parts[1] ?? ""));
			}
			if (parts[0] === "audio-cache") {
				return ["on", "off"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `audio-cache ${value}`, label: value }));
			}
			if (parts[0] === "audio-bitrate") {
				return ["24", "32", "48", "64"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `audio-bitrate ${value}`, label: `${value} kbps` }));
			}
			if (parts[0] === "code-budget") {
				return ["unlimited"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `code-budget ${value}`, label: value }));
			}
			if (parts[0] === "code-preprocess" || parts[0] === "timing-preprocess") {
				const choices = ["1", "2", "3", "4", "5", "6", "7", "8"];
				if (parts[0] === "timing-preprocess") choices.unshift("auto");
				return choices
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `${parts[0]} ${value}`, label: value }));
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
					{ value: "output auto", label: "auto", description: "Prefer the selected SSH client, then local speakers" },
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
					{ value: "input auto", label: "auto", description: "Prefer the selected SSH client, then the local microphone" },
					{ value: "input local", label: "local", description: "Use this machine's default microphone" },
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
					narration.finish();
					releaseSpeechOwnership(true);
					if (inputPhase === "recording") {
						setInputProgress("🎙 Stopping voice recording…");
						void phoneInput.stop(activeInputEndpoint ?? routedVoiceConfig().input).catch(error =>
							ctx.ui.notify(`Voice microphone: ${error instanceof Error ? error.message : String(error)}`, "error"),
						);
					}
					state = inputInProgress ? "listening" : "idle";
					refreshStatus();
					return;
				case "talk":
					void talk(ctx);
					return;
				case "attention":
					attendNextProject(ctx);
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
					narration.finish();
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
					narration.finish();
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
				case "device": {
					const requested = value.trim();
					if (
						requested !== "auto" &&
						requested !== "local" &&
						!deviceRouter.connected().some(device => device.id === requested)
					) {
						ctx.ui.notify("Usage: /voice device auto|local|<connected-device-id>", "error");
						return;
					}
					deviceSelection = requested;
					pi.appendEntry(DEVICE_SELECTION_ENTRY, { version: 1, selection: requested });
					const device = deviceRouter.claim(deviceSelection);
					activeDeviceId = device?.id;
					ctx.ui.notify(
						device ? `Voice device set to ${device.name}` : "Voice device set to local input/output",
						"info",
					);
					refreshStatus();
					return;
				}
				case "audio-cache": {
					const enabled = value.toLowerCase();
					if (enabled !== "on" && enabled !== "off") {
						ctx.ui.notify("Usage: /voice audio-cache on|off", "error");
						return;
					}
					await updateConfig({ ...config, audioCache: enabled === "on" });
					ctx.ui.notify(`Audio caching ${enabled === "on" ? "enabled" : "disabled"}`, "info");
					return;
				}
				case "audio-bitrate": {
					const bitrate = normalizeAudioCacheBitrate(Number(value));
					if (bitrate === undefined) {
						ctx.ui.notify("Usage: /voice audio-bitrate <12..128>", "error");
						return;
					}
					await updateConfig({ ...config, audioCacheBitrate: bitrate });
					ctx.ui.notify(`Opus audio cache bitrate set to ${bitrate} kbps`, "info");
					return;
				}
				case "code-preprocess": {
					const concurrency = normalizeWorkerCount(Number(value));
					if (concurrency === undefined) {
						ctx.ui.notify("Usage: /voice code-preprocess <1..8>", "error");
						return;
					}
					await updateConfig({ ...config, codeDescriptionPreprocessConcurrency: concurrency });
					ctx.ui.notify(`code-preprocess concurrency set to ${concurrency}`, "info");
					return;
				}
				case "code-budget": {
					if (!value) {
						const used = backfillUsed;
						ctx.ui.notify(
							`code-description backfill: scope=${config.codeDescriptionPreprocessScope}; budget=${backfillAllowance}; used=${used}; set /voice code-budget <0..n|unlimited> for this session`,
							"info",
						);
						return;
					}
					const parsed = normalizeBackfillBudget(value.toLowerCase() === "unlimited" ? "unlimited" : Number(value));
					if (parsed === undefined) {
						ctx.ui.notify("Usage: /voice code-budget [unlimited|<0..n>]", "error");
						return;
					}
					// Session-runtime only; the persisted config keeps its own budget.
					backfillAllowance = parsed;
					backfillUsed = 0;
					backfillExhaustionReported = false;
					if (activeContext) scheduleMissingCodeDescriptions(activeContext);
					ctx.ui.notify(`code-description backfill budget set to ${parsed} for this session`, "info");
					return;
				}
				case "timing-preprocess": {
					const concurrency = normalizePreprocessConcurrency(value.toLowerCase() === "auto" ? "auto" : Number(value));
					if (concurrency === undefined) {
						ctx.ui.notify("Usage: /voice timing-preprocess auto|<1..8>", "error");
						return;
					}
					await updateConfig({ ...config, timingPreprocessConcurrency: concurrency });
					ctx.ui.notify(`timing-preprocess concurrency set to ${concurrency}`, "info");
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
					narration.finish();
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
					narration.finish();
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
						ctx.ui.notify("Usage: /voice output auto|local|tcp://host:port|unix:///path", "error");
						return;
					}
					vocalizer.clear();
					narration.finish();
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
						`Voice microphone shortcut set to ${shortcut}. Run /reload to apply it.`,
						"info",
					);
					return;
				}
				case "input": {
					const input = normalizeVoiceInput(value);
					if (!input) {
						ctx.ui.notify("Usage: /voice input auto|local|disabled|tcp://host:port|unix:///path", "error");
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
					narration.finish();
					if (!acquireSpeech("replay", true, true)) return;
					ownerContentExpected = true;
					announceProjectForSpeech();
					lastOwnerUtterance = vocalizer.speakUntracked(text);
					ownerTurnEnded = true;
					completeOwnerSpeech();
					return;
				}
				case "timing":
					ctx.ui.notify(narration.timingSummary(), "info");
					return;
				case "status":
				case "":
					ctx.ui.notify(
						`Voice ${config.enabled ? "on" : "off"}; mode=${config.mode}; voice=${config.voice}; speed=${config.speed}; tts=${config.ttsModel}@${config.ttsDtype}; stt=${config.sttModel}@${config.sttDtype}; sttCandidates=${config.sttCandidates}; alignment=${config.alignmentModel}@${config.alignmentDtype}; editModel=${config.editModel}; highlight=${config.playbackHighlight ? "on" : "off"}; codeNarration=${config.codeNarration}; codeContext=${config.codeDescriptionContext}; codePreprocess=${config.codeDescriptionPreprocessConcurrency}; codeScope=${config.codeDescriptionPreprocessScope}; codeBudget=${backfillAllowance}; timingPreprocess=${config.timingPreprocessConcurrency}; audioCache=${config.audioCache ? `${config.audioCacheBitrate}kbps` : "off"}; device=${deviceSelection}${activeDeviceId ? `→${activeDeviceId}` : "→local"}; output=${config.output}; input=${config.input}; shortcut=${config.talkShortcut}; submit=${config.submitMode}; edit=${config.editMode}`,
						"info",
					);
					return;
				default:
					ctx.ui.notify(
						"Usage: /voice [on|off|toggle|status|stop|setup|test|talk|attention|mode|voice|speed|tts-model|tts-dtype|stt-model|stt-dtype|stt-candidates|alignment-model|alignment-dtype|edit-model|highlight|timing|code-narration|code-preprocess|timing-preprocess|audio-cache|audio-bitrate|device|output|input|shortcut|submit|edit]",
						"error",
					);
			}
		},
	});
}
