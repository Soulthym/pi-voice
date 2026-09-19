import { createHash } from "node:crypto";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { getMarkdownTheme, highlightCode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { hasSpeakableAudio, requiresVoiceAttention } from "./attention.js";
import {
	assistantCodeContext,
	eligibleAssistantBlocks,
	resolvedSessionContext,
	structuredContextIdentity,
	type ResolvedCodeContext,
} from "./code-context.js";
import { CodeDescriptionCache, type CodeDescriptionCacheSnapshot } from "./code-description-cache.js";
import {
	codeDescriptionCacheKey,
	legacyCodeDescriptionCacheKey,
	CodeDescriptionBudgetExhaustedError,
	classifyCodeDescriptionFailure,
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
import {
	NARRATION_ACTIVE_MARKER,
	NarrationProgress,
	type NarrationMessageType,
} from "./narration-progress.js";
import {
	PlaybackHistory,
	type PlaybackMessage,
	type PlaybackTarget,
	type PlaybackTimingSnapshot,
} from "./playback-history.js";
import { PhoneInputClient } from "./phone-input.js";
import { prioritizeFromCurrent, processConcurrently, resolveTimingConcurrency } from "./preprocessing.js";
import { SpeakableStream, type FencedCodeBlock, type SpeakableSourceRange } from "./speakable.js";
import { pendingPlaybackTiming, playbackTimingStatus, voiceProgressLines } from "./status-text.js";
import { anchorLineForMessage, computeAutoScrollTop, isManualScrollAway } from "./auto-scroll.js";
import { applySpokenEdit, parseEditModelSelector, resolveDictationCandidates } from "./prompt-editor.js";
import { formatAsrDisplay } from "./asr-display.js";
import { narrationRenderKey } from "./render-identity.js";
import { frameNarrationViewport, invalidateNarrationMarkdown } from "./narration-render.js";
import { SessionCoordinator, type WaitingSession } from "./session-coordinator.js";
import { supportsInteractiveVoice } from "./session-mode.js";
import { Vocalizer } from "./vocalizer.js";
import { isVoice, VOICES } from "./voices.js";
import { VoiceWorkerClient, type WorkerEvent } from "./worker-client.js";

type VoiceState = "downloading" | "error" | "idle" | "listening" | "loading" | "speaking";
type InputPhase = "idle" | "acquiring" | "recording" | "transcribing";
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
	entryId: string;
	conversationMessages: Message[];
	assistantMessage: unknown;
	contentIndex: number;
	messageType: NarrationMessageType;
};

const conversationBeforeCache = new WeakMap<object, Map<string, ResolvedCodeContext>>();
const completedMessagesCache = new WeakMap<object, { session: string; leaf: string | null; messages: Map<string, ContextualPlaybackMessage[]> }>();
const completedEntryCache = new WeakMap<object, Map<string, ContextualPlaybackMessage[]>>();
type IdentityContext = string | (() => string);
const completedBlocksCache = new WeakMap<ContextualPlaybackMessage, Array<DescribableCodeItem & { identityContext: () => string; providerMessagesThroughBlock: Message[] }>>();

function completedCodeItems(message: ContextualPlaybackMessage) {
	let items = completedBlocksCache.get(message);
	if (!items) {
		items = describableCodeItems(message.text).map(item => {
			// Retain compact lookup keys downstream, not serialized copies of every prefix.
			const providerMessages = () => assistantCodeContext(
				message.conversationMessages, message.assistantMessage, message.contentIndex, item.sourceEnd)!;
			return { ...item, get providerMessagesThroughBlock() { return providerMessages(); },
				identityContext: () => structuredContextIdentity(providerMessages()) };
		});
		completedBlocksCache.set(message, items);
	}
	return items;
}

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

function completedAssistantMessages(ctx: ExtensionContext, mode: VoiceMode, includeContext = false): ContextualPlaybackMessage[] {
	const session = ctx.sessionManager.getSessionId();
	const leaf = ctx.sessionManager.getLeafId();
	let cache = completedMessagesCache.get(ctx.sessionManager);
	if (cache?.session === session && cache.leaf !== leaf) {
		let ancestor = leaf;
		while (ancestor && ancestor !== cache.leaf) {
			const entry = ctx.sessionManager.getEntry?.(ancestor);
			if (entry?.type !== "custom") break;
			ancestor = entry.parentId;
		}
		if (ancestor === cache.leaf) cache.leaf = leaf;
	}
	if (cache?.session !== session || cache.leaf !== leaf) {
		cache = { session, leaf, messages: new Map() };
		completedMessagesCache.set(ctx.sessionManager, cache);
	}
	const key = `${mode}:${includeContext}`;
	const cached = cache.messages.get(key);
	if (cached) return cached;
	const messages: ContextualPlaybackMessage[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const stopReason = assistantStopReason(entry.message);
		if (stopReason === undefined || stopReason === "aborted" || stopReason === "error") continue;
		// Yield mode only speaks the final response, not intermediate text attached to tool/edit calls.
		if (mode === "yield" && stopReason === "toolUse") continue;
		let variants = completedEntryCache.get(entry);
		const existing = variants?.get(key);
		if (existing) { messages.push(...existing); continue; }
		const targets = eligibleAssistantBlocks(entry.message, mode).filter(block => hasSpeakableAudio(block.text)).map(block => ({
			...block,
			id: block.contentIndex === 0 ? entry.id : `${entry.id}:${block.contentIndex}`,
			entryId: entry.id,
			get conversationMessages() {
				return includeContext ? contextBeforeEntry(ctx, entry.parentId).messages : [];
			},
			assistantMessage: entry.message,
		}));
		if (!variants) { variants = new Map(); completedEntryCache.set(entry, variants); }
		variants.set(key, targets);
		messages.push(...targets);
	}
	cache.messages.set(key, messages);
	return messages;
}

function playbackTimingSnapshots(ctx: ExtensionContext): PlaybackTimingSnapshot[] {
	const snapshots: PlaybackTimingSnapshot[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== PLAYBACK_TIMING_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("version" in data) || data.version !== 3) continue;
		snapshots.push(data as PlaybackTimingSnapshot);
	}
	return snapshots;
}

function sessionDeviceSelection(ctx: ExtensionContext): { selection: VoiceDeviceSelection; pin?: string } {
	let selection: VoiceDeviceSelection = "auto";
	let pin: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== DEVICE_SELECTION_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("selection" in data) || typeof data.selection !== "string") continue;
		if (data.selection === "auto" || data.selection === "local" || /^[a-zA-Z0-9._-]{1,128}$/.test(data.selection)) {
			selection = data.selection;
			pin = "pin" in data && typeof data.pin === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(data.pin) ? data.pin : undefined;
		}
	}
	return { selection, pin };
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
	sourceEnd: number;
}

function describableCodeItems(text: string): DescribableCodeItem[] {
	const stream = new SpeakableStream();
	return [...stream.push(text), ...stream.flush()]
		.filter(item => item.kind === "code")
		.map(item => ({
			block: item.block,
			sourceEnd: item.source.end,
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
	let speechLeaseEpoch = 0;
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
	let attentionSuppressed = false;
	let deviceRetryRequired = false;
	let disabledAttentionPending = false;
	let speechBlocked = false;
	let blockedMessageHasSpeech = false;
	let blockedWarningIssued = false;
	let blockedSpeechText = "";
	let ownedSpeechText = "";
	let speechConversationMessages: Message[] = [];
	let speechAssistantMessage: unknown;
	let speechContentIndex = 0;
	let liveDisplayOffset = 0;
	let liveSource: { assistant: unknown; final: boolean; before: Message[]; existingEntries: Set<string>; waiters: Set<() => void> } | undefined;
	let liveBlockIndex: number | undefined;
	const liveBlockIds = new Map<number, string>();
	const setDescriptionSource = (contentIndex: number, suffixOffset = 0): void => {
		const source = liveSource?.assistant === speechAssistantMessage ? liveSource : undefined;
		const assistant = speechAssistantMessage;
		const before = speechConversationMessages;
		vocalizer.setCodeDescriptionMessages((end, signal) => {
			if (config.codeDescriptionContext !== "conversation") return Promise.resolve([]);
			if (!source) return Promise.resolve(assistantCodeContext(before, assistant, contentIndex, end + suffixOffset)!);
			return new Promise(resolve => {
				const finish = (messages: Message[]) => {
					source.waiters.delete(check);
					signal.removeEventListener("abort", abort);
					resolve(messages);
				};
				const abort = () => finish([]);
				const check = () => {
					const messages = assistantCodeContext(source.before, source.assistant, contentIndex, end + suffixOffset, source.final);
					if (messages) finish(messages);
				};
				source.waiters.add(check);
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort(); else check();
			});
		});
	};
	let completingOwnerSpeech = false;
	let attentionPollTimer: NodeJS.Timeout | null = null;
	let voiceWorkerIdleTimer: NodeJS.Timeout | null = null;
	let handleCoordinatedIdle: (utterance: number | undefined) => void = () => {};
	let playRequestedAttention: (ctx: ExtensionContext) => void = () => {};
	let releaseSpeechOwnership: (announceNext?: boolean) => void = () => {};
	let pendingSpeechPreemption:
		| { purpose: SpeechPurpose | undefined; wasComplete: boolean; spokenText: string; cancelId?: number }
		| undefined;
	let finishSpeechPreemption: () => void = () => {};
	const transportCancelWaiters = new Map<number, () => void>();
	let state: VoiceState = "idle";
	let downloadPercent: number | undefined;
	let lastError = "";
	let inputInProgress = false;
	let inputEpoch = 0;
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
	let queueIncomingWhilePaused = false;
	const queuedPausedMessages: PlaybackTarget[] = [];
	let pausedOwnerUtterance: number | undefined;
	let playbackRequestEpoch = 0;
	let pendingReplay:
		| {
				epoch: number;
				target: PlaybackTarget;
				recordTimings: boolean;
				previewTarget: boolean;
				paused: boolean;
				waiting: boolean;
			}
		| undefined;
	let playbackPositionEstimated = false;
	let playbackTimelineTimer: NodeJS.Timeout | null = null;
	let codePreprocessingProgress: PreprocessingProgress | undefined;
	let timingPreprocessingProgress: PreprocessingProgress | undefined;
	const playbackHistory = new PlaybackHistory();
	const codeDescriptionCache = new CodeDescriptionCache();
	const codeDescriptionText = new Map<string, string>();
	const pendingCodeDescriptions = new Map<string, CodeDescriptionCacheSnapshot>();
	let descriptionPersistTimer: NodeJS.Immediate | undefined;
	const persistPendingDescriptions = (): void => {
		for (const [key, snapshot] of pendingCodeDescriptions) {
			try {
				pi.appendEntry(CODE_DESCRIPTION_CACHE_ENTRY, snapshot);
				pendingCodeDescriptions.delete(key);
			} catch { break; } // Leave unwritten snapshots pending for a later safe flush.
		}
	};
	const scheduleDescriptionPersistence = (): void => {
		if (descriptionPersistTimer) return;
		const epoch = contextEpoch;
		descriptionPersistTimer = setImmediate(() => {
			descriptionPersistTimer = undefined;
			if (epoch === contextEpoch && activeContext?.isIdle()) persistPendingDescriptions();
		});
	};
	const reportedDescriptionOverflows = new Set<string>();
	/** Runtime-only failed-description records; retry commands clear them. */
	const codeDescriptionOmissions = new Map<string, { reason: "quality" | "provider"; message: string }>();
	let scheduleMissingTimings: (ctx: ExtensionContext, force?: boolean) => void = () => {};

	let renderedNarrationSources = new Set<string>();
	const changedDescriptionCode = new Set<string>();
	let invalidateAllNarration = false;
	const invalidateNarration = (): void => {
		const sources = new Set(narration.sourceTexts);
		const affected = new Set([...renderedNarrationSources, ...sources]);
		if (invalidateAllNarration || !invalidateNarrationMarkdown(narrationTui, affected, changedDescriptionCode)) {
			narrationTui?.invalidate();
		}
		renderedNarrationSources = sources;
		changedDescriptionCode.clear();
		invalidateAllNarration = false;
	};
	const requestNarrationRender = (changedCode?: string | true): void => {
		if (changedCode === true) invalidateAllNarration = true;
		else if (changedCode) changedDescriptionCode.add(changedCode);
		if (!narrationTui || narrationRenderTimer) return;
		narrationRenderTimer = setTimeout(() => {
			narrationRenderTimer = null;
			invalidateNarration();
			narrationTui?.requestRender();
		}, 80);
		narrationRenderTimer.unref?.();
	};
	const flushNarrationRender = (): void => {
		if (narrationRenderTimer) clearTimeout(narrationRenderTimer);
		narrationRenderTimer = null;
		invalidateNarration();
		narrationTui?.requestRender(true);
	};
	const narration = new NarrationProgress(requestNarrationRender);

	let outputEndpoint = "disabled";
	let outputGeneration: number | undefined;
	const routedVoiceConfig = (): VoiceConfig => ({
		...config,
		output: config.output === "auto" ? outputEndpoint : config.output,
		input: config.input === "auto" ? (activeInputEndpoint ?? "disabled") : config.input,
	});

	const claimOutputDevice = (): VoiceConfig => {
		const selection = activeDeviceId ?? deviceSelection;
		const route = deviceRouter.routeMetadata(selection, "output", config.output);
		outputEndpoint = route.endpoint;
		outputGeneration = route.kind === "device" ? route.device.connectedAt : undefined;
		if (route.kind === "device") deviceRouter.claim(selection);
		const routed = routedVoiceConfig();
		refreshStatus();
		return routed;
	};

	let progressWidgetKey: string | undefined;
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
					playbackLine = `${icon} ${playbackBar(playback.position, playback.duration)} ${formatPlaybackTime(playback.position)} / ${formatPlaybackTime(playback.duration)}${messageLabel}${playbackTimingStatus(playback.timingQuality, playbackPositionEstimated)}`;
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
			const key = JSON.stringify([contextEpoch, lines]);
			if (key === progressWidgetKey) return;
			ctx.ui.setWidget("pi-voice-progress", lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
			progressWidgetKey = key;
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

	const sourceKeys = new WeakMap<FencedCodeBlock, { context: IdentityContext; settings: string; identity: string; legacySettings?: string; legacy?: string }>();
	const descriptionCacheKey = (ctx: ExtensionContext, block: FencedCodeBlock, identityContext: IdentityContext): string => {
		let serialized: string | undefined;
		const context = () => serialized ??= typeof identityContext === "function" ? identityContext() : identityContext;
		const settings = `${config.codeNarration}:${config.codeDescriptionContext}`;
		let memo = sourceKeys.get(block);
		if (!memo || memo.context !== identityContext || memo.settings !== settings) {
			memo = { context: identityContext, settings, identity: codeDescriptionCacheKey(ctx, block, config.editModel,
				config.codeNarration, context(), config.codeDescriptionContext) };
			sourceKeys.set(block, memo);
		}
		const identity = memo.identity;
		const known = codeDescriptionCache.resolveKey(identity);
		if (known !== identity || codeDescriptionCache.get(identity)) return known;
		// Adopt resolvable old snapshots without changing their timing dependency key.
		try {
			const legacySettings = createHash("sha256").update(JSON.stringify([contextEpoch, config.editModel, ctx.model?.provider, ctx.model?.id,
				codeDescriptionUsesActivePrompt(ctx, config.editModel) ? [ctx.getSystemPrompt(), activePromptTools()] : null])).digest("hex");
			if (memo.legacySettings !== legacySettings) {
				memo.legacy = legacyCodeDescriptionCacheKey(ctx, block, config.editModel, config.codeNarration,
					contextualCodeDescription(ctx, context()), config.codeDescriptionContext);
				memo.legacySettings = legacySettings;
			}
			const legacy = memo.legacy!;
			const adopted = codeDescriptionCache.adopt(identity, legacy);
			if (adopted) {
				pendingCodeDescriptions.set(legacy, adopted);
				scheduleDescriptionPersistence();
				return legacy;
			}
		} catch { /* Cached source identities remain usable without an available generator. */ }
		return identity;
	};

	const isCurrentContext = (ctx: ExtensionContext): boolean =>
		activeContext?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId();

	const requestCodeDescription = async (
		ctx: ExtensionContext,
		block: FencedCodeBlock,
		identityContext: IdentityContext,
		providerMessagesThroughBlock: readonly Message[],
		options?: { chargeBackfill?: () => boolean },
): Promise<CodeNarrationPlan> => {
		const fallback = plainCodeNarration(fallbackCodeDescription(block));
		const requestEpoch = contextEpoch;
		let resolvedKey: string | undefined;
		let lastOverflowModel = "";
		try {
			const key = descriptionCacheKey(ctx, block, identityContext);
			resolvedKey = key;
			const cached = codeDescriptionCache.get(key);
			if (cached) return cached;
			if (codeDescriptionOmissions.has(key)) return { records: [], guided: false, omitted: true };
			const editModel = config.editModel;
			const narrationMode = config.codeNarration;
			const contextMode = config.codeDescriptionContext;
			const reusesActivePrompt =
				contextMode === "conversation";
			const systemPrompt = reusesActivePrompt ? ctx.getSystemPrompt() : undefined;
			const tools = reusesActivePrompt ? activePromptTools() : undefined;
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
			lastOverflowModel = editModel;
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
										if (requestEpoch !== contextEpoch || !isCurrentContext(ctx)) throw new Error("Code description aborted");
										if (options?.chargeBackfill && !options.chargeBackfill()) {
											throw new CodeDescriptionBudgetExhaustedError();
										}
									},
								},
							).catch(error => {
								if (error instanceof CodeDescriptionBudgetExhaustedError) throw BACKFILL_EXHAUSTED;
								throw error;
							});
						return coordinator
							? coordinator.withResource("code", config.codeDescriptionPreprocessConcurrency, generate)
							: generate();
					},
					snapshot => {
						if (requestEpoch !== contextEpoch || !isCurrentContext(ctx)) return;
						try {
							if (ctx.isIdle()) pi.appendEntry(CODE_DESCRIPTION_CACHE_ENTRY, snapshot);
							else pendingCodeDescriptions.set(snapshot.key, snapshot);
						} catch {
							// Session replacement invalidates captured contexts before background work settles.
						}
					},
				)
				.then(plan => {
					if (requestEpoch === contextEpoch && isCurrentContext(ctx) && !plan.omitted) {
						codeDescriptionText.set(key, descriptionText(plan));
						requestNarrationRender(block.code);
					}
					return plan;
				});
		} catch (outerError) {
			if (requestEpoch !== contextEpoch || !isCurrentContext(ctx)) return fallback;
			if (outerError === BACKFILL_EXHAUSTED || outerError instanceof CodeDescriptionBudgetExhaustedError) throw BACKFILL_EXHAUSTED;
			if (!resolvedKey) return fallback;
			if (outerError instanceof CodeDescriptionContextOverflowError) {
				// Isolated compaction could not fit anything either; fall back locally.
				const overflowId = `${lastOverflowModel}:${outerError.contextWindow}`;
				if (!reportedDescriptionOverflows.has(overflowId)) {
					reportedDescriptionOverflows.add(overflowId);
					try {
						if (isCurrentContext(ctx)) {
							ctx.ui.notify(
								`Voice used local code narration because ${lastOverflowModel} has insufficient context`,
								"warning",
							);
						}
					} catch {
						// Session replacement can invalidate the captured UI before generation settles.
					}
				}
				return fallback;
			}
			// Cache the omission so neither speech nor preprocessing repeats the cost.
			const reason = classifyCodeDescriptionFailure(outerError) === "quality" ? "quality" : "provider";
			codeDescriptionOmissions.set(resolvedKey, {
				reason,
				message: String(outerError instanceof Error ? outerError.message : outerError).slice(0, 200),
			});
			requestNarrationRender(block.code);
			return { records: [], guided: false, omitted: true };
		}
	};

	const timingItemsFor = async (
		ctx: ExtensionContext,
		message: ContextualPlaybackMessage,
	): Promise<{ items: Array<{ text: string; source: SpeakableSourceRange; wordTimings: boolean }>; codeDependencies: string[] }> => {
		const stream = new SpeakableStream();
		const result: Array<{ text: string; source: SpeakableSourceRange; wordTimings: boolean }> = [];
		const codeDependencies: string[] = [];
		for (const item of [...stream.push(message.text), ...stream.flush()]) {
			if (item.kind === "speech") {
				result.push({ text: item.text, source: item.source, wordTimings: true });
				continue;
			}
			const completed = completedCodeItems(message).find(block => block.sourceEnd === item.source.end)!;
			const key = descriptionCacheKey(ctx, completed.block, completed.identityContext);
			const plan = await requestCodeDescription(
				ctx,
				completed.block,
				completed.identityContext,
				completed.providerMessagesThroughBlock,
				{ chargeBackfill: chargeBackfillUnit },
			);
			codeDependencies.push(JSON.stringify([key, plan.omitted ? "omitted" : plan]));
			if (plan.omitted) continue;
			let chunks = chunkCodeNarration(plan);
			if (chunks.length === 0) chunks = chunkCodeNarration(plainCodeNarration(fallbackCodeDescription(item.block)));
			for (const chunk of chunks) result.push({ text: chunk.text, source: item.source, wordTimings: false });
		}
		return { items: result, codeDependencies };
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
		if (backfillAllowance !== "unlimited" && backfillUsed >= backfillAllowance) return false;
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
		const retained = new Set(branch.slice(lastCompactionIndex).map(entry => entry.id));
		const compaction = branch[lastCompactionIndex] as unknown as { firstKeptEntryId?: string; retainedTail?: unknown[] };
		if (Array.isArray(compaction.retainedTail)) {
			// Match the retained message values, newest occurrence first (entries need not survive serialization by reference).
			const remaining = new Map<string, number>();
			for (const message of compaction.retainedTail) {
				const key = JSON.stringify(message);
				remaining.set(key, (remaining.get(key) ?? 0) + 1);
			}
			for (let index = lastCompactionIndex - 1; index >= 0 && remaining.size; index -= 1) {
				const entry = branch[index];
				if (entry.type !== "message") continue;
				const key = JSON.stringify(entry.message);
				const count = remaining.get(key);
				if (!count) continue;
				retained.add(entry.id);
				if (count === 1) remaining.delete(key);
				else remaining.set(key, count - 1);
			}
		} else if (compaction.firstKeptEntryId) {
			const first = branch.findIndex(entry => entry.id === compaction.firstKeptEntryId);
			if (first >= 0) for (const entry of branch.slice(first, lastCompactionIndex)) retained.add(entry.id);
		}
		return retained;
	};

	/** Background work honors the scope; playback and replay always see everything. */
	const scopedCompletedMessages = (ctx: ExtensionContext, mode: VoiceMode): ContextualPlaybackMessage[] => {
		const all = completedAssistantMessages(ctx, mode, config.codeDescriptionContext === "conversation");
		if (config.codeDescriptionPreprocessScope !== "since-compaction") return all;
		const retained = retainedMessageIds(ctx);
		return retained ? all.filter(message => retained.has(message.entryId)) : all;
	};

	const scheduleMissingCodeDescriptions = (ctx: ExtensionContext): void => {
		if (codeDescriptionPreprocessing) return;
		const epoch = contextEpoch;
		const workEpoch = codeWorkEpoch;
		const queuedMessages: Array<
			Array<{ block: FencedCodeBlock; identityContext: IdentityContext; providerMessagesThroughBlock: Message[] }>
		> = [];
		let totalMessages = 0;
		let processedMessages = 0;
		let missingBlocks = 0;
		codeDescriptionPreprocessing = (async () => {
			await new Promise<void>(resolve => setImmediate(resolve));
			let sliceStart = performance.now();
			const currentId = playbackHistory.status()?.messageId;
			for (const message of prioritizeFromCurrent(scopedCompletedMessages(ctx, config.mode), currentId)) {
				if (performance.now() - sliceStart >= 8) {
					await new Promise<void>(resolve => setImmediate(resolve));
					sliceStart = performance.now();
				}
				if (epoch !== contextEpoch || workEpoch !== codeWorkEpoch || !isCurrentContext(ctx)) return;
				const keyedBlocks = new Map<
					string,
					{ block: FencedCodeBlock; identityContext: IdentityContext; providerMessagesThroughBlock: Message[] }
				>();
				for (const item of completedCodeItems(message)) {
					try {
						const key = descriptionCacheKey(ctx, item.block, item.identityContext);
						keyedBlocks.set(key, item);
					} catch {
						// A missing edit model is handled by the local fallback when requested directly.
					}
				}
				if (keyedBlocks.size === 0) continue;
				totalMessages += 1;
				const missing = [...keyedBlocks].filter(([key]) => !codeDescriptionCache.get(key) && !codeDescriptionOmissions.has(key)).map(([, item]) => item);
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
			await processConcurrently(queuedMessages, concurrency, async items => {
				if (performance.now() - sliceStart >= 8) {
					await new Promise<void>(resolve => setImmediate(resolve));
					sliceStart = performance.now();
				}
				if (epoch !== contextEpoch || workEpoch !== codeWorkEpoch || !isCurrentContext(ctx)) return;
				for (const item of items) {
					if (epoch !== contextEpoch || workEpoch !== codeWorkEpoch || !isCurrentContext(ctx)) return;
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
			});
		})()
			.catch(() => {
				// Reload/session replacement cancels captured-context preprocessing.
			})
			.finally(() => {
				codeDescriptionPreprocessing = undefined;
				codePreprocessingProgress = undefined;
				refreshPreprocessingProgress();
				if (epoch === contextEpoch && workEpoch !== codeWorkEpoch && isCurrentContext(ctx)) {
					scheduleMissingCodeDescriptions(ctx);
				}
			});
	};

	const scheduleCodeDescriptionsInText = (ctx: ExtensionContext, text: string): void => {
		const message = completedAssistantMessages(ctx, config.mode, config.codeDescriptionContext === "conversation").findLast(candidate => candidate.text === text);
		if (!message) return; // agent_settled retries after the session entry is committed
		for (const item of completedCodeItems(message)) {
			void requestCodeDescription(ctx, item.block, item.identityContext, item.providerMessagesThroughBlock);
		}
	};

	let renderedDescriptionKeys = new WeakMap<object, Map<string, string>>();
	const transformNarrationMarkdown = (markdown: string, messageType: NarrationMessageType): string =>
		narration.transform(
			markdown,
			messageType,
			text => (config.playbackHighlight ? (activeContext?.ui.theme.fg("dim", text) ?? text) : text),
			text => (config.playbackHighlight ? (activeContext?.ui.theme.bg("selectedBg", text) ?? text) : text),
			(block, messageThroughBlock) => {
				const ctx = activeContext;
				if (!ctx) return undefined;
				try {
					const contextual = config.codeDescriptionContext === "conversation";
					const matchesSource = (message: { text: string; messageType: NarrationMessageType; displayOffset?: number }) =>
						message.messageType === messageType && (messageType === "assistant-thinking"
							? markdown.slice(message.displayOffset ?? 0, (message.displayOffset ?? 0) + message.text.trim().length) === message.text.trim()
							: message.text.trim() === markdown.trim());
					const matchesEnd = (message: { text: string; displayOffset?: number }, end: number) =>
						(message.displayOffset ?? 0) + message.text.slice(0, end).trim().length === messageThroughBlock.trimEnd().length;
					const completed = contextual
						? completedAssistantMessages(ctx, config.mode, true).findLast(message => matchesSource(message) &&
							completedCodeItems(message).some(item => matchesEnd(message, item.sourceEnd)))
						: undefined;
					const source = completed?.assistantMessage;
					const memo = source && typeof source === "object" ? renderedDescriptionKeys.get(source) : undefined;
					const memoKey = JSON.stringify([contextEpoch, config.codeNarration, config.codeDescriptionContext, completed?.contentIndex, messageThroughBlock.length]);
					const remembered = memo?.get(memoKey);
					let key = remembered ? codeDescriptionCache.resolveKey(remembered) : undefined;
					if (!key) {
						const item = completed && completedCodeItems(completed).find(item => matchesEnd(completed, item.sourceEnd));
						const liveBlock = contextual && !item ? eligibleAssistantBlocks(speechAssistantMessage, config.mode).findLast(message =>
							matchesSource(message) && describableCodeItems(message.text).some(item => matchesEnd(message, item.sourceEnd))) : undefined;
						const liveItem = liveBlock && describableCodeItems(liveBlock.text).find(item => matchesEnd(liveBlock, item.sourceEnd));
						const providerMessages = item || !contextual ? [] : liveBlock && liveItem
							? assistantCodeContext(speechConversationMessages, speechAssistantMessage, liveBlock.contentIndex, liveItem.sourceEnd, liveSource?.final ?? true)
							: undefined;
						if (!providerMessages) return undefined;
						key = item ? descriptionCacheKey(ctx, item.block, item.identityContext)
							: descriptionCacheKey(ctx, block, structuredContextIdentity(providerMessages));
						if (source && typeof source === "object") {
							const keys = memo ?? new Map<string, string>();
							keys.set(memoKey, key);
							renderedDescriptionKeys.set(source, keys);
						}
					}
					const existing = codeDescriptionText.get(key);
					if (existing !== undefined) return existing;
					const omissionRecord = codeDescriptionOmissions.get(key);
					if (omissionRecord || codeDescriptionCache.get(key)?.omitted) {
						const omission = codeDescriptionOmissions.get(key);
						return `⚠ No semantic description available (${omissionRecord?.reason ?? "failed"}). Run /voice code-retry current or /voice code-retry historical.`;
					}
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
			config.enabled && (config.playbackHighlight || config.autoScroll),
			(code, language) => highlightCode(code, language),
			config.enabled ? NARRATION_ACTIVE_MARKER : "",
		);

	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "user" ? markdown : transformNarrationMarkdown(markdown, context.messageType),
	);

	const refreshPlaybackTimeline = refreshProgressWidget;

	/** Explicit actions anchor at 20%; continuation follows the 20–80% band until manual browsing. */
	let lastAutoScrollTop: number | undefined;
	let autoScrollForceOnce = false;
	let narrationManuallyFramed = false;
	let pinnedContentHeight = 0;
	let lastNarrationLayout = "";
	let restoreBottomAfterSpeech = false;
	let bottomPinned = false;
	let atTranscriptTail = false;
	let followHintVisible = false;
	const markdownLineCache = new Map<string, number>();
	let belowCacheKey = "";
	let belowCacheValue = 0;
	let narrationMessageAnchor:
		| {
				messageId: string;
				width: number;
				messageTop: number;
				contentHeight: number;
				viewportHeight: number;
				wordStart?: number;
				localMarkerLine?: number;
			}
		| undefined;

	const activeScrollView = (): {
		scrollTop: number;
		viewportHeight: number;
		contentHeight?: number;
		isFollowingEnd?: boolean | (() => boolean);
		getContentWidth?: (width: number) => number;
		render?: (width: number) => string[];
		/** Test/nonstandard views can opt out when their rendered document is synthetic. */
		piVoiceCacheNarrationLayout?: boolean;
		scrollTo(top: number, options?: { disableFollow?: boolean }): void;
		scrollToEnd?: () => void;
	} | undefined => {
		const tuiAny = narrationTui as
			| { primaryScrollView?: unknown; implicitScrollView?: unknown; getPrimaryScrollView?: () => unknown }
			| undefined
			| null;
		if (!tuiAny) return undefined;
		// Fullscreen Pi always owns an implicit fallback ScrollView, even when its
		// active layout exposes a different primary transcript viewport.
		return (tuiAny.getPrimaryScrollView?.() ?? tuiAny.primaryScrollView ?? tuiAny.implicitScrollView) as never;
	};

	const narrationViewportWidth = (): number => {
		const terminalWidth = (narrationTui as { terminal?: { columns?: number } } | null)?.terminal?.columns;
		return Number(terminalWidth ?? process.stdout?.columns ?? 100);
	};

	const renderedMessageLines = (text: string, width: number): number => {
		const key = `${width}:${text}`;
		const cached = markdownLineCache.get(key);
		if (cached !== undefined) return cached;
		let lines = Math.max(1, text.split("\n").length);
		try {
			const component = new Markdown(text, 1, 0, getMarkdownTheme());
			lines = Math.max(1, component.render(width).length);
		} catch {
			// Offline rendering is best-effort; the line estimate degrades gracefully.
		}
		if (markdownLineCache.size >= 400) {
			const oldest = markdownLineCache.keys().next().value;
			if (oldest !== undefined) markdownLineCache.delete(oldest);
		}
		markdownLineCache.set(key, lines);
		return lines;
	};

	const renderedNarrationMarkerLine = (text: string, width: number): number => {
		if (!text) return -1;
		try {
			const transformed = transformNarrationMarkdown(text, "assistant");
			const component = new Markdown(transformed, 1, 0, getMarkdownTheme());
			return component.render(width).findIndex(line => line.includes(NARRATION_ACTIVE_MARKER));
		} catch {
			return -1;
		}
	};

	const hideFollowHint = (): void => {
		if (!followHintVisible) return;
		followHintVisible = false;
		try {
			activeContext?.ui.setWidget("pi-voice-follow-hint", undefined);
		} catch {
			// The context may become stale during session replacement.
		}
	};

	const transcriptIsFollowingEnd = (): boolean => {
		const following = activeScrollView()?.isFollowingEnd;
		return typeof following === "function" ? following() : following === true;
	};

	const armNarrationFollow = (forceCanonicalAnchor = true, explicit = true): void => {
		if (!explicit) {
			if (lastAutoScrollTop !== undefined && activeScrollView()?.scrollTop !== lastAutoScrollTop && !transcriptIsFollowingEnd()) {
				narrationManuallyFramed = true;
				restoreBottomAfterSpeech = false;
			}
			if (narrationManuallyFramed) return;
		}
		narrationManuallyFramed = false;
		narrationMessageAnchor = undefined;
		atTranscriptTail = false;
		bottomPinned = false;
		lastAutoScrollTop = undefined;
		autoScrollForceOnce = forceCanonicalAnchor;
		hideFollowHint();
		requestNarrationRender();
	};

	const preserveNarrationViewport = (scrollTop: number | undefined): void => {
		if (scrollTop === undefined) return;
		const scrollView = activeScrollView();
		if (!scrollView) return;
		scrollView.scrollTo(scrollTop, { disableFollow: true });
		lastAutoScrollTop = scrollView.scrollTop;
	};

	const scrollToBottom = (ctx: ExtensionContext): void => {
		const scrollView = activeScrollView();
		if (!scrollView?.scrollToEnd) {
			ctx.ui.notify("Scroll-to-bottom is unavailable in this runtime", "warning");
			return;
		}
		scrollView.scrollToEnd();
		pinnedContentHeight = scrollView.contentHeight ?? 0;
		narrationManuallyFramed = false;
		atTranscriptTail = true;
		bottomPinned = ownsSpeech;
		restoreBottomAfterSpeech = ownsSpeech;
		lastAutoScrollTop = scrollView.scrollTop;
		autoScrollForceOnce = false;
		hideFollowHint();
	};

	const requestNarrationAutoScroll = (allowPaused = false, force = false): void => {
		const scrollView = activeScrollView();
		if (!scrollView || typeof scrollView.scrollTo !== "function") return;
		const layout = `${narrationViewportWidth()}:${scrollView.viewportHeight}:${scrollView.contentHeight}`;
		const layoutChanged = layout !== lastNarrationLayout;
		lastNarrationLayout = layout;
		if (layoutChanged) narrationMessageAnchor = undefined;
		if (bottomPinned && transcriptIsFollowingEnd()) {
			if (playbackPaused || (scrollView.contentHeight ?? 0) <= pinnedContentHeight) return;
			bottomPinned = false;
			atTranscriptTail = false;
			lastAutoScrollTop = scrollView.scrollTop;
		} else if (lastAutoScrollTop !== undefined && !autoScrollForceOnce &&
			(!layoutChanged || (!transcriptIsFollowingEnd() && scrollView.scrollTop !== Math.min(lastAutoScrollTop,
				Math.max(0, (scrollView.contentHeight ?? Infinity) - scrollView.viewportHeight)))) &&
			isManualScrollAway({ scrollTop: scrollView.scrollTop, viewportHeight: scrollView.viewportHeight,
				contentHeight: scrollView.contentHeight ?? 0 }, lastAutoScrollTop)) {
			narrationManuallyFramed = true;
			narrationMessageAnchor = undefined;
			restoreBottomAfterSpeech = false;
			bottomPinned = false;
		}
		if (layoutChanged) lastAutoScrollTop = scrollView.scrollTop;
		if (
			narrationManuallyFramed ||
			!config.enabled ||
			(!config.autoScroll && !force) ||
			(!ownsSpeech && !pendingReplay && !force) ||
			(playbackPaused && !allowPaused)
		) {
			hideFollowHint();
			return;
		}

		const resolvedContentHeight = scrollView.contentHeight ?? (scrollView.scrollTop + scrollView.viewportHeight);
		const scrollViewport = {
			scrollTop: scrollView.scrollTop,
			viewportHeight: scrollView.viewportHeight,
			contentHeight: resolvedContentHeight,
		};
		if (restoreBottomAfterSpeech && lastAutoScrollTop === undefined && !transcriptIsFollowingEnd()) {
			restoreBottomAfterSpeech = false;
		}
		const outerWidth = narrationViewportWidth();
		const innerWidth = Math.max(
			40,
			Math.min(outerWidth, scrollView.getContentWidth?.(outerWidth) ?? outerWidth - 2),
		);
		const selected = playbackHistory.selected();
		const isLive = liveTurnNarrationActive && ownedSpeechText.length > 0;
		const text = isLive ? ownedSpeechText : (selected?.text ?? "");
		const messageId = isLive ? "live" : selected?.id;
		const wordStart = narration.activeWordStart;
		const canCacheMessageTop = scrollView.piVoiceCacheNarrationLayout !== false;
		const cached =
			canCacheMessageTop &&
			messageId &&
			narrationMessageAnchor?.messageId === messageId &&
			narrationMessageAnchor.width === innerWidth &&
			narrationMessageAnchor.contentHeight === resolvedContentHeight &&
			narrationMessageAnchor.viewportHeight === scrollView.viewportHeight
				? narrationMessageAnchor
				: undefined;
		const localMarkerLine =
			cached && cached.wordStart === wordStart && cached.localMarkerLine !== undefined
				? cached.localMarkerLine
				: renderedNarrationMarkerLine(text, innerWidth);
		const cachedMessageTop = cached?.messageTop;
		if (cached && localMarkerLine >= 0 && cached.wordStart !== wordStart) {
			narrationMessageAnchor = { ...cached, wordStart, localMarkerLine };
		}
		let anchor = cachedMessageTop !== undefined && localMarkerLine >= 0
			? cachedMessageTop + localMarkerLine
			: undefined;

		// Establish the selected message's absolute top from one full transcript
		// render. Subsequent words render only that message until layout changes,
		// avoiding a second full long-context render on every playback tick.
		if (anchor === undefined && scrollView.render) {
			const lines = scrollView.render(outerWidth);
			const markedLine = lines.findIndex(line => line.includes(NARRATION_ACTIVE_MARKER));
			if (markedLine >= 0) {
				anchor = markedLine;
				if (canCacheMessageTop && messageId && localMarkerLine >= 0) {
					narrationMessageAnchor = {
						messageId,
						width: innerWidth,
						messageTop: markedLine - localMarkerLine,
						contentHeight: resolvedContentHeight,
						viewportHeight: scrollView.viewportHeight,
						wordStart,
						localMarkerLine,
					};
				}
			} else {
				// The playback event can precede the TUI's narration transform by one
				// render. Keep force-follow armed until the exact word marker exists.
				requestNarrationRender();
				return;
			}
		}

		// Compatibility fallback for older/nonstandard TUI scroll views that do
		// not expose their rendered document.
		if (anchor === undefined) {
			if (!text) return;
			const status = playbackHistory.status();
			const fraction = status && status.duration > 0
				? Math.min(1, Math.max(0, status.position / status.duration))
				: 0;
			const messageLines = renderedMessageLines(text, innerWidth);
			let below = 0;
			if (!isLive && selected && activeContext) {
				const ordered = completedAssistantMessages(activeContext, config.mode);
				const cacheId = `${innerWidth}:${selected.id}:${ordered.length}`;
				if (cacheId !== belowCacheKey) {
					belowCacheKey = cacheId;
					const idx = ordered.findIndex(message => message.id === selected.id);
					belowCacheValue = idx >= 0
						? ordered.slice(idx + 1).reduce(
							(total, message) => total + renderedMessageLines(message.text, innerWidth) + 2,
							0,
						)
						: 0;
				}
				below = belowCacheValue;
			}
			const messageTop = Math.max(0, resolvedContentHeight - below - messageLines);
			anchor = anchorLineForMessage(messageTop, messageLines, fraction);
		}

		const target = computeAutoScrollTop(scrollViewport, anchor, autoScrollForceOnce);
		if (target === null && !autoScrollForceOnce) {
			lastAutoScrollTop = scrollView.scrollTop;
			return;
		}

		hideFollowHint();
		const maxScrollTop = Math.max(0, resolvedContentHeight - scrollView.viewportHeight);
		const topBand = Math.floor(scrollView.viewportHeight * 0.2);
		const desired = Math.max(0, Math.min(maxScrollTop, target ?? anchor - topBand));
		autoScrollForceOnce = false;
		frameNarrationViewport(scrollView, desired, !playbackPaused);
		lastAutoScrollTop = scrollView.scrollTop;
	};

	const restoreFollowAfterSpeech = (): void => {
		hideFollowHint();
		autoScrollForceOnce = false;
		const manuallyMoved =
			lastAutoScrollTop !== undefined &&
			(activeScrollView()?.scrollTop ?? lastAutoScrollTop) !== lastAutoScrollTop;
		const restoreBottom = restoreBottomAfterSpeech && !manuallyMoved && !narrationManuallyFramed;
		restoreBottomAfterSpeech = false;
		bottomPinned = false;
		if (!restoreBottom) return;
		try {
			activeScrollView()?.scrollToEnd?.();
		} catch {
			// Follow restoration is cosmetic; ignore missing runtime support.
		}
	};

	const requestPlaybackTimeline = (): void => {
		if (playbackTimelineTimer) return;
		playbackTimelineTimer = setTimeout(() => {
			playbackTimelineTimer = null;
			refreshPlaybackTimeline();
			requestNarrationAutoScroll();
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
		inputPhase = "acquiring";
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

	const persistSegmentTiming = (segmentId: number): void => {
		const snapshot = playbackHistory.snapshotForSegment(segmentId);
		if (snapshot) pi.appendEntry(PLAYBACK_TIMING_ENTRY, snapshot);
	};
	const playbackUtterances = new Set<number>();
	let lastPlaybackTick: { utterance: number; position: number } | undefined;
	const handleWorkerEvent = (event: WorkerEvent): void => {
		// Cancellation acknowledgements still unblock retiring transports, not UI/history.
		if (event.type === "idle" && event.cancelId !== undefined) {
			transportCancelWaiters.get(event.cancelId)?.();
			transportCancelWaiters.delete(event.cancelId);
			return;
		}
		if (!interactiveVoiceSession || !activeContext) return;
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
				const narratedIdle = event.utterance !== undefined && playbackUtterances.delete(event.utterance);
				if (!inputInProgress) state = "idle";
				downloadPercent = undefined;
				playbackHistory.finishUtterance(event.utterance);
				playbackPositionEstimated = false;
				if (event.utterance !== undefined) {
					const snapshot = playbackHistory.snapshotForUtterance(event.utterance);
					if (snapshot) pi.appendEntry(PLAYBACK_TIMING_ENTRY, snapshot);
				}
				if (narratedIdle && !playbackPaused) {
					if (ownerTurnEnded && event.utterance !== undefined && event.utterance === lastOwnerUtterance) narration.finish();
					else narration.finishUtterance(event.utterance);
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
				narration.setSegmentAudio(event.segmentId, event.start, event.duration, event.timingQuality);
				playbackHistory.setSegmentAudio(event.segmentId, event.start, event.duration, event.timingQuality);
				playbackHistory.setWordTimings(event.segmentId, narration.sourceWordTimings(event.segmentId));
				persistSegmentTiming(event.segmentId);
				requestPlaybackTimeline();
				return;
			case "alignment":
				narration.setAlignment(event.segmentId, event.words, event.quality);
				playbackHistory.setTimingQuality(event.segmentId, narration.timingQuality(event.segmentId));
				playbackHistory.setWordTimings(event.segmentId, narration.sourceWordTimings(event.segmentId));
				persistSegmentTiming(event.segmentId);
				refreshProgressWidget();
				return;
			case "playback":
				if (!playbackUtterances.has(event.utterance) || event.utterance < (lastPlaybackTick?.utterance ?? 0) || pendingReplay?.waiting || playbackPaused) return;
				lastPlaybackTick = event;
				narration.setPlayback(event.utterance, event.position);
				playbackHistory.setPlayback(event.utterance, event.position);
				playbackPositionEstimated = event.estimated === true;
				requestPlaybackTimeline();
				return;
			case "alignment-error":
				// Overload/failure leaves duration-weighted estimates, not promised refinement.
				playbackHistory.setTimingQuality(event.segmentId, event.quality ?? "estimated");
				persistSegmentTiming(event.segmentId);
				refreshProgressWidget();
				return;
			case "transcribing":
			case "transcript":
				// The epoch-fenced talk() request owns input UI state, not unscoped worker events.
				return;
			case "error":
				if (event.preview) break;
				if (
					event.utterance !== undefined &&
					(event.utterance === lastOwnerUtterance ||
						event.utterance === pausedOwnerUtterance ||
						event.utterance === projectPrefixUtterance)
				) {
					attentionSuppressed = true;
					deviceRetryRequired = true;
					queuedPausedMessages.length = 0;
					coordinator?.setAttentionEnabled(false);
					const cancelId = clearPlaybackTransport();
					if (speechPurpose === "turn" && !ownerTurnEnded) {
						speechBlocked = true;
						blockedSpeechText = ownedSpeechText;
						blockedMessageHasSpeech = hasSpeakableAudio(ownedSpeechText);
					}
					ownerTurnEnded = true;
					if (ownsSpeech) releaseAfterTransportCancellation(cancelId, false);
				}
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
		async (block, sourceContext, signal) => {
			const ctx = activeContext;
			if (!ctx) return Promise.reject(new Error("No active Pi context for code description"));
			const providerMessages = [...await (typeof sourceContext.providerMessages === "function"
				? sourceContext.providerMessages(signal) : sourceContext.providerMessages ?? [])];
			if (signal.aborted) return { records: [], guided: false, omitted: true };
			return requestCodeDescription(ctx, block, structuredContextIdentity(providerMessages), providerMessages);
		},
		segment => {
			if (ownsSpeech) {
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
		undefined,
		utterance => {
			playbackUtterances.add(utterance);
			playbackHistory.bindUtterance(utterance);
			if (!ownsSpeech) return;
			lastOwnerUtterance = utterance;
			if (playbackPaused) pausedOwnerUtterance = utterance;
			ownerContentExpected = true;
		},
		utterance => playbackHistory.finishTimingGeneration(utterance),
	);
	const clearPlaybackTransport = (): number | undefined => {
		playbackUtterances.clear();
		lastPlaybackTick = undefined;
		playbackRequestEpoch += 1;
		coordinator?.cancelSpeechAcquisition();
		if (!ownsSpeech) coordinator?.releaseSpeech();
		pendingReplay = undefined;
		const cancelId = vocalizer.clear();
		if (cancelId !== undefined) void waitForTransportCancellation(cancelId);
		playbackPaused = false;
		pausedOwnerUtterance = undefined;
		lastOwnerUtterance = undefined;
		completedOwnerUtterance = undefined;
		ownerContentExpected = false;
		playbackPositionEstimated = false;
		return cancelId;
	};

	let transportStopPending = false;
	let transportStopBarrier = Promise.resolve();
	const transportStops = new Map<number, Promise<void>>();
	const waitForTransportCancellation = (cancelId: number | undefined): Promise<void> => {
		if (cancelId === undefined && !ownsSpeech) return transportStopBarrier;
		const existing = cancelId === undefined ? undefined : transportStops.get(cancelId);
		if (existing) return existing;
		transportStopPending = true;
		const previous = transportStopBarrier;
		const stopped = cancelId === undefined ? vocalizer.shutdown() : new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				transportCancelWaiters.delete(cancelId);
				void vocalizer.shutdown().then(resolve, reject);
			}, 1_000);
			timer.unref?.();
			transportCancelWaiters.set(cancelId, () => {
				clearTimeout(timer);
				resolve();
			});
		});
		// A fresh acknowledgement/termination can supersede a failed stop, not a pending one.
		transportStopBarrier = Promise.all([previous.catch(() => {}), stopped]).then(() => {});
		const barrier = transportStopBarrier;
		if (cancelId !== undefined) transportStops.set(cancelId, barrier);
		void barrier.then(() => {
			if (cancelId !== undefined) transportStops.delete(cancelId);
			if (transportStopBarrier === barrier) transportStopPending = false;
		}, error => activeContext?.ui.notify(`Voice stop failed; ownership retained: ${String(error)}`, "error"));
		return barrier;
	};

	const releaseAfterTransportCancellation = (cancelId: number | undefined, announceNext = false, inputCancelled = Promise.resolve()): void => {
		const leaseEpoch = speechLeaseEpoch;
		void Promise.all([waitForTransportCancellation(cancelId), inputCancelled]).then(() => {
			if (deviceRebind) return deviceRebind.then(() => {
				if (ownsSpeech && speechLeaseEpoch === leaseEpoch) releaseSpeechOwnership(announceNext);
			});
			if (ownsSpeech && speechLeaseEpoch === leaseEpoch) releaseSpeechOwnership(announceNext);
		}).catch(error => activeContext?.ui.notify(`Voice stop failed; ownership retained: ${error instanceof Error ? error.message : String(error)}`, "error"));
	};

	const phoneInput = new PhoneInputClient();
	let inputStopBarrier = Promise.resolve();
	let inputStopPending = false;
	let cancelPendingDictation: (() => void) | undefined;
	let finishPendingDictation: (() => Promise<void>) | undefined;
	const finishInputForPlayback = async (): Promise<void> => {
		if (inputPhase === "acquiring") {
			coordinator?.cancelSpeechAcquisition();
			await cancelActiveInput();
		} else {
			await finishPendingDictation?.();
		}
	};
	const cancelActiveInput = (): Promise<void> => {
		if (inputPhase === "acquiring" && !ownsSpeech) coordinator?.releaseSpeech();
		inputEpoch += 1;
		cancelPendingDictation?.();
		cancelPendingDictation = undefined;
		finishPendingDictation = undefined;
		inputStopPending = true;
		const cancelled = phoneInput.cancel();
		inputStopBarrier = cancelled;
		void cancelled.then(() => { if (inputStopBarrier === cancelled) inputStopPending = false; }, () => {});
		if (speechReservedForInput) {
			speechReservedForInput = false;
			if (lastOwnerUtterance === undefined) releaseAfterTransportCancellation(undefined, false, cancelled);
		}
		activeInputEndpoint = undefined;
		clearInputProgress();
		return cancelled;
	};
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

	const scheduleVoiceWorkerIdleStop = (): void => {
		if (voiceWorkerIdleTimer) clearTimeout(voiceWorkerIdleTimer);
		voiceWorkerIdleTimer = null;
		if (!ownsSpeech && !inputInProgress) {
			voiceWorkerIdleTimer = setTimeout(() => {
				voiceWorkerIdleTimer = null;
				if (!ownsSpeech && !inputInProgress) void vocalizer.shutdown().catch(() => {});
			}, 60_000);
			voiceWorkerIdleTimer.unref?.();
		}
	};

	const relinquishSpeech = (): void => {
		coordinator?.releaseSpeech();
		ownsSpeech = false;
		speechLeaseEpoch += 1;
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
		scheduleVoiceWorkerIdleStop();
	};

	const speakAttentionNotification = (waiting: WaitingSession): void => {
		if (!coordinator || attentionSuppressed || !config.enabled || waiting.instanceId === coordinator.instanceId) return;
		speechPurpose = "notification";
		ownerTurnEnded = true;
		pendingNotification = waiting;
		lastOwnerUtterance = undefined;
		projectPrefixUtterance = undefined;
		completedOwnerUtterance = undefined;
		ownerContentExpected = true;
		narration.finish();
		lastOwnerUtterance = vocalizer.speakUntracked(
			`Project ${coordinator.projectLabel(waiting.cwd, waiting.sessionId, waiting.sessionName)} requires attention next.`,
		);
	};

	releaseSpeechOwnership = (announceNext = true): void => {
		if (!ownsSpeech || !coordinator || deviceRebind || transportStopPending || inputStopPending) return;
		restoreFollowAfterSpeech();
		if (announceNext && config.enabled && !attentionSuppressed && !playbackPaused) {
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
		if (!ownsSpeech || !ownerTurnEnded || completingOwnerSpeech || playbackPaused || deviceRebind || transportStopPending || inputStopPending) return;
		if (expectedUtterance === undefined) projectAnnouncementPending = false;
		else if (completedOwnerUtterance !== expectedUtterance) return;
		completingOwnerSpeech = true;
		if (speechPurpose === "notification") {
			if (pendingNotification) coordinator?.markAnnounced(pendingNotification.instanceId);
			if (queuedPausedMessages.length === 0 && !queueIncomingWhilePaused) {
				relinquishSpeech();
				return;
			}
		}
		completingOwnerSpeech = false;
		const queued = queuedPausedMessages.shift();
		if (queued) {
			void playTarget(queued, !playbackHistory.hasCompleteTimingFor(queued.id), false, true);
			return;
		}
		if (!queueIncomingWhilePaused) releaseSpeechOwnership(true);
	};

	handleCoordinatedIdle = utterance => {
		if (!ownsSpeech || utterance === undefined) return;
		completedOwnerUtterance = utterance;
		completeOwnerSpeech();
	};

	const activateSpeechOwnership = (
		purpose: "turn" | "replay",
		announceProject: boolean,
		output = true,
	): boolean => {
		try { if (output) claimOutputDevice(); } catch (error) {
			attentionSuppressed = true;
			deviceRetryRequired = true;
			const cancelId = clearPlaybackTransport();
			if (ownsSpeech) releaseAfterTransportCancellation(cancelId, false);
			else coordinator?.releaseSpeech();
			activeContext?.ui.notify(`Voice device: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
		if (!coordinator) return true;
		if (voiceWorkerIdleTimer) clearTimeout(voiceWorkerIdleTimer);
		voiceWorkerIdleTimer = null;
		cancelTimingWorkers();
		const shouldAnnounce = announceProject && (!coordinator.attentionIsCurrent() || projectAnnouncementPending);
		ownsSpeech = true;
		speechLeaseEpoch += 1;
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

	const acquireSpeech = (purpose: "turn" | "replay", announceProject = true): boolean => {
		if (attentionSuppressed || deviceRetryRequired || !interactiveVoiceSession || deviceRebind || inputStopPending || transportStopPending) return false;
		if (!coordinator) return true;
		const alreadyOwned = ownsSpeech && coordinator.ownsSpeech();
		if (!alreadyOwned && !coordinator.tryAcquireSpeech()) return false;
		return activateSpeechOwnership(purpose, announceProject);
	};

	const forceAcquireSpeech = async (purpose: "turn" | "replay", announceProject = true, output = true): Promise<boolean> => {
		const owner = coordinator;
		const epoch = playbackRequestEpoch;
		const captureEpoch = inputEpoch;
		try {
			if (deviceRebind) await deviceRebind;
			if (transportStopPending) await transportStopBarrier;
		} catch { return false; }
		if (inputStopPending) {
			try { await inputStopBarrier; } catch { return false; }
		}
		if (captureEpoch !== inputEpoch || epoch !== playbackRequestEpoch) return false;
		if (!owner) return interactiveVoiceSession;
		const alreadyOwned = ownsSpeech && owner.ownsSpeech();
		if (!alreadyOwned && !(await owner.forceAcquireSpeech())) return false;
		if (owner !== coordinator || epoch !== playbackRequestEpoch || captureEpoch !== inputEpoch || !interactiveVoiceSession) return false;
		return activateSpeechOwnership(purpose, announceProject, output);
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

	const reserveSpeechForInput = async (dictation = false): Promise<boolean> => {
		if (!dictation && !config.enabled) return true;
		if (!coordinator) return true;
		const epoch = inputEpoch;
		const request = playbackRequestEpoch;
		const owner = coordinator;
		const lease = speechLeaseEpoch + 1;
		if (!(await forceAcquireSpeech("turn", false, false))) return false;
		if (epoch !== inputEpoch || request !== playbackRequestEpoch || owner !== coordinator || !interactiveVoiceSession) {
			if (owner === coordinator && ownsSpeech && speechLeaseEpoch === lease) releaseSpeechOwnership(false);
			return false;
		}
		speechReservedForInput = true;
		projectAnnouncementPending = !coordinator.attentionIsCurrent();
		return true;
	};

	finishSpeechPreemption = (): void => {
		const interrupted = pendingSpeechPreemption;
		if (!interrupted) return;
		pendingSpeechPreemption = undefined;
		relinquishSpeech();
		if (interrupted.purpose === "turn" || interrupted.purpose === "replay") {
			pausedForAttention = true;
			if (interrupted.purpose === "turn" && !interrupted.wasComplete) {
				speechBlocked = true;
				blockedSpeechText = interrupted.spokenText;
				blockedMessageHasSpeech = hasSpeakableAudio(interrupted.spokenText);
			} else {
				coordinator?.markWaiting();
			}
			refreshStatus();
		}
	};

	const handleSpeechPreemption = (): void => {
		if (pendingSpeechPreemption) return;
		const interrupted = {
			purpose: speechPurpose,
			wasComplete: ownerTurnEnded,
			spokenText: ownedSpeechText,
		};
		const hadActiveInput = inputInProgress;
		const inputCancellation = hadActiveInput ? cancelActiveInput() : inputStopBarrier;
		const cancelId = clearPlaybackTransport();
		const pending = { ...interrupted, ...(cancelId !== undefined ? { cancelId } : {}) };
		pendingSpeechPreemption = pending;
		narration.finish();
		// Release only after both the player and microphone have acknowledged stop.
		void Promise.all([inputCancellation, waitForTransportCancellation(cancelId)]).then(async () => {
			if (deviceRebind) await deviceRebind;
			if (pendingSpeechPreemption === pending) finishSpeechPreemption();
		}).catch(error => activeContext?.ui.notify(`Voice handoff stop failed; ownership retained: ${error instanceof Error ? error.message : String(error)}`, "error"));
	};

	const pollWaitingAttention = (): void => {
		if (!coordinator || deviceRebind || deviceRetryRequired || transportStopPending) return;
		if (ownsSpeech && coordinator.consumeSpeechPreemptionRequest()) {
			handleSpeechPreemption();
		}
		if (config.enabled && !attentionSuppressed && !playbackPaused && coordinator.hasAttentionRequest() && activeContext) {
			try {
				if (coordinator.consumeAttentionRequest()) {
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
		if ((!owner || (ownsSpeech && playbackPaused)) && activeContext && !timingPreprocessing) scheduleMissingTimings(activeContext, false);
		if (!config.enabled || attentionSuppressed || ownsSpeech) return;
		// Announcements never interrupt a transport or announce our own response.
		const waiting = coordinator.tryAcquireWaitingAnnouncement();
		if (!waiting) return;
		try { claimOutputDevice(); } catch (error) {
			coordinator.releaseSpeech();
			attentionSuppressed = true;
			deviceRetryRequired = true;
			activeContext?.ui.notify(`Voice device: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (voiceWorkerIdleTimer) clearTimeout(voiceWorkerIdleTimer);
		voiceWorkerIdleTimer = null;
		cancelTimingWorkers();
		ownsSpeech = true;
		completingOwnerSpeech = false;
		speakAttentionNotification(waiting);
	};

	let deviceRebind: Promise<void> | undefined;
	// Persist only session metadata. Reattachment alone never changes an existing pin.
	const adoptCurrentConnection = async (epoch: number, force = false): Promise<boolean> => {
		if (!force && (deviceSelection === "local" || config.output !== "auto")) {
			deviceRetryRequired = false;
			return true;
		}
		const ctx = activeContext;
		try {
			// Explicit reconnect retries stop proof; ordinary playback still waits on the failure.
			if (deviceRebind) await deviceRebind.catch(() => {});
			if (epoch !== playbackRequestEpoch || ctx !== activeContext) return false;
			const connection = await deviceRouter.resolveCurrentConnection();
			if (epoch !== playbackRequestEpoch || ctx !== activeContext || !interactiveVoiceSession) return false;
			const selection = connection.kind === "device" ? connection.id : "local";
			// Pin identity even if its registration is temporarily absent; operations validate their own direction.
			// A reconnect is metadata adoption, never a readiness claim.
			const identityChanged = selection !== (activeDeviceId ?? deviceSelection);
			let changed = identityChanged;
			try {
				const route = deviceRouter.routeMetadata(selection, "output", config.output);
				changed ||= route.endpoint !== outputEndpoint ||
					(route.kind === "device" ? route.device.connectedAt : undefined) !== outputGeneration;
			} catch (error) { if (!identityChanged) throw error; }
			if (deviceRebind || (changed && (ownsSpeech || inputInProgress))) {
				// Termination, not a TCP accept or a cancellation timeout, proves the old sink is gone.
				const stopping = Promise.all([vocalizer.shutdown(), cancelActiveInput()]).then(() => {});
				deviceRebind = stopping;
				await stopping;
				for (const resolve of transportCancelWaiters.values()) resolve();
				transportCancelWaiters.clear();
				await transportStopBarrier.catch(() => {});
				transportStopBarrier = Promise.resolve();
				transportStopPending = false;
				transportStops.clear();
				if (deviceRebind === stopping) deviceRebind = undefined;
				if (epoch !== playbackRequestEpoch || ctx !== activeContext) return false;
				pausedOwnerUtterance = undefined;
				lastOwnerUtterance = undefined;
			}
			if (force) deviceSelection = "auto";
			activeDeviceId = selection;
			deviceRouter.setEnvironmentDevice(connection.kind === "device" ? connection.id : undefined);
			pi.appendEntry(DEVICE_SELECTION_ENTRY, { version: 1, selection: deviceSelection, pin: selection });
			if (!force && selection !== "local") await deviceRouter.route(selection, "output", config.output);
			if (epoch !== playbackRequestEpoch || ctx !== activeContext) return false;
			deviceRetryRequired = false;
			return true;
		} catch (error) {
			if (epoch !== playbackRequestEpoch || ctx !== activeContext) return false;
			deviceRetryRequired = true;
			ctx?.ui.notify(`Voice device: ${error instanceof Error ? error.message : String(error)}${deviceRebind ? " Stop unconfirmed; ownership retained." : " Explicitly reconnect/retry."}`, "error");
			return false;
		}
	};

	const previewPlaybackTarget = (target: PlaybackTarget, explicit = true): void => {
		playbackUtterances.clear();
		lastPlaybackTick = undefined;
		narration.setCompletedText(target.text, target.messageType, target.contentIndex, target.displayOffset);
		narration.previewSourceOffset(target.sourceOffset);
		// Cached descriptions already have a source map; no audio or provider work is needed.
		const stream = new SpeakableStream();
		const item = [...stream.push(target.text), ...stream.flush()]
			.find(item => item.kind === "code" && item.source.start === target.sourceOffset);
		if (item?.kind === "code" && activeContext) {
			const contextual = config.codeDescriptionContext === "conversation"
				? completedAssistantMessages(activeContext, config.mode, true).find(message => message.id === target.id) : undefined;
			const messages = contextual ? assistantCodeContext(
				contextual.conversationMessages, contextual.assistantMessage, contextual.contentIndex, item.source.end)! : [];
			const plan = codeDescriptionCache.get(descriptionCacheKey(activeContext, item.block, structuredContextIdentity(messages)));
			const chunks = plan && !plan.omitted ? chunkCodeNarration(plan) : [];
			const skip = Math.min(target.skipUnits ?? 0, Math.max(0, chunks.length - 1));
			const chunk = chunks[skip];
			if (chunk) {
				const inherited = chunks.slice(0, skip).flatMap(chunk => chunk.cues.flatMap(cue => cue.operations));
				narration.registerSegment({ id: -1, utterance: -1, text: chunk.text,
					source: { start: item.source.start, end: item.source.start }, revealAtEnd: true,
					code: plan?.guided ? { blockSource: item.source, code: item.block.code, language: item.block.language,
						cues: [{ offset: 0, operations: inherited }, ...chunk.cues] } : undefined,
					codeDescription: { blockSource: item.source, text: chunks.map(chunk => chunk.text).join(" "),
						offset: chunks.slice(0, skip).reduce((offset, chunk) => offset + chunk.text.length + 1, 0) },
				});
				narration.setSegmentAudio(-1, 0, 1);
				narration.setPlayback(-1, 0, true);
			}
		}
		armNarrationFollow(true, explicit);
		flushNarrationRender();
		requestNarrationAutoScroll(true, explicit);
	};

	const playTarget = async (
		target: PlaybackTarget,
		recordTimings: boolean,
		previewTarget = false,
		queued = false,
		framed = false,
		restoreTail = false,
	): Promise<void> => {
		if (!interactiveVoiceSession) return;
		if (!queued) restoreBottomAfterSpeech = restoreTail;
		const sourceOffset = Math.max(0, Math.min(target.text.length, target.sourceOffset));
		const suffix = target.text.slice(sourceOffset);
		const liveTargetIndex = [...liveBlockIds].find(([, id]) => id === target.id)?.[0];
		const continueLiveTurn = queued && queueIncomingWhilePaused && (livePlaybackId === target.id || liveTargetIndex !== undefined);
		if (!suffix.trim() && !continueLiveTurn) return;
		if (pendingSpeechPreemption) {
			activeContext?.ui.notify("Voice device handoff is still stopping the previous transport", "warning");
			return;
		}

		if (!queued) queuedPausedMessages.length = 0;
		attentionSuppressed = false;
		coordinator?.setAttentionEnabled(config.enabled);
		coordinator?.cancelSpeechAcquisition();
		const owner = coordinator;
		const request = {
			epoch: ++playbackRequestEpoch,
			target: { ...target, sourceOffset },
			recordTimings,
			previewTarget,
			paused: playbackPaused,
			waiting: true,
		};
		pendingReplay = request;
		// Keep the requested target usable by F6–F10 and F8 while another process
		// acknowledges shutdown. Do not destroy the current sink before ownership.
		playbackHistory.beginCapture(target.id, target.text, target.time, false, sourceOffset, target.skipUnits ?? 0);
		playbackPaused = request.paused;
		narration.setPaused(playbackPaused);
		pausedOwnerUtterance = undefined;
		if (!framed) previewPlaybackTarget({ ...target, sourceOffset }, !queued);
		refreshPlaybackTimeline();

		const displacedLiveTurn = ownsSpeech && speechPurpose === "turn" && !ownerTurnEnded;
		const displacedLiveText = displacedLiveTurn ? ownedSpeechText : "";
		if (inputInProgress) {
			await finishInputForPlayback();
			if (pendingReplay !== request || request.epoch !== playbackRequestEpoch) return;
		}

		if (inputStopPending) {
			try { await inputStopBarrier; } catch {
				activeContext?.ui.notify("Microphone stop is unconfirmed; playback ownership retained", "error");
				return;
			}
		}
		try {
			if (deviceRebind) await deviceRebind;
			if (transportStopPending) await transportStopBarrier;
		} catch { return; }
		if (!queued && !request.paused && !await adoptCurrentConnection(request.epoch)) {
			if (pendingReplay === request) {
				pendingReplay = undefined;
				vocalizer.setPlaybackPaused(true);
				playbackPaused = true;
				narration.setPaused(playbackPaused);
			}
			return;
		}
		if (pendingReplay !== request || request.epoch !== playbackRequestEpoch) return;
		let acquired = true;
		let newlyAcquired = false;
		if (coordinator && !(ownsSpeech && coordinator.ownsSpeech())) {
			if (coordinator.tryAcquireSpeech()) newlyAcquired = true;
			else {
				acquired = await coordinator.forceAcquireSpeech();
				newlyAcquired = acquired;
			}
		}
		if (pendingReplay !== request || request.epoch !== playbackRequestEpoch || owner !== coordinator || !interactiveVoiceSession) {
			// A newer playback request can reuse this lease. A non-playback action
			// that superseded the wait has no use for it and must release it.
			if (newlyAcquired && owner !== coordinator) owner?.releaseSpeech();
			else if (newlyAcquired && !pendingReplay && !ownsSpeech) owner?.releaseSpeech();
			return;
		}
		if (!acquired) {
			request.waiting = false;
			request.paused = true;
			playbackPaused = true;
			narration.setPaused(playbackPaused);
			vocalizer.setPlaybackPaused(true);
			pausedForAttention = true;
			refreshStatus();
			activeContext?.ui.notify("Another Pi project currently owns voice playback; this replay remains paused", "warning");
			return;
		}

		if (!activateSpeechOwnership(continueLiveTurn ? "turn" : "replay", true)) {
			pendingReplay = undefined;
			return;
		}
		pendingReplay = undefined;
		liveTurnNarrationActive = continueLiveTurn;
		if (continueLiveTurn) {
			queueIncomingWhilePaused = false;
			// Capture can be ahead of the audible block when a setting dirties the turn.
			livePlaybackId = target.id;
			liveBlockIndex = liveTargetIndex;
			ownedSpeechText = target.text;
		}
		if (displacedLiveTurn && !continueLiveTurn) {
			// Keep the streaming response independent from this completed snapshot.
			// Later deltas are collected for attention instead of joining replay audio.
			speechBlocked = true;
			blockedSpeechText = displacedLiveText;
			blockedMessageHasSpeech = hasSpeakableAudio(displacedLiveText);
		}
		codeWorkEpoch += 1;
		if (activeContext) scheduleMissingCodeDescriptions(activeContext);
		cancelTimingWorkers();
		clearPlaybackTransport();
		// Timeline movement replaces the sink without changing transport state.
		// Sticky worker pause applies even before the replacement sink exists.
		vocalizer.setPlaybackPaused(request.paused);
		playbackHistory.beginCapture(target.id, target.text, target.time, recordTimings, sourceOffset, target.skipUnits ?? 0);
		const contextual = activeContext
			? completedAssistantMessages(activeContext, config.mode, config.codeDescriptionContext === "conversation").find(message => message.id === target.id)
			: undefined;
		if (!continueLiveTurn) {
			speechConversationMessages = contextual?.conversationMessages ?? [];
			speechAssistantMessage = contextual?.assistantMessage;
		}
		speechContentIndex = contextual?.contentIndex ?? target.contentIndex ?? speechContentIndex;
		setDescriptionSource(speechContentIndex, sourceOffset);
		playbackPaused = request.paused;
		narration.setPaused(playbackPaused);
		pausedOwnerUtterance = undefined;
		playbackPositionEstimated = false;
		refreshPlaybackTimeline();
		ownerContentExpected = hasSpeakableAudio(suffix);
		if (ownerContentExpected) announceProjectForSpeech();
		if (continueLiveTurn) {
			vocalizer.setNarrationSourceOffset(sourceOffset, target.skipUnits ?? 0);
			vocalizer.pushDelta(suffix);
			// Later content blocks can arrive while a dirty/paused live target is
			// retained. Catch up from the source snapshot before accepting deltas.
			for (const block of eligibleAssistantBlocks(liveSource?.assistant, config.mode)) {
				if (block.contentIndex > (liveBlockIndex ?? -1)) pushLiveDelta(block.messageType, block.contentIndex, block.text);
			}
		} else vocalizer.speakFrom(suffix, sourceOffset, target.skipUnits ?? 0);
		ownerTurnEnded = !continueLiveTurn;
		completeOwnerSpeech();
	};

	const renderKeyFor = (ctx: ExtensionContext, message: ContextualPlaybackMessage): string => {
		const codeDependencies: string[] = [];
		for (const item of completedCodeItems(message)) {
			const identity = item.identityContext;
			try {
				const key = descriptionCacheKey(ctx, item.block, identity);
				const omittedPlan = codeDescriptionCache.get(key);
				codeDependencies.push(JSON.stringify([key, omittedPlan ?? (codeDescriptionOmissions.has(key) ? "omitted" : "missing")]));
			} catch {
				codeDependencies.push(`fallback:${item.block.language}`);
			}
		}
		return narrationRenderKey(message.text, config, codeDependencies);
	};

	const playbackMessages = (ctx: ExtensionContext): PlaybackMessage[] =>
		completedAssistantMessages(ctx, config.mode, config.codeDescriptionContext === "conversation").map(message => ({
			id: message.id,
			text: message.text,
			messageType: message.messageType,
			contentIndex: message.contentIndex,
			displayOffset: message.displayOffset,
			renderKey: renderKeyFor(ctx, message),
		}));

	// ponytail: yield between historical messages; a single large context/hash is still synchronous.
	const preparePlaybackMessages = async (ctx: ExtensionContext, request = playbackRequestEpoch): Promise<boolean> => {
		const epoch = contextEpoch;
		let sliceStart = performance.now();
		for (const message of completedAssistantMessages(ctx, config.mode, config.codeDescriptionContext === "conversation")) {
			if (performance.now() - sliceStart >= 8) {
				await new Promise<void>(resolve => setImmediate(resolve));
				sliceStart = performance.now();
			}
			if (epoch !== contextEpoch || request !== playbackRequestEpoch || !isCurrentContext(ctx)) return false;
			renderKeyFor(ctx, message);
		}
		return epoch === contextEpoch && request === playbackRequestEpoch && isCurrentContext(ctx);
	};

	const pendingCanonicalizations = new Set<(messages: PlaybackMessage[]) => boolean>();
	const syncPlaybackMessages = (ctx: ExtensionContext, selectLatest = false): PlaybackMessage[] => {
		const messages = playbackMessages(ctx);
		for (const canonicalize of pendingCanonicalizations) {
			if (canonicalize(messages)) pendingCanonicalizations.delete(canonicalize);
		}
		// Never let sync replace a selected live id before its session entry exists.
		const selected = playbackHistory.selected(true);
		if (pendingCanonicalizations.size > 0 || (!ownerTurnEnded && livePlaybackId !== undefined && selected?.id.startsWith("live:") && !messages.some(message => message.id === selected.id))) return messages;
		const updated = messages.find(message => message.id === selected?.id);
		if (selected && updated && (selected.text !== updated.text || selected.renderKey !== updated.renderKey)) pauseDirtyPlayback();
		playbackHistory.sync(messages, selectLatest);
		return messages;
	};

	const finalizePlaybackMessages = (
		ctx: ExtensionContext,
		targets: Array<{ id: string; text: string; contentIndex: number }>,
		assistant: unknown,
		existingEntries: Set<string>,
	): void => {
		if (targets.length === 0) return;
		for (const target of targets) playbackHistory.updateText(target.id, target.text);
		const epoch = contextEpoch;
		const canonicalize = (messages: PlaybackMessage[]): boolean => {
			if (epoch !== contextEpoch || !isCurrentContext(ctx)) return true;
			const entry = ctx.sessionManager.getBranch().find(entry => entry.type === "message" &&
				!existingEntries.has(entry.id) && (entry.message === assistant || JSON.stringify(entry.message) === JSON.stringify(assistant)));
			if (!entry) return false;
			for (const target of targets) {
				const completed = messages.find(message => message.id === (target.contentIndex === 0 ? entry.id : `${entry.id}:${target.contentIndex}`));
				if (!completed) continue;
				playbackHistory.rename(target.id, completed);
				const queued = queuedPausedMessages.find(message => message.id === target.id);
				if (queued) Object.assign(queued, completed);
			}
			return true;
		};
		pendingCanonicalizations.add(canonicalize);
		const retry = (attempt = 0): void => {
			if (epoch !== contextEpoch || !isCurrentContext(ctx)) {
				pendingCanonicalizations.delete(canonicalize);
				return;
			}
			if (!pendingCanonicalizations.has(canonicalize)) return;
			syncPlaybackMessages(ctx);
			if (!pendingCanonicalizations.has(canonicalize) || attempt >= 5) return;
			const timer = setTimeout(() => {
				try { retry(attempt + 1); } catch { /* Session replacement invalidates retries. */ }
			}, [0, 20, 100, 250, 500][attempt]);
			timer.unref?.();
		};
		retry();
	};

	let timingPreprocessing: Promise<void> | undefined;
	let lastTimingScan = "";
	scheduleMissingTimings = (ctx: ExtensionContext, force = true): void => {
		if (timingPreprocessing || config.timingPreprocessConcurrency === 0) return;
		const canRecover = (): boolean => {
			const owner = coordinator?.speechOwner();
			return !owner || (owner.instanceId === coordinator?.instanceId && playbackPaused);
		};
		if (!canRecover()) return;
		const scan = JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId(), timingWorkEpoch, playbackPaused]);
		if (!force && scan === lastTimingScan) return;
		lastTimingScan = scan;
		const epoch = contextEpoch;
		const workEpoch = timingWorkEpoch;
		timingPreprocessing = (async () => {
			if (!await preparePlaybackMessages(ctx)) return;
			if (epoch !== contextEpoch || workEpoch !== timingWorkEpoch || !isCurrentContext(ctx) || !canRecover()) return;
			const scoped = scopedCompletedMessages(ctx, config.mode);
			const contextualById = new Map(scoped.map(message => [message.id, message]));
			const scopedIds = new Set(scoped.map(message => message.id));
			const messages = syncPlaybackMessages(ctx);
			const ordered = prioritizeFromCurrent(messages, playbackHistory.status()?.messageId).filter(message =>
				scopedIds.has(message.id),
			);
			const missing = ordered.filter(message => !playbackHistory.hasCompleteTimingFor(message.id));
			if (missing.length === 0) return;
			let processedMessages = messages.length - missing.length;
			timingPreprocessingProgress = {
				label: "Speech timing",
				processed: processedMessages,
				total: messages.length,
			};
			refreshPreprocessingProgress();
			const concurrency = resolveTimingConcurrency(config.timingPreprocessConcurrency, config.ttsDtype);
			const workers = ensureTimingWorkers(concurrency);
			const measurementConfig = config;
			let sliceStart = performance.now();
			await processConcurrently(missing, concurrency, async (message, lane) => {
				const processMessage = async (): Promise<void> => {
					if (performance.now() - sliceStart >= 8) {
						await new Promise<void>(resolve => setImmediate(resolve));
						sliceStart = performance.now();
					}
					if (epoch !== contextEpoch || workEpoch !== timingWorkEpoch || !isCurrentContext(ctx)) return;
					const contextual = contextualById.get(message.id);
					if (!contextual) return;
					let checkpoints: PlaybackTimingSnapshot["checkpoints"] = [];
					const timingNarration = new NarrationProgress();
					timingNarration.setCompletedText(message.text);
					let timingSegmentId = 0;
					let lastWordTime = Number.NEGATIVE_INFINITY;
					let time = 0;
					let measuredRenderKey: string;
					try {
						const prepared = await timingItemsFor(ctx, contextual);
						if (epoch !== contextEpoch || workEpoch !== timingWorkEpoch || !isCurrentContext(ctx)) return;
						measuredRenderKey = narrationRenderKey(message.text, measurementConfig, prepared.codeDependencies);
						if (renderKeyFor(ctx, contextual) !== measuredRenderKey) return;
						let previousSource = -1;
						let skipUnits = 0;
						for (const item of prepared.items) {
							if (!canRecover()) return;
							skipUnits = item.source.start === previousSource ? skipUnits + 1 : 0;
							previousSource = item.source.start;
							const unit = { sourceOffset: item.source.start, skipUnits };
							const cached = playbackHistory.timingForUnit(message.id, measuredRenderKey, unit);
							if (cached) {
								checkpoints.push(...cached.map(point => ({ ...point, time: time + point.time })));
								time += cached[0].duration;
								continue;
							}
							const duration = await workers[lane].measureSegment(item.text, measurementConfig);
							if (epoch !== contextEpoch || workEpoch !== timingWorkEpoch || !isCurrentContext(ctx) || !canRecover()) return;
							// One failed unit leaves the whole target incomplete; never persist a prefix as complete.
							if (!Number.isFinite(duration) || duration <= 0) return;
							const unitStart = checkpoints.length;
							checkpoints.push({ time, duration, sourceOffset: item.source.start, quality: "estimated" });
							if (item.wordTimings) {
								const segmentId = ++timingSegmentId;
								timingNarration.registerSegment({
									id: segmentId,
									utterance: 1,
									text: item.text,
									source: item.source,
								});
								timingNarration.setSegmentAudio(segmentId, 0, duration);
								for (const word of timingNarration.sourceWordTimings(segmentId)) {
									const wordTime = time + word.time;
									if (word.sourceOffset === item.source.start || wordTime - lastWordTime < 0.4) continue;
									checkpoints.push({ time: wordTime, duration: 0, sourceOffset: word.sourceOffset, quality: word.quality });
									lastWordTime = wordTime;
								}
							}
							if (renderKeyFor(ctx, contextual) !== measuredRenderKey) return;
							playbackHistory.retainTimingUnit(message.id, measuredRenderKey, unit,
								checkpoints.slice(unitStart).map(point => ({ ...point, time: point.time - time })));
							time += duration;
						}
					} catch {
						// Live speech and microphone actions preempt low-priority timing work.
						return;
					}
					if (checkpoints.length === 0 || epoch !== contextEpoch || workEpoch !== timingWorkEpoch || !isCurrentContext(ctx)) return;
					checkpoints.sort((left, right) => left.time - right.time);
					// Preserve all sentence starts; dropping them shifts code-description unit ordinals.
					try {
						if (renderKeyFor(ctx, contextual) !== measuredRenderKey) return;
						syncPlaybackMessages(ctx);
						const snapshot: PlaybackTimingSnapshot = {
							version: 3,
							messageId: message.id,
							renderKey: measuredRenderKey,
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
			});
		})()
			.catch(() => {
				// Reload/session replacement cancels captured-context preprocessing.
			})
			.finally(() => {
				timingPreprocessing = undefined;
				timingPreprocessingProgress = undefined;
				const completedWorkers = timingWorkers.splice(0);
				void Promise.all(completedWorkers.map(worker => worker.terminate())).catch(() => {});
				refreshPreprocessingProgress();
				if (timingRescheduleRequested && epoch === contextEpoch && isCurrentContext(ctx)) {
					timingRescheduleRequested = false;
					scheduleMissingTimings(ctx);
				}
			});
	};

	const warmModels = async (): Promise<void> => {
		await vocalizer.warm();
	};

	// Dirty current assets keep their lease and frozen target, but cannot resume
	// their obsolete sink. Explicit resume rebuilds with the current dependencies.
	const pauseDirtyPlayback = (): void => {
		playbackHistory.invalidateCaptures();
		if ((!ownsSpeech || speechReservedForInput) && !pendingReplay) return;
		if (speechPurpose === "turn" && !ownerTurnEnded) {
			queueIncomingWhilePaused = true;
			if (livePlaybackId) playbackHistory.updateText(livePlaybackId, ownedSpeechText);
		}
		clearPlaybackTransport();
		vocalizer.setPlaybackPaused(true);
		playbackPaused = true;
		narration.setPaused(playbackPaused);
		state = "idle";
		hideFollowHint();
		autoScrollForceOnce = false;
		refreshStatus();
		refreshPlaybackTimeline();
	};

	const updateConfig = async (next: VoiceConfig): Promise<void> => {
		const previous = config;
		const wasEnabled = config.enabled;
		const currentText = playbackHistory.selected()?.text ?? ownedSpeechText;
		const currentAssetConfig = /```|~~~/.test(currentText) ? next : { ...next, codeNarration: previous.codeNarration };
		if (narrationRenderKey(currentText, previous, []) !== narrationRenderKey(currentText, currentAssetConfig, []) ||
			(previous.mode !== next.mode && (previous.mode === "all" || next.mode === "all"))) {
			pauseDirtyPlayback();
		}
		await saveVoiceConfig(next);
		config = next;
		const renderDependenciesChanged =
			previous.ttsModel !== config.ttsModel ||
			previous.ttsDtype !== config.ttsDtype ||
			previous.voice !== config.voice ||
			previous.speed !== config.speed ||
			previous.codeNarration !== config.codeNarration ||
			previous.audioCache !== config.audioCache ||
			previous.audioCacheBitrate !== config.audioCacheBitrate;
		if (renderDependenciesChanged) {
			timingRescheduleRequested = true;
			cancelTimingWorkers();
		}
		if (wasEnabled && !config.enabled) {
			disabledAttentionPending = queuedPausedMessages.length > 0 || pausedForAttention || (coordinator?.isWaiting() ?? false);
			queueIncomingWhilePaused = false;
			queuedPausedMessages.length = 0;
			coordinator?.setAttentionEnabled(false);
			const cancelId = clearPlaybackTransport();
			narration.finish();
			if (!inputInProgress) releaseAfterTransportCancellation(cancelId);
		}
		if (!wasEnabled && config.enabled && !attentionSuppressed) {
			coordinator?.setAttentionEnabled(true);
			if (disabledAttentionPending) coordinator?.markWaiting();
			disabledAttentionPending = false;
		}
		refreshStatus();
		refreshPlaybackTimeline();
		if (activeContext) {
			if (!await preparePlaybackMessages(activeContext)) return;
			// A live capture is not in the completed transcript yet. Do not let a
			// settings sweep replace its selected/paused target with older history.
			if (!livePlaybackId) syncPlaybackMessages(activeContext);
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
		restoreBottomAfterSpeech = false;
		bottomPinned = false;
		const talkEpoch = contextEpoch;
		const requestedInputEpoch = inputEpoch;
		if (inputPhase === "recording" && activeInputEndpoint) {
			setInputProgress("🎙 Stopping voice recording…");
			try { await phoneInput.stop(activeInputEndpoint); }
			catch (error) { ctx.ui.notify(`Voice microphone: ${String(error)}`, "error"); }
			return;
		}
		if (deviceRebind) {
			try { await deviceRebind; } catch { return; }
			if (talkEpoch !== contextEpoch || requestedInputEpoch !== inputEpoch) return;
		}
		if (inputPhase === "acquiring") {
			coordinator?.cancelSpeechAcquisition();
			void cancelActiveInput();
			return;
		}
		const captureEpoch = inputPhase === "idle" ? ++inputEpoch : inputEpoch;
		if (inputPhase === "idle") beginInputProgress();
		let routed: VoiceConfig;
		try {
			const route = await deviceRouter.route(activeDeviceId ?? deviceSelection, "input", config.input);
			if (talkEpoch !== contextEpoch || captureEpoch !== inputEpoch) return;
			routed = { ...config, input: route.endpoint };
		} catch (error) {
			if (captureEpoch !== inputEpoch) return;
			clearInputProgress();
			ctx.ui.notify(`Voice microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (routed.input === "disabled") {
			clearInputProgress();
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
		cancelTimingWorkers();
		const playbackCancelId = clearPlaybackTransport();
		narration.finish();
		const leaseEpoch = speechLeaseEpoch;
		try { await waitForTransportCancellation(playbackCancelId); }
		catch { clearInputProgress(); return; }
		if (captureEpoch !== inputEpoch || talkEpoch !== contextEpoch) {
			if (talkEpoch === contextEpoch && leaseEpoch === speechLeaseEpoch) releaseSpeechOwnership(false);
			return;
		}
		releaseSpeechOwnership(false);
		const reserved = await reserveSpeechForInput(true);
		if (captureEpoch !== inputEpoch || talkEpoch !== contextEpoch) return;
		if (!reserved) {
			clearInputProgress();
			ctx.ui.notify("Another Pi session still owns the selected voice device", "warning");
			return;
		}
		activeInputEndpoint = routed.input;
		inputPhase = "recording";
		state = "listening";
		refreshStatus();
		const editorBase = ctx.ui.getEditorText();
		let lastPreview = editorBase;
		let manuallyEdited = false;
		const current = (): boolean => talkEpoch === contextEpoch && captureEpoch === inputEpoch && !!activeContext;
		const writeEditor = (text: string): boolean => {
			if (!current()) return false;
			manuallyEdited ||= ctx.ui.getEditorText() !== lastPreview;
			if (manuallyEdited) return false;
			if (text !== lastPreview) ctx.ui.setEditorText(text);
			lastPreview = text;
			return true;
		};
		const committed: string[][] = [];
		let partial: string[] = [];
		const renderPreview = (): void => {
			const evidence = [...committed, ...(partial.length ? [partial] : [])].map(formatAsrDisplay).join("\n\n");
			writeEditor(appendDictation(editorBase, evidence));
		};
		const live = new LiveTranscriptionSession(audio => vocalizer.transcribePcmCandidates(audio), {
			onPartialCandidates: candidates => {
				partial = candidates;
				renderPreview();
			},
			onSegmentCandidates: candidates => {
				committed.push(candidates);
				partial = [];
				renderPreview();
			},
		});
		const resolution = new AbortController();
		const cancel = (): void => {
			try {
				if (talkEpoch === contextEpoch && !manuallyEdited && ctx.ui.getEditorText() === lastPreview) {
					ctx.ui.setEditorText(editorBase);
				}
			} catch { /* UI may already be unmounted during session replacement. */ }
			live.cancel();
			resolution.abort();
			finished.resolve();
		};
		cancelPendingDictation = cancel;
		let reviewOnly = false;
		const finished = Promise.withResolvers<void>();
		const finishForPlayback = async (): Promise<void> => {
			reviewOnly = true;
			if (inputPhase === "recording") await phoneInput.stop(activeInputEndpoint ?? routed.input);
			await finished.promise;
		};
		finishPendingDictation = finishForPlayback;
		try {
			const capture = await phoneInput.capture(routed.input, {
				onProgress: progress => {
					if (talkEpoch !== contextEpoch || captureEpoch !== inputEpoch) return;
					const elapsed = progress.elapsedSeconds.toFixed(1);
					setInputProgress(
						progress.speechDetected
							? `🎙 Live dictation: ${elapsed}s — stops after silence; Alt+M to finish`
							: `🎙 Waiting for speech: ${elapsed}s — Alt+M to finish`,
					);
				},
				onAudio: audio => {
					if (talkEpoch !== contextEpoch || captureEpoch !== inputEpoch) return;
					live.push(audio);
				},
			});
			if (talkEpoch !== contextEpoch || captureEpoch !== inputEpoch || !activeContext) {
				live.cancel();
				return;
			}
			activeInputEndpoint = undefined;
			inputPhase = "transcribing";
			if (inputProgressTimer) clearInterval(inputProgressTimer);
			inputProgressTimer = null;
			setInputProgress("♬ Finalizing transcript…");
			let liveTranscript = "";
			try {
				liveTranscript = (await live.finish()).trim();
			} catch {
				// The final whole-utterance pass below remains available as a fallback.
			}
			if (!current()) return;
			let candidates =
				capture.type === "audio" ? await vocalizer.transcribe(capture.data) : [capture.data.trim()];
			candidates = [...new Set(candidates.map(candidate => candidate.replace(/\s+/g, " ").trim()).filter(Boolean))];
			if (candidates.length === 0 && liveTranscript) candidates = [liveTranscript];
			if (talkEpoch !== contextEpoch || captureEpoch !== inputEpoch || !activeContext) return;
			if (candidates.length === 0) {
				releaseSpeechOwnership(false);
				writeEditor(editorBase);
				ctx.ui.notify("No speech recognized", "warning");
				return;
			}
			if (!writeEditor(appendDictation(editorBase, formatAsrDisplay(candidates)))) {
				releaseSpeechOwnership(false);
				ctx.ui.notify("Dictation left your manual edits untouched; review the draft before submitting", "info");
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
					prompt = await applySpokenEdit(ctx, editorBase, candidates, config.editModel, resolution.signal);
				} else {
					const resolved = await resolveDictationCandidates(ctx, editorBase, candidates, config.editModel, resolution.signal);
					prompt = appendDictation(editorBase, resolved);
				}
			} catch (error) {
				if (!current()) return;
				ctx.ui.notify(
					`Voice dictation resolution failed; used the primary ASR candidate: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			if (!current()) return;
			if (!writeEditor(prompt)) {
				releaseSpeechOwnership(false);
				ctx.ui.notify("Dictation left your manual edits untouched; review the draft before submitting", "info");
				return;
			}
			if (reviewOnly || config.submitMode === "review") {
				releaseSpeechOwnership(false);
				ctx.ui.notify("Dictation ready to review — press Enter to submit", "info");
				return;
			}
			ctx.ui.setEditorText("");
			if (ctx.isIdle()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "steer" });
		} catch (error) {
			cancel();
			if (talkEpoch !== contextEpoch || captureEpoch !== inputEpoch || !activeContext) return;
			activeInputEndpoint = undefined;
			releaseAfterTransportCancellation(undefined, false, cancelActiveInput());
			clearInputProgress();
			state = "error";
			refreshStatus();
			ctx.ui.notify(`Voice microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			finished.resolve();
			if (finishPendingDictation === finishForPlayback) finishPendingDictation = undefined;
			if (cancelPendingDictation === cancel) cancelPendingDictation = undefined;
			if (current()) {
				clearInputProgress();
				scheduleVoiceWorkerIdleStop();
				if (state !== "error") state = "idle";
				refreshStatus();
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const inputCancelled = cancelActiveInput();
		clearPlaybackTransport();
		try {
			await Promise.all([inputCancelled, deviceRebind?.catch(() => {}), vocalizer.shutdown()]);
			deviceRebind = undefined;
			for (const resolve of transportCancelWaiters.values()) resolve();
			transportCancelWaiters.clear();
			await transportStopBarrier.catch(() => {});
			transportStopBarrier = Promise.resolve();
			transportStopPending = false;
			transportStops.clear();
		} catch (error) {
			ctx.ui.notify(`Voice reload stop failed; ownership retained: ${String(error)}`, "error");
			throw error;
		}
		ownsSpeech = false;
		attentionSuppressed = false;
		deviceRetryRequired = false;
		disabledAttentionPending = false;
		queueIncomingWhilePaused = false;
		queuedPausedMessages.length = 0;
		contextEpoch += 1;
		interactiveVoiceSession = supportsInteractiveVoice(ctx.mode);
		activeContext = interactiveVoiceSession ? ctx : null;
		coordinator?.shutdown();
		if (!interactiveVoiceSession) {
			coordinator = null;
			return;
		}
		coordinator = new SessionCoordinator(ctx.cwd, ctx.sessionManager.getSessionId());
		coordinator.setSessionName(pi.getSessionName());
		coordinator.start();
		coordinator.setAttentionEnabled(config.enabled);
		const savedDevice = sessionDeviceSelection(ctx);
		deviceSelection = savedDevice.selection;
		activeDeviceId = savedDevice.pin ?? (deviceSelection === "auto" || deviceSelection === "local" ? undefined : deviceSelection);
		deviceRouter.setEnvironmentDevice(undefined);
		if (deviceSelection === "auto" && !activeDeviceId) {
			const epoch = playbackRequestEpoch;
			await adoptCurrentConnection(epoch, true);
			if (epoch !== playbackRequestEpoch || activeContext !== ctx) return;
		}
		inputProgressMessage = undefined;
		// Remove progress widgets from versions before the unified, ordered display.
		ctx.ui.setWidget("pi-voice-input", undefined);
		ctx.ui.setWidget("pi-voice-playback", undefined);
		ctx.ui.setWidget("pi-voice-preprocessing", undefined);
		ctx.ui.setWidget("pi-voice-follow-hint", undefined);
		followHintVisible = false;
		if (attentionPollTimer) clearInterval(attentionPollTimer);
		attentionPollTimer = setInterval(pollWaitingAttention, 200);
		attentionPollTimer.unref?.();
		pendingCodeDescriptions.clear();
		codeDescriptionText.clear();
		reportedDescriptionOverflows.clear();
		codeDescriptionOmissions.clear();
		backfillAllowance = config.codeDescriptionPreprocessBudget;
		backfillUsed = 0;
		backfillExhaustionReported = false;
		codeDescriptionCache.restore(codeDescriptionSnapshots(ctx));
		if (!await preparePlaybackMessages(ctx)) return;
		syncPlaybackMessages(ctx, true);
		// Presence-only description keys cannot prove which wording was measured.
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
		clearPlaybackTransport();
		const retiringCoordinator = coordinator;
		coordinator = null;
		retiringCoordinator?.shutdown(true);
		cancelPendingDictation?.();
		if (interactiveVoiceSession) persistPendingDescriptions();
		if (descriptionPersistTimer) clearImmediate(descriptionPersistTimer);
		descriptionPersistTimer = undefined;
		conversationBeforeCache.delete(ctx.sessionManager);
		completedMessagesCache.delete(ctx.sessionManager);
		renderedDescriptionKeys = new WeakMap();
		contextEpoch += 1;
		if (!interactiveVoiceSession) {
			activeContext = null;
			retiringCoordinator?.shutdown();
			return;
		}
		interactiveVoiceSession = false;
		pendingCodeDescriptions.clear();
		codeDescriptionOmissions.clear();
		clearInputProgress();
		ctx.ui.setStatus("pi-voice", undefined);
		ctx.ui.setWidget("pi-voice-render-driver", undefined);
		ctx.ui.setWidget("pi-voice-progress", undefined);
		ctx.ui.setWidget("pi-voice-input", undefined);
		ctx.ui.setWidget("pi-voice-playback", undefined);
		ctx.ui.setWidget("pi-voice-preprocessing", undefined);
		ctx.ui.setWidget("pi-voice-follow-hint", undefined);
		followHintVisible = false;
		codePreprocessingProgress = undefined;
		timingPreprocessingProgress = undefined;
		if (attentionPollTimer) clearInterval(attentionPollTimer);
		attentionPollTimer = null;
		if (voiceWorkerIdleTimer) clearTimeout(voiceWorkerIdleTimer);
		voiceWorkerIdleTimer = null;
		pendingSpeechPreemption = undefined;
		pausedForAttention = false;
		if (narrationRenderTimer) clearTimeout(narrationRenderTimer);
		narrationRenderTimer = null;
		if (playbackTimelineTimer) clearTimeout(playbackTimelineTimer);
		playbackTimelineTimer = null;
		narrationTui = null;
		narration.finish();
		activeContext = null;
		const inputCancelled = cancelActiveInput();
		const workers = timingWorkers.splice(0);
		try {
			await Promise.all([inputCancelled, deviceRebind?.catch(() => {}), ...workers.map(worker => worker.terminate()), vocalizer.shutdown()]);
			deviceRebind = undefined;
		} catch (error) {
			ctx.ui.notify(`Voice shutdown stop failed; ownership retained: ${String(error)}`, "error");
			throw error;
		}
		for (const resolve of transportCancelWaiters.values()) resolve();
		transportCancelWaiters.clear();
		await transportStopBarrier.catch(() => {});
		transportStopBarrier = Promise.resolve();
		transportStopPending = false;
		transportStops.clear();
		retiringCoordinator?.shutdown();
		if (!interactiveVoiceSession) ownsSpeech = false;
	});

	pi.on("session_info_changed", event => {
		if (!interactiveVoiceSession || !coordinator) return;
		coordinator.setSessionName(event.name ?? pi.getSessionName());
	});

	pi.on("input", async () => {
		if (!interactiveVoiceSession || playbackPaused) return;
		disabledAttentionPending = false;
		queuedPausedMessages.length = 0;
		restoreBottomAfterSpeech = false;
		bottomPinned = false;
		coordinator?.clearWaiting();
		pausedForAttention = false;
		speechBlocked = false;
		blockedMessageHasSpeech = false;
		blockedSpeechText = "";
		cancelTimingWorkers();
		const cancelId = clearPlaybackTransport();
		narration.finish();
		const request = playbackRequestEpoch;
		void waitForTransportCancellation(cancelId).then(async () => {
			if (request !== playbackRequestEpoch || !interactiveVoiceSession || deviceRebind) return;
			releaseSpeechOwnership(false);
			if (!attentionSuppressed) await reserveSpeechForInput();
		}).catch(error => activeContext?.ui.notify(`Voice input stop failed; ownership retained: ${String(error)}`, "error"));
	});

	pi.on("before_agent_start", async () => {
		if (!interactiveVoiceSession || playbackPaused) return;
		speechBlocked = false;
		blockedMessageHasSpeech = false;
		blockedWarningIssued = false;
		blockedSpeechText = "";
		cancelTimingWorkers();
		const cancelId = clearPlaybackTransport();
		narration.finish();
		const request = playbackRequestEpoch;
		void waitForTransportCancellation(cancelId).then(() => {
			if (request !== playbackRequestEpoch || !interactiveVoiceSession || deviceRebind) return;
			if (!speechReservedForInput) releaseSpeechOwnership(false);
		}).catch(error => activeContext?.ui.notify(`Voice turn stop failed; ownership retained: ${String(error)}`, "error"));
	});

	pi.on("message_start", event => {
		if (interactiveVoiceSession && (event.message as { role?: string })?.role === "assistant") {
			attentionSuppressed = false;
			coordinator?.setAttentionEnabled(config.enabled);
			queueIncomingWhilePaused = config.enabled && playbackPaused;
			liveBlockIndex = undefined;
			liveBlockIds.clear();
			liveSource = { assistant: event.message, final: false,
				existingEntries: new Set(activeContext?.sessionManager.getBranch().filter(entry => entry.type !== "message" || entry.message !== event.message).map(entry => entry.id)), before: activeContext && config.codeDescriptionContext === "conversation"
				? liveConversationBefore(activeContext).messages : [], waiters: new Set() };
			if (queueIncomingWhilePaused) return;
		}
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
			speechConversationMessages = liveSource?.before ?? [];
			speechAssistantMessage = event.message;
			const continuingTurn =
				!deviceRebind && !transportStopPending && liveTurnNarrationActive && ownsSpeech && speechPurpose === "turn" && (coordinator?.ownsSpeech() ?? true);
			const wasFollowingTranscriptEnd = transcriptIsFollowingEnd();
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
				restoreBottomAfterSpeech = wasFollowingTranscriptEnd;
				bottomPinned = false;
				narration.finish();
				narration.begin();
				liveTurnNarrationActive = true;
			}
			vocalizer.setNarrationSourceOffset(sourceOffset);
			playbackPaused = false;
			narration.setPaused(playbackPaused);
			armNarrationFollow(true, false);
			livePlaybackId = `live:${++nextLivePlaybackId}`;
			playbackHistory.beginCapture(livePlaybackId, "", 0, true, 0, 0, !continuingTurn);
			refreshPlaybackTimeline();
		}
	});

	const pushLiveDelta = (messageType: NarrationMessageType, contentIndex: number, text: string): void => {
		if (liveBlockIndex !== contentIndex) {
			if (liveBlockIndex !== undefined) {
				vocalizer.flush();
				vocalizer.setNarrationSourceOffset(narration.startMessage());
				livePlaybackId = `live:${++nextLivePlaybackId}`;
				playbackHistory.beginCapture(livePlaybackId, "", 0, true, 0, 0, false);
			}
			liveBlockIndex = speechContentIndex = contentIndex;
			liveDisplayOffset = eligibleAssistantBlocks(speechAssistantMessage, config.mode).find(block => block.contentIndex === contentIndex)?.displayOffset ?? 0;
			if (livePlaybackId) liveBlockIds.set(contentIndex, livePlaybackId);
			ownedSpeechText = "";
			setDescriptionSource(contentIndex);
		}
		ownedSpeechText += text;
		if (livePlaybackId) playbackHistory.updateText(livePlaybackId, ownedSpeechText, { contentIndex, messageType, displayOffset: liveDisplayOffset });
		if (hasSpeakableAudio(ownedSpeechText)) announceProjectForSpeech();
		narration.pushDelta(messageType, contentIndex, text, liveDisplayOffset);
		vocalizer.pushDelta(text);
	};

	pi.on("message_update", event => {
		if (!interactiveVoiceSession || !config.enabled || attentionSuppressed || config.mode === "yield") return;
		speechAssistantMessage = event.message;
		if (liveSource) {
			liveSource.assistant = event.message;
			for (const check of liveSource.waiters) check();
		}
		const delta = event.assistantMessageEvent;
		const speakableDelta =
			delta.type === "text_delta" || (delta.type === "thinking_delta" && config.mode === "all")
				? delta.delta
				: undefined;
		if (deviceRebind || transportStopPending) {
			speechBlocked = true;
			if (speakableDelta !== undefined) blockedSpeechText += speakableDelta;
			return;
		}
		if (playbackPaused && liveBlockIndex !== undefined && speakableDelta !== undefined &&
			"contentIndex" in delta && delta.contentIndex !== liveBlockIndex && !queueIncomingWhilePaused) {
			vocalizer.flush();
			queueIncomingWhilePaused = true;
		}
		if (queueIncomingWhilePaused) {
			if (livePlaybackId && liveBlockIndex === undefined && speakableDelta !== undefined && "contentIndex" in delta) {
				liveBlockIndex = speechContentIndex = delta.contentIndex;
				liveBlockIds.set(delta.contentIndex, livePlaybackId);
			}
			if (livePlaybackId && speakableDelta !== undefined && "contentIndex" in delta && delta.contentIndex === liveBlockIndex) {
				ownedSpeechText += speakableDelta;
				const source = eligibleAssistantBlocks(event.message, config.mode).find(block => block.contentIndex === delta.contentIndex);
				liveDisplayOffset = source?.displayOffset ?? 0;
				playbackHistory.updateText(livePlaybackId, ownedSpeechText, source);
			}
			return;
		}
		if (!ownsSpeech || speechPurpose !== "turn") {
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
		if (speakableDelta !== undefined && "contentIndex" in delta) {
			pushLiveDelta(delta.type === "thinking_delta" ? "assistant-thinking" : "assistant", delta.contentIndex, speakableDelta);
		}
	});

	pi.on("message_end", async event => {
		if (!interactiveVoiceSession) return;
		const completedText = assistantText(event.message);
		const stopReason = assistantStopReason(event.message);
		if (stopReason === undefined) return;
		if (liveSource) {
			liveSource.assistant = event.message;
			liveSource.final = true;
			for (const check of liveSource.waiters) check();
		}
		const eligible = eligibleAssistantBlocks(event.message, config.mode).filter(block => hasSpeakableAudio(block.text));
		if (queueIncomingWhilePaused) {
			if (config.enabled && !attentionSuppressed && stopReason !== "aborted" && stopReason !== "error" && !(config.mode === "yield" && stopReason === "toolUse")) {
				const targets = eligible.map(block => {
					const id = liveBlockIds.get(block.contentIndex);
					if (id) return { ...block, id };
					const queued = { ...block, id: `live:${++nextLivePlaybackId}`, time: 0, sourceOffset: 0 };
					queuedPausedMessages.push(queued);
					return queued;
				});
				if (activeContext) finalizePlaybackMessages(activeContext, targets, event.message, liveSource?.existingEntries ?? new Set());
				livePlaybackId = undefined;
				ownerTurnEnded = true;
			}
			return;
		}
		if (stopReason !== "aborted" && stopReason !== "error" && activeContext) {
			for (const block of eligible) {
				scheduleCodeDescriptionsInText(activeContext, block.text);
			}
			finalizePlaybackMessages(activeContext, eligible.flatMap(block => {
				const id = liveBlockIds.get(block.contentIndex);
				return id ? [{ ...block, id }] : [];
			}), event.message, liveSource?.existingEntries ?? new Set());
			livePlaybackId = undefined;
		}
		if (config.enabled && !attentionSuppressed && speechBlocked && requiresVoiceAttention(eligible.map(block => block.text).join("\n"), config.mode, stopReason)) {
			blockedMessageHasSpeech = true;
			pausedForAttention = true;
			refreshStatus();
		}
		if (!config.enabled || attentionSuppressed || deviceRebind || transportStopPending || stopReason === undefined || !ownsSpeech || speechPurpose !== "turn") return;
		if (stopReason === "aborted" || stopReason === "error") {
			liveTurnNarrationActive = false;
			const cancelId = clearPlaybackTransport();
			narration.finish();
			livePlaybackId = undefined;
			releaseAfterTransportCancellation(cancelId, true);
		} else if (config.mode !== "yield") {
			ownerContentExpected = ownerContentExpected || hasSpeakableAudio(completedText);
			if (ownerContentExpected) announceProjectForSpeech();
			vocalizer.flush();
		}
	});

	pi.on("turn_end", (event, ctx) => {
		if (!interactiveVoiceSession) return;
		if (queueIncomingWhilePaused) {
			queueIncomingWhilePaused = false;
			completeOwnerSpeech();
			return;
		}
		const stopReason = assistantStopReason(event.message);
		const completedTurn = stopReason !== "aborted" && stopReason !== "error" && stopReason !== undefined;
		if (!config.enabled && !attentionSuppressed && requiresVoiceAttention(eligibleAssistantBlocks(event.message, config.mode).map(block => block.text).join("\n"), config.mode, stopReason)) {
			disabledAttentionPending = true;
		}
		if (config.enabled && !attentionSuppressed && config.mode === "yield" && completedTurn) {
			const text = assistantText(event.message);
			if (text && stopReason !== "toolUse" && acquireSpeech("turn")) {
				const messages = syncPlaybackMessages(ctx);
				narration.begin();
				let firstBlock = true;
				for (const block of eligibleAssistantBlocks(event.message, config.mode)) {
					if (!hasSpeakableAudio(block.text)) continue;
					const contextual = completedAssistantMessages(ctx, config.mode, config.codeDescriptionContext === "conversation")
						.findLast(message => message.text === block.text && message.contentIndex === block.contentIndex);
					const completed = messages.find(message => message.id === contextual?.id);
					if (completed) playbackHistory.beginCapture(completed.id, completed.text, 0, true, 0, 0, firstBlock);
					firstBlock = false;
					speechConversationMessages = contextual?.conversationMessages ?? liveSource?.before ?? [];
					speechAssistantMessage = event.message;
					speechContentIndex = block.contentIndex;
					setDescriptionSource(block.contentIndex);
					const offset = narration.startMessage();
					narration.pushDelta(block.messageType, block.contentIndex, block.text, block.displayOffset);
					ownerContentExpected = true;
					announceProjectForSpeech();
					vocalizer.speakFrom(block.text, offset);
				}
			} else if (requiresVoiceAttention(text, config.mode, stopReason)) {
				speechBlocked = true;
				blockedMessageHasSpeech = true;
				blockedSpeechText = text;
				pausedForAttention = true;
			}
		}
		if (config.enabled && !attentionSuppressed && completedTurn) {
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
		if (!interactiveVoiceSession || !isCurrentContext(ctx)) return;
		void preparePlaybackMessages(ctx).then(current => {
			if (!current) return;
			persistPendingDescriptions();
			syncPlaybackMessages(ctx);
			scheduleMissingCodeDescriptions(ctx);
			scheduleMissingTimings(ctx);
		}).catch(() => { /* Session replacement invalidates historical work. */ });
	});

	pi.registerShortcut("ctrl+shift+v", {
		description: "Toggle Kokoro voice mode",
		handler: async ctx => {
			restoreBottomAfterSpeech = false;
			bottomPinned = false;
			await toggle(ctx);
		},
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

	// Resolve identity after preview, never in this shared scroll/control path.
	const preparePlaybackAction = async (ctx: ExtensionContext, pauseResume = false, deferInput = false): Promise<number | undefined> => {
		if (!requireEnabledVoice(ctx)) return;
		const epoch = ++playbackRequestEpoch;
		// Pause/resume edits the pending replay rather than superseding it.
		if (pauseResume && pendingReplay) pendingReplay.epoch = epoch;
		if (!deferInput && inputInProgress) {
			try { await finishInputForPlayback(); }
			catch (error) {
				ctx.ui.notify(`Voice microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
		}
		return epoch === playbackRequestEpoch && interactiveVoiceSession ? epoch : undefined;
	};

	// Preview raw source before contextual identities yield or device acquisition waits.
	const previewHistoricalTarget = (ctx: ExtensionContext, movement: -1 | 0 | 1, automatic = false): boolean => {
		const messages = completedAssistantMessages(ctx, config.mode, false);
		const selected = playbackHistory.selected();
		const index = movement === 0 && pausedForAttention ? messages.length - 1 : messages.findIndex(message => message.id === selected?.id);
		const live = index < 0 && !ownerTurnEnded && livePlaybackId !== undefined && selected?.id.startsWith("live:");
		const target = live ? (movement === 0 ? selected : messages.at(-1))
			: messages[Math.max(0, Math.min(messages.length - 1, (index < 0 ? messages.length - 1 : index) + movement))];
		if (!target || (movement === 1 && index === messages.length - 1)) return false;
		previewPlaybackTarget({ ...target, time: 0, sourceOffset: 0 }, !automatic);
		return true;
	};

	const replaySelected = async (ctx: ExtensionContext, automatic = false): Promise<void> => {
		if (!requireEnabledVoice(ctx)) return;
		const restoreTail = atTranscriptTail && transcriptIsFollowingEnd();
		const framed = previewHistoricalTarget(ctx, 0, automatic);
		const request = await preparePlaybackAction(ctx);
		if (request === undefined || !await preparePlaybackMessages(ctx, request) || request !== playbackRequestEpoch) return;
		syncPlaybackMessages(ctx, pausedForAttention);
		const target = playbackHistory.restartTarget();
		if (!target) {
			ctx.ui.notify("There is no completed assistant message to replay yet", "warning");
			return;
		}
		playbackPaused = false;
		narration.setPaused(playbackPaused);
		playTarget(target, !playbackHistory.hasCompleteTimingFor(target.id), true, automatic, framed, restoreTail);
	};

	playRequestedAttention = ctx => {
		pausedForAttention = true;
		replaySelected(ctx, true);
	};

	const attendNextProject = async (ctx: ExtensionContext): Promise<void> => {
		restoreBottomAfterSpeech = false;
		bottomPinned = false;
		await replaySelected(ctx);
	};

	pi.registerShortcut("f6", {
		description: "Play the previous assistant message",
		handler: async ctx => {
			if (!requireEnabledVoice(ctx)) return;
			const framed = previewHistoricalTarget(ctx, -1);
			const request = await preparePlaybackAction(ctx);
			if (request === undefined || !await preparePlaybackMessages(ctx, request) || request !== playbackRequestEpoch) return;
			syncPlaybackMessages(ctx);
			const message = playbackHistory.move(-1);
			if (message) playTarget({ ...message, time: 0, sourceOffset: 0 }, !playbackHistory.hasCompleteTimingFor(message.id), true, false, framed);
		},
	});

	const stepSentence = async (ctx: ExtensionContext, direction: -1 | 1, fromPrevious = false, navigation?: PlaybackHistory): Promise<void> => {
		if (!requireEnabledVoice(ctx)) return;
		const request = ++playbackRequestEpoch;
		const messages = completedAssistantMessages(ctx, config.mode, false);
		let history = navigation ?? playbackHistory;
		if (!navigation && messages.length !== playbackHistory.status()?.messageCount) {
			history = new PlaybackHistory();
			history.sync(messages);
			const cursor = playbackHistory.resumeTarget();
			if (cursor) history.beginCapture(cursor.id, cursor.text, cursor.time, false, cursor.sourceOffset, cursor.skipUnits ?? 0);
		}
		const selected = history.selected();
		if (!selected) { ctx.ui.notify("There is no completed assistant message", "warning"); return; }
		const contextual = config.codeDescriptionContext === "conversation"
			? completedAssistantMessages(ctx, config.mode, true).find(message => message.id === selected.id) : undefined;
		const stream = new SpeakableStream();
		const units: Array<{ sourceOffset: number; skipUnits: number }> = [];
		let complete = true;
		for (const item of [...stream.push(selected.text), ...stream.flush()]) {
			let count = 1;
			if (item.kind === "code") {
				const messages = contextual ? assistantCodeContext(
					contextual.conversationMessages, contextual.assistantMessage, contextual.contentIndex, item.source.end)! : [];
				const key = descriptionCacheKey(ctx, item.block, structuredContextIdentity(messages));
				const plan = codeDescriptionCache.get(key);
				const omitted = plan?.omitted || (!plan && codeDescriptionOmissions.has(key));
				if (!plan && !omitted) complete = false;
				count = omitted ? 0 : plan ? Math.max(1, chunkCodeNarration(plan).length) : 1;
			}
			for (let skipUnits = 0; skipUnits < count; skipUnits++) units.push({ sourceOffset: item.source.start, skipUnits });
		}
		const cursor = history.resumeTarget();
		if (direction < 0 && !atTranscriptTail && complete &&
			(!units.length || (!fromPrevious && (cursor?.sourceOffset ?? 0) <= units[0].sourceOffset && !cursor?.skipUnits)) &&
			(history.status()?.messageIndex ?? 0) > 0) {
			history.move(-1);
			return stepSentence(ctx, direction, true, history);
		}
		const target = history.sentenceTarget(direction, units, atTranscriptTail || fromPrevious);
		if (target) {
			previewPlaybackTarget(target);
			await new Promise<void>(resolve => setImmediate(resolve));
			if (!await preparePlaybackMessages(ctx, request) || request !== playbackRequestEpoch) return;
			syncPlaybackMessages(ctx);
			const fullCapture = target.sourceOffset === units[0]?.sourceOffset && !target.skipUnits;
			void playTarget(target, fullCapture && !playbackHistory.hasCompleteTimingFor(target.id), true, false, true);
		} else if (direction > 0 && complete) {
			const before = history.status();
			if (before && before.messageIndex === before.messageCount - 1) followTranscriptTail(ctx);
			else {
				const next = history.move(1);
				if (next) {
					const target = { ...next, time: 0, sourceOffset: 0 };
					previewPlaybackTarget(target);
					await new Promise<void>(resolve => setImmediate(resolve));
					if (!await preparePlaybackMessages(ctx, request) || request !== playbackRequestEpoch) return;
					syncPlaybackMessages(ctx);
					void playTarget(target, !playbackHistory.hasCompleteTimingFor(next.id), true, false, true);
				}
			}
		} else {
			scheduleMissingTimings(ctx);
			ctx.ui.notify("Sentence boundaries for this code description are still pending", "info");
		}
	};

	pi.registerShortcut("f7", {
		description: "Play the previous sentence or literal newline unit",
		handler: ctx => stepSentence(ctx, -1),
	});

	const pauseCurrentPlayback = (preserveViewport: boolean): boolean => {
		if (playbackPaused) return true;
		if (!playbackHistory.selected() || !ownsSpeech || lastOwnerUtterance === undefined) return false;
		const pausedScrollTop = preserveViewport ? activeScrollView()?.scrollTop : undefined;
		pausedOwnerUtterance = lastOwnerUtterance;
		vocalizer.setPlaybackPaused(true);
		playbackPaused = true;
		narration.setPaused(playbackPaused);
		// A paused sink still owns the selected output device. Retaining the
		// lease prevents another session from starting overlapping audio and lets
		// live turns continue queueing/flush safely behind the paused transport.
		hideFollowHint();
		autoScrollForceOnce = false;
		state = "idle";
		refreshStatus();
		refreshPlaybackTimeline();
		if (preserveViewport) preserveNarrationViewport(pausedScrollTop);
		return true;
	};

	const followTranscriptTail = (ctx: ExtensionContext): void => {
		// Tail is beyond the final playable position. Freeze an active sink before
		// moving the viewport so narration cannot continue behind transcript-tail
		// following. An already paused or completed transport remains untouched.
		if (pendingReplay) {
			playbackRequestEpoch += 1;
			pendingReplay = undefined;
			playbackPaused = true;
			narration.setPaused(playbackPaused);
		}
		pauseCurrentPlayback(false);
		scrollToBottom(ctx);
	};

	pi.registerShortcut("f8", {
		description: "Pause or resume regenerated voice playback",
		handler: async ctx => {
			const requestEpoch = await preparePlaybackAction(ctx, true);
			if (requestEpoch === undefined || requestEpoch !== playbackRequestEpoch) return;
			if (pendingReplay) {
				const request = pendingReplay;
				if (request.paused) {
					playbackPaused = false;
					narration.setPaused(playbackPaused);
					void playTarget(request.target, request.recordTimings, request.previewTarget);
					return;
				}
				request.paused = !request.paused;
				playbackPaused = request.paused;
				narration.setPaused(playbackPaused);
				vocalizer.setPlaybackPaused(request.paused);
				refreshStatus();
				refreshPlaybackTimeline();
				if (!request.waiting && !request.paused) {
					void playTarget(request.target, request.recordTimings, request.previewTarget, true);
				}
				return;
			}
			if (pendingSpeechPreemption) {
				ctx.ui.notify("Voice device handoff is still stopping the previous transport", "warning");
				return;
			}
			if (atTranscriptTail && !attentionSuppressed && (pausedOwnerUtterance === undefined || !ownsSpeech)) {
				await replaySelected(ctx);
				return;
			}
			restoreBottomAfterSpeech = atTranscriptTail && transcriptIsFollowingEnd();
			bottomPinned = false;
			if (playbackPaused) {
				if (lastPlaybackTick) narration.setPlayback(lastPlaybackTick.utterance, lastPlaybackTick.position, true);
				armNarrationFollow();
				flushNarrationRender();
				requestNarrationAutoScroll(true, true);
				if (!await adoptCurrentConnection(requestEpoch) || requestEpoch !== playbackRequestEpoch) return;
				playbackPaused = false;
				narration.setPaused(playbackPaused);
				if (speechPurpose === "notification" && completedOwnerUtterance === pausedOwnerUtterance) {
					vocalizer.setPlaybackPaused(false);
					completeOwnerSpeech();
					return;
				}
				if (pausedOwnerUtterance === undefined || completedOwnerUtterance === pausedOwnerUtterance) {
					const target = playbackHistory.resumeTarget();
					if (target) playTarget(target, false, false, true);
					return;
				}
				if (!ownsSpeech || !(coordinator?.ownsSpeech() ?? true)) {
					const target = playbackHistory.resumeTarget();
					if (target) playTarget(target, false, false, true);
					return;
				}
				cancelTimingWorkers();
				lastOwnerUtterance = pausedOwnerUtterance;
				ownerContentExpected = true;
				completedOwnerUtterance = undefined;
				vocalizer.setPlaybackPaused(false);
				playbackPaused = false;
				narration.setPaused(playbackPaused);
				pausedOwnerUtterance = undefined;
				state = "speaking";
				refreshStatus();
				refreshPlaybackTimeline();
				return;
			}
			if (!pauseCurrentPlayback(true)) {
				ctx.ui.notify("There is no assistant message playing", "warning");
			}
		},
	});

	pi.registerShortcut("f9", {
		description: "Play the next sentence/newline; after the latest message, pause and follow the transcript tail",
		handler: ctx => stepSentence(ctx, 1),
	});

	pi.registerShortcut("f10", {
		description: "Play the next assistant message; pause and follow transcript tail after the latest",
		handler: async ctx => {
			if (!requireEnabledVoice(ctx)) return;
			const framed = previewHistoricalTarget(ctx, 1);
			const request = await preparePlaybackAction(ctx);
			if (request === undefined || !await preparePlaybackMessages(ctx, request) || request !== playbackRequestEpoch) return;
			syncPlaybackMessages(ctx);
			const before = playbackHistory.status();
			if (before && before.messageIndex === before.messageCount - 1) {
				followTranscriptTail(ctx);
				return;
			}
			const message = playbackHistory.move(1);
			if (message) playTarget({ ...message, time: 0, sourceOffset: 0 }, !playbackHistory.hasCompleteTimingFor(message.id), true, false, framed);
		},
	});

	pi.registerShortcut("f11", {
		description: "Replay this project's response",
		handler: attendNextProject,
	});

	const registeredTalkShortcut = config.talkShortcut;
	const effectiveTalkShortcuts = new Set<string>();
	if (config.talkShortcut !== "disabled") {
		const registerTalkShortcut = (key: Exclude<VoiceConfig["talkShortcut"], "disabled">): void => {
			effectiveTalkShortcuts.add(key);
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

	const scrollToNarration = (ctx: ExtensionContext): void => {
		if (!ownsSpeech || narration.activeWordStart === undefined) {
			ctx.ui.notify("There is no active narrated position to scroll to", "warning");
			return;
		}
		restoreBottomAfterSpeech = false;
		armNarrationFollow(true);
		requestNarrationAutoScroll(true, true);
	};

	if (config.scrollToShortcut !== "disabled" && config.scrollToShortcut !== config.scrollBottomShortcut) {
		pi.registerShortcut(config.scrollToShortcut, {
			description: "Scroll to the current narrated position",
			handler: scrollToNarration,
		});
		effectiveTalkShortcuts.delete(config.scrollToShortcut);
	}
	if (config.scrollBottomShortcut !== "disabled") {
		pi.registerShortcut(config.scrollBottomShortcut, {
			description: "Pin the transcript to its end and follow new output",
			handler: scrollToBottom,
		});
		effectiveTalkShortcuts.delete(config.scrollBottomShortcut);
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
				"tts-workers",
				"stt-model",
				"stt-dtype",
				"stt-candidates",
				"alignment-model",
				"alignment-dtype",
				"edit-model",
				"highlight",
				"autoscroll",
				"scroll-to",
				"bottom",
				"timing",
				"code-narration",
				"code-budget",
				"code-retry",
				"code-preprocess",
				"timing-preprocess",
				"audio-cache",
				"audio-bitrate",
				"device",
				"reconnect",
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
					{ value: "device auto", label: "auto", description: "Pin the current connection; never fall back to another device" },
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
			if (parts[0] === "code-retry") {
				if (parts[1] === "historical" && parts.length > 2) {
					return ["all"]
						.filter(value => value.startsWith(parts[2] ?? ""))
						.map(value => ({ value: `code-retry historical ${value}`, label: value }));
				}
				return ["current", "historical"]
					.filter(value => value.startsWith(parts[1] ?? ""))
					.map(value => ({ value: `code-retry ${value}`, label: value }));
			}
			if (parts[0] === "code-preprocess" || parts[0] === "timing-preprocess" || parts[0] === "tts-workers" || parts[0] === "tts-worker") {
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
			if (parts[0] === "highlight" || parts[0] === "autoscroll") {
				return ["on", "off"]
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
			const [action = "status", value = "", ...restArgs] = args.split(/\s+/);
			const normalizedAction = action.toLowerCase();
			// Queries must return before even the transcript-follow reset below.
			if (!value && restArgs.length === 0) {
				const queries: Record<string, () => string | number | boolean> = {
					mode: () => config.mode,
					voice: () => config.voice,
					speed: () => config.speed,
					"tts-model": () => config.ttsModel,
					"tts-dtype": () => config.ttsDtype,
					"tts-workers": () => `concurrency: ${config.ttsWorkers}`,
					"tts-worker": () => `concurrency: ${config.ttsWorkers}`,
					"stt-model": () => config.sttModel,
					"stt-dtype": () => config.sttDtype,
					"stt-candidates": () => config.sttCandidates,
					"alignment-model": () => config.alignmentModel,
					"alignment-dtype": () => config.alignmentDtype,
					"edit-model": () => {
						const selected = parseEditModelSelector(config.editModel);
						const model = selected ? ctx.modelRegistry.find(selected.provider, selected.modelId) : ctx.model;
						return `${config.editModel} → ${model ? `${model.provider}/${model.id}` : "unavailable"}`;
					},
					highlight: () => config.playbackHighlight,
					autoscroll: () => config.autoScroll,
					"code-narration": () => config.codeNarration,
					"code-preprocess": () => config.codeDescriptionPreprocessConcurrency,
					"code-budget": () => `scope=${config.codeDescriptionPreprocessScope}; budget=${backfillAllowance}; used=${backfillUsed}; set /voice code-budget <0..n|unlimited> for this session`,
					"timing-preprocess": () => `${config.timingPreprocessConcurrency} → ${resolveTimingConcurrency(config.timingPreprocessConcurrency, config.ttsDtype)}${timingPreprocessing ? `; active batch=${timingWorkers.length}` : ""}`,
					"audio-cache": () => config.audioCache,
					"audio-bitrate": () => `${config.audioCacheBitrate} kbps`,
					shortcut: () => {
						const [primary, fallback] = effectiveTalkShortcuts;
						return `${primary ?? (registeredTalkShortcut === "disabled" ? "disabled" : "none")}${fallback ? ` (also ${fallback})` : ""}${registeredTalkShortcut !== config.talkShortcut ? `; configured=${config.talkShortcut} (run /reload to apply)` : ""}`;
					},
					submit: () => config.submitMode,
					edit: () => config.editMode,
				};
				if (normalizedAction === "device" || normalizedAction === "output" || normalizedAction === "input") {
					// Metadata only: no attachment lookup, claim, transport, or selection mutation.
					const selection = activeDeviceId ?? deviceSelection;
					if (normalizedAction !== "device" && config[normalizedAction] !== "auto") {
						ctx.ui.notify(`${normalizedAction}: ${config[normalizedAction]} → ${config[normalizedAction]}`, "info");
						return;
					}
					let device;
					try { device = deviceRouter.resolve(selection); } catch (error) {
						ctx.ui.notify(`${normalizedAction}: ${normalizedAction === "device" ? selection : config[normalizedAction]} → unavailable (${error instanceof Error ? error.message : String(error)}); metadata only`, "info");
						return;
					}
					const current = normalizedAction === "device"
						? `${deviceSelection} → ${device ? `${device.id} (${device.name})` : "local"}`
						: `${config[normalizedAction]} → ${normalizedAction === "output"
							? (config.output === "auto" ? device?.audioEndpoint ?? "local" : config.output)
							: (activeInputEndpoint ?? (config.input === "auto" ? device?.inputEndpoint ?? "local" : config.input))}`;
					ctx.ui.notify(`${normalizedAction}: ${current}`, "info");
					return;
				}
				if (Object.hasOwn(queries, normalizedAction)) {
					const current = queries[normalizedAction]();
					const label = normalizedAction === "tts-worker" ? "tts-workers" : normalizedAction;
					ctx.ui.notify(`${label}${label === "tts-workers" ? " " : ": "}${typeof current === "boolean" ? (current ? "on" : "off") : current}`, "info");
					return;
				}
			}
			if (!["", "status", "timing", "bottom", "tts-workers", "tts-worker"].includes(normalizedAction)) {
				restoreBottomAfterSpeech = false;
				bottomPinned = false;
			}
			switch (normalizedAction) {
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
				case "stop": {
					attentionSuppressed = true;
					queueIncomingWhilePaused = false;
					queuedPausedMessages.length = 0;
					disabledAttentionPending = false;
					pausedForAttention = false;
					speechBlocked = false;
					blockedMessageHasSpeech = false;
					coordinator?.setAttentionEnabled(false);
					pendingSpeechPreemption = undefined;
					const cancelId = clearPlaybackTransport();
					narration.finish();
					const inputCancelled = cancelActiveInput();
					// Return promptly, but retain the lease until both devices acknowledge stop.
					releaseAfterTransportCancellation(cancelId, false, inputCancelled);
					state = "idle";
					refreshStatus();
					return;
				}
				case "talk":
					void talk(ctx);
					return;
				case "attention":
					await attendNextProject(ctx);
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
					if (inputInProgress && action.toLowerCase() === "stt-model") await cancelActiveInput();
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
					if (inputInProgress && action.toLowerCase() === "stt-dtype") await cancelActiveInput();
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
				case "reconnect": {
					const epoch = ++playbackRequestEpoch;
					pendingReplay = undefined;
					if (ownsSpeech) {
						playbackPaused = true;
						narration.setPaused(playbackPaused);
						vocalizer.setPlaybackPaused(true);
					}
					if (await adoptCurrentConnection(epoch, true)) {
						playbackPaused = ownsSpeech;
						narration.setPaused(playbackPaused);
						vocalizer.setPlaybackPaused(playbackPaused);
						ctx.ui.notify(`Voice pinned to ${activeDeviceId ?? deviceSelection}; no playback started (metadata only)`, "info");
					}
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
					if (inputInProgress) await cancelActiveInput();
					const cancelId = clearPlaybackTransport();
					narration.finish();
					releaseAfterTransportCancellation(cancelId);
					deviceSelection = requested;
					pi.appendEntry(DEVICE_SELECTION_ENTRY, { version: 1, selection: requested });
					activeDeviceId = undefined;
					if (requested === "auto" && !await adoptCurrentConnection(playbackRequestEpoch, true)) return;
					let device;
					try { device = deviceRouter.resolve(activeDeviceId ?? deviceSelection); } catch (error) {
						ctx.ui.notify(`Voice device: ${error instanceof Error ? error.message : String(error)}`, "warning");
						return;
					}
					ctx.ui.notify(
						device ? `Voice device set to ${device.name} (metadata only)` : "Voice device set to local input/output",
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
				case "tts-worker":
				case "tts-workers": {
					const workers = /^[1-8]$/.test(value) && restArgs.length === 0 ? normalizeWorkerCount(Number(value)) : undefined;
					if (workers === undefined) {
						ctx.ui.notify("Usage: /voice tts-workers <1..8>", "error");
						break;
					}
					const next = { ...config, ttsWorkers: workers };
					await saveVoiceConfig(next);
					config = next;
					// Scheduling only: do not reset playback, assets, preprocessing or its budget.
					vocalizer.setTtsWorkers(workers);
					ctx.ui.notify(`tts-workers concurrency set to ${workers}`, "info");
					break;
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
					const parsed = normalizeBackfillBudget(value.toLowerCase() === "unlimited" ? "unlimited" : Number(value));
					if (parsed === undefined) {
						ctx.ui.notify("Usage: /voice code-budget [unlimited|<0..n>] | code-retry current|historical [all|<id>]", "error");
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
				case "scroll-to": {
					scrollToNarration(ctx);
					return;
				}
				case "bottom": {
					scrollToBottom(ctx);
					return;
				}
				case "code-retry": {
					const retryCtx = activeContext;
					if (!retryCtx) return;
					const retryArgs = [value, ...restArgs].filter(Boolean);
					const mode0 = retryArgs[0] ?? "";
					const collectFailed = () => {
						const found: Array<{ key: string; messageId: string; index: number; preview: string; block: FencedCodeBlock; providerMessages: Message[] }> = [];
						scopedCompletedMessages(retryCtx, config.mode).forEach((message, index) => {
							for (const item of describableCodeItems(message.text)) {
								try {
									const providerMessages = assistantCodeContext(
										message.conversationMessages, message.assistantMessage, message.contentIndex, item.sourceEnd)!;
									const key = descriptionCacheKey(retryCtx, item.block, structuredContextIdentity(providerMessages));
									if (codeDescriptionOmissions.has(key) || codeDescriptionCache.get(key)?.omitted) {
										found.push({ key, messageId: message.id, index, preview: item.block.code.replace(/\s+/g, " ").slice(0, 48), block: item.block, providerMessages });
									}
								} catch {
									// Unkeyable blocks have nothing recorded to retry.
								}
							}
						});
						return found;
					};
					const retryKeys = (keys: Set<string>): number => {
						// Fence the currently narrated asset when it becomes dirty, not when
						// the replacement plan eventually arrives. Retry coalescing is separate.
						if (collectFailed().some(failed => failed.messageId === playbackHistory.selected()?.id && keys.has(failed.key))) {
							pauseDirtyPlayback();
						}
						let scheduled = 0;
						for (const failed of collectFailed()) {
							if (!keys.delete(failed.key)) continue;
							codeDescriptionOmissions.delete(failed.key);
							codeDescriptionCache.invalidate(failed.key);
							void requestCodeDescription(
								retryCtx,
								failed.block,
								structuredContextIdentity(failed.providerMessages),
								failed.providerMessages,
								{ chargeBackfill: chargeBackfillUnit },
							).then(() => {
								if (isCurrentContext(retryCtx) && !livePlaybackId) syncPlaybackMessages(retryCtx);
							}).catch(() => {});
							scheduled += 1;
						}
						return scheduled;
					};

					if (mode0 === "current") {
						const selectedId = playbackHistory.selected()?.id ?? playbackHistory.status()?.messageId;
						const keys = new Set(collectFailed().filter(failed => failed.messageId === selectedId).map(failed => failed.key));
						if (keys.size === 0) {
							ctx.ui.notify("No failed descriptions on the currently selected message", "info");
							return;
						}
						ctx.ui.notify(`Retrying ${retryKeys(keys)} description(s) on ${selectedId}`, "info");
						return;
					}
					if (mode0 !== "historical") {
						ctx.ui.notify("Usage: /voice code-retry current | historical [all|<message-id>]", "error");
						return;
					}
					const arg1 = retryArgs[1];
					if (!arg1 && ctx.hasUI) {
						void (async () => {
							try {
								const failed = collectFailed();
								if (failed.length === 0) {
									ctx.ui.notify("No failed descriptions to retry", "info");
									return;
								}
								// Chronological order; the entry nearest the current selection is
								// surfaced first as the implicit default.
								const currentIndex = playbackHistory.status()?.messageIndex ?? -1;
								let nearestOffset = Number.POSITIVE_INFINITY;
								let nearestKey: string | undefined;
								for (const entry of failed) {
									const offset = Math.abs(entry.index - currentIndex);
									if (offset < nearestOffset) {
										nearestOffset = offset;
										nearestKey = entry.key;
									}
								}
								const ordered = [...failed].sort((left, right) => {
									if (left.key === nearestKey) return -1;
									if (right.key === nearestKey) return 1;
									return left.index - right.index;
								});
								const labels = ordered.map((entry, position) =>
									`[${position === 0 ? "closest" : `#${entry.index + 1}`}] ${entry.messageId.slice(0, 10)} · ${entry.preview}`,
								);
								labels.push("Retry ALL failed descriptions");
								const picked = await ctx.ui.select("Retry a failed code description", labels);
								if (!picked) return;
								if (picked === "Retry ALL failed descriptions") {
									ctx.ui.notify(`Retrying ${retryKeys(new Set(failed.map(entry => entry.key)))} description(s)`, "info");
									return;
								}
								const chosen = ordered[labels.indexOf(picked)];
								if (chosen) ctx.ui.notify(`Retrying ${retryKeys(new Set([chosen.key]))} description(s)`, "info");
							} catch {
								// Dialog failures leave state untouched.
							}
						})();
						return;
					}
					const failed = collectFailed();
					const keys = new Set(
						(arg1 === "all" ? failed : failed.filter(entry => entry.messageId.includes(arg1))).map(entry => entry.key),
					);
					if (keys.size === 0) {
						ctx.ui.notify("No matching failed descriptions to retry", "info");
						return;
					}
					ctx.ui.notify(`Retrying ${retryKeys(keys)} description(s)`, "info");
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
					requestNarrationRender(true);
					ctx.ui.notify(`Spoken-word highlighting ${normalized === "on" ? "enabled" : "disabled"}`, "info");
					return;
				}
				case "autoscroll": {
					const normalized = value.toLowerCase();
					if (normalized !== "on" && normalized !== "off") {
						ctx.ui.notify("Usage: /voice autoscroll on|off", "error");
						return;
					}
					await updateConfig({ ...config, autoScroll: normalized === "on" });
					// Display settings retain paused/playing state and manual framing.
					hideFollowHint();
					requestNarrationRender(true);
					ctx.ui.notify(`Spoken-text auto-scroll ${normalized === "on" ? "enabled" : "disabled"}`, "info");
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
					await updateConfig({ ...config, mode });
					ctx.ui.notify(`Voice mode set to ${mode}`, "info");
					return;
				}
				case "voice": {
					const selected = value;
					if (!isVoice(selected)) {
						ctx.ui.notify("Unknown voice. Use /voice voice <voice-id>; completion lists available voices.", "error");
						return;
					}
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
					if (inputInProgress) await cancelActiveInput();
					const cancelId = clearPlaybackTransport();
					narration.finish();
					releaseAfterTransportCancellation(cancelId);
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
					if (inputInProgress) await cancelActiveInput();
					if (speechReservedForInput) releaseSpeechOwnership(false);
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
					queuedPausedMessages.length = 0;
					attentionSuppressed = false;
					coordinator?.setAttentionEnabled(true);
					clearPlaybackTransport();
					narration.finish();
					const epoch = await preparePlaybackAction(ctx);
					if (epoch === undefined || !await adoptCurrentConnection(epoch)) return;
					if (!(await forceAcquireSpeech("replay", true))) return;
					if (epoch !== playbackRequestEpoch || !isCurrentContext(ctx) || !interactiveVoiceSession) return;
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
						`Voice ${config.enabled ? "on" : "off"}; mode=${config.mode}; voice=${config.voice}; speed=${config.speed}; tts=${config.ttsModel}@${config.ttsDtype}; ttsWorkers=${config.ttsWorkers}; stt=${config.sttModel}@${config.sttDtype}; sttCandidates=${config.sttCandidates}; alignment=${config.alignmentModel}@${config.alignmentDtype}; editModel=${config.editModel}; highlight=${config.playbackHighlight ? "on" : "off"}; autoScroll=${config.autoScroll ? "on" : "off"}; scrollToShortcut=${config.scrollToShortcut}; bottomShortcut=${config.scrollBottomShortcut}; codeNarration=${config.codeNarration}; codeContext=${config.codeDescriptionContext}; codePreprocess=${config.codeDescriptionPreprocessConcurrency}; codeScope=${config.codeDescriptionPreprocessScope}; codeBudget=${backfillAllowance}; timingPreprocess=${config.timingPreprocessConcurrency}; audioCache=${config.audioCache ? `${config.audioCacheBitrate}kbps` : "off"}; device=${deviceSelection}${activeDeviceId ? `→${activeDeviceId}` : "→local"}; output=${config.output}; input=${config.input}; shortcut=${config.talkShortcut}; submit=${config.submitMode}; edit=${config.editMode}`,
						"info",
					);
					return;
				default:
					ctx.ui.notify(
						"Usage: /voice [on|off|toggle|status|stop|setup|test|talk|attention|mode|voice|speed|tts-model|tts-dtype|tts-workers|stt-model|stt-dtype|stt-candidates|alignment-model|alignment-dtype|edit-model|highlight|autoscroll|scroll-to|bottom|timing|code-narration|code-budget|code-retry|code-preprocess|timing-preprocess|audio-cache|audio-bitrate|device|reconnect|output|input|shortcut|submit|edit]",
						"error",
					);
			}
		},
	});
}
