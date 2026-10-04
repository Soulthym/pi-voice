import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { DevicePriorityStore } from "./device-priorities.js";
import { DeviceRouting } from "./device-routing.js";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { getMarkdownTheme, highlightCode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { hasSpeakableAudio, requiresVoiceAttention } from "./attention.js";
import {
	assistantCodeContext,
	eligibleAssistantBlocks,
	resolvedSessionContext,
	structuredContextIdentity,
	legacyStructuredContextIdentity,
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
import { deviceProgressComponent, selectPriorityDeviceOverlay } from "./device-picker-ui.js";
import { DeviceRouter, validDeviceName, type ConnectionDevice, type VoiceDeviceSelection } from "./device-router.js";
import { LiveTranscriptionSession } from "./live-transcription.js";
import {
	NarrationProgress,
	type NarrationMessageType,
} from "./narration-progress.js";
import {
	PlaybackHistory,
	type PlaybackMessage,
	type PlaybackTarget,
	type PlaybackResumeSnapshot,
	type PlaybackTimingSnapshot,
} from "./playback-history.js";
import { PhoneInputClient } from "./phone-input.js";
import { StopRecovery, boundedStopRecovery } from "./stop-recovery.js";
import { prioritizeFromCurrent, processConcurrently, resolveTimingConcurrency } from "./preprocessing.js";
import { SpeakableStream, type FencedCodeBlock, type SpeakableSourceRange } from "./speakable.js";
import { notifyVoice, playbackTimingStatus, voiceProgressLines, type ReadyProgress } from "./status-text.js";
import { anchorLineForMessage, computeAutoScrollTop, isManualScrollAway, narrationScrollBox, narrationSourceLine, type NarrationLayoutBox } from "./auto-scroll.js";
import { applySpokenEdit, parseEditModelSelector, resolveDictationCandidates } from "./prompt-editor.js";
import { formatAsrDisplay } from "./asr-display.js";
import { narrationRenderKey } from "./render-identity.js";
import { frameNarrationViewport, invalidateNarrationMarkdown, narrationJumpButton, withNarrationLayout } from "./narration-render.js";
import { SessionCoordinator, type AttentionRequest, type WaitingSession } from "./session-coordinator.js";
import { supportsInteractiveVoice } from "./session-mode.js";
import { Vocalizer, type PlaybackPhase } from "./vocalizer.js";
import { isVoice, VOICES } from "./voices.js";
import { VoiceWorkerClient, type WorkerEvent, type TimingRetryResult } from "./worker-client.js";

type VoiceState = "downloading" | "error" | "idle" | "listening" | "loading" | "speaking";
type InputPhase = "idle" | "acquiring" | "recording" | "transcribing";
type PreprocessingProgress = ReadyProgress;
type SpeechPurpose = "turn" | "replay";

const PLAYBACK_TIMING_ENTRY = "pi-voice.playback-timing";
const CODE_DESCRIPTION_CACHE_ENTRY = "pi-voice.code-description";
const DEVICE_SELECTION_ENTRY = "pi-voice.device-selection";
// Pi reloads even when session_shutdown throws. Retain cleanup, never retired UI/session callbacks.
const retiredStopsKey = Symbol.for("pi-voice.retired-stops");
type RetiredStop = ((guard?: Parameters<StopRecovery["retry"]>[3]) => Promise<void>) & { owner?: ReturnType<SessionCoordinator["speechOwner"]>; root?: string };
const retiredStops = ((globalThis as typeof globalThis & {
	[retiredStopsKey]?: Set<RetiredStop>;
})[retiredStopsKey] ??= new Set<RetiredStop>());

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
const completedMessagesCache = new WeakMap<object, { session: string; leaf: string | null; branch?: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>; messages: Map<string, ContextualPlaybackMessage[]> }>();
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
				identityContext: Object.assign(() => structuredContextIdentity(providerMessages()),
					{ legacy: () => legacyStructuredContextIdentity(providerMessages()) }) };
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

function completedEntryMessages(ctx: ExtensionContext, entry: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number], mode: VoiceMode, includeContext: boolean): ContextualPlaybackMessage[] {
	if (entry.type !== "message") return [];
	const stopReason = assistantStopReason(entry.message);
	if (stopReason === undefined || stopReason === "aborted" || stopReason === "error") return [];
	if (mode === "yield" && stopReason === "toolUse") return [];
	const key = `${mode}:${includeContext}`;
	let variants = completedEntryCache.get(entry);
	const existing = variants?.get(key);
	if (existing) return existing;
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
	return targets;
}

function completedBranch(ctx: ExtensionContext) {
	const session = ctx.sessionManager.getSessionId();
	const leaf = ctx.sessionManager.getLeafId();
	let cache = completedMessagesCache.get(ctx.sessionManager);
	if (cache?.session === session && cache.leaf !== leaf) {
		let ancestor = leaf;
		let userAdded = false;
		while (ancestor && ancestor !== cache.leaf) {
			const entry = ctx.sessionManager.getEntry?.(ancestor);
			if (entry?.type !== "custom" && !(entry?.type === "message" && entry.message.role === "user")) break;
			userAdded ||= entry.type === "message";
			ancestor = entry.parentId;
		}
		if (ancestor === cache.leaf) {
			cache.leaf = leaf;
			if (userAdded) cache.branch = undefined;
		}
	}
	if (cache?.session !== session || cache.leaf !== leaf) {
		cache = { session, leaf, messages: new Map() };
		completedMessagesCache.set(ctx.sessionManager, cache);
	}
	return cache.branch ??= ctx.sessionManager.getBranch();
}

function completedAssistantMessages(ctx: ExtensionContext, mode: VoiceMode, includeContext = false): ContextualPlaybackMessage[] {
	const branch = completedBranch(ctx);
	const cache = completedMessagesCache.get(ctx.sessionManager)!;
	const key = `${mode}:${includeContext}`;
	const cached = cache.messages.get(key);
	if (cached) return cached;
	const messages: ContextualPlaybackMessage[] = [];
	for (const entry of branch) {
		messages.push(...completedEntryMessages(ctx, entry, mode, includeContext));
	}
	cache.messages.set(key, messages);
	return messages;
}

function playbackTimingSnapshots(ctx: ExtensionContext, currentIds: Set<string>): Map<string, Map<string, PlaybackTimingSnapshot>> {
	// References to session-owned entries, not another unbounded decoded timing pool.
	const snapshots = new Map<string, Map<string, PlaybackTimingSnapshot>>();
	for (const entry of ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== PLAYBACK_TIMING_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("version" in data) || data.version !== 3) continue;
		const snapshot = data as PlaybackTimingSnapshot;
		if (!currentIds.has(snapshot.messageId) || typeof snapshot.renderKey !== "string" || !snapshot.renderKey ||
			!Number.isFinite(snapshot.duration) || snapshot.duration < 0 ||
			!Array.isArray(snapshot.checkpoints) || snapshot.checkpoints.length > 100_000) continue;
		let versions = snapshots.get(snapshot.messageId);
		if (!versions) snapshots.set(snapshot.messageId, versions = new Map());
		versions.set(snapshot.renderKey, snapshot);
	}
	return snapshots;
}

function sessionDeviceSelection(ctx: ExtensionContext): { selection: VoiceDeviceSelection; pin?: string; selected?: string } {
	let selection: VoiceDeviceSelection = "auto";
	let pin: string | undefined;
	let selected: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== DEVICE_SELECTION_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("selection" in data) || typeof data.selection !== "string") continue;
		if (data.selection === "auto" || data.selection === "local" || /^[a-zA-Z0-9._-]{1,128}$/.test(data.selection)) {
			selection = data.selection;
			selected = "selected" in data && typeof data.selected === "string" && data.selected !== "auto" && /^[a-zA-Z0-9._-]{1,128}$/.test(data.selected) ? data.selected : undefined;
			pin = "pin" in data && typeof data.pin === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(data.pin) ? data.pin : undefined;
		}
	}
	return { selection, pin, selected };
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
	return `[${Array.from({ length: width }, (_value, index) => (duration > 0 && index === cursor ? "●" : "━")).join("")}]`;
}

export default async function (pi: ExtensionAPI) {
	let config = await loadVoiceConfig();
	let activeContext: ExtensionContext | null = null;
	let interactiveVoiceSession = false;
	let coordinator: SessionCoordinator | null = null;
	const deviceRouter = new DeviceRouter();
	let deviceSelection: VoiceDeviceSelection = "auto";
	let activeDeviceId: string | undefined;
	let devicePin: string | undefined;
	let routing: DeviceRouting | undefined;
	let devicePoll: NodeJS.Timeout | undefined;
	let priorityWatch: FSWatcher | undefined;
	let routeFlight: Promise<void> | undefined;
	let routePending = false;
	let manualRouteRevision = 0;
	let manualRoutesPending = 0;
	let routeIntent: { request: number; context: number; playing: boolean } | undefined;
	const persistDevice = () => pi.appendEntry(DEVICE_SELECTION_ENTRY, { version: 2, selection: deviceSelection, selected: activeDeviceId, pin: devicePin });
	let ownsSpeech = false;
	let speechLeaseEpoch = 0;
	let speechLeaseGeneration: string | undefined;
	let speechPurpose: SpeechPurpose | undefined;
	let ownerTurnEnded = false;
	let lastOwnerUtterance: number | undefined;
	let projectPrefixUtterance: number | undefined;
	let completedOwnerUtterance: number | undefined;
	let ownerContentExpected = false;
	let speechReservedForInput = false;
	let projectAnnouncementPending = false;
	type PendingNotification = { waiting: WaitingSession; utterance?: number; epoch: number; context: number;
		endpoint: string; generation?: number; finish: (current: boolean) => void; admit?: () => void };
	let pendingNotification: PendingNotification | undefined;
	let pausedAnnouncementResume: (PlaybackResumeSnapshot & { source?: typeof liveSource }) | undefined;
	const cancelWaitingAnnouncement = (): void => {
		const pending = pendingNotification;
		pendingNotification = undefined;
		pending?.finish(false);
	};
	let playingSource: typeof liveSource;
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
	let liveSource: { assistant: unknown; final: boolean; before: Message[]; existingEntries: Set<string>; waiters: Set<() => void>; blockIds: Map<number, string> } | undefined;
	let liveBlockIndex: number | undefined;
	let liveBlockIds = new Map<number, string>();
	let waitingSource: typeof liveSource;
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
	let attentionPollTimer: NodeJS.Timeout | null = null;
	let attentionPreparation: { epoch: number } | undefined;
	let voiceWorkerIdleTimer: NodeJS.Timeout | null = null;
	let handleCoordinatedIdle: (utterance: number | undefined) => void = () => {};
	let playRequestedAttention: (ctx: ExtensionContext, request: AttentionRequest) => void = () => {};
	let releaseSpeechOwnership: (announceNext?: boolean) => void = () => {};
	let deferredRelease: { input: number; lease: number; context: number; announceNext: boolean;
		loan?: { owner: SessionCoordinator; generation: string | undefined; stopping: boolean } } | undefined;
	let flushDeferredRelease = (): void => {};
	let pendingSpeechPreemption:
		| { purpose: SpeechPurpose | undefined; wasComplete: boolean; spokenText: string; cancelId?: number; request: number; context: number; input: number }
		| undefined;
	let finishSpeechPreemption: () => void = () => {};
	const transportCancelWaiters = new Map<number, () => void>();
	let state: VoiceState = "idle";
	let lastError = "";
	type StopEpisode = { notified: boolean; device: string; cause: string; utterance?: number; remote?: boolean; cancelled?: boolean };
	type StopCleanup = { promise: Promise<void>; episode?: StopEpisode };
	const stopResources: Record<"input" | "output", { episode?: StopEpisode; cleanup?: StopCleanup }> = { input: {}, output: {} };
	let stopRecovery: StopRecovery | undefined;
	let orphanRecovery: StopRecovery | undefined;
	let orphanRecoveryOwner: string | undefined;
	let orphanRecoveryLease: ReturnType<SessionCoordinator["speechOwner"]>;
	let orphanRecoveryBlocked = false;
	let automaticRecoveryTimer: NodeJS.Timeout | undefined;
	let automaticRecoveryFlight: Promise<void> | undefined;
	let automaticRecoveryWork: Promise<void> | undefined;
	let automaticRecoveryEpoch = 0;
	let automaticRecoveryDelay = 3_000;
	let automaticRecoveryEnabled = false;
	let scheduleAutomaticRecovery = (): void => {};
	const cancelAutomaticRecovery = (): void => {
		automaticRecoveryEnabled = false;
		automaticRecoveryEpoch++;
		clearTimeout(automaticRecoveryTimer);
		automaticRecoveryTimer = undefined;
	};
	const inheritedStops: Partial<Record<"input" | "output", StopEpisode>> = {};
	const recoveryRoutes = { input: new Map<string, { selection: string; configured: string; device: string }>(), output: new Map<string, { selection: string; configured: string; device: string }>() };
	const captureRecoveryRoute = (direction: "input" | "output", route: ReturnType<DeviceRouter["routeMetadata"]>): void => {
		recoveryRoutes[direction].set(route.endpoint, { selection: route.kind === "device" ? route.device.id : "local", configured: config[direction], device: route.kind === "device" ? route.device.name : selectedDeviceLabel });
	};
	const retainRecoveryHandle = (direction: "input" | "output", endpoint: string, id: string, bootId?: string | null, rebootSafe?: boolean, deviceId?: string, desktopWait?: true, networkAdmission?: true, nativeWatchdog?: true): void => {
		if (!stopRecovery || (!/^(tcp|unix):\/\//.test(endpoint) && !(direction === "input" && endpoint === "local"))) {
			throw new Error("Recovery journal unavailable; dispatch denied");
		}
		const route = recoveryRoutes[direction].get(endpoint);
		if (!route) throw new Error("Original recovery route not captured; ownership retained");
		stopRecovery.retain(direction, { endpoint, id, selection: route.selection, configured: route.configured, ...(bootId !== undefined ? { bootId } : {}), ...(desktopWait ? { desktopWait } : {}), ...(networkAdmission ? { networkAdmission } : {}), ...(nativeWatchdog ? { nativeWatchdog } : {}), ...(rebootSafe === true && route.configured === "auto" && deviceId === route.selection && deviceId !== "local" && deviceId !== "legacy-loopback" ? { rebootSafe } : {}) }, route.device);
	};
	const restoreStopRecovery = (initialize = false): void => {
		const previousRecovery = orphanRecovery;
		const previousOwner = orphanRecoveryOwner;
		const previousLease = orphanRecoveryLease;
		const previousStops = { ...inheritedStops };
		orphanRecovery = undefined;
		orphanRecoveryOwner = undefined;
		orphanRecoveryLease = undefined;
		orphanRecoveryBlocked = false;
		delete inheritedStops.input;
		delete inheritedStops.output;
		if (!coordinator) return;
		if (initialize) stopRecovery = coordinator.recovery;
		const owner = coordinator.speechOwner();
		if (!owner || owner.instanceId === coordinator.instanceId) return;
		if (coordinator.recoverIdleSpeech(owner)) return;
		try { process.kill(owner.pid, 0); return; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
		orphanRecoveryBlocked = true;
		orphanRecoveryOwner = owner.instanceId;
		orphanRecoveryLease = owner;
		try { orphanRecovery = previousRecovery && previousOwner === owner.instanceId && previousLease?.speechGeneration === owner.speechGeneration
			? previousRecovery : new StopRecovery(coordinator.root, owner.instanceId); }
		catch (error) { notifyStopFailure(error); }
		for (const direction of ["input", "output"] as const) {
			if (orphanRecovery?.isIdle(direction)) continue;
			const saved = orphanRecovery?.episode(direction);
			inheritedStops[direction] = { device: saved?.device ?? "Previous voice owner", cause: saved?.cause ?? "Interrupted transport coverage unavailable; ownership retained",
				notified: previousOwner === orphanRecoveryOwner &&
					JSON.stringify(previousRecovery?.episode(direction)?.handles) === JSON.stringify(saved?.handles) && !!previousStops[direction]?.notified };
		}
		deviceRetryRequired = true;
	};
	const retryStopRecovery = async (locked = false): Promise<void> => {
		if (!orphanRecoveryBlocked) return;
		const owner = coordinator;
		const lease = orphanRecoveryLease;
		if (!locked && owner && lease && owner.canRecoverSpeech(lease)) {
			return owner.withSpeechRecovery(lease, async () => {
				orphanRecovery = new StopRecovery(owner.root, lease.instanceId);
				await retryStopRecovery(true);
			});
		}
		if (orphanRecovery) {
			await Promise.allSettled((["input", "output"] as const).map(async direction => {
				try { await orphanRecovery!.retry(direction, deviceRouter, config[direction]); }
				catch (error) {
					const diagnostic = inheritedStops[direction];
					if (diagnostic) diagnostic.cause = error instanceof Error ? error.message : String(error);
					notifyStopFailure(error, diagnostic);
					return;
				}
				const saved = orphanRecovery!.episode(direction);
				if (saved && inheritedStops[direction]) inheritedStops[direction]!.cause = saved.cause;
			}));
		}
		if (orphanRecoveryLease && coordinator?.recoverIdleSpeech(orphanRecoveryLease)) {
			restoreStopRecovery();
			refreshProgressWidget();
			return;
		}
		refreshProgressWidget();
		const unknownCoverage = !orphanRecovery || (["input", "output"] as const).some(direction => !orphanRecovery!.isIdle(direction) && !orphanRecovery!.isCovered(direction));
		const pendingReceipts = orphanRecovery && (["input", "output"] as const).some(direction => orphanRecovery!.isCovered(direction));
		const error = new Error(`${unknownCoverage
			? "Interrupted transport coverage remains unproven. Ownership retained; reconnect cannot reconstruct missing admission evidence."
			: pendingReceipts
				? "Admission coverage complete; scoped stop receipts still pending. Ownership retained."
				: "Stop receipts complete; ownership release remains unconfirmed."} Preserve the original device receipts and see docs/troubleshooting.md#unconfirmed-stop; restarting or deleting the fence is not stop proof.`);
		notifyStopFailure(error);
		throw error;
	};
	const beforePhysicalIO = (direction: "input" | "output"): void => {
		if (!coordinator?.ownsSpeech() || stopRecovery !== coordinator.recovery) {
			throw new Error("Physical voice IO requires the current durable owner");
		}
		if (direction === "output" && pendingNotification && !notificationIsCurrent()) {
			throw new Error("Waiting announcement superseded before output admission");
		}
		stopRecovery.beforeIO(direction, direction === "output" && /^(tcp|unix):\/\//.test(routedVoiceConfig().output), direction === "input");
	};
	const stopRecoveryAdvice = "preserve original device receipts; /voice reconnect can retry available stop proof, but cannot reconstruct missing same-boot guardian wait proof; see docs/troubleshooting.md#unconfirmed-stop";
	const reportedStopErrors = new WeakSet<object>();
	let stopDiagnostic = { cause: "", notified: false };
	const notifyStopFailure = (error: unknown, diagnostic?: { notified: boolean }): void => {
		if (error && typeof error === "object") {
			if (reportedStopErrors.has(error)) {
				if (diagnostic) diagnostic.notified = true;
				return;
			}
			reportedStopErrors.add(error);
		}
		const cause = error instanceof Error ? error.message : String(error);
		if (stopDiagnostic.cause !== cause) stopDiagnostic = { cause, notified: false };
		notifyVoice(activeContext, `Stop unconfirmed; ownership retained: ${cause} · ${stopRecoveryAdvice}`, "error", diagnostic ?? stopDiagnostic);
		stopDiagnostic.notified = true;
	};
	const stopsUnresolved = (): boolean => Object.values(stopResources).some(resource => resource.episode || resource.cleanup);
	const retireStopHandle = (resource: "input" | "output", id: string, endpoint?: string): void => {
		stopRecovery?.retire(resource, id, endpoint);
		const state = stopResources[resource];
		if (state.episode?.cancelled && !state.cleanup && !stopRecovery?.episode(resource)?.handles.length) {
			stopRecovery?.clear(resource);
			state.episode = undefined;
			finishSpeechPreemption();
			flushDeferredRelease();
			refreshProgressWidget();
		}
	};
	// Observe each resource, not Promise.all's first rejection. Only its latest
	// cleanup can prove its own episode resolved; a first late notice joins it.
	const trackStop = (resource: "input" | "output", promise: Promise<void>, automatic = false): Promise<void> => {
		const state = stopResources[resource];
		if (state.cleanup?.promise === promise) return promise;
		const device = selectedDeviceLabel;
		const cleanup: StopCleanup = { promise, episode: state.episode };
		if (state.episode) state.episode.cancelled = false;
		const journal = stopRecovery;
		state.cleanup = cleanup;
		void promise.then(() => {
			if (state.cleanup !== cleanup) return;
			// ACK proves cancellation, not individual remote releases. Only matching
			// receipts retire handles, including those admitted during this cleanup.
			const unresolved = journal?.episode(resource)?.handles.length;
			if (state.episode === cleanup.episode && journal === stopRecovery && !unresolved) {
				try { journal?.clear(resource); state.episode = undefined; }
				catch (error) {
					state.episode = { device, cause: String(error), notified: false };
					notifyStopFailure(error, state.episode);
				}
			} else if (!state.episode && journal === stopRecovery && unresolved) {
				state.episode = { device, cause: "Newer transport scope remains unconfirmed", notified: false };
			}
			if (journal === stopRecovery && state.episode && (state.episode === cleanup.episode || !cleanup.episode)) state.episode.cancelled = true;
			state.cleanup = undefined;
			if (!automatic) {
				finishSpeechPreemption();
				flushDeferredRelease();
			}
			refreshProgressWidget();
		}, error => {
			const cause = error instanceof Error ? error.message : String(error);
			const existing = cleanup.episode ?? state.episode;
			const episode = existing ?? { device, cause, notified: false };
			try { if (journal === stopRecovery && !journal?.isIdle(resource)) journal?.fail(resource, episode.device, automatic ? episode.cause : cause); } catch (error) { notifyStopFailure(error); }
			if (state.cleanup === cleanup) {
				if (state.episode === cleanup.episode) state.episode = episode;
				state.cleanup = undefined;
			}
			notifyStopFailure(error, episode);
			refreshProgressWidget();
			if (!existing) {
				automaticRecoveryDelay = 3_000;
				clearTimeout(automaticRecoveryTimer);
				automaticRecoveryTimer = undefined;
			}
			scheduleAutomaticRecovery();
		});
		return promise;
	};
	let inputInProgress = false;
	let inputEpoch = 0;
	let activeInputEndpoint: string | undefined;
	let inputPhase: InputPhase = "idle";
	let inputProgressTimer: NodeJS.Timeout | null = null;
	let inputProgressMessage: string | undefined;
	let inputStartedAt = 0;
	let contextEpoch = 0;
	let narrationTui: TUI | null = null;
	let narrationRenderTimer: NodeJS.Timeout | null = null;
	let livePlaybackId: string | undefined;
	let liveTurnNarrationActive = false;
	let nextLivePlaybackId = 0;
	let playbackPaused = false;
	let playbackTailIntent = false;
	let playbackTailSourceEnd = 0;
	let playbackPhase: PlaybackPhase = "idle";
	let queueIncomingWhilePaused = false;
	const queuedPausedMessages: Array<PlaybackTarget & { source: typeof liveSource }> = [];
	let pausedOwnerUtterance: number | undefined;
	let playbackRequestEpoch = 0;
	let pendingReplay:
		| {
				epoch: number;
				target: PlaybackTarget & { tailPrefix?: string; audioOffset?: PlaybackResumeSnapshot["audioOffset"] };
				recordTimings: boolean;
				previewTarget: boolean;
				restoreTail: boolean;
				paused: boolean;
				waiting: boolean;
				acquiring: boolean;
				explicit: boolean;
				rerouted: boolean;
				phase: PlaybackPhase;
				continueLiveTurn: boolean;
				source: typeof liveSource;
				blockIds: Map<number, string>;
				closedPrefix: boolean;
			}
		| undefined;
	let playbackTimelineTimer: NodeJS.Timeout | null = null;
	let codePreprocessingProgress: PreprocessingProgress | undefined;
	let timingPreprocessingProgress: PreprocessingProgress | undefined;
	const playbackHistory = new PlaybackHistory();
	let persistedTimingSnapshots = new Map<string, Map<string, PlaybackTimingSnapshot>>();
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
	// Runtime-only overflow results: retry after session reload, never on each timing sweep.
	const codeDescriptionFallbacks = new Map<string, CodeNarrationPlan>();
	// Retain the original render settings until its first missing dependencies resolve.
	const unresolvedRenders = new Map<string, { text: string; config: VoiceConfig; renderKey: string; dependencies: Array<{ key: string; value: string; missing: boolean }> }>();
	const resolveDescriptionDependency = (key: string, plan: CodeNarrationPlan): CodeNarrationPlan => {
		for (const [id, pending] of unresolvedRenders) {
			if (!pending.dependencies.some(dependency => dependency.key === key && dependency.missing)) continue;
			for (const dependency of pending.dependencies) if (dependency.key === key && dependency.missing) {
				dependency.value = JSON.stringify([key, plan.omitted ? "omitted" : plan]);
				dependency.missing = false;
			}
			const resolved = narrationRenderKey(pending.text, pending.config, pending.dependencies.map(dependency => dependency.value));
			playbackHistory.resolveRenderKey(id, pending.renderKey, resolved);
			pending.renderKey = resolved;
			if (!pending.dependencies.some(dependency => dependency.missing)) unresolvedRenders.delete(id);
		}
		return plan;
	};
	let scheduleMissingTimings: (ctx: ExtensionContext, force?: boolean) => void = () => {};

	let renderedNarrationSources = new Set<string>();
	const changedDescriptionCode = new Set<string>();
	let invalidateAllNarration = false;
	const invalidateNarration = (): void => {
		const sources = new Set(narration.sourceTexts);
		const affected = new Set([...renderedNarrationSources, ...sources]);
		const attached = invalidateNarrationMarkdown(narrationTui, affected, changedDescriptionCode);
		if (invalidateAllNarration || !attached) {
			narrationTui?.invalidate();
			// Assistant.invalidate rebuilds Markdown children; wrap the replacements.
			invalidateNarrationMarkdown(narrationTui, affected, changedDescriptionCode);
		}
		if (offscreenNarration) invalidateNarrationMarkdown({ children: [offscreenNarration.component] }, affected, changedDescriptionCode);
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
		// Forced rendering resets Pi's currentLayout and temporarily selects its
		// implicit fallback viewport instead of the real transcript ScrollView.
		narrationTui?.requestRender();
	};
	const narration = new NarrationProgress(requestNarrationRender);

	let outputEndpoint = "disabled";
	let outputGeneration: number | undefined;
	let inputEndpoint = "disabled";
	let inputGeneration: number | undefined;
	const routedVoiceConfig = (): VoiceConfig => ({
		...config,
		output: config.output === "auto" ? outputEndpoint : config.output,
		input: config.input === "auto" ? (activeInputEndpoint ?? "disabled") : config.input,
	});

	let verifiedOutputOrigin: { selection: string; configured: string; context: number; connection: ConnectionDevice } | undefined;
	const outputConnection = (route?: ReturnType<DeviceRouter["routeMetadata"]>): ConnectionDevice | undefined => {
		const selection = activeDeviceId ?? deviceSelection;
		if (verifiedOutputOrigin?.selection !== selection || verifiedOutputOrigin.configured !== config.output || verifiedOutputOrigin.context !== contextEpoch) {
			verifiedOutputOrigin = undefined;
		}
		try {
			route ??= deviceRouter.routeMetadata(selection, "output", config.output);
			const connection: ConnectionDevice | undefined = route.kind === "intentional_local" ? { kind: "intentional_local" }
				: route.kind === "device" ? { kind: "device", id: route.device.id } : undefined;
			verifiedOutputOrigin = connection ? { selection, configured: config.output, context: contextEpoch, connection } : undefined;
		} catch { /* Registry loss does not erase a verified origin for this selection/configuration. */ }
		return verifiedOutputOrigin?.connection;
	};

	const claimOutputDevice = (): VoiceConfig => {
		const selection = activeDeviceId ?? deviceSelection;
		const route = deviceRouter.routeMetadata(selection, "output", config.output);
		outputConnection(route);
		captureRecoveryRoute("output", route);
		outputEndpoint = route.endpoint;
		outputGeneration = route.kind === "device" ? route.device.connectedAt : undefined;
		if (route.kind === "device") deviceRouter.claim(selection);
		const routed = routedVoiceConfig();
		refreshStatus();
		return routed;
	};

	let selectedDeviceLabel = "no device";
	let progressComponent: ReturnType<typeof deviceProgressComponent> | undefined;
	let progressComponentEpoch: number | undefined;
	let voiceStatusLine: string | undefined;
	let progressWidgetKey: string | undefined;
	let progressRender: (() => void) | undefined;
	let handoffConnecting = false;
	let jumpWidgetVisible = false;
	let displayedCodeProgress: PreprocessingProgress | undefined;
	let displayedTimingProgress: PreprocessingProgress | undefined;
	let preprocessingPaint: ReturnType<typeof setTimeout> | undefined;
	const playbackTimeline = (ctx: ExtensionContext) => {
		// Count raw eligible sources, never the timing/identity-hydrated selection prefix.
		const completed = completedAssistantMessages(ctx, config.mode);
		const sourceBlocks = liveSource ? eligibleAssistantBlocks(liveSource.assistant, config.mode).filter(block => hasSpeakableAudio(block.text)) : [];
		const sourceIds = new Map([...liveBlockIds].filter(([index]) => sourceBlocks.some(block => block.contentIndex === index)));
		const provisional = livePlaybackId ?? playbackHistory.status(vocalizer.playbackUtterance)?.messageId;
		if (!sourceIds.size && sourceBlocks.length && provisional?.startsWith("live:")) {
			sourceIds.set(sourceBlocks[0].contentIndex, provisional);
		}
		const liveIds = (liveSource && !liveSource.final) || pendingCanonicalizations.size ? [...sourceIds.values()] : [];
		// Session insertion can precede canonicalization. Resolve aliases for counting
		// without preparing render identities or disturbing the audible capture.
		const aliases = new Map<string, string>();
		if (liveSource) for (const [index, id] of sourceIds) {
			const saved = completed.findLast(message => message.contentIndex === index &&
				!liveSource!.existingEntries.has(message.entryId) &&
				message.text === sourceBlocks.find(block => block.contentIndex === index)?.text);
			if (saved) aliases.set(id, saved.id);
		}
		const timeline = [...new Set([...completed.map(message => message.id), ...liveIds.map(id => aliases.get(id) ?? id)])];
		return { completed, timeline, aliases, hasLiveContent: sourceBlocks.length > 0 };
	};

	// Audio can catch up before the model finishes or the session saves its source.
	// Keep forward navigation and the waiting counter on the same chronology.
	const playbackTailState = (ctx: ExtensionContext, snapshot = playbackTimeline(ctx)) => {
		const latest = snapshot.timeline.at(-1);
		const canonical = (id: string | undefined) => id === undefined ? undefined : snapshot.aliases.get(id) ?? id;
		const explicit = navigationTail !== undefined && canonical(navigationTail.id) === latest;
		const announcedBoundary = !!pendingNotification && ownerTurnEnded && lastOwnerUtterance !== undefined && completedOwnerUtterance === lastOwnerUtterance;
		const drained = liveTurnNarrationActive && (playbackPhase === "idle" || announcedBoundary) &&
			((!snapshot.hasLiveContent && lastOwnerUtterance === undefined && narration.sourceEnd === 0) ||
				(canonical(playbackHistory.selected()?.id) === latest && lastOwnerUtterance !== undefined &&
					completedOwnerUtterance === lastOwnerUtterance && narration.consumedSourceEnd >= narration.sourceEnd));
		const waiting = !speechBlocked && !pausedForAttention && !pendingReplay && !attentionSuppressed &&
			(drained || (explicit && playbackTailIntent && (lastOwnerUtterance === undefined || announcedBoundary) &&
				(!liveTurnNarrationActive || playbackTailSourceEnd >= narration.sourceEnd)));
		return { atTail: explicit || drained, waiting };
	};

	const refreshProgressWidget = (paintPreprocessing = false): void => {
		const ctx = activeContext;
		if (!ctx) return;
		try {
			const snapshot = playbackTimeline(ctx);
			const { completed, timeline, aliases } = snapshot;
			const unreadWaiting = (speechBlocked && blockedMessageHasSpeech) || (pausedForAttention && !!waitingSource);
			const activePlayback = handoffConnecting || playbackPaused || (!inputInProgress && !attentionSuppressed && (unreadWaiting || !!pendingReplay || !!pendingNotification || playbackTailIntent ||
				(ownsSpeech && (speechPurpose === "turn" || speechPurpose === "replay") &&
					(!ownerTurnEnded || (lastOwnerUtterance !== undefined && completedOwnerUtterance !== lastOwnerUtterance)))));
			const waitingAtTail = playbackTailState(ctx, snapshot).waiting;
			const tailMessages = waitingAtTail ? completed : [];
			const tailId = waitingAtTail ? timeline.at(-1) : undefined;
			const blockedUnread = unreadWaiting && vocalizer.playbackUtterance === undefined && !playbackPaused && !pendingReplay && !inputInProgress;
			if (liveTurnNarrationActive && !playbackPaused && !pendingReplay && !blockedUnread) {
				playbackHistory.selectCapture(vocalizer.playbackUtterance);
			}
			const historyStatus = blockedUnread ? undefined : playbackHistory.status(playbackPaused || pendingReplay || pendingNotification ? undefined : vocalizer.playbackUtterance);
			const playback = config.enabled ? (waitingAtTail && historyStatus && ((!playbackPaused && historyStatus.messageId !== tailId) || historyStatus.position < historyStatus.duration) ? undefined : historyStatus) ?? (activePlayback ? {
				messageId: blockedUnread ? livePlaybackId ?? (liveSource?.final ? completed.at(-1)?.id : undefined) ?? "" : waitingAtTail ? tailId ?? "" : pendingReplay?.target.id ?? playbackHistory.selected()?.id ?? livePlaybackId ?? "", position: 0, duration: 0,
				messageIndex: tailId?.startsWith("live:") ? -1 : tailMessages.length - 1, messageCount: tailMessages.length, hasTimings: false, timingsComplete: false, wordTimingCoverage: undefined,
			} : undefined) : undefined;
			let playbackLine: string | undefined;
			if (playback) {
				playback.messageIndex = timeline.indexOf(aliases.get(playback.messageId) ?? playback.messageId);
				playback.messageCount = timeline.length;
				const phase = handoffConnecting ? "connecting" : playbackPaused || pendingReplay?.paused ? "paused"
					: pendingReplay?.waiting ? pendingReplay.phase : activePlayback ? (blockedUnread || playbackPhase === "idle" || playbackPhase === "paused" ? "queued" : playbackPhase) : "idle";
				const labels: Record<PlaybackPhase, string> = { idle: "○ Idle", playing: "▶ Playing", paused: "⏯ Paused",
					synthesizing: "◷ Synthesizing", loading: "◷ Loading", describing: "◷ Describing", connecting: "◷ Connecting", queued: "◷ Queued" };
				const latest = liveSource && !liveSource.final ? [...liveBlockIds.values()].at(-1) ?? livePlaybackId
					: completed.at(-1)?.id;
				// Playback chronology, never the transcript viewport or Alt+T follow setting.
				const live = activePlayback && !handoffConnecting && !speechBlocked && !unreadWaiting && !playbackPaused && !pendingReplay?.paused &&
					(waitingAtTail || !latest || playback.messageId === latest || !playback.messageId || (pendingCanonicalizations.size > 0 && [...liveBlockIds.values()].at(-1) === playback.messageId)) &&
					!pendingReplay && (playbackPhase === "idle" || (pendingNotification && waitingAtTail)) && (waitingAtTail || ((playbackTailIntent || (liveTurnNarrationActive && !ownerTurnEnded)) &&
						Math.max(narration.consumedSourceEnd, playbackTailIntent ? playbackTailSourceEnd : 0) >= narration.sourceEnd)) && playback.position >= playback.duration;
				const known = playback.hasTimings && playback.timingsComplete && playback.duration > 0 &&
					!(liveSource && !liveSource.final && [...liveBlockIds.values()].includes(playback.messageId));
				const time = live ? ctx.ui.theme.fg("error", "● live")
					: known ? `${formatPlaybackTime(playback.position)} / ${formatPlaybackTime(playback.duration)}`
					: playback.hasTimings || playback.position > 0 ? formatPlaybackTime(playback.position) : "--:--";
				const nextAtTail = live && waitingAtTail && !playbackPaused;
				const message = nextAtTail ? `${timeline.length + 1}/${timeline.length}`
					: playback.messageIndex >= 0 ? `${playback.messageIndex + 1}/${playback.messageCount}` : "current response";
				playbackLine = `${labels[live ? "playing" : phase]} ${playbackBar(playback.position, known ? playback.duration : 0)} ${time} · ${message}${!known && !live ? " · timing pending" : ""}`;
			}
			if (paintPreprocessing) {
				displayedCodeProgress = codePreprocessingProgress ?? (codeDescriptionPreprocessing ? displayedCodeProgress : undefined);
				displayedTimingProgress = timingPreprocessingProgress ?? (timingPreprocessing ? displayedTimingProgress : undefined);
			}
			const preprocessing = [displayedCodeProgress, displayedTimingProgress].filter(
				(progress): progress is PreprocessingProgress => progress !== undefined,
			);
			const lines = voiceProgressLines(inputProgressMessage, playbackLine, preprocessing,
				{ input: stopResources.input.episode ?? inheritedStops.input, output: stopResources.output.episode ?? inheritedStops.output }).map(line =>
				line.kind === "input"
					? line.text
					: ctx.ui.theme.fg(line.kind === "stop" ? "warning" : line.kind === "playback" && state === "speaking" ? "accent" : "dim", line.text),
			);
			if (config.enabled && voiceStatusLine && (!lines.length || transportStopPending || routeIntent || deviceRetryRequired ||
				pausedForAttention || state === "error")) lines.splice(1, 0, voiceStatusLine);
			const canJump = config.enabled && ownsSpeech && narration.activeWordStart !== undefined;
			if (canJump !== jumpWidgetVisible) {
				ctx.ui.setWidget("pi-voice-jump", canJump ? (_tui, theme) =>
					narrationJumpButton(text => theme.fg("accent", text), () => scrollToNarration(ctx)) : undefined,
					{ placement: "belowEditor" });
				jumpWidgetVisible = canJump;
			}
			const key = JSON.stringify([contextEpoch, lines, selectedDeviceLabel]);
			if (key === progressWidgetKey) return;
			const name = selectedDeviceLabel;
			const uiEpoch = contextEpoch;
			if (progressComponentEpoch !== uiEpoch) {
				progressComponent?.invalidate();
				progressComponent = undefined;
				progressRender = undefined;
			}
			progressComponentEpoch = uiEpoch;
			progressComponent?.update(lines, name);
			const component = progressComponent ?? deviceProgressComponent(lines, name, () => {
				if (uiEpoch === contextEpoch && interactiveVoiceSession) void pickDevice(ctx);
			});
			progressComponent = component;
			if (!progressRender && component) {
				ctx.ui.setWidget("pi-voice-progress", tui => {
					progressRender = () => tui.requestRender();
					return component;
				}, { placement: "belowEditor" });
			} else progressRender?.();
			progressWidgetKey = key;
		} catch {
			// The active context can become stale just before session shutdown runs.
		}
	};

	const refreshPreprocessingProgress = (): void => {
		// Show the first job immediately; keep its row through preparation gaps
		// and paint replacements/settlement on the existing 80 ms UI cadence.
		refreshProgressWidget(!displayedCodeProgress && !displayedTimingProgress && !!(codePreprocessingProgress || timingPreprocessingProgress));
		if (preprocessingPaint) return;
		preprocessingPaint = setTimeout(() => {
			preprocessingPaint = undefined;
			refreshProgressWidget(true);
		}, 80);
		preprocessingPaint.unref?.();
	};

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

	const sourceKeys = new WeakMap<FencedCodeBlock, { context: IdentityContext; settings: string; identity: string; legacySettings?: string; legacy?: string[] }>();
	const descriptionCacheKey = (ctx: ExtensionContext, block: FencedCodeBlock, identityContext: IdentityContext): string => {
		let serialized: string | undefined;
		const context = () => serialized ??= typeof identityContext === "function" ? identityContext() : identityContext;
		const settings = `${config.codeNarration}:${config.codeDescriptionContext}`;
		let memo = sourceKeys.get(block);
		if (!memo || memo.context !== identityContext || memo.settings !== settings) {
			memo = { context: identityContext, settings, identity: codeDescriptionCacheKey(ctx, block, config.editModel,
				config.codeNarration, config.codeDescriptionContext === "conversation" ? context() : "", config.codeDescriptionContext) };
			sourceKeys.set(block, memo);
		}
		const identity = memo.identity;
		return codeDescriptionCache.resolveKey(identity, () => {
			const legacySettings = createHash("sha256").update(JSON.stringify([contextEpoch, config.editModel, ctx.model?.provider, ctx.model?.id,
				codeDescriptionUsesActivePrompt(ctx, config.editModel) ? [ctx.getSystemPrompt(), activePromptTools()] : null])).digest("hex");
			if (memo.legacySettings !== legacySettings) {
				// Completed contexts expose old serialization lazily; retain only derived hashes.
				const legacyContext = config.codeDescriptionContext === "conversation" && typeof identityContext === "function"
					? (identityContext as (() => string) & { legacy?: () => string }).legacy?.()
					: undefined;
				memo.legacy = [];
				if (legacyContext !== undefined) memo.legacy.push(codeDescriptionCacheKey(ctx, block, config.editModel,
					config.codeNarration, legacyContext, config.codeDescriptionContext));
				for (const candidate of legacyContext === undefined ? [context()] : [legacyContext, context()]) {
					try {
						memo.legacy.push(legacyCodeDescriptionCacheKey(ctx, block, config.editModel, config.codeNarration,
							contextualCodeDescription(ctx, candidate), config.codeDescriptionContext));
					} catch { /* Source-key adoption does not require an available generator. */ }
				}
				memo.legacySettings = legacySettings;
			}
			return memo.legacy!;
		}, snapshot => {
			pendingCodeDescriptions.set(snapshot.key, snapshot);
			scheduleDescriptionPersistence();
		});
	};

	const isCurrentContext = (ctx: ExtensionContext): boolean =>
		activeContext?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId();

	const requestCodeDescription = async (
		ctx: ExtensionContext,
		block: FencedCodeBlock,
		identityContext: IdentityContext,
		providerMessagesThroughBlock: readonly Message[],
		options?: { chargeBackfill?: () => boolean; signal?: AbortSignal; background?: boolean; allowPaused?: boolean; onActivity?: (active: boolean) => void },
): Promise<CodeNarrationPlan> => {
		const fallback = plainCodeNarration(fallbackCodeDescription(block));
		const requestEpoch = contextEpoch;
		let resolvedKey: string | undefined;
		let lastOverflowModel = "";
		try {
			const key = descriptionCacheKey(ctx, block, identityContext);
			resolvedKey = key;
			const cached = codeDescriptionCache.get(key) ?? codeDescriptionFallbacks.get(key);
			if (cached) return resolveDescriptionDependency(key, cached);
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
					(signal, onActivity) => {
						// Every provider attempt is metered; cache hits and coalesced
						// duplicates never reach describeCodeBlock at all.
						const generate = () => {
							if (options?.background && ((ownsSpeech && !(options.allowPaused && playbackPaused)) || (attentionSuppressed && !deviceRetryRequired))) throw BACKGROUND_DEFERRED;
							return describeCodeBlock(
								ctx,
								block,
								editModel,
								narrationMode,
								conversation,
								signal,
								{
									onActivity,
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
						};
						return coordinator
							? coordinator.withResource("code", config.codeDescriptionPreprocessConcurrency, generate, signal)
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
					// Live/replay callers must not inherit a historical caller's budget rejection.
					options?.chargeBackfill ? undefined : error =>
						requestEpoch === contextEpoch && isCurrentContext(ctx) &&
						(error === BACKGROUND_DEFERRED || error === BACKFILL_EXHAUSTED || error instanceof CodeDescriptionBudgetExhaustedError),
					options?.signal,
					options?.onActivity,
				)
				.then(plan => {
					if (requestEpoch === contextEpoch && isCurrentContext(ctx) && !plan.omitted) {
						codeDescriptionText.set(key, descriptionText(plan));
						requestNarrationRender(block.code);
					}
					return requestEpoch === contextEpoch && isCurrentContext(ctx) ? resolveDescriptionDependency(key, plan) : plan;
				});
		} catch (outerError) {
			if (options?.signal?.aborted || outerError === BACKGROUND_DEFERRED) throw outerError;
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
							notifyVoice(ctx,
								`Local code narration · ${lastOverflowModel} has insufficient context`,
								"warning",
							);
						}
					} catch {
						// Session replacement can invalidate the captured UI before generation settles.
					}
				}
				codeDescriptionFallbacks.set(resolvedKey, fallback);
				return resolveDescriptionDependency(resolvedKey, fallback);
			}
			// Cache the omission so neither speech nor preprocessing repeats the cost.
			const reason = classifyCodeDescriptionFailure(outerError) === "quality" ? "quality" : "provider";
			codeDescriptionOmissions.set(resolvedKey, {
				reason,
				message: String(outerError instanceof Error ? outerError.message : outerError).slice(0, 200),
			});
			requestNarrationRender(block.code);
			return resolveDescriptionDependency(resolvedKey, { records: [], guided: false, omitted: true });
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
				{ chargeBackfill: chargeBackfillUnit, background: true, allowPaused: true },
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
	const BACKGROUND_DEFERRED = new Error("Code description cancelled for foreground speech");

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
		if (codeDescriptionPreprocessing || ownsSpeech || (attentionSuppressed && !deviceRetryRequired)) return;
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
			// Warm raw history in bounded slices too, without resetting resolved render identities.
			for (const entry of completedBranch(ctx)) {
				if (performance.now() - sliceStart >= 8) {
					await new Promise<void>(resolve => setImmediate(resolve));
					sliceStart = performance.now();
				}
				if (epoch !== contextEpoch || workEpoch !== codeWorkEpoch || !isCurrentContext(ctx)) return;
				completedEntryMessages(ctx, entry, config.mode, config.codeDescriptionContext === "conversation");
			}
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
				const missing = [...keyedBlocks].filter(([key]) => !codeDescriptionCache.get(key) && !codeDescriptionFallbacks.has(key) && !codeDescriptionOmissions.has(key)).map(([, item]) => item);
				missingBlocks += missing.length;
				if (missing.length === 0) processedMessages += 1;
				else queuedMessages.push(missing);
			}
			if (queuedMessages.length === 0) return;
			codePreprocessingProgress = {
				label: "Preparing code descriptions",
				processed: processedMessages,
				total: totalMessages,
				unit: "processed",
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
					if (epoch !== contextEpoch || workEpoch !== codeWorkEpoch || !isCurrentContext(ctx) || ownsSpeech || (attentionSuppressed && !deviceRetryRequired)) return;
					try {
						await requestCodeDescription(ctx, item.block, item.identityContext, item.providerMessagesThroughBlock, { chargeBackfill: chargeBackfillUnit, background: true });
					} catch (error) {
						if (error === BACKFILL_EXHAUSTED || error instanceof CodeDescriptionBudgetExhaustedError) {
							if (!backfillExhaustionReported) {
								backfillExhaustionReported = true;
								notifyVoice(ctx,
									`Descriptions blocked · budget ${backfillAllowance} requests used; /voice code-budget <n|unlimited> to authorize more`,
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
					label: "Preparing code descriptions",
					processed: processedMessages,
					total: totalMessages,
					unit: "processed",
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
		if (ownsSpeech || (attentionSuppressed && !deviceRetryRequired)) return;
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
						return `Voice · Description omitted (${omissionRecord?.reason ?? "failed"}) · ↺ /voice code-retry current; historical for older messages.`;
					}
					const plan = codeDescriptionCache.get(key) ?? codeDescriptionFallbacks.get(key);
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
			config.enabled ? narration.activeMarker : "",
		);

	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "user" ? markdown : transformNarrationMarkdown(markdown, context.messageType),
	);

	const refreshPlaybackTimeline = refreshProgressWidget;

	/** Explicit actions anchor at 20%; continuation follows the 20–80% band until manual browsing. */
	let lastAutoScrollTop: number | undefined;
	let autoScrollForceOnce = false;
	let narrationManuallyFramed = false;
	// Explicit Voice framing and native End must not be mistaken for manual browsing.
	let framingIntent = 0;
	let nativeGestureTracking = false;
	let pinnedContentHeight = 0;
	let lastNarrationLayout = "";
	let restoreBottomAfterSpeech = false;
	let bottomPinned = false;
	let atTranscriptTail = false;
	// The chronological cursor's Tail is distinct from the viewport following its end.
	let navigationTail: { id?: string } | undefined;
	let followHintVisible = false;
	const markdownLineCache = new Map<string, number>();
	let belowCacheKey = "";
	let belowCacheValue = 0;
	let narrationMessageAnchor:
		| {
				messageId: string;
				text: string;
				activeMarker: string;
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

	let offscreenNarration: { text: string; component: Markdown } | undefined;
	const renderedNarrationMarkerLine = (text: string, width: number): number => {
		if (!text) return -1;
		try {
			if (offscreenNarration?.text !== text) {
				offscreenNarration = { text, component: withNarrationLayout(new Markdown(text, 1, 0, getMarkdownTheme(), undefined, {
					transform: source => transformNarrationMarkdown(source, "assistant"),
				})) };
			}
			return offscreenNarration.component.render(width).findIndex(line => line.includes(narration.activeMarker));
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
		if (explicit) framingIntent++;
		if (!explicit) {
			if (!nativeGestureTracking && lastAutoScrollTop !== undefined && activeScrollView()?.scrollTop !== lastAutoScrollTop && !transcriptIsFollowingEnd()) {
				narrationManuallyFramed = true;
				restoreBottomAfterSpeech = false;
			}
			if (narrationManuallyFramed) return;
		}
		narrationManuallyFramed = false;
		narrationMessageAnchor = undefined;
		atTranscriptTail = false;
		bottomPinned = false;
		lastAutoScrollTop = activeScrollView()?.scrollTop;
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
			notifyVoice(ctx, "Scroll-to-bottom unavailable in this runtime; use Pi's native End", "warning");
			return;
		}
		scrollView.scrollToEnd();
		recordBottomPin();
	};

	const recordBottomPin = (): void => {
		framingIntent++;
		const scrollView = activeScrollView();
		if (!scrollView) return;
		pinnedContentHeight = scrollView.contentHeight ?? 0;
		narrationManuallyFramed = false;
		atTranscriptTail = true;
		bottomPinned = ownsSpeech;
		restoreBottomAfterSpeech ||= ownsSpeech;
		lastAutoScrollTop = scrollView.scrollTop;
		autoScrollForceOnce = false;
		hideFollowHint();
	};

	const requestNarrationAutoScroll = (allowPaused = false, force = false,
		frame?: { view: NonNullable<ReturnType<typeof activeScrollView>>; box: NarrationLayoutBox }): void => {
		const scrollView = frame?.view ?? activeScrollView();
		if (!scrollView || typeof scrollView.scrollTo !== "function") return;
		const layout = `${frame?.box.rect.width ?? narrationViewportWidth()}:${scrollView.viewportHeight}:${scrollView.contentHeight}`;
		const layoutChanged = layout !== lastNarrationLayout;
		lastNarrationLayout = layout;
		if (layoutChanged) narrationMessageAnchor = undefined;
		if (bottomPinned && transcriptIsFollowingEnd()) {
			// Explicit End waits for output growth; automatic arrival rechecks every layout change.
			if (playbackPaused || ((atTranscriptTail || !layoutChanged) && (scrollView.contentHeight ?? 0) <= pinnedContentHeight)) return;
			bottomPinned = false;
			atTranscriptTail = false;
			lastAutoScrollTop = scrollView.scrollTop;
		} else if (!nativeGestureTracking && lastAutoScrollTop !== undefined &&
			(!layoutChanged || (!transcriptIsFollowingEnd() && scrollView.scrollTop !== Math.min(lastAutoScrollTop,
				Math.max(0, (scrollView.contentHeight ?? Infinity) - scrollView.viewportHeight)))) &&
			isManualScrollAway({ scrollTop: scrollView.scrollTop, viewportHeight: scrollView.viewportHeight,
				contentHeight: scrollView.contentHeight ?? 0 }, lastAutoScrollTop)) {
			narrationManuallyFramed = true;
			autoScrollForceOnce = false;
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
		const outerWidth = frame?.box.rect.width ?? narrationViewportWidth();
		const innerWidth = Math.max(
			1,
			Math.min(outerWidth, scrollView.getContentWidth?.(outerWidth) ?? outerWidth - 2),
		);
		const selected = playbackHistory.selected();
		// The selected capture follows audible playback, not the newest generated block.
		const isLive = liveTurnNarrationActive && !selected;
		const text = selected?.text ?? ownedSpeechText;
		const messageId = selected?.id;
		const wordStart = narration.activeWordStart;
		let anchor: number | undefined;
		if (frame) {
			const markedLine = frame.box.scrollContentLines?.findIndex(line => line.includes(narration.activeMarker)) ?? -1;
			const sourceLine = markedLine < 0 ? narrationSourceLine(frame.box, text) : undefined;
			anchor = markedLine >= 0 ? markedLine : sourceLine;
			// An absent/collapsed source is not permission to follow unrelated tail text.
			if (anchor === undefined) return;
			// Layout-only movement can change a message's top without changing total height.
			const previous = narrationMessageAnchor;
			if (previous) narrationMessageAnchor = markedLine >= 0 && previous.text === text &&
				previous.messageId === messageId && previous.activeMarker === narration.activeMarker &&
				previous.width === innerWidth && previous.wordStart === wordStart && previous.localMarkerLine !== undefined
				? { ...previous, messageTop: markedLine - previous.localMarkerLine,
					contentHeight: resolvedContentHeight, viewportHeight: scrollView.viewportHeight } : undefined;
		}
		const canCacheMessageTop = !frame && scrollView.piVoiceCacheNarrationLayout !== false;
		const cached =
			canCacheMessageTop &&
			messageId &&
			narrationMessageAnchor?.messageId === messageId &&
			narrationMessageAnchor.text === text &&
			narrationMessageAnchor.activeMarker === narration.activeMarker &&
			narrationMessageAnchor.width === innerWidth &&
			narrationMessageAnchor.contentHeight === resolvedContentHeight &&
			narrationMessageAnchor.viewportHeight === scrollView.viewportHeight
				? narrationMessageAnchor
				: undefined;
		const localMarkerLine = frame ? -1 :
			cached && cached.wordStart === wordStart && cached.localMarkerLine !== undefined
				? cached.localMarkerLine
				: renderedNarrationMarkerLine(text, innerWidth);
		const cachedMessageTop = cached?.messageTop;
		if (cached && localMarkerLine >= 0 && cached.wordStart !== wordStart) {
			narrationMessageAnchor = { ...cached, wordStart, localMarkerLine };
		}
		anchor ??= cachedMessageTop !== undefined && localMarkerLine >= 0
			? cachedMessageTop + localMarkerLine
			: undefined;

		// Establish the selected message's absolute top from one full transcript
		// render. Subsequent words render only that message until layout changes,
		// avoiding a second full long-context render on every playback tick.
		if (anchor === undefined && scrollView.render) {
			const lines = scrollView.render(outerWidth);
			const markedLine = lines.findIndex(line => line.includes(narration.activeMarker));
			if (markedLine >= 0) {
				anchor = markedLine;
				if (canCacheMessageTop && messageId && localMarkerLine >= 0) {
					narrationMessageAnchor = {
						messageId,
						text,
						activeMarker: narration.activeMarker,
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
		const maxScrollTop = Math.max(0, resolvedContentHeight - scrollView.viewportHeight);
		if (target === null && !autoScrollForceOnce && (playbackPaused || scrollView.scrollTop !== maxScrollTop)) {
			lastAutoScrollTop = scrollView.scrollTop;
			return;
		}

		hideFollowHint();
		const topBand = Math.floor(scrollView.viewportHeight * 0.2);
		const desired = Math.max(0, Math.min(maxScrollTop, target ?? (autoScrollForceOnce ? anchor - topBand : scrollView.scrollTop)));
		autoScrollForceOnce = false;
		frameNarrationViewport(scrollView, desired, !playbackPaused);
		// Only the actual clamp hands off to native follow, never proximity inside
		// the speech band. Do not turn viewport arrival into a playback Tail action.
		if (!playbackPaused && scrollView.scrollTop === maxScrollTop) {
			pinnedContentHeight = resolvedContentHeight;
			bottomPinned = ownsSpeech;
			restoreBottomAfterSpeech ||= ownsSpeech;
		}
		lastAutoScrollTop = scrollView.scrollTop;
	};

	const restoreFollowAfterSpeech = (): void => {
		hideFollowHint();
		autoScrollForceOnce = false;
		const manuallyMoved =
			!nativeGestureTracking && lastAutoScrollTop !== undefined &&
			(activeScrollView()?.scrollTop ?? lastAutoScrollTop) !== lastAutoScrollTop;
		const restoreBottom = restoreBottomAfterSpeech && !manuallyMoved && !narrationManuallyFramed;
		restoreBottomAfterSpeech = false;
		bottomPinned = false;
		if (!restoreBottom) return;
		try {
			activeScrollView()?.scrollToEnd?.();
			atTranscriptTail = transcriptIsFollowingEnd();
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
		flushDeferredRelease();
	};

	const finishInputHint = (): string => `${[...effectiveTalkShortcuts][0] ?? "/voice talk"} to ${inputPhase === "acquiring" ? "cancel" : "finish"}`;
	const beginInputProgress = (): void => {
		inputInProgress = true;
		inputPhase = "acquiring";
		inputStartedAt = Date.now();
		const update = (): void => {
			const elapsed = Math.floor((Date.now() - inputStartedAt) / 1000);
			setInputProgress(`🎙 Input · ${inputPhase === "acquiring" ? "connecting" : "listening"} · ${elapsed}s · ${finishInputHint()}`);
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
			voiceStatusLine = undefined;
			refreshProgressWidget();
			return;
		}
		let label = `Voice · ready · ${config.voice}`;
		let color: "accent" | "dim" | "error" | "success" | "warning" = "dim";
		if (transportStopPending) {
			label = "Voice · stopping · waiting for device confirmation";
			color = "warning";
		} else if (routeIntent) {
			label = `Voice · waiting for ${selectedDeviceLabel} · device switch requires stop proof`;
			color = "warning";
		} else if (deviceRetryRequired) {
			label = "Voice · blocked · /voice reconnect";
			color = "warning";
		} else if (inputInProgress) {
			label = `🎙 Voice · ${inputPhase === "acquiring" ? "connecting" : inputPhase}`;
			color = "accent";
		} else if (pausedForAttention) {
			label = `Voice · waiting · ${coordinator?.projectLabel() ?? "project"} · ↺ F5`;
			color = "warning";
		} else if (playbackPaused) {
			label = "⏯ Voice · paused · F8 resume";
			color = "warning";
		} else if (state === "loading") {
			label = "Voice · loading speech model";
			color = "warning";
		} else if (state === "downloading") {
			label = "Voice · downloading model files";
			color = "warning";
		} else if (state === "speaking") {
			label = `Voice · speaking · ${config.voice}`;
			color = "accent";
		} else if (state === "listening") {
			label = "🎙 Voice · listening";
			color = "accent";
		} else if (state === "error") {
			label = "Voice · error · see notice";
			color = "error";
		} else {
			color = "success";
		}
		voiceStatusLine = ctx.ui.theme.fg(color, label);
		ctx.ui.setStatus("pi-voice", undefined);
		refreshProgressWidget();
	};

	const persistSegmentTiming = (segmentId: number): void => {
		const snapshot = playbackHistory.snapshotForSegment(segmentId);
		if (snapshot) pi.appendEntry(PLAYBACK_TIMING_ENTRY, snapshot);
	};
	const playbackUtterances = new Set<number>();
	let lastPlaybackTick: { utterance: number; position: number } | undefined;
	const handleWorkerEvent = (event: WorkerEvent): void | boolean => {
		if (event.type === "remote-handle") {
			try {
				retainRecoveryHandle("output", event.output, event.id, event.bootId, event.rebootSafe, event.deviceId, undefined, undefined, event.nativeWatchdog);
				event.grant?.();
			}
			catch (error) { notifyStopFailure(error); }
			return;
		}
		if (event.type === "remote-released" || event.type === "remote-not-admitted") {
			try { retireStopHandle("output", event.id); } catch (error) { notifyStopFailure(error); }
			return;
		}
		// Cancellation acknowledgements still unblock retiring transports, not UI/history.
		if (event.type === "idle" && event.cancelId !== undefined) {
			transportCancelWaiters.get(event.cancelId)?.();
			transportCancelWaiters.delete(event.cancelId);
			return;
		}
		if (!interactiveVoiceSession || !activeContext) return;
		let failedNotification: PendingNotification | undefined;
		if (pendingNotification && ((event.type === "idle" && event.utterance !== undefined && event.utterance === pendingNotification.utterance) ||
			(event.type === "error" && !event.preview && (event.utterance === undefined || event.utterance === pendingNotification.utterance)))) {
			if (event.type === "idle") {
				const pending = pendingNotification;
				try { if (notificationIsCurrent()) coordinator?.markAnnounced(pending.waiting); }
				catch (error) { notifyVoice(activeContext, `Attention acknowledgement failed: ${String(error)}`, "error"); }
				pendingNotification = undefined;
				vocalizer.setPlaybackPaused(playbackPaused);
				pending.finish(pending.epoch === playbackRequestEpoch && pending.context === contextEpoch);
				return;
			}
			failedNotification = pendingNotification;
			pendingNotification = undefined;
		}
		switch (event.type) {
			case "loading":
				state = "loading";
				break;
			case "progress":
				if (inputInProgress) {
					state = "listening";
					setInputProgress("🎙 Input · loading speech recognition model…");
				} else {
					state = "downloading";
				}
				break;
			case "ready":
				if (!inputInProgress) state = "idle";
				break;
			case "idle":
				const narratedIdle = event.utterance !== undefined && playbackUtterances.delete(event.utterance);
				if (!inputInProgress) state = "idle";
				playbackHistory.finishUtterance(event.utterance, !playbackPaused);
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
				if (attentionSuppressed && !playbackPaused) return;
				state = "speaking";
				// Coordinator project/attention prompts are separate from the selected
				// message transport and must not turn a paused message back into playing.
				break;
			case "segment-audio":
				narration.setSegmentAudio(event.segmentId, event.start, event.duration, event.timingQuality);
				playbackHistory.setSegmentAudio(event.segmentId, event.start, event.duration, event.timingQuality, event.audioIdentity);
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
				if (!playbackUtterances.has(event.utterance)) return; // Untracked prompts have no history checkpoint.
				if (event.utterance < (lastPlaybackTick?.utterance ?? 0) || pendingReplay?.waiting || playbackPaused) return false;
				if (!playbackHistory.setPlayback(event.utterance, event.position, event.estimated === true)) return false;
				lastPlaybackTick = event;
				narration.setPlayback(event.utterance, event.position);
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
				if (event.code === "REMOTE_PLAYBACK_UNCONFIRMED") {
					const output = stopResources.output;
					if (!output.episode?.remote || (event.utterance !== undefined && output.episode.utterance !== event.utterance)) {
						output.episode = { device: selectedDeviceLabel, cause: event.message, notified: false, utterance: event.utterance, remote: true };
						try { stopRecovery?.fail("output", output.episode.device, output.episode.cause); } catch (error) { notifyStopFailure(error); }
						if (output.cleanup && !output.cleanup.episode) output.cleanup.episode = output.episode;
					}
					deviceRetryRequired = true;
					notifyStopFailure(event.message, output.episode);
				}
				if (failedNotification) {
					const pending = failedNotification;
					const cancelId = vocalizer.clear();
					state = "error";
					notifyVoice(activeContext, `Attention announcement failed: ${event.message}`, "error");
					pendingNotification = pending;
					pending.utterance = undefined; // Failed EOF can never become delivery proof.
					void waitForTransportCancellation(cancelId).then(() => {
						pending.admit = () => {
							if (pendingNotification !== pending || stopsUnresolved() || transportStopPending || inputStopPending ||
								stopRecovery?.episode("output")?.handles.length || stopRecovery?.episode("input")?.handles.length) return;
							pendingNotification = undefined;
							const current = pending.epoch === playbackRequestEpoch && pending.context === contextEpoch;
							if (current) vocalizer.setPlaybackPaused(playbackPaused);
							pending.finish(current);
						};
						pending.admit();
					}, error => { if (pendingNotification === pending) cancelWaitingAnnouncement(); notifyStopFailure(error); });
					refreshStatus();
					return;
				}
				const currentUtterance = event.utterance !== undefined &&
					(playbackUtterances.has(event.utterance) || event.utterance === lastOwnerUtterance ||
						event.utterance === pausedOwnerUtterance ||
						event.utterance === projectPrefixUtterance);
				// Retired errors cannot cancel a replacement; remote uncertainty above
				// still belongs to the original transport until matching stop proof.
				if (event.utterance !== undefined && !currentUtterance && event.code !== "REMOTE_PLAYBACK_UNCONFIRMED") return;
				if (currentUtterance && event.code === "REMOTE_PLAYBACK_UNCONFIRMED" && config.output === "auto") suspendDevicePlayback();
				if (currentUtterance && routeIntent?.request === playbackRequestEpoch && routeIntent.context === contextEpoch) {
					deviceRetryRequired = true;
					refreshStatus();
					return;
				}
				if (currentUtterance) {
					attentionSuppressed = true;
					deviceRetryRequired = true;
					queuedPausedMessages.length = 0;
					queueIncomingWhilePaused = false;
					liveTurnNarrationActive = false;
					livePlaybackId = undefined;
					narration.finish();
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
				if (event.code !== "REMOTE_PLAYBACK_UNCONFIRMED" && event.message !== lastError) {
					lastError = event.message;
					notifyVoice(activeContext, event.message, "error");
				}
				break;
		}
		refreshStatus();
		requestPlaybackTimeline();
	};

	// Seeded live streams emit absolute ranges; history adds its capture origin itself.
	let liveCaptureOrigin = 0;
	const liveCaptureOrigins = new Map<number, number>();
	const vocalizer = new Vocalizer(
		() => routedVoiceConfig(),
		handleWorkerEvent,
		async (block, sourceContext, signal, onActivity) => {
			const ctx = activeContext;
			if (!ctx) return Promise.reject(new Error("No active Pi context for code description"));
			const providerMessages = [...await (typeof sourceContext.providerMessages === "function"
				? sourceContext.providerMessages(signal) : sourceContext.providerMessages ?? [])];
			if (signal.aborted) return { records: [], guided: false, omitted: true };
			return requestCodeDescription(ctx, block, structuredContextIdentity(providerMessages), providerMessages, { signal, onActivity });
		},
		segment => {
			if (ownsSpeech) {
				ownerContentExpected = true;
			}
			narration.registerSegment(segment);
			const base = (segment.sourceBase ?? 0) + (liveCaptureOrigins.get(segment.utterance) ?? 0);
			playbackHistory.registerSegment({
				...segment,
				sourceBase: base,
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
		(utterance, tracked) => {
			if (tracked) {
				if (liveCaptureOrigin) liveCaptureOrigins.set(utterance, liveCaptureOrigin);
				playbackUtterances.add(utterance);
				playbackHistory.bindUtterance(utterance);
			}
			if (pendingNotification && !tracked) { pendingNotification.utterance = utterance; return; }
			if (!ownsSpeech) return;
			lastOwnerUtterance = utterance;
			if (playbackPaused) pausedOwnerUtterance = utterance;
			ownerContentExpected = true;
		},
		utterance => playbackHistory.finishTimingGeneration(utterance),
		phase => { playbackPhase = phase; requestPlaybackTimeline(); },
		source => { narration.consumeOmittedSource(source.end); requestPlaybackTimeline(); },
		() => beforePhysicalIO("output"),
	);
	const clearPlaybackTransport = (): number | undefined => {
		cancelWaitingAnnouncement();
		pausedAnnouncementResume = undefined;
		devicePicker?.abort();
		routeIntent = undefined;
		playbackTailIntent = false;
		playbackUtterances.clear();
		lastPlaybackTick = undefined;
		playbackRequestEpoch += 1;
		coordinator?.cancelSpeechAcquisition();
		if (!ownsSpeech) coordinator?.releaseSpeech();
		pendingReplay = undefined;
		const cancelId = vocalizer.clear();
		liveCaptureOrigin = 0;
		liveCaptureOrigins.clear();
		if (cancelId !== undefined) void waitForTransportCancellation(cancelId);
		playbackPaused = false;
		pausedOwnerUtterance = undefined;
		lastOwnerUtterance = undefined;
		completedOwnerUtterance = undefined;
		ownerContentExpected = false;
		return cancelId;
	};

	let transportStopPending = false;
	let transportStopBarrier = Promise.resolve();
	const transportStops = new Map<number, Promise<void>>();
	const waitForTransportCancellation = (cancelId: number | undefined): Promise<void> => {
		if (cancelId === undefined && !ownsSpeech && !stopResources.output.episode) return transportStopBarrier;
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
		transportStopBarrier = Promise.all([previous.catch(() => {}), trackStop("output", stopped)]).then(() => {});
		const barrier = transportStopBarrier;
		if (cancelId !== undefined) transportStops.set(cancelId, barrier);
		void barrier.then(() => {
			if (cancelId !== undefined) transportStops.delete(cancelId);
			if (transportStopBarrier === barrier) {
				transportStopPending = false;
				flushDeferredRelease();
			}
		}, notifyStopFailure);
		return barrier;
	};

	const releaseAfterTransportCancellation = (cancelId: number | undefined, announceNext = false, inputCancelled = Promise.resolve(), stopBoundary = false): void => {
		const leaseEpoch = speechLeaseEpoch;
		const boundaryEpoch = playbackRequestEpoch;
		void Promise.all([waitForTransportCancellation(cancelId), inputCancelled, inputStopBarrier]).then(() => {
			const release = (): void => {
				// A superseding Stop must survive the routing continuation as well as
				// its physical rebind, without releasing a replacement playback lease.
				if (routeFlight) { void routeFlight.then(release).catch(notifyStopFailure); return; }
				if (ownsSpeech && speechLeaseEpoch === leaseEpoch) {
					const announcement = stopBoundary && boundaryEpoch === playbackRequestEpoch ? announceWaiting(false, true) : undefined;
					if (announcement) void announcement.then(current => {
						if (!current) return;
						// This epoch still belongs to Stop: arrivals remain transcript, not autoplay continuations.
						queuedPausedMessages.length = 0;
						queueIncomingWhilePaused = false;
						attentionSuppressed = true;
						coordinator?.setAttentionEnabled(false);
						releaseSpeechOwnership(false);
					});
					else releaseSpeechOwnership(announceNext);
				}
			};
			const rebind = deviceRebind;
			if (rebind) return rebind.catch(error => { if (unconfirmedDeviceStops.has(rebind)) throw error; }).then(release);
			release();
		}).catch(notifyStopFailure);
	};

	const phoneInput = new PhoneInputClient(
		handle => retainRecoveryHandle("input", handle.endpoint, handle.ticket, handle.bootId, handle.networkAdmission, handle.deviceId, handle.desktopWait, handle.networkAdmission),
		handle => retireStopHandle("input", handle.ticket, handle.endpoint),
		() => beforePhysicalIO("input"),
	);
	let inputStopBarrier = Promise.resolve();
	let inputStopPending = false;
	let cancelPendingDictation: (() => void) | undefined;
	let finishPendingDictation: ((stopCapture?: boolean) => Promise<void>) | undefined;
	const finishInputForPlayback = async (): Promise<void> => {
		if (inputPhase === "acquiring") {
			coordinator?.cancelSpeechAcquisition();
			await cancelActiveInput();
		} else {
			await finishPendingDictation?.();
		}
	};
	const cancelActiveInput = (): Promise<void> => {
		devicePicker?.abort();
		if (inputPhase === "acquiring" && !ownsSpeech) coordinator?.releaseSpeech();
		// Cancellation retires this input, not a new acquisition. Carry its release request forward.
		if (deferredRelease?.input === inputEpoch) deferredRelease.input += 1;
		inputEpoch += 1;
		cancelPendingDictation?.();
		cancelPendingDictation = undefined;
		finishPendingDictation = undefined;
		inputStopPending = true;
		const cancelled = trackStop("input", phoneInput.cancel());
		inputStopBarrier = cancelled;
		void cancelled.then(() => {
			if (inputStopBarrier === cancelled) inputStopPending = false;
			flushDeferredRelease();
		}, () => {});
		if (speechReservedForInput) {
			if (lastOwnerUtterance === undefined) {
				releaseSpeechOwnership(false);
				releaseAfterTransportCancellation(undefined, false, cancelled);
			}
			speechReservedForInput = false;
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

	const relinquishSpeech = (): boolean => {
		if (Object.values(stopResources).some(resource => resource.episode || resource.cleanup)) return false;
		coordinator?.releaseSpeech();
		ownsSpeech = false;
		codeWorkEpoch += 1;
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
		cancelWaitingAnnouncement();
		if (!inputInProgress) state = "idle";
		refreshStatus();
		scheduleVoiceWorkerIdleStop();
		if (activeContext) scheduleMissingCodeDescriptions(activeContext);
		return true;
	};

	const notificationIsCurrent = (): boolean => {
		const pending = pendingNotification;
		const waiting = pending && coordinator?.nextUnannouncedWaiting(outputConnection());
		return !!pending && pending.epoch === playbackRequestEpoch && pending.context === contextEpoch &&
			pending.endpoint === outputEndpoint && pending.generation === outputGeneration &&
			waiting?.instanceId === pending.waiting.instanceId && waiting?.generation === pending.waiting.generation;
	};

	// One existing waiting record per safe boundary. No notification queue or mutable-state restore.
	const announceWaiting = (stopOriginal = false, allowSuppressed = false, retainPaused = false): Promise<boolean> | undefined => {
		if (!coordinator || !ownsSpeech || pendingNotification || !config.enabled ||
			(attentionSuppressed && !allowSuppressed) || deviceRebind || routeFlight || inputInProgress || pendingSpeechPreemption) return;
		const waiting = coordinator.nextUnannouncedWaiting(outputConnection());
		if (!waiting) return;
		if (stopOriginal) {
			++playbackRequestEpoch;
			coordinator.cancelSpeechAcquisition();
			pendingReplay = undefined;
		}
		const result = Promise.withResolvers<boolean>();
		const pending: PendingNotification = { waiting, epoch: playbackRequestEpoch, context: contextEpoch,
			endpoint: outputEndpoint, generation: outputGeneration, finish: result.resolve };
		pendingNotification = pending;
		if (retainPaused && playbackPaused) {
			const snapshot = playbackHistory.resumeSnapshot(true);
			if (snapshot) {
				pausedAnnouncementResume = { ...snapshot, source: playingSource };
				// Cancellation retires every worker block, not just the selected unit.
				const remaining = playingSource ? eligibleAssistantBlocks(playingSource.assistant, config.mode)
					.filter(block => block.contentIndex > (snapshot.contentIndex ?? 0) && hasSpeakableAudio(block.text)) : [];
				const unheard = remaining.flatMap(block => {
					const id = playingSource!.blockIds.get(block.contentIndex);
					return id && !queuedPausedMessages.some(message => message.id === id)
						? [{ ...block, id, time: 0, sourceOffset: 0, source: playingSource }] : [];
				});
				queuedPausedMessages.unshift(...unheard);
			}
		}
		if (stopOriginal) queueIncomingWhilePaused = true;
		const cancelId = stopOriginal ? vocalizer.clear() : undefined;
		if (stopOriginal) { playbackUtterances.clear(); pausedOwnerUtterance = undefined; }
		const failed = (error: unknown): void => {
			if (pendingNotification === pending) pendingNotification = undefined;
			pending.finish(false);
			notifyStopFailure(error);
		};
		void (async () => {
			if (stopOriginal) await waitForTransportCancellation(cancelId);
			if (transportStopPending) await transportStopBarrier;
			if (inputStopPending) await inputStopBarrier;
			// An ACK can precede individual receipts. Keep this same boundary, not a new request.
			pending.admit = () => {
				if (pendingNotification !== pending) return;
				try {
					if (!notificationIsCurrent()) {
						pendingNotification = undefined;
						pending.finish(pending.epoch === playbackRequestEpoch && pending.context === contextEpoch);
						return;
					}
					if (stopsUnresolved() || deviceRebind || routeFlight || transportStopPending || inputStopPending ||
						stopRecovery?.episode("output")?.handles.length || stopRecovery?.episode("input")?.handles.length) return;
					pending.admit = undefined;
					vocalizer.setPlaybackPaused(false);
					pending.utterance = vocalizer.speakUntracked(
						`Project ${coordinator!.projectLabel(waiting.cwd, waiting.sessionId, waiting.sessionName)} requires attention next.`,
					);
					if (pending.utterance === undefined) { pendingNotification = undefined; pending.finish(false); }
				} catch (error) { failed(error); }
			};
			pending.admit();
		})().catch(failed);
		return result.promise;
	};

	flushDeferredRelease = (): void => {
		const pending = deferredRelease;
		if (!pending) return;
		if (pending.input !== inputEpoch || pending.lease !== speechLeaseEpoch || pending.context !== contextEpoch || !ownsSpeech || lastOwnerUtterance !== undefined) {
			deferredRelease = undefined;
			return;
		}
		if (pending.loan) {
			const owner = coordinator?.speechOwner();
			if (coordinator !== pending.loan.owner || owner?.instanceId !== coordinator?.instanceId ||
				!pending.loan.generation || owner?.speechGeneration !== pending.loan.generation) {
				deferredRelease = undefined;
				return;
			}
			// Shutdown/ACK alone cannot retire the original remote scopes.
			if (pending.loan.stopping || pendingReplay || pendingNotification || stopRecovery?.episode("output")?.handles.length || stopRecovery?.episode("input")?.handles.length) return;
			if (!stopsUnresolved() && deviceRebind && unconfirmedDeviceStops.has(deviceRebind)) deviceRebind = undefined;
		}
		if (inputInProgress || speechReservedForInput || routeIntent || routeFlight || deviceRebind || transportStopPending || inputStopPending || stopsUnresolved()) return;
		deferredRelease = undefined;
		releaseSpeechOwnership(pending.announceNext);
	};

	releaseSpeechOwnership = (announceNext = true): void => {
		if (!ownsSpeech || !coordinator) return;
		// Every release continuation owns this durable generation, not a same-owner replacement.
		if (!speechLeaseGeneration || coordinator.speechOwner()?.speechGeneration !== speechLeaseGeneration) return;
		// A finished input's release survives every barrier, not only retained-handle recovery.
		if (speechReservedForInput && lastOwnerUtterance === undefined) {
			deferredRelease = { input: inputEpoch, lease: speechLeaseEpoch, context: contextEpoch, announceNext };
			speechReservedForInput = false;
			flushDeferredRelease();
			return;
		}
		if (routeIntent || routeFlight || deviceRebind || transportStopPending || inputStopPending || stopsUnresolved()) return;
		if (pendingSpeechPreemption) {
			finishSpeechPreemption();
			return;
		}
		restoreFollowAfterSpeech();
		if (pendingNotification) return;
		if (announceNext && !automaticRecoveryFlight) {
			const announcement = announceWaiting();
			if (announcement) { void announcement.then(current => { if (current) releaseSpeechOwnership(false); }); return; }
		}
		relinquishSpeech();
	};

	const completeOwnerSpeech = (announce = true): void => {
		const expectedUtterance = ownerContentExpected ? lastOwnerUtterance : projectPrefixUtterance;
		if (!ownsSpeech || !ownerTurnEnded || pendingNotification || pendingReplay || playbackPaused || deviceRebind || transportStopPending || inputStopPending || attentionPreparation?.epoch === playbackRequestEpoch) return;
		if (expectedUtterance === undefined) projectAnnouncementPending = false;
		else if (completedOwnerUtterance !== expectedUtterance) return;
		if (!queuedPausedMessages.length && !queueIncomingWhilePaused) {
			// Whole-message audio completion advances Tail even while an untracked prompt plays.
			const latest = activeContext && completedAssistantMessages(activeContext, config.mode, false).at(-1);
			const selected = playbackHistory.selected()?.id;
			const pendingLiveEnd = liveTurnNarrationActive && pendingCanonicalizations.size > 0 && selected !== undefined &&
				selected === [...liveBlockIds.values()].at(-1);
			if ((latest && latest.id === selected) || pendingLiveEnd) {
				navigationTail = { id: selected };
				playbackTailIntent = true;
			}
			restoreFollowAfterSpeech();
		}
		if (announce && expectedUtterance !== undefined && (!queuedPausedMessages[0] || queuedPausedMessages[0].source !== playingSource)) {
			const announcement = announceWaiting();
			if (announcement) { void announcement.then(current => { if (current) completeOwnerSpeech(false); }); return; }
		}
		const queued = queuedPausedMessages.shift();
		if (queued) {
			void playTarget(queued, !playbackHistory.hasCompleteTimingFor(queued.id), false, true);
			return;
		}
		if (!queueIncomingWhilePaused) releaseSpeechOwnership(false);
	};

	handleCoordinatedIdle = utterance => {
		if (!ownsSpeech || utterance === undefined || (utterance !== lastOwnerUtterance && utterance !== projectPrefixUtterance)) return;
		completedOwnerUtterance = utterance;
		completeOwnerSpeech();
	};

	const activateSpeechOwnership = (
		purpose: "turn" | "replay",
		announceProject: boolean,
		output = true,
		handledSource: typeof liveSource | null = liveSource,
	): boolean => {
		if (pendingSpeechPreemption || stopsUnresolved()) return false;
		try { if (output) claimOutputDevice(); } catch (error) {
			attentionSuppressed = true;
			deviceRetryRequired = true;
			const cancelId = clearPlaybackTransport();
			if (ownsSpeech) releaseAfterTransportCancellation(cancelId, false);
			else coordinator?.releaseSpeech();
			notifyVoice(activeContext, `Device: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
		if (!coordinator) return true;
		if (voiceWorkerIdleTimer) clearTimeout(voiceWorkerIdleTimer);
		voiceWorkerIdleTimer = null;
		cancelTimingWorkers();
		const shouldAnnounce = announceProject && (!coordinator.attentionIsCurrent() || projectAnnouncementPending);
		ownsSpeech = true;
		speechLeaseEpoch += 1;
		speechLeaseGeneration = coordinator.speechOwner()?.speechGeneration;
		speechPurpose = purpose;
		ownerTurnEnded = false;
		lastOwnerUtterance = undefined;
		projectPrefixUtterance = undefined;
		completedOwnerUtterance = undefined;
		ownerContentExpected = false;
		speechReservedForInput = false;
		projectAnnouncementPending = shouldAnnounce;
		ownedSpeechText = "";
		cancelWaitingAnnouncement();
		if (!waitingSource || waitingSource === handledSource) {
			pausedForAttention = false;
			waitingSource = undefined;
			coordinator.clearWaiting();
		}
		speechBlocked = false;
		blockedMessageHasSpeech = false;
		blockedSpeechText = "";
		refreshStatus();
		return true;
	};

	const acquireSpeech = (purpose: "turn" | "replay", announceProject = true): boolean => {
		if (pendingSpeechPreemption || stopsUnresolved() || attentionSuppressed || deviceRetryRequired || !interactiveVoiceSession || deviceRebind || inputStopPending || transportStopPending) return false;
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
		if (captureEpoch !== inputEpoch || epoch !== playbackRequestEpoch || pendingSpeechPreemption || stopsUnresolved()) return false;
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

	const preserveDisplacedSpeech = (interrupted: { purpose: typeof speechPurpose; wasComplete: boolean; spokenText: string }): void => {
		if (interrupted.purpose === "turn" || interrupted.purpose === "replay") {
			pausedForAttention = true;
			if (interrupted.purpose === "turn" && !interrupted.wasComplete) {
				speechBlocked = true;
				blockedSpeechText = interrupted.spokenText;
				blockedMessageHasSpeech = hasSpeakableAudio(interrupted.spokenText);
			} else {
				waitingSource = liveSource;
				coordinator?.markWaiting(outputConnection());
			}
			refreshStatus();
		}
	};

	finishSpeechPreemption = (): void => {
		const interrupted = pendingSpeechPreemption;
		if (!interrupted || deviceRebind || stopsUnresolved()) return;
		// Consume before release refreshes UI: callbacks may reenter with newer intent.
		pendingSpeechPreemption = undefined;
		const releasedLease = speechLeaseEpoch + 1;
		relinquishSpeech();
		if (speechLeaseEpoch === releasedLease && interrupted.request === playbackRequestEpoch && interrupted.context === contextEpoch && interrupted.input === inputEpoch) {
			preserveDisplacedSpeech(interrupted);
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
		const pending = { ...interrupted, request: playbackRequestEpoch, context: contextEpoch, input: inputEpoch, ...(cancelId !== undefined ? { cancelId } : {}) };
		pendingSpeechPreemption = pending;
		narration.finish();
		// Release only after both the player and microphone have acknowledged stop.
		void Promise.all([inputCancellation, waitForTransportCancellation(cancelId)]).then(async () => {
			if (deviceRebind) await deviceRebind;
			if (pendingSpeechPreemption === pending) finishSpeechPreemption();
		}).catch(error => notifyVoice(activeContext, `Handoff stop failed; ownership retained: ${error instanceof Error ? error.message : String(error)} · ${stopRecoveryAdvice}`, "error"));
	};

	const pollWaitingAttention = (): void => {
		if (!coordinator || deviceRebind || transportStopPending) return;
		if (ownsSpeech && coordinator.consumeSpeechPreemptionRequest()) {
			handleSpeechPreemption();
		}
		if (attentionPreparation?.epoch === playbackRequestEpoch) return;
		if (config.enabled && !attentionSuppressed && coordinator.hasAttentionRequest() && activeContext) {
			try {
				const request = coordinator.takeAttentionRequest();
				if (request) {
					playRequestedAttention(activeContext, request);
					return;
				}
			} catch {
				// Session replacement will create a fresh coordinator and discard this request.
			}
		}
		if (pendingNotification?.admit) { pendingNotification.admit(); return; }
		if (deviceRetryRequired) return;
		const owner = coordinator.speechOwner();
		if (ownsSpeech && owner?.instanceId !== coordinator.instanceId) handleSpeechPreemption();
		if (owner && owner.instanceId !== coordinator.instanceId) {
			if (timingPreprocessing) cancelTimingWorkers();
			return;
		}
		if ((!owner || (ownsSpeech && playbackPaused)) && activeContext && !timingPreprocessing) scheduleMissingTimings(activeContext, false);
		if (!config.enabled || attentionSuppressed || ownsSpeech) return;
		// Announcements never interrupt a transport or announce our own response.
		const waiting = coordinator.tryAcquireWaitingAnnouncement(outputConnection());
		if (!waiting) return;
		try { claimOutputDevice(); } catch (error) {
			coordinator.releaseSpeech();
			attentionSuppressed = true;
			deviceRetryRequired = true;
			notifyVoice(activeContext, `Device: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (voiceWorkerIdleTimer) clearTimeout(voiceWorkerIdleTimer);
		voiceWorkerIdleTimer = null;
		cancelTimingWorkers();
		ownsSpeech = true;
		speechLeaseEpoch += 1;
		speechLeaseGeneration = coordinator.speechOwner()?.speechGeneration;
		ownerTurnEnded = true;
		const loan = { owner: coordinator, generation: speechLeaseGeneration, stopping: true };
		const lease = speechLeaseEpoch;
		const context = contextEpoch;
		const announcement = announceWaiting();
		if (announcement) void announcement.then(current => {
			const owner = loan.owner.speechOwner();
			if (!ownsSpeech || lease !== speechLeaseEpoch || context !== contextEpoch || coordinator !== loan.owner ||
				owner?.instanceId !== loan.owner.instanceId || !loan.generation || owner.speechGeneration !== loan.generation) return;
			if (current) { completeOwnerSpeech(false); return; }
			// Every cancellation retires the prompt, not its borrowed lease's stop obligation.
			const release = deferredRelease = { input: inputEpoch, lease, context, announceNext: false, loan };
			flushDeferredRelease();
			if (deferredRelease !== release) return;
			// Join the caller's stop; state-only cancellation still needs physical proof.
			const stopped = deviceRebind ?? (transportStopPending ? transportStopBarrier : waitForTransportCancellation(undefined));
			void stopped.catch(notifyStopFailure).then(() => { loan.stopping = false; flushDeferredRelease(); });
		});
		else releaseSpeechOwnership(false);
	};

	const refreshDeviceLabel = (): void => {
		const selection = activeDeviceId ?? deviceSelection;
		selectedDeviceLabel = selection === "auto" ? "no device" : selection === "local" ? hostname() : selection;
		if (selection !== "auto" && selection !== "local") {
			try { selectedDeviceLabel = deviceRouter.resolve(selection)?.name ?? selectedDeviceLabel; } catch { /* Keep an unavailable pin truthful. */ }
		}
		refreshProgressWidget();
		refreshStatus();
	};

	// Identity feedback only: registration and pinning do not prove audio readiness.
	const notifyConnectedDevice = (ctx: ExtensionContext | null, direction?: "input" | "output"): void => {
		if (inputStopPending || transportStopPending) return;
		try {
			const host = hostname();
			const localName = validDeviceName(host) ? host : "local device";
			const selection = activeDeviceId ?? deviceSelection;
			if (direction) {
				const route = deviceRouter.routeMetadata(selection, direction, config[direction]);
				if (route.kind === "disabled" || route.kind === "custom") {
					notifyVoice(ctx, `${direction}: ${route.kind === "disabled" ? "disabled" : "custom endpoint configured"} · audio readiness not checked`, "info");
					return;
				}
				if (route.kind === "intentional_local") {
					notifyVoice(ctx, `Connected to ${localName} · local ${direction}; audio readiness not checked`, "info");
					return;
				}
			}
			const device = deviceRouter.resolve(selection);
			const overrides = deviceSelection === "auto" ? [] : (["input", "output"] as const)
				.filter(key => config[key] !== "auto")
				.map(key => `${key}: ${["local", "disabled"].includes(config[key]) ? config[key] : "custom endpoint"}`);
			notifyVoice(ctx, `Connected to ${device?.name ?? localName} · identity selected; audio readiness not checked${overrides.length ? ` · overrides unchanged (${overrides.join(", ")})` : ""}`, "info");
		} catch (error) {
			notifyVoice(ctx, `Device: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	// Seal dispatch and close descendants before replaying scopes only the journal still knows.
	const shutdownOutput = async (recovery = stopRecovery, router = deviceRouter, configured = config.output, guard: Parameters<StopRecovery["retry"]>[3] = {}): Promise<void> => {
		await vocalizer.shutdown(recovery?.episode("output")?.handles.length
			? scope => recovery.stopOutputScope(scope, router, configured, guard) : undefined);
		guard.signal?.throwIfAborted();
		if (guard.current && !guard.current()) throw new Error("Recovery owner changed; ownership retained");
		if (recovery?.episode("output")?.handles.length) await recovery.retry("output", router, configured, guard);
	};
	let deviceRebind: Promise<void> | undefined;
	let reconnectDiagnostic = { notified: false };
	const unconfirmedDeviceStops = new WeakSet<Promise<void>>();
	// Recovery is stop-only: never adopt a connection or replay a user intent here.
	scheduleAutomaticRecovery = (): void => {
		if (!automaticRecoveryEnabled || automaticRecoveryTimer || automaticRecoveryFlight) return;
		automaticRecoveryTimer = setTimeout(() => {
			automaticRecoveryTimer = undefined;
			if (!automaticRecoveryEnabled) return;
			if (automaticRecoveryWork || deviceRebind && !unconfirmedDeviceStops.has(deviceRebind)) {
				scheduleAutomaticRecovery();
				return;
			}
			const owner = coordinator;
			const epoch = automaticRecoveryEpoch;
			const context = contextEpoch;
			const request = playbackRequestEpoch;
			const current = () => automaticRecoveryEnabled && automaticRecoveryEpoch === epoch && coordinator === owner && contextEpoch === context && playbackRequestEpoch === request;
			let attempted = false;
			const attempt = boundedStopRecovery(signal => {
				const work = (async () => {
					if (!owner || !current()) return;
					restoreStopRecovery(); // Also discover owners that died after session startup.
					const lease = owner.speechOwner();
					const retired = [...retiredStops].find(cleanup => cleanup.root === owner.root && cleanup.owner?.instanceId === lease?.instanceId &&
						!!lease?.speechGeneration && cleanup.owner?.speechGeneration === lease.speechGeneration && cleanup.owner.pid === lease.pid);
					if (retired) {
						attempted = true;
						// Only the original closure can seal a same-process retired worker.
						await retired({ signal, current: () => current() && owner.speechOwner()?.speechGeneration === lease?.speechGeneration });
						return;
					}
					if (orphanRecoveryBlocked) {
						const recovery = orphanRecovery;
						if (!lease || !recovery || !owner.canRecoverSpeech(lease)) return;
						const valid = () => current() && owner.canRecoverSpeech(lease);
						await owner.withSpeechRecovery(lease, async () => {
							// Another session may have retired scopes before we acquired the lock.
							const journal = new StopRecovery(owner.root, lease.instanceId);
							orphanRecovery = journal;
							await Promise.allSettled((["input", "output"] as const).map(async direction => {
								if (!journal.episode(direction)?.handles.length && !journal.isCovered(direction)) return;
								attempted = true;
								try { await journal.retry(direction, deviceRouter, config[direction], { signal, current: valid }); }
								catch (error) { if (current()) notifyStopFailure(error, inheritedStops[direction]); }
							}));
							signal.throwIfAborted();
							if (valid() && owner.recoverIdleSpeech(lease)) restoreStopRecovery();
						});
						if (current()) refreshProgressWidget();
						return;
					}
					const recovery = stopRecovery;
					if (!recovery || lease?.instanceId !== owner.instanceId) return;
					const input = inputEpoch;
					const generations = { ...recovery.generations };
					const valid = () => current() && stopRecovery === recovery && inputEpoch === input &&
						owner.speechOwner()?.speechGeneration === lease.speechGeneration &&
						recovery.generations.input === generations.input && recovery.generations.output === generations.output;
					const rebind = deviceRebind;
					const failedOutput = !!stopResources.output.episode;
					await Promise.allSettled((["input", "output"] as const).map(async direction => {
						const resource = stopResources[direction];
						// Retained handles alone describe healthy IO. Unknown microphones stay fenced.
						if (!resource.episode || resource.cleanup || direction === "input" && !recovery.episode(direction)?.handles.length && !recovery.isCovered(direction)) return;
						attempted = true;
						const guard = { signal, current: valid };
						const stopping = trackStop(direction, direction === "output" ? shutdownOutput(recovery, deviceRouter, config.output, guard)
							: phoneInput.recover(() => recovery.retry("input", deviceRouter, config.input, guard)), true);
						if (direction === "input") { inputStopBarrier = stopping; inputStopPending = true; }
						await stopping;
						// Consume output proof before a sibling can time out: trackStop has
						// cleared this episode, so the next attempt cannot recognize it.
						if (direction === "output" && valid() && !resource.episode && !resource.cleanup) {
							for (const resolve of transportCancelWaiters.values()) resolve();
							transportCancelWaiters.clear();
							transportStopBarrier = Promise.resolve();
							transportStopPending = false;
							transportStops.clear();
						}
						signal.throwIfAborted();
						if (direction === "input" && valid() && inputStopBarrier === stopping && !resource.episode) inputStopPending = false;
					}));
					signal.throwIfAborted();
					if (!attempted || !valid()) return;
					if (stopsUnresolved()) return;
					if (rebind === deviceRebind && rebind && unconfirmedDeviceStops.has(rebind)) deviceRebind = undefined;
					if (routeIntent?.request === playbackRequestEpoch && routeIntent.context === contextEpoch) {
						routePending = true;
						queueMicrotask(pollDeviceRouting);
					}
					// Do not release a healthy sibling transport or announce/play anything.
					if (!inputInProgress && !recovery.episode("input")?.handles.length && !recovery.episode("output")?.handles.length && (failedOutput || lastOwnerUtterance === undefined)) {
						if (deferredRelease) deferredRelease.announceNext = false;
						releaseSpeechOwnership(false);
					}
					refreshProgressWidget();
				})();
				automaticRecoveryWork = work;
				void work.finally(() => { if (automaticRecoveryWork === work) automaticRecoveryWork = undefined; }).catch(() => {});
				return work;
			});
			const flight = attempt.catch(() => { /* The episode already owns its coalesced diagnostic. */ }).finally(() => {
				if (automaticRecoveryFlight === flight) automaticRecoveryFlight = undefined;
				automaticRecoveryDelay = attempted ? Math.min(60_000, automaticRecoveryDelay * 2) : 3_000;
				scheduleAutomaticRecovery();
			});
			automaticRecoveryFlight = flight;
		}, automaticRecoveryDelay);
		automaticRecoveryTimer.unref();
	};
	// Persist only session metadata. Reattachment alone never changes an existing pin.
	const adoptCurrentConnection = (epoch: number, force = false, origin?: ConnectionDevice, current = () => true, manual?: VoiceDeviceSelection, recover = false, routingDecision = false): Promise<boolean> => {
		if (!force && (deviceSelection !== "auto" || (!origin && (activeDeviceId !== undefined || config.output !== "auto")))) {
			deviceRetryRequired = false;
			return Promise.resolve(true);
		}
		// Explicit intent makes existing dictation review-only before identity lookup can yield.
		// Keep recording until route validation and old-device stop proof begin.
		if (force) {
			void finishPendingDictation?.(false);
			// Once deltas are captured instead of fed, retire even an unchanged paused sink.
			if (playbackPaused) queueIncomingWhilePaused = true;
		}
		const ctx = activeContext;
		// A new playback request retires the resume callback, not the pending route decision.
		const requestCurrent = () => (routingDecision || epoch === playbackRequestEpoch) &&
			ctx === activeContext && interactiveVoiceSession && current();
		const previous = deviceRebind;
		handoffConnecting = true;
		refreshProgressWidget();
		let stopUnconfirmed = false;
		const adoption = (async () => {
			try {
				// Fence the whole adoption, including resolution, stop proof and both route metadata updates.
				// Explicit reconnect retries stop proof; ordinary playback still waits on the failure.
				if (automaticRecoveryFlight) await automaticRecoveryFlight;
				if (automaticRecoveryWork) throw new Error("Original stop recovery still pending; ownership retained");
				if (previous) await previous.catch(() => { stopUnconfirmed = unconfirmedDeviceStops.has(previous); });
				if (!requestCurrent()) return false;
				// A retained capture ticket is normal admission, not a failed stop.
				if (recover && inputInProgress && stopRecovery?.episode("input")?.handles.length && !inputStopPending && !stopResources.input.episode) {
					try {
						await trackStop("input", finishInputForPlayback());
					} catch { /* A failed finish may now use scoped stop recovery below. */ }
				}
				if (recover) restoreStopRecovery();
				if (orphanRecoveryBlocked) {
					const previousStopUnconfirmed = stopUnconfirmed;
					stopUnconfirmed = true;
					if (recover) await retryStopRecovery();
					if (orphanRecoveryBlocked) throw new Error("Previous voice owner stop remains unconfirmed; retry /voice reconnect");
					stopUnconfirmed = previousStopUnconfirmed;
				}
				if (force && retiredStops.size) {
					stopUnconfirmed = true;
					await Promise.all([...retiredStops].map(cleanup => cleanup()));
					stopUnconfirmed = stopsUnresolved();
				}
				if (!requestCurrent()) return false;
				if (recover && stopRecovery?.episode("output")?.handles.length) {
					// Retry the original identity before resolving a possibly different/ambiguous attachment.
					const recovery = stopRecovery;
					stopUnconfirmed = true;
					await trackStop("output", shutdownOutput(recovery));
					if (stopResources.output.episode || stopResources.output.cleanup) throw new Error("Retained output scopes remain unconfirmed");
					stopUnconfirmed = false;
				}
				if (recover && stopRecovery?.episode("input")?.handles.length) {
					const recovery = stopRecovery;
					stopUnconfirmed = true;
					// Invalidate dictation first: its rejection must not replace recovery's cleanup tracker.
					await cancelActiveInput().catch(() => {});
					await trackStop("input", phoneInput.recover(() => recovery.retry("input", deviceRouter, config.input)));
					if (stopResources.input.episode || stopResources.input.cleanup) throw new Error("Retained input scopes remain unconfirmed");
					inputStopBarrier = Promise.resolve();
					inputStopPending = false;
					stopUnconfirmed = false;
				}
				const resolvedConnection = origin ?? await deviceRouter.resolveCurrentConnection();
				const pinned = config.output === "auto" ? routing?.rows.find(row => row.pinned && row.available) : undefined;
				const connection: ConnectionDevice = pinned ? pinned.id === "local" ? { kind: "intentional_local" } : { kind: "device", id: pinned.id } : resolvedConnection;
				if (!requestCurrent()) return false;
				const selection = connection.kind === "device" ? connection.id : "local";
				// Retain identity even if its registration is temporarily absent; operations validate their own direction.
				// A reconnect is metadata adoption, never a readiness claim.
				const identityChanged = selection !== (activeDeviceId ?? deviceSelection);
				let changed = identityChanged;
				let outputRoute: ReturnType<DeviceRouter["routeMetadata"]> | undefined;
				let inputRoute: ReturnType<DeviceRouter["routeMetadata"]> | undefined;
				try {
					outputRoute = deviceRouter.routeMetadata(selection, "output", config.output);
					changed ||= outputRoute.endpoint !== outputEndpoint ||
						(outputRoute.kind === "device" ? outputRoute.device.connectedAt : undefined) !== outputGeneration;
				} catch (error) { if (!identityChanged || (manual !== undefined && manual !== "auto")) throw error; }
				try {
					inputRoute = deviceRouter.routeMetadata(selection, "input", config.input);
					changed ||= inputInProgress && (inputRoute.endpoint !== inputEndpoint ||
						(inputRoute.kind === "device" ? inputRoute.device.connectedAt : undefined) !== inputGeneration);
				} catch (error) { if ((!identityChanged && inputInProgress) || (manual !== undefined && manual !== "auto")) throw error; }
				if (manual !== undefined || previous || stopsUnresolved() || pendingSpeechPreemption || transportStopPending || inputStopPending || (force && (deviceRetryRequired || inputInProgress || playbackPaused || !!pendingNotification)) || (changed && (ownsSpeech || inputInProgress))) {
					// Termination, not a TCP accept or a cancellation timeout, proves the old sink is gone.
					stopUnconfirmed = true;
					if (force && inputInProgress) await finishInputForPlayback();
					cancelWaitingAnnouncement();
					pausedAnnouncementResume = undefined;
					await Promise.all([trackStop("output", vocalizer.shutdown()), cancelActiveInput()]);
					if (stopsUnresolved()) throw new Error("Retained transport scopes remain unconfirmed");
					liveTurnNarrationActive = false;
					stopUnconfirmed = false;
					for (const resolve of transportCancelWaiters.values()) resolve();
					transportCancelWaiters.clear();
					await transportStopBarrier.catch(() => {});
					transportStopBarrier = Promise.resolve();
					transportStopPending = false;
					transportStops.clear();
					if (!requestCurrent()) return false;
					pausedOwnerUtterance = undefined;
					lastOwnerUtterance = undefined;
				}
				if (!force && selection !== "local") await deviceRouter.route(selection, "output", config.output);
				if (!requestCurrent()) return false;
				if (manual !== undefined) deviceSelection = manual;
				else if (force || origin) deviceSelection = "auto";
				activeDeviceId = selection;
				deviceRouter.setEnvironmentDevice(connection.kind === "device" ? connection.id : undefined);
				routing?.select(selection);
				persistDevice();
				outputConnection(outputRoute);
				if (outputRoute) {
					outputEndpoint = outputRoute.endpoint;
					outputGeneration = outputRoute.kind === "device" ? outputRoute.device.connectedAt : undefined;
				}
				if (inputRoute) {
					inputEndpoint = inputRoute.endpoint;
					inputGeneration = inputRoute.kind === "device" ? inputRoute.device.connectedAt : undefined;
				}
				if (force || changed || deviceRetryRequired) notifyConnectedDevice(ctx);
				deviceRetryRequired = false;
				reconnectDiagnostic = { notified: false };
				refreshDeviceLabel();
				return true;
			} catch (error) {
				if (epoch === playbackRequestEpoch && ctx === activeContext) {
					deviceRetryRequired = true;
					if (!stopUnconfirmed || (!stopResources.input.episode && !stopResources.output.episode)) {
						notifyVoice(ctx, `Device: ${error instanceof Error ? error.message : String(error)}${stopUnconfirmed ? ` Stop unconfirmed; ownership retained. ${stopRecoveryAdvice}.` : " Retry /voice reconnect."}`, "error", reconnectDiagnostic);
					}
				}
				throw error;
			}
		})();
		const barrier = adoption.then(() => {
			if (stopUnconfirmed) throw new Error("Voice stop unconfirmed; retry /voice reconnect");
		});
		deviceRebind = barrier;
		const clearBarrier = () => {
			if (deviceRebind === barrier) {
				deviceRebind = undefined;
				finishSpeechPreemption();
				flushDeferredRelease();
			}
		};
		void adoption.finally(() => {
			if (deviceRebind === barrier || !deviceRebind) {
				handoffConnecting = false;
				refreshProgressWidget();
			}
		}).catch(() => {});
		void barrier.then(clearBarrier, () => {
			if (stopUnconfirmed) unconfirmedDeviceStops.add(barrier);
			else clearBarrier();
		});
		return adoption.catch(() => false);
	};

	const currentRoutedReplay = () => pendingReplay &&
		(pendingReplay.waiting || pendingReplay.rerouted) &&
		pendingReplay.epoch === playbackRequestEpoch ? pendingReplay : undefined;

	// Logical suspension never retires a physical scope. All admission still runs
	// through adoptCurrentConnection's original-resource recovery barrier.
	const suspendDevicePlayback = (manual = false): void => {
		// Automatic routing changes the destination, not an in-flight user takeover.
		if (currentRoutedReplay() && (!manual || !pendingReplay!.waiting)) {
			pendingReplay!.rerouted = true;
			vocalizer.setPlaybackPaused(true);
			return;
		}
		if (routeIntent?.request === playbackRequestEpoch && routeIntent.context === contextEpoch) return;
		const active = !!pendingReplay || (ownsSpeech &&
			((lastOwnerUtterance !== undefined && playbackUtterances.has(lastOwnerUtterance)) ||
				(speechPurpose === "turn" && liveTurnNarrationActive && !ownerTurnEnded)));
		if (!active) { routeIntent = undefined; return; }
		const playing = !(pendingReplay?.paused ?? playbackPaused);
		pendingReplay = undefined;
		coordinator?.cancelSpeechAcquisition();
		routeIntent = { request: ++playbackRequestEpoch, context: contextEpoch, playing };
		pausedOwnerUtterance = undefined;
		playbackPaused = true;
		queueIncomingWhilePaused = true;
		attentionSuppressed = true;
		coordinator?.setAttentionEnabled(false);
		narration.setPaused(true);
		vocalizer.setPlaybackPaused(true);
		refreshStatus();
	};

	const handoffDevice = async (id: string, current: () => boolean, manual = false): Promise<(() => Promise<void>) | undefined> => {
		devicePicker?.abort();
		suspendDevicePlayback(manual);
		const acquisition = currentRoutedReplay();
		const epoch = acquisition ? playbackRequestEpoch : ++playbackRequestEpoch;
		if (routeIntent) routeIntent = { ...routeIntent, request: epoch };
		const intent = routeIntent;
		const origin: ConnectionDevice = id === "local" ? { kind: "intentional_local" } : { kind: "device", id };
		if (!await adoptCurrentConnection(epoch, true, origin, current, manual ? id : undefined, true, !manual) ||
			!current() || epoch !== playbackRequestEpoch || !interactiveVoiceSession) return;
		playbackUtterances.clear();
		// Publish the route first. Resume only after its flight/manual selection has
		// retired, so every replay can await every routing barrier without a bypass.
		return async () => {
			if (!current() || epoch !== playbackRequestEpoch || routePending || routeFlight || manualRoutesPending) return;
			// Only a live coroutine can finish its original admission. A failed transport
			// wait retains intent, not a phantom continuation; retry it once on this route.
			if (acquisition) {
				if (!acquisition.waiting && pendingReplay === acquisition) {
					await playTarget(acquisition.target, acquisition.recordTimings, acquisition.previewTarget,
						true, false, acquisition.restoreTail, undefined, false, !manual);
				}
				return;
			}
			if (routeIntent !== intent) return;
			routeIntent = undefined;
			if (!intent || intent.context !== contextEpoch) {
				if (!pendingReplay && lastOwnerUtterance === undefined) {
					deferredRelease = { input: inputEpoch, lease: speechLeaseEpoch, context: contextEpoch, announceNext: false };
					flushDeferredRelease();
				}
				return;
			}
			const target = playbackHistory.resumeTarget();
			playbackPaused = !intent.playing;
			queueIncomingWhilePaused = playbackPaused || (queueIncomingWhilePaused && !!liveSource && !liveSource.final);
			narration.setPaused(playbackPaused);
			if (target) await playTarget(target, false, false, true, false, false, undefined, false, !manual);
			else refreshStatus();
		};
	};

	const pollDeviceRouting = (): void => {
		if (!routing || !interactiveVoiceSession) return;
		try {
			if (routing.update(deviceRouter.connected(config.output === "auto" ? "output" : undefined), activeDeviceId, devicePin, JSON.stringify([config.input, config.output]))) routePending = true;
			if (!routePending || routeFlight || manualRoutesPending) return;
			routePending = false;
			// Explicit endpoints remain authoritative; discovery must not pause their audio.
			if (config.output !== "auto" || orphanRecoveryBlocked) return;
			const selected = activeDeviceId;
			const row = routing.rows.find(row => row.id === selected);
			if (selected && !row?.available) suspendDevicePlayback();
			const winner = routing.winner(selected);
			if (!winner) return;
			const device = routing.devices.find(device => device.id === winner);
			const changed = winner !== selected || (device && (device.connectedAt !== outputGeneration || device.audioEndpoint !== outputEndpoint ||
				(inputInProgress && config.input === "auto" && device.inputEndpoint !== inputEndpoint)));
			if (!changed && !routeIntent) return;
			const revision = routing.revision;
			const context = contextEpoch;
			const manualRevision = manualRouteRevision;
			const current = () => context === contextEpoch && routing?.revision === revision && manualRouteRevision === manualRevision;
			let resume: (() => Promise<void>) | undefined;
			const flight = handoffDevice(winner, current).then(next => { resume = next; }).catch(error => notifyStopFailure(error)).finally(() => {
				if (routeFlight === flight) routeFlight = undefined;
				flushDeferredRelease();
				if (routePending) pollDeviceRouting();
				void resume?.().catch(notifyStopFailure);
			});
			routeFlight = flight;
		} catch (error) { notifyVoice(activeContext, `Device routing: ${String(error)}`, "error"); }
	};

	const selectDevice = async (ctx: ExtensionContext, requested: VoiceDeviceSelection, available = () => true, confirmCurrent = false): Promise<void> => {
		devicePicker?.abort();
		const manualRevision = ++manualRouteRevision;
		routePending = false; // Events already observed cannot supersede this newer manual choice.
		manualRoutesPending++;
		let resume: (() => Promise<void>) | undefined;
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionEpoch = contextEpoch;
			const current = () => manualRevision === manualRouteRevision && sessionEpoch === contextEpoch && sessionId === activeContext?.sessionManager.getSessionId() && available();
			if (requested === "auto") requested = routing?.winner() ?? requested;
			const pinned = routing?.rows.find(row => row.pinned && row.available);
			if (config.output === "auto" && pinned && requested !== pinned.id) { requested = pinned.id; confirmCurrent = true; }
			if (routeIntent && requested !== "auto") {
				resume = await handoffDevice(requested, current, true);
				return;
			}
			// Confirming the same healthy route must not interrupt audio or implicitly pin.
			if (confirmCurrent && requested !== "auto" && requested === (activeDeviceId ?? deviceSelection) && current() &&
				!deviceRetryRequired && !deviceRebind && !transportStopPending && !inputStopPending) {
				try {
					const output = deviceRouter.routeMetadata(requested, "output", config.output);
					const input = deviceRouter.routeMetadata(requested, "input", config.input);
					if (output.endpoint === outputEndpoint && input.endpoint === inputEndpoint &&
						(output.kind === "device" ? output.device.connectedAt : undefined) === outputGeneration &&
						(input.kind === "device" ? input.device.connectedAt : undefined) === inputGeneration) {
						if (deviceSelection !== requested) {
							deviceSelection = requested;
							persistDevice();
						}
						return;
					}
				} catch { /* Unavailable routes retain the normal validated transition. */ }
			}
			const epoch = ++playbackRequestEpoch;
			const paused = playbackPaused || !!pendingReplay || (ownsSpeech &&
				(lastOwnerUtterance !== undefined || (speechPurpose === "turn" && liveTurnNarrationActive && !ownerTurnEnded)));
			pendingReplay = undefined;
			coordinator?.cancelSpeechAcquisition();
			playbackPaused = paused;
			narration.setPaused(paused);
			vocalizer.setPlaybackPaused(true);
			const origin: ConnectionDevice | undefined = requested === "auto" ? undefined
				: requested === "local" ? { kind: "intentional_local" } : { kind: "device", id: requested };
			if (!await adoptCurrentConnection(epoch, true, origin, current, requested) ||
				epoch !== playbackRequestEpoch || !current() || !interactiveVoiceSession) return;
			playbackUtterances.clear();
			queueIncomingWhilePaused = paused;
			attentionSuppressed = paused;
			coordinator?.setAttentionEnabled(config.enabled && !paused);
			playbackPaused = paused;
			narration.setPaused(paused);
			vocalizer.setPlaybackPaused(paused);
			state = "idle";
			refreshStatus();
			refreshPlaybackTimeline();
		} finally {
			manualRoutesPending--;
			if (routePending) pollDeviceRouting();
			await resume?.();
		}
	};

	let devicePicker: AbortController | undefined;
	const pickDevice = async (ctx: ExtensionContext): Promise<void> => {
		if (!interactiveVoiceSession || devicePicker) return;
		pollDeviceRouting();
		const session = ctx.sessionManager.getSessionId();
		const context = contextEpoch;
		const request = playbackRequestEpoch;
		const setting = deviceSettingEpoch;
		const input = inputEpoch;
		const framing = framingIntent;
		const settings = config;
		const controller = devicePicker = new AbortController();
		if (!routing) { devicePicker = undefined; return; }
		const cache = routing;
		const current = () => context === contextEpoch && session === activeContext?.sessionManager.getSessionId() &&
			request === playbackRequestEpoch && setting === deviceSettingEpoch && input === inputEpoch &&
			framing === framingIntent && settings === config && interactiveVoiceSession;
		try {
			const choice = await selectPriorityDeviceOverlay(ctx, {
				snapshot: () => cache.snapshot,
				onAction: (action, snapshot) => {
					if (!current() || controller.signal.aborted || cache.snapshot !== snapshot) return;
					if (action.kind === "pin") { devicePin = action.id; persistDevice(); }
					else if (action.kind === "place") cache.store.place(action.id, action.index);
					else cache.store.reset(action.id);
					pollDeviceRouting();
				},
			}, controller.signal, narrationTui ?? undefined);
			if (controller.signal.aborted || context !== contextEpoch || session !== activeContext?.sessionManager.getSessionId() ||
				request !== playbackRequestEpoch || setting !== deviceSettingEpoch || input !== inputEpoch ||
				framing !== framingIntent || settings !== config || !interactiveVoiceSession) return;
			if (choice === undefined) return;
			const target = cache.devices.find(device => device.id === choice);
			const available = () => choice === "local" || !!target && deviceRouter.connected().some(device => device.id === choice &&
				device.connectedAt === target.connectedAt && device.audioEndpoint === target.audioEndpoint && device.inputEndpoint === target.inputEndpoint);
			if (!available()) { notifyVoice(ctx, "Device is no longer available; reopen the picker", "warning"); return; }
			await selectDevice(ctx, choice, available, true);
		} catch (error) {
			if (context === contextEpoch && interactiveVoiceSession) notifyVoice(ctx, `Device picker: ${String(error)}`, "error");
		} finally {
			if (devicePicker === controller) devicePicker = undefined;
		}
	};

	let deviceSettingEpoch = 0;
	// Metadata lookup failures do not block overrides; unconfirmed stops always do.
	const prepareDeviceSetting = async (ctx: ExtensionContext, stopOutput: boolean): Promise<boolean> => {
		devicePicker?.abort();
		const settingEpoch = ++deviceSettingEpoch;
		const sessionEpoch = contextEpoch;
		// SDK command/event contexts are distinct facades with dynamic session getters.
		const sessionId = ctx.sessionManager.getSessionId();
		const inputCancelled = inputInProgress ? cancelActiveInput() : inputStopBarrier;
		const cancelId = stopOutput ? clearPlaybackTransport() : undefined;
		const epoch = playbackRequestEpoch;
		if (stopOutput) {
			narration.finish();
			releaseAfterTransportCancellation(cancelId, false, inputCancelled);
		}
		await inputCancelled;
		const rebind = deviceRebind;
		if (rebind) await rebind.catch(error => { if (unconfirmedDeviceStops.has(rebind)) throw error; });
		await inputStopBarrier;
		await transportStopBarrier;
		return settingEpoch === deviceSettingEpoch && sessionEpoch === contextEpoch &&
			sessionId === activeContext?.sessionManager.getSessionId() &&
			epoch === playbackRequestEpoch && interactiveVoiceSession;
	};

	const previewPlaybackTarget = (target: PlaybackTarget, explicit = true): void => {
		playbackTailIntent = false;
		navigationTail = undefined;
		playbackUtterances.clear();
		lastPlaybackTick = undefined;
		narration.setCompletedText(target.text, target.messageType, target.contentIndex, target.displayOffset);
		narration.previewSourceOffset(target.sourceOffset);
		// Cached descriptions already have a source map; no audio or provider work is needed.
		const stream = new SpeakableStream();
		const item = [...stream.push(target.text), ...stream.flush()]
			.find(item => item.kind === "code" && item.source.start === target.sourceOffset);
		if (item?.kind === "code" && activeContext) {
			const entry = config.codeDescriptionContext === "conversation" ? completedBranch(activeContext)
				.find(entry => entry.id === target.id || target.id.startsWith(`${entry.id}:`)) : undefined;
			const contextual = entry ? completedEntryMessages(activeContext, entry, config.mode, true)
				.find(message => message.id === target.id) : undefined;
			const completed = contextual && completedCodeItems(contextual).find(candidate => candidate.sourceEnd === item.source.end);
			const source = pendingReplay?.source && (pendingReplay.target.id === target.id ||
				[...pendingReplay.blockIds.values()].includes(target.id)) ? pendingReplay.source : liveSource;
			const messages = config.codeDescriptionContext === "conversation" && !completed && source
				? assistantCodeContext(source.before, source.assistant, target.contentIndex ?? 0, item.source.end, source.final) : [];
			const plan = messages && codeDescriptionCache.get(descriptionCacheKey(activeContext, completed?.block ?? item.block,
				completed?.identityContext ?? (() => structuredContextIdentity(messages))));
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
		target: PlaybackTarget & { source?: typeof liveSource; tailPrefix?: string; audioOffset?: PlaybackResumeSnapshot["audioOffset"] },
		recordTimings: boolean,
		previewTarget = false,
		queued = false,
		framed = false,
		restoreTail = false,
		prepareContext?: ExtensionContext,
		explicitPlay = false,
		automaticRoute = false,
	): Promise<void> => {
		if (!interactiveVoiceSession) return;
		routeIntent = undefined;
		if (!queued) restoreBottomAfterSpeech = restoreTail;
		let sourceOffset = Math.max(0, Math.min(target.text.length, target.sourceOffset));
		let suffix = target.text.slice(sourceOffset);
		const retry = pendingReplay?.target.id === target.id ? pendingReplay : undefined;
		const replayBlockIds = retry?.blockIds ?? liveBlockIds;
		const displacedLiveTurn = ownsSpeech && speechPurpose === "turn" && !ownerTurnEnded;
		let liveTargetIndex = [...replayBlockIds].find(([, id]) => id === target.id)?.[0];
		// Undefined on a retry is an established historical source, not today's live turn.
		const replaySource = retry ? retry.source : (liveSource && !liveSource.final &&
			(livePlaybackId === target.id || liveTargetIndex !== undefined) ? liveSource : undefined);
		const requestedLiveSource = retry ? retry.source : target.source ?? replaySource;
		const continueLiveTurn = !!replaySource;
		const prefix = target.tailPrefix ?? target.text.slice(0, sourceOffset);
		const content = (replaySource?.assistant as { content?: unknown[] } | undefined)?.content;
		const closedPrefix = retry && target === retry.target ? retry.closedPrefix : (prefix === target.text &&
			!!(replaySource?.final || (liveTargetIndex ?? 0) < (content?.length ?? 0) - 1));
		if (!suffix.trim() && !continueLiveTurn) return;
		if (pendingSpeechPreemption) {
			notifyVoice(activeContext, "Handoff waiting · stopping the previous device", "warning");
			return;
		}

		if (!queued && !retry) {
			queuedPausedMessages.length = 0;
			queueIncomingWhilePaused = false;
		}
		if (!queued) {
			// Accepting a new navigation intent retires the old detached Resume checkpoint,
			// before either preparation or another announcement can yield to F8.
			pausedAnnouncementResume = undefined;
			if (pendingNotification) {
				const paused = playbackPaused;
				clearPlaybackTransport();
				playbackPaused = paused;
			}
			const announcement = announceWaiting(true);
			if (announcement && !await announcement) return;
		}
		attentionSuppressed = false;
		coordinator?.setAttentionEnabled(config.enabled);
		coordinator?.cancelSpeechAcquisition();
		const owner = coordinator;
		const request = {
			epoch: ++playbackRequestEpoch,
			target: { ...target, sourceOffset },
			recordTimings,
			previewTarget,
			restoreTail,
			paused: explicitPlay ? false : pendingReplay?.paused ?? playbackPaused,
			waiting: true,
			acquiring: false,
			explicit: !queued || !!retry?.explicit,
			rerouted: !!retry?.rerouted,
			phase: (prepareContext ? "queued" : "connecting") as PlaybackPhase,
			continueLiveTurn,
			source: replaySource,
			blockIds: replayBlockIds,
			closedPrefix,
		};
		pendingReplay = request;
		if (replaySource && !replaySource.final) {
			queueIncomingWhilePaused = true;
			vocalizer.setPlaybackPaused(true);
		}
		// Keep the requested target usable by F6–F10 and F8 while another process
		// acknowledges shutdown. Do not destroy the current sink before ownership.
		playbackHistory.beginCapture(target.id, target.text, target.time, false, sourceOffset, target.skipUnits ?? 0);
		playbackPaused = request.paused;
		narration.setPaused(playbackPaused);
		pausedOwnerUtterance = undefined;
		if (!framed) previewPlaybackTarget({ ...target, sourceOffset }, !queued);
		refreshPlaybackTimeline();

		let retryable = false;
		let newlyAcquired = false;
		// update() advances this even when a routing/manual flight defers the event.
		const routingRevision = routing?.revision;
		const retainRouteIntent = () => {
			retryable = request.rerouted = true;
			if (pendingReplay !== request || request.epoch !== playbackRequestEpoch) return;
			routeIntent = { request: request.epoch, context: contextEpoch, playing: !request.paused };
			vocalizer.setPlaybackPaused(true);
			refreshStatus();
		};
		const requestCurrent = () => pendingReplay === request && request.epoch === playbackRequestEpoch &&
			owner === coordinator && interactiveVoiceSession;
		// Every asynchronous admission step can overlap a newer route/stop. Drain
		// the current barriers, not just the ones present when F5 first arrived.
		const admissionBarrier = () => routeFlight || deviceRebind ||
			(transportStopPending && transportStopBarrier) || (inputStopPending && inputStopBarrier);
		const admissionCurrent = () => {
			if (!requestCurrent()) return false;
			if (routePending || ((request.rerouted || routing?.revision !== routingRevision) &&
				config.output === "auto" && activeDeviceId && activeDeviceId !== "local" &&
				!routing?.rows.find(row => row.id === activeDeviceId)?.available)) {
				// A missing registration cannot admit I/O or release an existing sink's lease.
				retainRouteIntent();
				// Unused acquisition is released in finally; an activated lease must
				// stay coherent with ownsSpeech until stop proof or real preemption.
				return false;
			}
			return true;
		};
		const awaitAdmission = async (): Promise<boolean> => {
			try {
				while (requestCurrent()) {
					const barrier = admissionBarrier();
					if (!barrier) return true;
					await barrier;
				}
			} catch { retainRouteIntent(); }
			return false;
		};
		try {
		if (prepareContext) {
			if (!await preparePlaybackMessages(prepareContext, request.epoch) || pendingReplay !== request) return;
			const messages = syncPlaybackMessages(prepareContext, false, true);
			target = request.target;
			if (!replaySource && !messages.some(message => message.id === target.id && message.text === target.text)) {
				pendingReplay = undefined;
				return;
			}
			// Resolve absolute timing only after canonical identities and snapshots are available.
			playbackHistory.beginCapture(target.id, target.text, target.time, false, sourceOffset, target.skipUnits ?? 0);
			target = playbackHistory.resumeTarget()!;
			request.target = { ...request.target, ...target, sourceOffset };
			request.recordTimings = recordTimings = recordTimings && !playbackHistory.hasCompleteTimingFor(target.id);
			refreshPlaybackTimeline();
		}

		request.phase = "connecting";
		refreshPlaybackTimeline();
		try {
			if (inputInProgress) await finishInputForPlayback();
			if (pendingReplay !== request || request.epoch !== playbackRequestEpoch) return;
			if (inputStopPending) await inputStopBarrier;
		} catch (error) {
			if (pendingReplay !== request || request.epoch !== playbackRequestEpoch) return;
			pendingReplay = undefined;
			vocalizer.setPlaybackPaused(true);
			playbackPaused = true;
			narration.setPaused(true);
			refreshStatus();
			notifyVoice(activeContext, `Replay blocked; microphone ownership retained: ${error instanceof Error ? error.message : String(error)} · ${stopRecoveryAdvice}`, "error");
			return;
		}
		while (admissionBarrier()) if (!await awaitAdmission()) return;
		if (!admissionCurrent()) return;
		if (!queued && !request.paused && !await adoptCurrentConnection(request.epoch)) {
			retainRouteIntent();
			return;
		}
		while (admissionBarrier()) if (!await awaitAdmission()) return;
		if (!admissionCurrent()) return;
		let acquired = true;
		if (coordinator && !(ownsSpeech && coordinator.ownsSpeech())) {
			if (coordinator.tryAcquireSpeech()) newlyAcquired = true;
			else if (automaticRoute) acquired = false;
			else {
				request.phase = "queued";
				refreshPlaybackTimeline();
				request.acquiring = !queued;
				acquired = await coordinator.forceAcquireSpeech();
				newlyAcquired = acquired;
				request.acquiring = false;
			}
		}
		if (!requestCurrent()) return;
		while (admissionBarrier()) if (!await awaitAdmission()) return;
		if (!admissionCurrent()) return;
		if (!acquired) {
			retryable = true;
			request.waiting = false;
			request.paused = true;
			playbackPaused = true;
			narration.setPaused(playbackPaused);
			vocalizer.setPlaybackPaused(true);
			pausedForAttention = true;
			refreshStatus();
			notifyVoice(activeContext, "Replay paused · another project owns playback; retry ↺ when it finishes", "warning");
			return;
		}

		request.phase = "connecting";
		refreshPlaybackTimeline();
		const completedAssistant = waitingSource && !replaySource && !target.source && activeContext && completedAssistantMessages(activeContext, config.mode, false)
			.find(message => message.id === target.id)?.assistantMessage;
		const handledSource = replaySource ?? target.source ??
			(waitingSource && completedAssistant === waitingSource.assistant ? waitingSource : undefined);
		if (!activateSpeechOwnership(continueLiveTurn && !replaySource?.final ? "turn" : "replay", true, true, handledSource ?? null)) {
			pendingReplay = undefined;
			return;
		}
		if (replaySource) {
			// Keep collecting the source until the old sink acknowledges cancellation.
			// Starting continuation earlier would lose deltas behind transportStopPending.
			const cancelId = clearPlaybackTransport();
			request.epoch = playbackRequestEpoch;
			pendingReplay = request;
			playbackPaused = request.paused;
			try { await waitForTransportCancellation(cancelId); }
			catch (error) {
				retainRouteIntent();
				if (pendingReplay === request) {
					request.waiting = false;
					request.paused = playbackPaused = true;
					narration.setPaused(true);
					refreshStatus();
					notifyVoice(activeContext, `Replay stop failed; ownership retained: ${String(error)} · ${stopRecoveryAdvice}`, "error");
				}
				return;
			}
			if (pendingReplay !== request || request.epoch !== playbackRequestEpoch) return;
		}
		while (admissionBarrier()) if (!await awaitAdmission()) return;
		if (!admissionCurrent()) return;
		// Preparation, microphone shutdown, device adoption and acquisition can all
		// outlive the prefix or even message_end. Replay the latest source once.
		target = request.target;
		if (requestedLiveSource) {
			const blocks = eligibleAssistantBlocks(requestedLiveSource.assistant, config.mode);
			liveTargetIndex ??= target.contentIndex ?? blocks[0]?.contentIndex;
			const block = blocks.find(block => block.contentIndex === liveTargetIndex);
			if (requestedLiveSource.final && (!block || !hasSpeakableAudio(block.text))) {
				// Retire only this request. Remaining blocks and newer responses still
				// belong to the queue, and a later F8 may have changed its pause intent.
				pendingReplay = undefined;
				playbackPaused = request.paused;
				narration.finish();
				narration.setPaused(playbackPaused);
				ownerContentExpected = false;
				ownerTurnEnded = true;
				speechPurpose = undefined;
				completedOwnerUtterance = lastOwnerUtterance;
				if (liveSource?.final) queueIncomingWhilePaused = false;
				refreshPlaybackTimeline();
				completeOwnerSpeech(false);
				return;
			}
			if (block) {
				const retained = playbackHistory.updateText(target.id, block.text, block);
				const checkpoint = retained ? undefined : playbackHistory.resumeSnapshot(request.paused, target.id);
				target = { ...target, ...block, ...(checkpoint ? { ...checkpoint, audioOffset: checkpoint.audioOffset } : {}) };
			}
		}
		sourceOffset = target.sourceOffset;
		suffix = target.text.slice(sourceOffset);
		if (replaySource) {
			speechConversationMessages = replaySource.before;
			speechAssistantMessage = replaySource.assistant;
			if (request.previewTarget) previewPlaybackTarget({ ...target, sourceOffset }, !queued);
			else {
				narration.setCompletedText(target.text, target.messageType, target.contentIndex, target.displayOffset);
				narration.previewSourceOffset(sourceOffset);
			}
			queueIncomingWhilePaused = false;
		}
		if (liveSource?.final) queueIncomingWhilePaused = false;
		if (request.explicit || replaySource) {
			// A source that arrived during acquisition still belongs behind this replay.
			queueIncomingWhilePaused = queueIncomingWhilePaused && !!liveSource && !liveSource.final && liveSource !== requestedLiveSource;
			// Only discard this request's source; later tool responses must drain normally.
			for (let i = queuedPausedMessages.length - 1; i >= 0; i--) {
				if (queuedPausedMessages[i].source === requestedLiveSource) queuedPausedMessages.splice(i, 1);
			}
		}
		const currentLiveSource = replaySource === liveSource;
		speechPurpose = continueLiveTurn && currentLiveSource && !replaySource?.final ? "turn" : "replay";
		pendingReplay = undefined;
		playingSource = requestedLiveSource;
		liveTurnNarrationActive = continueLiveTurn && currentLiveSource;
		if (continueLiveTurn && currentLiveSource) {
			queueIncomingWhilePaused = false;
			// Capture can be ahead of the audible block when a setting dirties the turn.
			livePlaybackId = target.id;
			liveBlockIndex = liveTargetIndex;
			liveDisplayOffset = target.displayOffset ?? 0;
			if (liveTargetIndex !== undefined) liveBlockIds.set(liveTargetIndex, target.id);
			ownedSpeechText = target.text;
		}
		if (liveSource && !liveSource.final && (displacedLiveTurn || liveSource !== requestedLiveSource) &&
			(!continueLiveTurn || !currentLiveSource)) {
			// Keep the streaming response independent from this completed snapshot.
			// Later deltas are collected for attention instead of joining replay audio.
			speechBlocked = true;
			blockedSpeechText = eligibleAssistantBlocks(liveSource.assistant, config.mode).map(block => block.text).join("\n");
			blockedMessageHasSpeech = hasSpeakableAudio(blockedSpeechText);
		}
		codeWorkEpoch += 1;
		if (activeContext) scheduleMissingCodeDescriptions(activeContext);
		cancelTimingWorkers();
		if (!replaySource) clearPlaybackTransport();
		// Timeline movement replaces the sink without changing transport state.
		// Sticky worker pause applies even before the replacement sink exists.
		vocalizer.setPlaybackPaused(request.paused);
		playbackHistory.beginCapture(target.id, target.text, target.time, recordTimings, sourceOffset, target.skipUnits ?? 0);
		if (replaySource) playbackHistory.updateText(target.id, target.text, target);
		const contextual = activeContext
			? completedAssistantMessages(activeContext, config.mode, config.codeDescriptionContext === "conversation").find(message => message.id === target.id)
			: undefined;
		if (!replaySource) {
			speechConversationMessages = contextual?.conversationMessages ?? [];
			speechAssistantMessage = contextual?.assistantMessage;
		}
		speechContentIndex = contextual?.contentIndex ?? target.contentIndex ?? speechContentIndex;
		setDescriptionSource(speechContentIndex, continueLiveTurn ? 0 : sourceOffset);
		playbackPaused = request.paused;
		playbackTailIntent = request.target.tailPrefix !== undefined;
		playbackTailSourceEnd = request.target.tailPrefix?.trimEnd().length ?? 0;
		narration.setPaused(playbackPaused);
		pausedOwnerUtterance = undefined;
		refreshPlaybackTimeline();
		ownerContentExpected = hasSpeakableAudio(suffix);
		if (ownerContentExpected) announceProjectForSpeech();
		if (continueLiveTurn) {
			liveCaptureOrigin = sourceOffset;
			vocalizer.setNarrationSourceOffset(0, target.skipUnits ?? 0, target.audioOffset);
			// Closure belongs to the navigation intent, not a later message_end.
			const prefix = request.target.tailPrefix ?? target.text.slice(0, sourceOffset);
			// A closed block has no unfinished unit to retain at Tail.
			if (closedPrefix) vocalizer.setNarrationSourceOffset(prefix.length);
			vocalizer.seedLivePrefix(closedPrefix ? "" : prefix);
			vocalizer.pushDelta(target.text.slice(prefix.length));
			// Later content blocks can arrive while a dirty/paused live target is
			// retained. Catch up from the source snapshot before accepting deltas.
			if (liveTargetIndex !== undefined) replayBlockIds.set(liveTargetIndex, target.id);
			for (const block of eligibleAssistantBlocks(replaySource?.assistant, config.mode)) {
				if (block.contentIndex <= (liveTargetIndex ?? -1)) continue;
				if (currentLiveSource) pushLiveDelta(block.messageType, block.contentIndex, block.text);
				else {
					// A new tool turn owns live capture now. Drain the old source as
					// completed blocks without lending its IDs to the new assistant.
					vocalizer.flush();
					liveCaptureOrigin = 0;
					const offset = narration.startMessage();
					const id = replayBlockIds.get(block.contentIndex) ?? `live:${++nextLivePlaybackId}`;
					replayBlockIds.set(block.contentIndex, id);
					playbackHistory.beginCapture(id, block.text, 0, true, 0, 0, false);
					playbackHistory.updateText(id, block.text, block);
					setDescriptionSource(block.contentIndex);
					narration.pushDelta(block.messageType, block.contentIndex, block.text, block.displayOffset);
					vocalizer.setNarrationSourceOffset(offset);
					vocalizer.pushDelta(block.text);
				}
			}
			if (replaySource?.final) {
				vocalizer.flush();
				if (activeContext) finalizePlaybackMessages(activeContext,
					eligibleAssistantBlocks(replaySource.assistant, config.mode).flatMap(block => {
						const id = replayBlockIds.get(block.contentIndex);
						return id ? [{ ...block, id }] : [];
					}), replaySource.assistant, replaySource.existingEntries, replayBlockIds);
				if (currentLiveSource) livePlaybackId = undefined;
			}
		} else vocalizer.speakFrom(suffix, sourceOffset, target.skipUnits ?? 0, target.audioOffset);
		ownerTurnEnded = !continueLiveTurn || !!replaySource?.final;
		completeOwnerSpeech();
		} finally {
			request.waiting = request.acquiring = false;
			// Any later await can cancel admission after acquisition, not just forceAcquireSpeech.
			// A newer playback request may reuse the lease; an abandoned admission may not.
			if (newlyAcquired && owner !== coordinator) owner?.releaseSpeech();
			else if (newlyAcquired && !ownsSpeech && (!pendingReplay?.waiting || pendingReplay === request) &&
				(!requestCurrent() || retryable)) owner?.releaseSpeech();
			if (pendingReplay === request && request.epoch === playbackRequestEpoch && !retryable) pendingReplay = undefined;
		}
	};

	const renderKeyFor = (ctx: ExtensionContext, message: ContextualPlaybackMessage): string => {
		const dependencies: Array<{ key: string; value: string; missing: boolean }> = [];
		for (const item of completedCodeItems(message)) {
			const identity = item.identityContext;
			try {
				const key = descriptionCacheKey(ctx, item.block, identity);
				const plan = codeDescriptionCache.get(key) ?? codeDescriptionFallbacks.get(key);
				const omitted = plan?.omitted || codeDescriptionOmissions.has(key);
				dependencies.push({ key, value: JSON.stringify([key, omitted ? "omitted" : plan ?? "missing"]), missing: !plan && !omitted });
			} catch {
				dependencies.push({ key: "", value: `fallback:${item.block.language}`, missing: false });
			}
		}
		const renderKey = narrationRenderKey(message.text, config, dependencies.map(dependency => dependency.value));
		if (dependencies.some(dependency => dependency.missing)) {
			unresolvedRenders.set(message.id, { text: message.text, config: { ...config }, renderKey, dependencies });
		} else unresolvedRenders.delete(message.id);
		return renderKey;
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
	const preparePlaybackMessages = async (ctx: ExtensionContext, request = playbackRequestEpoch, onChecked?: () => void): Promise<boolean> => {
		const epoch = contextEpoch;
		let sliceStart = performance.now();
		for (const entry of completedBranch(ctx)) {
			if (performance.now() - sliceStart >= 8) {
				await new Promise<void>(resolve => setImmediate(resolve));
				sliceStart = performance.now();
			}
			if (epoch !== contextEpoch || request !== playbackRequestEpoch || !isCurrentContext(ctx)) return false;
			// Navigation/scrolling also reads raw snapshots; warm those in the same bounded slice.
			if (config.codeDescriptionContext === "conversation") completedEntryMessages(ctx, entry, config.mode, false);
			for (const message of completedEntryMessages(ctx, entry, config.mode, config.codeDescriptionContext === "conversation")) {
				renderKeyFor(ctx, message);
				onChecked?.();
			}
		}
		if (epoch !== contextEpoch || request !== playbackRequestEpoch || !isCurrentContext(ctx)) return false;
		completedAssistantMessages(ctx, config.mode);
		return true;
	};

	const pendingCanonicalizations = new Set<(messages: PlaybackMessage[]) => boolean>();
	const syncPlaybackMessages = (ctx: ExtensionContext, selectLatest = false, replacing = false): PlaybackMessage[] => {
		const messages = playbackMessages(ctx);
		for (const canonicalize of pendingCanonicalizations) {
			if (canonicalize(messages)) pendingCanonicalizations.delete(canonicalize);
		}
		// Never let sync replace a selected live id before its session entry exists.
		const selected = playbackHistory.selected(true);
		if (pendingCanonicalizations.size > 0 || (!ownerTurnEnded && livePlaybackId !== undefined && selected?.id.startsWith("live:") && !messages.some(message => message.id === selected.id))) return messages;
		const updated = messages.find(message => message.id === selected?.id);
		// A cold preview has no asset identity yet; first canonicalization is not a settings change.
		if (!replacing && selected && updated && (selected.text !== updated.text ||
			(selected.renderKey !== undefined && selected.renderKey !== updated.renderKey))) pauseDirtyPlayback();
		playbackHistory.sync(messages, selectLatest);
		return messages;
	};

	const finalizePlaybackMessages = (
		ctx: ExtensionContext,
		targets: Array<{ id: string; text: string; contentIndex: number }>,
		assistant: unknown,
		existingEntries: Set<string>,
		blockIds = liveBlockIds,
	): void => {
		targets = targets.filter(target => hasSpeakableAudio(target.text));
		for (const target of targets) {
			const retained = playbackHistory.updateText(target.id, target.text);
			if (pendingReplay?.target.id === target.id && !retained) {
				const checkpoint = playbackHistory.resumeSnapshot(pendingReplay.paused, target.id);
				if (checkpoint) Object.assign(pendingReplay.target, checkpoint, { audioOffset: checkpoint.audioOffset });
			}
			const queued = queuedPausedMessages.find(message => message.id === target.id);
			if (queued) Object.assign(queued, target);
			// The final source is authoritative even before its session entry exists.
			if (pausedAnnouncementResume?.id === target.id) {
				const snapshot = playbackHistory.resumeSnapshot(true, target.id);
				pausedAnnouncementResume = snapshot && { ...snapshot, source: pausedAnnouncementResume.source };
			}
		}
		for (const [contentIndex, id] of blockIds) {
			if (targets.some(target => target.id === id)) continue;
			playbackHistory.remove(id);
			blockIds.delete(contentIndex);
			for (let i = queuedPausedMessages.length - 1; i >= 0; i--) {
				if (queuedPausedMessages[i].id === id) queuedPausedMessages.splice(i, 1);
			}
			if (pausedAnnouncementResume?.id === id) {
				// The announcement already cancelled this transport. Resume may drain
				// remaining blocks, but must never recreate the disappeared source.
				pausedAnnouncementResume = undefined;
				pausedOwnerUtterance = undefined;
				completedOwnerUtterance = lastOwnerUtterance;
				lastPlaybackTick = undefined;
				narration.finish();
			}
		}
		if (targets.length === 0) return;
		const epoch = contextEpoch;
		const canonicalize = (messages: PlaybackMessage[]): boolean => {
			if (epoch !== contextEpoch || !isCurrentContext(ctx)) return true;
			const entry = ctx.sessionManager.getBranch().find(entry => entry.type === "message" &&
				!existingEntries.has(entry.id) && (entry.message === assistant || JSON.stringify(entry.message) === JSON.stringify(assistant)));
			if (!entry) return false;
			for (const target of targets) {
				const completed = messages.find(message => message.id === (target.contentIndex === 0 ? entry.id : `${entry.id}:${target.contentIndex}`));
				if (!completed) continue;
				// updateText has already discarded offsets invalidated by destructive final text.
				const pausedResume = pausedAnnouncementResume?.id === target.id
					? playbackHistory.resumeSnapshot(true, target.id) : undefined;
				playbackHistory.rename(target.id, completed);
				if (pausedResume) pausedAnnouncementResume = { ...pausedResume, ...completed, source: pausedAnnouncementResume?.source };
				if (livePlaybackId === target.id) livePlaybackId = completed.id;
				if (navigationTail?.id === target.id) navigationTail.id = completed.id;
				if (pendingReplay?.target.id === target.id) Object.assign(pendingReplay.target, completed);
				if (blockIds.get(target.contentIndex) === target.id) blockIds.set(target.contentIndex, completed.id);
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
			// Paused playback has no worker event to paint delayed session insertion.
			refreshProgressWidget();
			if (!pendingCanonicalizations.has(canonicalize) || attempt >= 5) return;
			const timer = setTimeout(() => {
				try { retry(attempt + 1); } catch { /* Session replacement invalidates retries. */ }
			}, [0, 20, 100, 250, 500][attempt]);
			timer.unref?.();
		};
		retry();
	};

	let timingRetry: { controller: AbortController; worker: VoiceWorkerClient; progress: string } | undefined;
	let timingRetryRetirement = Promise.resolve();
	const cancelTimingRetry = (): void => {
		const retry = timingRetry;
		timingRetry = undefined;
		retry?.controller.abort();
		if (retry) timingRetryRetirement = Promise.all([timingRetryRetirement, retry.worker.terminate().catch(() => {})]).then(() => {});
	};

	// Snapshot the spoken plan synchronously; missing descriptions never invoke a provider.
	const cachedTimingItems = (ctx: ExtensionContext, message: ContextualPlaybackMessage) => {
		const stream = new SpeakableStream();
		const items: Array<{ text: string; source: SpeakableSourceRange; wordTimings: boolean }> = [];
		const dependencies: string[] = [];
		for (const item of [...stream.push(message.text), ...stream.flush()]) {
			if (item.kind === "speech") { items.push({ ...item, wordTimings: true }); continue; }
			const block = completedCodeItems(message).find(block => block.sourceEnd === item.source.end)!;
			let key: string;
			try { key = descriptionCacheKey(ctx, block.block, block.identityContext); }
			catch { return undefined; }
			const plan = codeDescriptionCache.get(key) ?? codeDescriptionFallbacks.get(key);
			const omitted = plan?.omitted || codeDescriptionOmissions.has(key);
			if (!plan && !omitted) return undefined;
			dependencies.push(JSON.stringify([key, omitted ? "omitted" : plan]));
			if (omitted) continue;
			let chunks = chunkCodeNarration(plan!);
			if (!chunks.length) chunks = chunkCodeNarration(plainCodeNarration(fallbackCodeDescription(item.block)));
			for (const chunk of chunks) items.push({ text: chunk.text, source: item.source, wordTimings: false });
		}
		return { items, renderKey: narrationRenderKey(message.text, config, dependencies) };
	};

	const retryMessageTimings = (ctx: ExtensionContext, scope: string): void => {
		const messages = completedAssistantMessages(ctx, config.mode, config.codeDescriptionContext === "conversation");
		let selected: ContextualPlaybackMessage[];
		if (scope === "all") selected = messages;
		else if (scope === "current") selected = messages.filter(message => message.id === playbackHistory.selected()?.id);
		else if (/^[1-9]\d*-[1-9]\d*$/.test(scope)) {
			const [min, max] = scope.split("-").map(Number);
			if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max || max > messages.length) {
				notifyVoice(ctx, "Invalid timing retry range", "error"); return;
			}
			selected = messages.slice(min - 1, max);
		} else selected = messages.filter(message => message.id === scope);
		if (!selected.length || (scope !== "all" && !/^[1-9]\d*-[1-9]\d*$/.test(scope) && selected.length !== 1)) {
			notifyVoice(ctx, "Unknown or ambiguous timing retry target", "error"); return;
		}
		const targets = selected.map(message => ({ message, plan: cachedTimingItems(ctx, message) }));
		cancelTimingRetry();
		const settings = { ...config };
		const epoch = contextEpoch;
		const session = ctx.sessionManager.getSessionId();
		const retry = timingRetry = { controller: new AbortController(), worker: new VoiceWorkerClient(() => {}, () => settings), progress: `queued ${targets.length} targets` };
		const current = () => timingRetry === retry && !retry.controller.signal.aborted && epoch === contextEpoch &&
			session === activeContext?.sessionManager.getSessionId();
		const foregroundBusy = () => {
			const owner = coordinator?.speechOwner();
			return inputInProgress || (ownsSpeech && !playbackPaused) ||
				!!owner && (owner.instanceId !== coordinator?.instanceId || !playbackPaused);
		};
		const compatible = (message: ContextualPlaybackMessage, key: string) => current() &&
			completedAssistantMessages(ctx, config.mode, config.codeDescriptionContext === "conversation").some(candidate =>
				candidate.id === message.id && candidate.text === message.text && cachedTimingItems(ctx, candidate)?.renderKey === key);
		notifyVoice(ctx, `Timing retry · queued ${targets.length} targets`, "info");
		void (async () => {
			await timingRetryRetirement;
			let improved = 0, missing = 0, skipped = 0, estimated = 0;
			for (const [index, { message, plan }] of targets.entries()) {
				await new Promise<void>(resolve => setImmediate(resolve));
				if (!current()) return;
				retry.progress = `target ${index + 1}/${targets.length} · ${improved} improved · ${missing} missing cached audio`;
				if (!plan) { skipped++; continue; }
				let previousSource = -1, skipUnits = 0;
				for (const item of plan.items) {
					skipUnits = previousSource === item.source.start ? skipUnits + 1 : 0;
					previousSource = item.source.start;
					const unit = { sourceOffset: item.source.start, skipUnits };
					const old = playbackHistory.timingForUnit(message.id, plan.renderKey, unit);
					if (!old?.length) { skipped++; continue; }
					const mapped = new NarrationProgress();
					mapped.setCompletedText(message.text);
					mapped.registerSegment({ id: 1, utterance: 1, text: item.text, source: item.source });
					mapped.setSegmentAudio(1, 0, old[0].duration);
					const sourceWords = item.wordTimings ? mapped.sourceWordTimings(1).map(word => word.sourceOffset) : [];
					if (!playbackHistory.retryableTimingUnit(message.id, plan.renderKey, unit, sourceWords)) { skipped++; continue; }
					// One cache decode/alignment at a time; foreground owns the next slot.
					await new Promise<void>(resolve => setImmediate(resolve));
					let result: TimingRetryResult | undefined;
					while (!result) {
						while (current() && foregroundBusy()) {
							await new Promise<void>(resolve => { const timer = setTimeout(resolve, 50); timer.unref?.(); });
						}
						if (!compatible(message, plan.renderKey)) return;
						const preempt = new AbortController();
						const signal = AbortSignal.any([retry.controller.signal, preempt.signal]);
						const timer = setInterval(() => { if (foregroundBusy()) preempt.abort(); }, 50);
						timer.unref?.();
						try {
							result = await retry.worker.retryTiming(item.text, signal);
							if (preempt.signal.aborted) result = undefined;
						}
						catch (error) { if (!preempt.signal.aborted || !current()) throw error; }
						finally { clearInterval(timer); }
					}
					if (!compatible(message, plan.renderKey)) return;
					if (result.status === "cache-miss") { missing++; continue; }
					if (!Number.isFinite(result.duration) || result.duration <= 0 || Math.abs(result.duration - old[0].duration) > 0.02) { skipped++; continue; }
					mapped.setAlignment(1, result.words, result.quality);
					const words = item.wordTimings ? mapped.sourceWordTimings(1) : [];
					const quality = item.wordTimings ? mapped.timingQuality(1) : result.quality;
					const coverage = { total: words.length, estimated: words.filter(word => word.quality !== "ctc-refined").length };
					const points = [{ ...old[0], quality }, ...words.map(word => ({ ...word, duration: 0 }))];
					const previousRefined = playbackHistory.timingForUnit(message.id, plan.renderKey, unit)
						?.filter(point => point.duration === 0 && point.quality === "ctc-refined").length ?? 0;
					const snapshot = playbackHistory.refineTimingUnit(message.id, plan.renderKey, unit, points, coverage, sourceWords);
					if (snapshot) {
						pi.appendEntry(PLAYBACK_TIMING_ENTRY, snapshot);
						let versions = persistedTimingSnapshots.get(message.id);
						if (!versions) persistedTimingSnapshots.set(message.id, versions = new Map());
						versions.set(plan.renderKey, snapshot);
						const saved = snapshot.units?.find(entry => entry.unit.sourceOffset === unit.sourceOffset && entry.unit.skipUnits === unit.skipUnits);
						if (item.wordTimings ? (saved?.coverage?.total ?? 0) - (saved?.coverage?.estimated ?? 0) > previousRefined
							: quality === "ctc-refined" || quality === "mixed") improved++;
						if (item.wordTimings ? saved?.coverage?.estimated : quality !== "ctc-refined") estimated++;
					} else skipped++;
				}
			}
			if (current()) notifyVoice(ctx, `Timing retry · ${improved} improved · ${estimated} still estimated · ${missing} missing cached audio · ${skipped} skipped (missing plan, refined, incompatible or unknown timing)`, "info");
		})().catch(error => {
			if (current()) notifyVoice(ctx, `Timing retry · ${String(error)}`, "error");
		}).finally(() => {
			if (timingRetry === retry) timingRetry = undefined;
			void retry.worker.terminate().catch(() => {});
		});
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
			let processedMessages = ordered.length - missing.length;
			const phases = new Map<number, string>();
			let failedMessages = 0;
			let failureReason = "";
			const updateTimingProgress = (): void => {
				if (epoch !== contextEpoch || workEpoch !== timingWorkEpoch || !isCurrentContext(ctx)) return;
				const counts = new Map<string, number>();
				for (const phase of phases.values()) counts.set(phase, (counts.get(phase) ?? 0) + 1);
				timingPreprocessingProgress = {
					label: "Recovering speech timing", processed: processedMessages, total: ordered.length,
					detail: [...counts].map(([phase, count]) => `${phase}: ${count}`).join(" · "),
				};
				refreshPreprocessingProgress();
			};
			updateTimingProgress();
			const concurrency = resolveTimingConcurrency(config.timingPreprocessConcurrency, config.ttsDtype);
			const workers = ensureTimingWorkers(concurrency);
			const measurementConfig = config;
			let sliceStart = performance.now();
			await processConcurrently(missing, concurrency, async (message, lane) => {
				const phase = (label: string): void => { phases.set(lane, label); updateTimingProgress(); };
				phase("waiting for timing slot");
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
						phase("preparing text / descriptions");
						const prepared = await timingItemsFor(ctx, contextual);
						if (epoch !== contextEpoch || workEpoch !== timingWorkEpoch || !isCurrentContext(ctx)) return;
						measuredRenderKey = narrationRenderKey(message.text, measurementConfig, prepared.codeDependencies);
						if (renderKeyFor(ctx, contextual) !== measuredRenderKey) return;
						// Description resolution can return to a persisted fallback identity that
						// was unresolved at startup (and evicted from the bounded variant pool).
						playbackHistory.syncMessage({ ...message, renderKey: measuredRenderKey });
						if (!playbackHistory.hasCompleteTimingFor(message.id)) {
							const saved = persistedTimingSnapshots.get(message.id)?.get(measuredRenderKey);
							if (saved) playbackHistory.restore([saved], true);
						}
						if (playbackHistory.hasCompleteTimingFor(message.id)) {
							processedMessages += 1;
							updateTimingProgress();
							requestPlaybackTimeline();
							return;
						}
						let previousSource = -1;
						let skipUnits = 0;
						for (const item of prepared.items) {
							if (!canRecover()) return;
							skipUnits = item.source.start === previousSource ? skipUnits + 1 : 0;
							previousSource = item.source.start;
							const unit = { sourceOffset: item.source.start, skipUnits };
							const cached = playbackHistory.timingForUnit(message.id, measuredRenderKey, unit);
							if (cached) {
								phase("restoring timing units");
								checkpoints.push(...cached.map(point => ({ ...point, time: time + point.time })));
								time += cached[0].duration;
								continue;
							}
							phase("measuring audio");
							const duration = await workers[lane].measureSegment(item.text, measurementConfig, step => {
								phase(step === "cache-decode" ? "decoding cached audio" : "generating speech");
							});
							if (epoch !== contextEpoch || workEpoch !== timingWorkEpoch || !isCurrentContext(ctx) || !canRecover()) return;
							// One failed unit leaves the whole target incomplete; never persist a prefix as complete.
							if (!Number.isFinite(duration) || duration <= 0) throw new Error("Audio duration unavailable");
							// Original audio and a retry may have filled this unit while measurement awaited.
							const current = playbackHistory.timingForUnit(message.id, measuredRenderKey, unit);
							if (current?.[0].duration === duration) {
								checkpoints.push(...current.map(point => ({ ...point, time: time + point.time })));
								time += duration;
								continue;
							}
							const unitStart = checkpoints.length;
							checkpoints.push({ time, duration, sourceOffset: item.source.start, quality: "estimated" });
							let coverage = { estimated: 0, total: 0 };
							if (item.wordTimings) {
								phase("estimating word timing");
								const segmentId = ++timingSegmentId;
								timingNarration.registerSegment({
									id: segmentId,
									utterance: 1,
									text: item.text,
									source: item.source,
								});
								timingNarration.setSegmentAudio(segmentId, 0, duration);
								const words = timingNarration.sourceWordTimings(segmentId);
								coverage = { estimated: words.filter(word => word.quality !== "ctc-refined").length, total: words.length };
								for (const word of words) {
									const wordTime = time + word.time;
									if (word.sourceOffset === item.source.start || wordTime - lastWordTime < 0.4) continue;
									checkpoints.push({ time: wordTime, duration: 0, sourceOffset: word.sourceOffset, quality: word.quality });
									lastWordTime = wordTime;
								}
							}
							if (renderKeyFor(ctx, contextual) !== measuredRenderKey) return;
							playbackHistory.retainTimingUnit(message.id, measuredRenderKey, unit,
								checkpoints.slice(unitStart).map(point => ({ ...point, time: point.time - time })), coverage);
							time += duration;
						}
					} catch (error) {
						// Preemption is not a failed cache check or completed timing target.
						if (epoch === contextEpoch && workEpoch === timingWorkEpoch && isCurrentContext(ctx) && canRecover() &&
							error !== BACKFILL_EXHAUSTED && !/interrupted|cancelled/i.test(String(error))) {
							failedMessages += 1;
							failureReason = error instanceof Error ? error.message : String(error);
						}
						return;
					}
					if (checkpoints.length === 0 || epoch !== contextEpoch || workEpoch !== timingWorkEpoch || !isCurrentContext(ctx)) return;
					checkpoints.sort((left, right) => left.time - right.time);
					// Preserve all sentence starts; dropping them shifts code-description unit ordinals.
					try {
						if (renderKeyFor(ctx, contextual) !== measuredRenderKey) return;
						syncPlaybackMessages(ctx);
						const snapshot = playbackHistory.completeRecoveredTimings({
							version: 3,
							messageId: message.id,
							renderKey: measuredRenderKey,
							duration: time,
							checkpoints,
						});
						if (!snapshot) return;
						requestPlaybackTimeline();
						pi.appendEntry(PLAYBACK_TIMING_ENTRY, snapshot);
						processedMessages += 1;
						updateTimingProgress();
					} catch {
						// Session replacement can invalidate ctx between the epoch check and access.
					}
				};
				try {
					if (coordinator) await coordinator.withResource("timing", concurrency, processMessage);
					else await processMessage();
				} finally {
					phases.delete(lane);
					updateTimingProgress();
				}
			});
			if (failedMessages && epoch === contextEpoch && workEpoch === timingWorkEpoch && isCurrentContext(ctx)) {
				notifyVoice(ctx, `Timing incomplete · ${failedMessages} targets failed: ${failureReason} · ↺ replay to retry the selected message`, "warning");
			}
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
		if (previous.input !== next.input || previous.output !== next.output) pollDeviceRouting();
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
			if (disabledAttentionPending) coordinator?.markWaiting(outputConnection());
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
		notifyVoice(ctx, `Mode ${config.enabled ? "on" : "off"}`, "info");
	};

	const talk = async (ctx: ExtensionContext): Promise<void> => {
		restoreBottomAfterSpeech = false;
		bottomPinned = false;
		const talkEpoch = contextEpoch;
		const requestedPlaybackEpoch = playbackRequestEpoch;
		if (deviceRebind) {
			try { await deviceRebind; } catch { return; }
			if (talkEpoch !== contextEpoch || requestedPlaybackEpoch !== playbackRequestEpoch) return;
		}
		if (inputPhase === "recording" && activeInputEndpoint) {
			setInputProgress("🎙 Input · stopping recording…");
			try { await phoneInput.stop(activeInputEndpoint); }
			catch (error) { notifyVoice(ctx, `Microphone: ${String(error)}`, "error"); }
			return;
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
			captureRecoveryRoute("input", route);
			inputEndpoint = route.endpoint;
			inputGeneration = route.kind === "device" ? route.device.connectedAt : undefined;
			routed = { ...config, input: route.endpoint };
		} catch (error) {
			if (captureEpoch !== inputEpoch) return;
			clearInputProgress();
			notifyVoice(ctx, `Microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (routed.input === "disabled") {
			clearInputProgress();
			notifyVoice(ctx, "Microphone disabled · /voice input auto to enable", "warning");
			return;
		}
		if (inputPhase === "recording") {
			setInputProgress("🎙 Input · stopping recording…");
			try {
				await phoneInput.stop(activeInputEndpoint ?? routed.input);
			} catch (error) {
				notifyVoice(ctx, `Microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return;
		}
		if (inputPhase === "transcribing") {
			notifyVoice(ctx, "Waiting for the previous transcript", "info");
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
			notifyVoice(ctx, "Microphone blocked · another session owns this device", "warning");
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
		const finishForPlayback = async (stopCapture = true): Promise<void> => {
			reviewOnly = true;
			if (!stopCapture) return;
			if (inputPhase === "recording") await phoneInput.stop(activeInputEndpoint ?? routed.input);
			await finished.promise;
		};
		finishPendingDictation = finishForPlayback;
		try {
			const capture = await phoneInput.capture(routed.input, {
				onProgress: progress => {
					if (talkEpoch !== contextEpoch || captureEpoch !== inputEpoch) return;
					const elapsed = Math.floor(progress.elapsedSeconds);
					setInputProgress(
						progress.speechDetected
							? `🎙 Input · listening · ${elapsed}s · stops on silence; ${finishInputHint()}`
							: `🎙 Input · waiting for speech · ${elapsed}s · ${finishInputHint()}`,
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
			setInputProgress("🎙 Input · finalizing transcript…");
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
				notifyVoice(ctx, "No speech recognized · 🎙 /voice talk to retry", "warning");
				return;
			}
			if (!writeEditor(appendDictation(editorBase, formatAsrDisplay(candidates)))) {
				releaseSpeechOwnership(false);
				notifyVoice(ctx, "Manual edits preserved · review the draft before submitting", "info");
				return;
			}
			const editingModel = config.editModel === "current" ? (ctx.model?.id ?? "the current model") : config.editModel;
			const candidateLabel = `${candidates.length} ASR candidate${candidates.length === 1 ? "" : "s"}`;
			setInputProgress(
				config.editMode === "smart" && editorBase.trim()
					? `🎙 Input · resolving ${candidateLabel} + spoken edits · ${editingModel}…`
					: `🎙 Input · resolving ${candidateLabel} · ${editingModel}…`,
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
				notifyVoice(ctx,
					`Dictation resolution failed · using first transcript candidate; review the draft: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			if (!current()) return;
			if (!writeEditor(prompt)) {
				releaseSpeechOwnership(false);
				notifyVoice(ctx, "Manual edits preserved · review the draft before submitting", "info");
				return;
			}
			if (reviewOnly || config.submitMode === "review") {
				releaseSpeechOwnership(false);
				notifyVoice(ctx, "Dictation ready · review, then Enter to submit", "info");
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
			notifyVoice(ctx, `Microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
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
		clearInterval(devicePoll);
		priorityWatch?.close();
		routing = undefined;
		routeIntent = undefined;
		cancelAutomaticRecovery();
		if (automaticRecoveryFlight) await automaticRecoveryFlight;
		cancelTimingRetry();
		const inputCancelled = cancelActiveInput();
		clearPlaybackTransport();
		try {
			await Promise.all([inputCancelled, deviceRebind?.catch(() => {}), trackStop("output", vocalizer.shutdown())]);
			if (Object.values(stopResources).some(resource => resource.episode || resource.cleanup)) throw new Error("Newer stop remains unconfirmed");
			deviceRebind = undefined;
			for (const resolve of transportCancelWaiters.values()) resolve();
			transportCancelWaiters.clear();
			await transportStopBarrier.catch(() => {});
			transportStopBarrier = Promise.resolve();
			transportStopPending = false;
			transportStops.clear();
		} catch (error) {
			notifyVoice(ctx, `Reload stop failed; ownership retained: ${String(error)} · ${stopRecoveryAdvice}`, "error");
			throw error;
		}
		ownsSpeech = false;
		attentionSuppressed = false;
		deviceRetryRequired = false;
		disabledAttentionPending = false;
		waitingSource = undefined;
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
		restoreStopRecovery(true);
		automaticRecoveryEnabled = true;
		automaticRecoveryDelay = 3_000;
		scheduleAutomaticRecovery();
		const savedDevice = sessionDeviceSelection(ctx);
		deviceSelection = savedDevice.selection;
		devicePin = savedDevice.pin;
		activeDeviceId = savedDevice.selected ?? savedDevice.pin ?? (deviceSelection === "auto" ? undefined : deviceSelection);
		deviceRouter.setEnvironmentDevice(undefined);
		// A new session must not inherit route snapshots from the previous pin.
		outputEndpoint = inputEndpoint = "disabled";
		outputGeneration = inputGeneration = undefined;
		refreshDeviceLabel();
		if (deviceSelection === "auto" && !activeDeviceId) {
			const epoch = playbackRequestEpoch;
			await adoptCurrentConnection(epoch, true);
			if (epoch !== playbackRequestEpoch || activeContext !== ctx) return;
		} else {
			// Restored pins skip adoption. Seed both directions from metadata only,
			// after startup stop proof; later endpoint/generation changes still require handoff.
			try {
				const route = deviceRouter.routeMetadata(activeDeviceId ?? deviceSelection, "output", config.output);
				outputConnection(route);
				outputEndpoint = route.endpoint;
				outputGeneration = route.kind === "device" ? route.device.connectedAt : undefined;
			} catch { /* Unknown routes cannot match a later available endpoint. */ }
			try {
				const route = deviceRouter.routeMetadata(activeDeviceId ?? deviceSelection, "input", config.input);
				inputEndpoint = route.endpoint;
				inputGeneration = route.kind === "device" ? route.device.connectedAt : undefined;
			} catch { /* Unknown routes cannot match a later available endpoint. */ }
			notifyConnectedDevice(ctx);
		}
		const priorityFile = join(dirname(deviceRouter.directory), "device-priorities.json");
		routing = new DeviceRouting(new DevicePriorityStore(priorityFile));
		for (const id of [activeDeviceId, devicePin]) {
			if (id && id !== "auto" && id !== "local" && !Object.hasOwn(routing.store.snapshot.discovery, id)) routing.store.discover([{ id, date: Date.now() }]);
		}
		mkdirSync(dirname(priorityFile), { recursive: true, mode: 0o700 });
		priorityWatch = watch(dirname(priorityFile), (_event, file) => {
			if (String(file) !== "device-priorities.json") return;
			try { routing?.store.refresh(); pollDeviceRouting(); } catch (error) { notifyVoice(activeContext, String(error), "error"); }
		});
		priorityWatch.on("error", error => notifyVoice(activeContext, `Device priority watch: ${String(error)}`, "warning"));
		priorityWatch.unref();
		pollDeviceRouting();
		if (routeFlight) await routeFlight;
		devicePoll = setInterval(pollDeviceRouting, 1_000);
		devicePoll.unref();
		inputProgressMessage = undefined;
		// Remove progress widgets from versions before the unified, ordered display.
		ctx.ui.setWidget("pi-voice-input", undefined);
		ctx.ui.setWidget("pi-voice-playback", undefined);
		ctx.ui.setWidget("pi-voice-preprocessing", undefined);
		ctx.ui.setWidget("pi-voice-follow-hint", undefined);
		followHintVisible = false;
		if (attentionPollTimer) clearInterval(attentionPollTimer);
		attentionPollTimer = setInterval(() => {
			try { pollWaitingAttention(); }
			catch (error) {
				attentionSuppressed = true;
				notifyVoice(activeContext, `Attention poll failed; ownership retained: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}, 200);
		attentionPollTimer.unref?.();
		pendingCodeDescriptions.clear();
		codeDescriptionText.clear();
		reportedDescriptionOverflows.clear();
		codeDescriptionOmissions.clear();
		codeDescriptionFallbacks.clear();
		unresolvedRenders.clear();
		backfillAllowance = config.codeDescriptionPreprocessBudget;
		backfillUsed = 0;
		backfillExhaustionReported = false;
		codeDescriptionCache.restore(codeDescriptionSnapshots(ctx));
		const checkProgress: ReadyProgress = {
			label: "Checking saved timing", processed: 0,
			total: completedAssistantMessages(ctx, config.mode).length, unit: "checked",
		};
		timingPreprocessingProgress = checkProgress;
		refreshPreprocessingProgress();
		let lastCheckPaint = performance.now();
		const checked = await preparePlaybackMessages(ctx, playbackRequestEpoch, () => {
			checkProgress.processed += 1;
			if (performance.now() - lastCheckPaint >= 80 || checkProgress.processed === checkProgress.total) {
				lastCheckPaint = performance.now();
				refreshPreprocessingProgress();
			}
		});
		if (!checked) {
			if (timingPreprocessingProgress === checkProgress) timingPreprocessingProgress = undefined;
			refreshPreprocessingProgress();
			return;
		}
		const messages = syncPlaybackMessages(ctx, true);
		persistedTimingSnapshots = playbackTimingSnapshots(ctx, new Set(messages.map(message => message.id)));
		// Restore only exact current identities; unresolved assets remain lazily addressable
		// in the entry index even when the bounded historical variant pool evicts them.
		for (const message of messages) {
			const saved = message.renderKey && persistedTimingSnapshots.get(message.id)?.get(message.renderKey);
			if (saved) playbackHistory.restore([saved]);
		}
		timingPreprocessingProgress = undefined;
		scheduleMissingCodeDescriptions(ctx);
		refreshPlaybackTimeline();
		scheduleMissingTimings(ctx);
		if (ctx.mode === "tui") {
			ctx.ui.setWidget("pi-voice-render-driver", tui => {
				narrationTui = tui;
				// Native End (including remapped keys) and the mouse banner both route
				// through this method, after Pi has handled overlays/key releases/hit tests.
				// Observing the accepted action avoids mistaking wheel/search/layout motion for a pin.
				const native = tui as typeof tui & {
					scrollToBottom?: () => void;
					selectionAnchor?: { scrollView?: ReturnType<typeof activeScrollView> };
				} &
					Partial<Record<"handleViewportInput" | "refreshSearch" | "autoScrollSelection", (...args: unknown[]) => unknown>>;
				// Search reveals during render and selection autoscroll runs on a timer.
				// Observe those accepted moves, not arbitrary render/layout scroll changes.
				const restoreGestures = (["handleViewportInput", "refreshSearch", "autoScrollSelection"] as const).map(method => {
					const original = native[method];
					if (!original) return () => {};
					const observed = (...args: unknown[]) => {
						const view = method === "autoScrollSelection" ? native.selectionAnchor?.scrollView : activeScrollView();
						const before = view?.scrollTop;
						const intent = framingIntent;
						const result = original.apply(tui, args);
						// refreshSearch reports the move against its new layout, even
						// when a forced render has cleared the current primary view.
						const moved = method === "refreshSearch" ? result === true : view && view.scrollTop !== before;
						if (moved && intent === framingIntent) {
							narrationManuallyFramed = true;
							autoScrollForceOnce = false;
							restoreBottomAfterSpeech = false;
							bottomPinned = false;
						}
						if (method === "refreshSearch" && !result) {
							// Pi offers this post-layout hook before composing the visible frame.
							// Returning true asks native layout to repaint with the new scrollTop.
							const layout = args[0] as { root?: NarrationLayoutBox; primaryScrollView?: ReturnType<typeof activeScrollView> };
							const view = layout.primaryScrollView;
							const box = layout.root && view && narrationScrollBox(layout.root, view);
							if (view && box) {
								const top = view.scrollTop;
								requestNarrationAutoScroll(false, false, { view, box });
								return view.scrollTop !== top;
							}
						}
						return result;
					};
					native[method] = observed;
					return () => { if (native[method] === observed) native[method] = original; };
				});
				nativeGestureTracking = !!native.handleViewportInput;
				const originalBottom = native.scrollToBottom;
				const onBottom = () => {
					originalBottom!.call(tui);
					recordBottomPin();
				};
				if (originalBottom) native.scrollToBottom = onBottom;
				return {
					render: () => [],
					invalidate: () => {},
					dispose: () => {
						if (native.scrollToBottom === onBottom) native.scrollToBottom = originalBottom;
						restoreGestures.forEach(restore => restore());
						progressComponent?.invalidate();
						nativeGestureTracking = false;
						if (narrationTui === tui) narrationTui = null;
					},
				};
			});
		}
		refreshStatus();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearInterval(devicePoll);
		priorityWatch?.close();
		routing = undefined;
		routeIntent = undefined;
		cancelAutomaticRecovery();
		if (automaticRecoveryFlight) await automaticRecoveryFlight;
		cancelTimingRetry();
		devicePicker?.abort();
		devicePicker = undefined;
		if (preprocessingPaint) clearTimeout(preprocessingPaint);
		preprocessingPaint = undefined;
		displayedCodeProgress = displayedTimingProgress = undefined;
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
		codeDescriptionFallbacks.clear();
		unresolvedRenders.clear();
		clearInputProgress();
		ctx.ui.setStatus("pi-voice", undefined);
		ctx.ui.setWidget("pi-voice-render-driver", undefined);
		ctx.ui.setWidget("pi-voice-jump", undefined);
		jumpWidgetVisible = false;
		progressComponent?.invalidate();
		progressComponent = undefined;
		progressWidgetKey = undefined;
		progressRender = undefined;
		handoffConnecting = false;
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
		const retiringRebind = deviceRebind;
		const ownerRecovery = stopRecovery;
		const ownerRouter = deviceRouter;
		const ownerInput = config.input;
		const ownerOutput = config.output;
		let stopping: Promise<void> | undefined;
		const cleanup = (guard: Parameters<StopRecovery["retry"]>[3] = {}): Promise<void> => stopping ??= Promise.allSettled([
			trackStop("input", ownerRecovery?.episode("input")?.handles.length
				? phoneInput.recover(() => ownerRecovery.retry("input", ownerRouter, ownerInput, guard)) : phoneInput.cancel()), retiringRebind?.catch(() => {}),
			...workers.map(worker => worker.terminate()), trackStop("output", shutdownOutput(ownerRecovery, ownerRouter, ownerOutput, guard)),
		]).then(results => {
			const failure = results.find(result => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			guard.signal?.throwIfAborted();
			if (guard.current && !guard.current()) throw new Error("Recovery owner changed; ownership retained");
			if (Object.values(stopResources).some(resource => resource.episode || resource.cleanup)) throw new Error("Newer stop remains unconfirmed");
			retiringCoordinator?.shutdown();
			retiredStops.delete(cleanup);
		}).finally(() => { stopping = undefined; });
		retiredStops.add(Object.assign(cleanup, { owner: retiringCoordinator?.speechOwner(), root: retiringCoordinator?.root }));
		try {
			await Promise.all([inputCancelled, cleanup()]);
			deviceRebind = undefined;
		} catch (error) {
			notifyVoice(ctx, `Shutdown stop failed; ownership retained: ${String(error)} · ${stopRecoveryAdvice}`, "error");
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
		if (!interactiveVoiceSession || playbackPaused || (playbackTailIntent && !ownsSpeech && !pendingReplay && !attentionSuppressed)) return;
		disabledAttentionPending = false;
		queuedPausedMessages.length = 0;
		restoreBottomAfterSpeech = false;
		bottomPinned = false;
		coordinator?.clearWaiting();
		waitingSource = undefined;
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
		}).catch(notifyStopFailure);
	});

	pi.on("before_agent_start", async () => {
		if (!interactiveVoiceSession || playbackPaused || pendingNotification || (ownsSpeech && (speechPurpose === "replay" || lastOwnerUtterance !== completedOwnerUtterance)) || (playbackTailIntent && !ownsSpeech)) return;
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
		}).catch(notifyStopFailure);
	});

	pi.on("message_start", event => {
		if (interactiveVoiceSession && (event.message as { role?: string })?.role === "assistant") {
			if (!pendingNotification) {
				attentionSuppressed = false;
				coordinator?.setAttentionEnabled(config.enabled);
			}
			// A running replay owns its source/cursor just like a paused one. Model
			// output queues behind it; reacquiring "turn" would erase paint while audio plays.
			const replaying = !!pendingNotification || (ownsSpeech && (speechPurpose === "replay" || ownerTurnEnded));
			queueIncomingWhilePaused = config.enabled && (playbackPaused || !!pendingReplay || replaying);
			liveBlockIndex = undefined;
			liveBlockIds = new Map();
			if (pendingReplay || replaying) livePlaybackId = undefined;
			liveSource = { assistant: event.message, final: false, blockIds: liveBlockIds,
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
				!pendingSpeechPreemption && !stopsUnresolved() && !deviceRebind && !transportStopPending && liveTurnNarrationActive && ownsSpeech && speechPurpose === "turn" && (coordinator?.ownsSpeech() ?? true);
			const wasFollowingTranscriptEnd = transcriptIsFollowingEnd();
			if (!continuingTurn && !acquireSpeech("turn")) {
				speechBlocked = true;
				blockedMessageHasSpeech = false;
				blockedSpeechText = "";
				livePlaybackId = undefined;
				refreshStatus();
				return;
			}
			playingSource = liveSource;
			navigationTail = undefined;
			liveCaptureOrigin = 0;
			ownerTurnEnded = false;
			completedOwnerUtterance = undefined;
			ownedSpeechText = "";
			const sourceOffset = continuingTurn ? narration.startMessage() : 0;
			if (!continuingTurn) {
				playbackTailSourceEnd = 0;
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
		if (pendingSpeechPreemption || stopsUnresolved()) {
			speechBlocked = true;
			blockedSpeechText += text;
			if (pendingSpeechPreemption) pendingSpeechPreemption.spokenText += text;
			blockedMessageHasSpeech ||= hasSpeakableAudio(blockedSpeechText);
			if (livePlaybackId && (liveBlockIndex === undefined || liveBlockIndex === contentIndex)) {
				ownedSpeechText += text;
				playbackHistory.updateText(livePlaybackId, ownedSpeechText, { contentIndex, messageType, displayOffset: liveDisplayOffset });
			}
			return;
		}
		if (liveBlockIndex !== contentIndex) {
			if (liveBlockIndex !== undefined) {
				vocalizer.flush();
				liveCaptureOrigin = 0;
				vocalizer.setNarrationSourceOffset(narration.startMessage());
				livePlaybackId = liveBlockIds.get(contentIndex) ?? `live:${++nextLivePlaybackId}`;
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
		const sourceEnd = narration.sourceEnd;
		narration.pushDelta(messageType, contentIndex, text, liveDisplayOffset);
		vocalizer.pushDelta(text);
		if (narration.sourceEnd !== sourceEnd) requestPlaybackTimeline();
	};

	pi.on("message_update", event => {
		if (!interactiveVoiceSession || !config.enabled || config.mode === "yield") return;
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
		if (attentionSuppressed) return;
		if (deviceRebind || transportStopPending || pendingReplay) {
			speechBlocked = true;
			if (speakableDelta !== undefined) blockedSpeechText += speakableDelta;
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
		if (stopReason === "aborted" || stopReason === "error") {
			// A newer aborted response must not retire an unrelated paused replay.
			for (let i = queuedPausedMessages.length - 1; i >= 0; i--) {
				if (queuedPausedMessages[i].source === liveSource) queuedPausedMessages.splice(i, 1);
			}
			const affectsPlayback = (pendingReplay?.source && pendingReplay.source === liveSource) ||
				[...liveBlockIds.values()].includes(playbackHistory.selected()?.id ?? "") ||
				(liveTurnNarrationActive && !queueIncomingWhilePaused);
			if (!affectsPlayback) return;
			queueIncomingWhilePaused = false;
			queuedPausedMessages.length = 0;
			liveTurnNarrationActive = false;
			ownerTurnEnded = true;
			attentionSuppressed = true;
			const cancelId = clearPlaybackTransport();
			narration.finish();
			livePlaybackId = undefined;
			if (!inputInProgress) state = "idle";
			refreshStatus();
			refreshPlaybackTimeline();
			if (!speechReservedForInput && !inputInProgress) releaseAfterTransportCancellation(cancelId, true);
			return;
		}
		if (queueIncomingWhilePaused) {
			if (config.enabled && stopReason !== "aborted" && stopReason !== "error" && !(config.mode === "yield" && stopReason === "toolUse")) {
				const targets = eligible.map(block => {
					const id = liveBlockIds.get(block.contentIndex);
					if (id) return { ...block, id };
					const queued = { ...block, id: `live:${++nextLivePlaybackId}`, time: 0, sourceOffset: 0, source: liveSource };
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
		if (!config.enabled || attentionSuppressed || deviceRebind || transportStopPending || pendingSpeechPreemption || stopsUnresolved() || stopReason === undefined || !ownsSpeech || speechPurpose !== "turn") return;
		if (config.mode !== "yield") {
			ownerContentExpected = ownerContentExpected || hasSpeakableAudio(completedText);
			if (ownerContentExpected) announceProjectForSpeech();
			vocalizer.flush();
			ownerTurnEnded = true;
			completeOwnerSpeech();
		}
	});

	pi.on("turn_end", (event, ctx) => {
		if (!interactiveVoiceSession) return;
		if (queueIncomingWhilePaused) {
			queueIncomingWhilePaused = playbackPaused;
			ownerTurnEnded = true;
			completeOwnerSpeech();
			return;
		}
		const stopReason = assistantStopReason(event.message);
		const completedTurn = stopReason !== "aborted" && stopReason !== "error" && stopReason !== undefined;
		if (!config.enabled && !attentionSuppressed && requiresVoiceAttention(eligibleAssistantBlocks(event.message, config.mode).map(block => block.text).join("\n"), config.mode, stopReason)) {
			disabledAttentionPending = true;
			waitingSource = liveSource;
		}
		if (config.enabled && !attentionSuppressed && config.mode === "yield" && completedTurn) {
			const text = assistantText(event.message);
			if (text && stopReason !== "toolUse" && acquireSpeech("turn")) {
				navigationTail = undefined;
				const messages = syncPlaybackMessages(ctx);
				playingSource = liveSource;
				narration.begin();
				let firstBlock = true;
				for (const block of eligibleAssistantBlocks(event.message, config.mode)) {
					if (!hasSpeakableAudio(block.text)) continue;
					const contextual = completedAssistantMessages(ctx, config.mode, config.codeDescriptionContext === "conversation")
						.findLast(message => message.text === block.text && message.contentIndex === block.contentIndex);
					const completed = messages.find(message => message.id === contextual?.id);
					if (completed) {
						playingSource?.blockIds.set(block.contentIndex, completed.id);
						playbackHistory.beginCapture(completed.id, completed.text, 0, true, 0, 0, firstBlock);
					}
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
				waitingSource = liveSource;
				coordinator?.markWaiting(outputConnection());
				pausedForAttention = true;
				speechBlocked = false;
				blockedMessageHasSpeech = false;
				blockedSpeechText = "";
				if (!blockedWarningIssued) {
					blockedWarningIssued = true;
					notifyVoice(ctx, "Response waiting · ↺ F5 plays this project; /voice attention switches projects", "warning");
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
		description: "Toggle Voice output",
		handler: async ctx => {
			restoreBottomAfterSpeech = false;
			bottomPinned = false;
			await toggle(ctx);
		},
	});

	// Manual controls also preempt speech ownership while Pi streams. Live replay
	// replaces only the transport; the source continues collecting deltas.
	const requireEnabledVoice = (ctx: ExtensionContext): boolean => {
		if (!config.enabled) {
			notifyVoice(ctx, "Mode off · /voice on to enable", "warning");
			return false;
		}
		return true;
	};

	// These IDs belong to the source, not its position in the eligible block list.
	const liveNavigationMessages = (): PlaybackMessage[] => {
		if (!liveSource || liveSource.final) return [];
		return eligibleAssistantBlocks(liveSource.assistant, config.mode).filter(block => hasSpeakableAudio(block.text)).map(block => {
			let id = liveBlockIds.get(block.contentIndex);
			if (!id) {
				id = liveBlockIds.size === 0 && liveBlockIndex === undefined && livePlaybackId ? livePlaybackId : `live:${++nextLivePlaybackId}`;
				liveBlockIds.set(block.contentIndex, id);
			}
			return { ...block, id };
		});
	};

	// Resolve identity after preview, never in this shared scroll/control path.
	const preparePlaybackAction = async (ctx: ExtensionContext, pauseResume = false, deferInput = false): Promise<number | undefined> => {
		devicePicker?.abort();
		if (!requireEnabledVoice(ctx)) return;
		// Pause/resume edits the pending replay without invalidating its preparation.
		const epoch = pauseResume && pendingReplay ? playbackRequestEpoch : ++playbackRequestEpoch;
		if (!(pauseResume && pendingReplay)) coordinator?.cancelSpeechAcquisition();
		if (!deferInput && inputInProgress) {
			try { await finishInputForPlayback(); }
			catch (error) {
				notifyVoice(ctx, `Microphone: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
		}
		return epoch === playbackRequestEpoch && interactiveVoiceSession ? epoch : undefined;
	};

	// Preview raw source before contextual identities yield or device acquisition waits.
	const previewHistoricalTarget = (ctx: ExtensionContext, movement: -1 | 0 | 1, automatic = false): PlaybackTarget | undefined => {
		const { atTail } = playbackTailState(ctx);
		if (atTail && movement === 1) return;
		const branch = completedBranch(ctx);
		const fromTail = movement === -1 && atTail;
		const selected = fromTail || (movement === 0 && pausedForAttention) ? undefined : playbackHistory.selected();
		const liveMessages = liveNavigationMessages();
		const liveIndex = liveMessages.findIndex(message => message.id === selected?.id);
		const livePosition = liveSource && !liveSource.final ? [...liveBlockIds].find(([, id]) => id === selected?.id)?.[0] : undefined;
		const liveTarget = fromTail ? liveMessages.at(-1)
			: liveIndex >= 0 ? liveMessages[liveIndex + movement]
			: livePosition !== undefined && movement === 1 ? liveMessages.find(message => message.contentIndex! > livePosition)
			: livePosition !== undefined && movement === -1 ? liveMessages.findLast(message => message.contentIndex! < livePosition) : undefined;
		if (liveTarget) {
			const preview = { ...liveTarget, time: 0, sourceOffset: 0 };
			previewPlaybackTarget(preview, !automatic);
			return preview;
		}
		if ((liveIndex >= 0 || livePosition !== undefined) && movement > 0) return;
		const selectedEntry = selected ? branch.findIndex(entry => entry.id === selected.id || selected.id.startsWith(`${entry.id}:`)) : -1;
		const live = liveIndex >= 0 || (selectedEntry < 0 && !ownerTurnEnded && livePlaybackId !== undefined && selected?.id.startsWith("live:"));
		if (movement === 1 && selectedEntry < 0 && !live) return; // No selection means the latest completed response.
		const direction = selectedEntry >= 0 && movement === 1 ? 1 : -1;
		let skip = fromTail ? 0 : selectedEntry >= 0 ? Math.abs(movement) : movement === -1 && !live ? 1 : 0;
		let target: PlaybackMessage | undefined = live && movement === 0 ? selected : undefined;
		let boundary = selected;
		// Only parse the selected/adjacent source, not every completed response on a cold F5.
		for (let i = selectedEntry >= 0 ? selectedEntry : branch.length - 1; !target && i >= 0 && i < branch.length; i += direction) {
			const messages = completedEntryMessages(ctx, branch[i]!, config.mode, false);
			const selectedBlock = i === selectedEntry ? messages.findIndex(message => message.id === selected?.id) : -1;
			for (let j = selectedBlock >= 0 ? selectedBlock : direction === 1 ? 0 : messages.length - 1;
				j >= 0 && j < messages.length; j += direction) {
				if (skip-- > 0) { boundary = messages[j]; continue; }
				target = messages[j];
				break;
			}
		}
		if (!target && movement === 1) target = liveMessages[0];
		if (!target && movement === -1) target = boundary;
		if (!target) return;
		const preview = { ...target, time: 0, sourceOffset: 0 };
		previewPlaybackTarget(preview, !automatic);
		return preview;
	};

	const replaySelected = async (ctx: ExtensionContext, automatic = false, prepared = false): Promise<void> => {
		if (!requireEnabledVoice(ctx)) return;
		if (!automatic) {
			restoreBottomAfterSpeech = false;
			bottomPinned = false;
		}
		const restoreTail = atTranscriptTail && transcriptIsFollowingEnd();
		const target = previewHistoricalTarget(ctx, 0, automatic);
		if (!target) {
			notifyVoice(ctx, "Replay unavailable · no completed assistant message yet", "warning");
			return;
		}
		const request = prepared ? playbackRequestEpoch : await preparePlaybackAction(ctx, false, true);
		if (request === undefined || request !== playbackRequestEpoch) return;
		playbackPaused = false;
		narration.setPaused(playbackPaused);
		// Select now; canonical timing/history catch-up yields inside playTarget.
		void playTarget(target, !prepared || !playbackHistory.hasCompleteTimingFor(target.id), true, automatic, true, restoreTail, prepared ? undefined : ctx, true);
		// Let already-warm preparation finish its microtask without waiting on cold slices/device handoff.
		await Promise.resolve();
	};

	const reserveAttentionIntent = (): { epoch: number } => {
		// Retire obsolete preparation, not its still-playing transport/lease.
		pendingReplay = undefined;
		return attentionPreparation = { epoch: ++playbackRequestEpoch };
	};

	const finishAttentionPreparation = (preparation: { epoch: number }): void => {
		if (attentionPreparation !== preparation) return;
		attentionPreparation = undefined;
		completeOwnerSpeech();
	};

	playRequestedAttention = (ctx, request) => {
		const preparation = reserveAttentionIntent();
		const owner = coordinator!;
		const epoch = preparation.epoch;
		const current = () => owner === coordinator && epoch === playbackRequestEpoch &&
			config.enabled && !attentionSuppressed && owner.attentionRequestIsCurrent(request);
		void (async () => {
			if (inputInProgress) await finishInputForPlayback();
			if (inputStopPending) await inputStopBarrier;
			if (!current() || !await preparePlaybackMessages(ctx, epoch) || !current()) return;
			syncPlaybackMessages(ctx, false, true);
			if (!await owner.forceAcquireSpeech()) return;
			if (!current()) { if (!ownsSpeech) owner.releaseSpeech(); return; }
			// Only the requesting terminal resolves attachment identity; the waiting pane may be detached.
			if (!await adoptCurrentConnection(epoch, false, request.connection, current) || !current()) {
				if (!ownsSpeech && !deviceRebind) owner.releaseSpeech();
				return;
			}
			pausedForAttention = true;
			// Preparation is complete: no unguarded cold-history wait after accepting the request.
			await replaySelected(ctx, true, true);
			if (!ownsSpeech && !pendingReplay) owner.releaseSpeech();
		})().catch(error => {
			if (current()) notifyVoice(ctx, `Attention failed: ${String(error)}`, "error");
		}).finally(() => finishAttentionPreparation(preparation));
	};

	const attendNextProject = async (ctx: ExtensionContext): Promise<void> => {
		if (!requireEnabledVoice(ctx)) return;
		const owner = coordinator;
		const waiting = owner?.waitingSessions()[0];
		if (!owner || !waiting || waiting.instanceId === owner.instanceId) {
			await replaySelected(ctx);
			return;
		}
		owner.cancelSpeechAcquisition();
		const preparation = reserveAttentionIntent();
		let epoch = preparation.epoch;
		// Finalizing acquisition intentionally cancels once, synchronously before yielding.
		const captureEpoch = inputEpoch + (inputInProgress && inputPhase === "acquiring" ? 1 : 0);
		const current = () => owner === coordinator && epoch === playbackRequestEpoch && captureEpoch === inputEpoch && config.enabled && interactiveVoiceSession;
		try {
			if (inputInProgress) await finishInputForPlayback();
			if (inputStopPending) await inputStopBarrier;
			if (deviceRebind) await deviceRebind;
			if (!current()) return;
			const connection: ConnectionDevice = deviceSelection === "auto" ? await deviceRouter.resolveCurrentConnection()
				: deviceSelection === "local" ? { kind: "intentional_local" } : { kind: "device", id: deviceSelection };
			if (!current()) return;
			const cancelId = clearPlaybackTransport();
			epoch = playbackRequestEpoch;
			preparation.epoch = epoch;
			await waitForTransportCancellation(cancelId);
			if (!current()) return;
			if (ownsSpeech) preserveDisplacedSpeech({ purpose: speechPurpose, wasComplete: ownerTurnEnded, spokenText: ownedSpeechText });
			releaseSpeechOwnership(false);
			owner.requestAttention(waiting.instanceId, connection);
		} catch (error) {
			if (current()) notifyVoice(ctx, `Attention failed: ${String(error)}`, "error");
		} finally {
			finishAttentionPreparation(preparation);
		}
	};

	pi.registerShortcut("f6", {
		description: "⏮ Previous message",
		handler: async ctx => {
			if (!requireEnabledVoice(ctx)) return;
			const target = previewHistoricalTarget(ctx, -1);
			if (target) void playTarget(target, true, true, false, true, false, ctx);
		},
	});

	const stepSentence = async (ctx: ExtensionContext, direction: -1 | 1, fromPrevious = false, navigation?: PlaybackHistory): Promise<void> => {
		if (!requireEnabledVoice(ctx)) return;
		const { atTail, waiting } = playbackTailState(ctx);
		if (direction > 0 && waiting) return;
		if (direction > 0 && atTail) { followTranscriptTail(ctx); return; }
		const liveMessages = liveNavigationMessages();
		const messages = [...completedAssistantMessages(ctx, config.mode, false), ...liveMessages];
		const history = navigation ?? new PlaybackHistory();
		if (!navigation) {
			history.sync(messages);
			const cursor = playbackHistory.resumeTarget();
			const current = messages.find(message => message.id === cursor?.id);
			if (!atTail && cursor && current && (current.text === cursor.text || liveMessages.some(live => live.id === cursor.id))) {
				history.beginCapture(cursor.id, current.text, cursor.time, false, cursor.sourceOffset, cursor.skipUnits ?? 0);
			}
		}
		const selected = history.selected();
		if (!selected) { notifyVoice(ctx, "No completed assistant message", "warning"); return; }
		const contextual = config.codeDescriptionContext === "conversation"
			? completedAssistantMessages(ctx, config.mode, true).find(message => message.id === selected.id) ??
				(liveSource && liveMessages.some(message => message.id === selected.id)
					? { conversationMessages: liveSource.before, assistantMessage: liveSource.assistant, contentIndex: selected.contentIndex! } : undefined)
			: undefined;
		const stream = new SpeakableStream();
		const units: Array<{ sourceOffset: number; skipUnits: number }> = [];
		let complete = true;
		const content = (liveSource?.assistant as { content?: unknown[] } | undefined)?.content;
		const streaming = liveMessages.some(message => message.id === selected.id) &&
			selected.contentIndex === (content?.length ?? 0) - 1;
		for (const item of [...stream.push(selected.text), ...(streaming ? [] : stream.flush())]) {
			let count = 1;
			if (item.kind === "code") {
				const messages = contextual ? assistantCodeContext(
					contextual.conversationMessages, contextual.assistantMessage, contextual.contentIndex, item.source.end)! : [];
				const key = descriptionCacheKey(ctx, item.block, structuredContextIdentity(messages));
				const plan = codeDescriptionCache.get(key) ?? codeDescriptionFallbacks.get(key);
				const omitted = plan?.omitted || (!plan && codeDescriptionOmissions.has(key));
				if (!plan && !omitted) complete = false;
				count = omitted ? 0 : plan ? Math.max(1, chunkCodeNarration(plan).length) : 1;
			}
			for (let skipUnits = 0; skipUnits < count; skipUnits++) units.push({ sourceOffset: item.source.start, skipUnits });
		}
		const cursor = history.resumeTarget();
		if (direction < 0 && (!atTail || !units.length) && complete &&
			(!units.length || (!fromPrevious && (cursor?.sourceOffset ?? 0) <= units[0].sourceOffset && !cursor?.skipUnits)) &&
			(history.status()?.messageIndex ?? 0) > 0) {
			history.move(-1);
			return stepSentence(ctx, direction, true, history);
		}
		const target = fromPrevious && direction > 0
			? units[0] && { ...selected, time: 0, ...units[0] }
			: history.sentenceTarget(direction, units, atTail || fromPrevious);
		if (target) {
			const fullCapture = target.sourceOffset === units[0]?.sourceOffset && !target.skipUnits;
			await playTarget(target, fullCapture, true, false, false, false, ctx);
		} else if (direction > 0 && complete) {
			const before = history.status();
			if (before && before.messageIndex === before.messageCount - 1) followTranscriptTail(ctx);
			else {
				history.move(1);
				return stepSentence(ctx, direction, true, history);
			}
		} else {
			scheduleMissingTimings(ctx);
			notifyVoice(ctx, "Waiting for code-description sentence boundaries", "info");
		}
	};

	pi.registerShortcut("f7", {
		description: "↶ Previous sentence or newline",
		handler: ctx => stepSentence(ctx, -1),
	});

	const pauseCurrentPlayback = (preserveViewport: boolean): boolean => {
		if (playbackPaused) return true;
		if (!playbackHistory.selected() || !ownsSpeech || (lastOwnerUtterance === undefined && ownerTurnEnded)) return false;
		const pausedScrollTop = preserveViewport ? activeScrollView()?.scrollTop : undefined;
		pausedOwnerUtterance = lastOwnerUtterance;
		if (!liveTurnNarrationActive && speechPurpose === "turn" && !pendingReplay && vocalizer.playbackUtterance !== undefined) {
			playbackHistory.selectCapture(vocalizer.playbackUtterance);
		}
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
		if (!pendingNotification) {
			const announcement = announceWaiting(true, false, true);
			if (announcement) {
				queueIncomingWhilePaused = true;
				void announcement.then(current => { if (current) { refreshStatus(); refreshPlaybackTimeline(); } });
			}
		}
		return true;
	};

	const followTranscriptTail = (ctx: ExtensionContext): void => {
		const latest = liveNavigationMessages().at(-1) ?? (liveSource && !liveSource.final
			? { id: livePlaybackId ??= `live:${++nextLivePlaybackId}`, text: "" } : undefined);
		if (latest) {
			void playTarget({ ...latest, time: 0, sourceOffset: 0, tailPrefix: latest.text }, false, false, false, true, false, ctx);
			navigationTail = { id: latest.id };
			playbackTailIntent = true;
			refreshPlaybackTimeline();
			scrollToBottom(ctx);
			return;
		}
		navigationTail = { id: playbackTimeline(ctx).timeline.at(-1) };
		// Tail retires historical audio/preparation, not the user's play/pause intent.
		const paused = playbackPaused;
		const cancelId = clearPlaybackTransport();
		playbackPaused = paused;
		playbackTailIntent = true;
		narration.setPaused(paused);
		queuedPausedMessages.length = 0;
		queueIncomingWhilePaused = false;
		scrollToBottom(ctx);
		releaseAfterTransportCancellation(cancelId, true);
	};

	pi.registerShortcut("f8", {
		description: "⏯ Pause or resume playback",
		handler: async ctx => {
			if (!requireEnabledVoice(ctx)) return;
			if (pendingNotification && pausedAnnouncementResume && playbackPaused) {
				const target = pausedAnnouncementResume;
				clearPlaybackTransport();
				playbackPaused = false;
				void playTarget(target, false, false, true);
				return;
			}
			if (pendingNotification) {
				playbackPaused = !playbackPaused;
				narration.setPaused(playbackPaused);
				vocalizer.setPlaybackPaused(playbackPaused);
				refreshStatus(); refreshPlaybackTimeline();
				return;
			}
			if (pausedAnnouncementResume && playbackPaused) {
				const target = pausedAnnouncementResume;
				pausedAnnouncementResume = undefined;
				playbackPaused = false;
				void playTarget(target, false, false, true);
				return;
			}
			if (playbackPaused && ownerTurnEnded && (lastOwnerUtterance === undefined
				? ownsSpeech && speechPurpose === undefined && !speechReservedForInput
				: completedOwnerUtterance === lastOwnerUtterance)) {
				playbackPaused = false;
				narration.setPaused(false);
				vocalizer.setPlaybackPaused(false);
				completeOwnerSpeech(false);
				return;
			}
			if (routeIntent) {
				// Explicit pause supersedes saved playing intent without admitting a sink.
				routeIntent = undefined;
				++playbackRequestEpoch;
				// Retain source/Tail intent in a new object; never lend the cancelled
				// coroutine the new epoch when its old cancellation ACK eventually arrives.
				if (pendingReplay) pendingReplay = { ...pendingReplay, epoch: playbackRequestEpoch,
					paused: true, waiting: false, acquiring: false };
				vocalizer.setPlaybackPaused(true);
				playbackPaused = true;
				narration.setPaused(true);
				refreshStatus();
				return;
			}
			if (playbackTailIntent && !ownsSpeech && !pendingReplay && !attentionSuppressed) {
				playbackPaused = !playbackPaused;
				narration.setPaused(playbackPaused);
				queueIncomingWhilePaused = playbackPaused;
				if (!playbackPaused) {
					const queued = queuedPausedMessages.shift();
					if (queued) void playTarget(queued, !playbackHistory.hasCompleteTimingFor(queued.id), false, true);
					else if (liveSource && !liveSource.final) {
						const live = liveNavigationMessages()[0] ?? { id: livePlaybackId ??= `live:${++nextLivePlaybackId}`, text: "" };
						void playTarget({ ...live, time: 0, sourceOffset: 0 }, true, false, true);
					}
				}
				refreshStatus();
				refreshPlaybackTimeline();
				return;
			}
			// Model completion is not audio completion: a started or startup-pending
			// turn/replay still owns its sink, even when the viewport is at the tail.
			if (atTranscriptTail && !playbackPaused && !attentionSuppressed &&
				!(ownsSpeech && (speechPurpose === "turn" || speechPurpose === "replay") && (lastOwnerUtterance !== undefined || !ownerTurnEnded)) &&
				(pausedOwnerUtterance === undefined || !ownsSpeech) && !pendingReplay) {
				await replaySelected(ctx);
				return;
			}
			const retainTail = !narrationManuallyFramed && (nativeGestureTracking || lastAutoScrollTop === undefined || activeScrollView()?.scrollTop === lastAutoScrollTop);
			if (pendingReplay) pendingReplay.restoreTail &&= retainTail;
			const restoreTail = (atTranscriptTail && transcriptIsFollowingEnd()) || (restoreBottomAfterSpeech && retainTail);
			armNarrationFollow();
			flushNarrationRender();
			requestNarrationAutoScroll(true, true);
			const requestEpoch = await preparePlaybackAction(ctx, true);
			if (requestEpoch === undefined || requestEpoch !== playbackRequestEpoch) return;
			if (pendingReplay) {
				const request = pendingReplay;
				request.restoreTail &&= !narrationManuallyFramed &&
					(nativeGestureTracking || lastAutoScrollTop === undefined || activeScrollView()?.scrollTop === lastAutoScrollTop);
				if (request.paused && !request.waiting) {
					request.paused = false;
					playbackPaused = false;
					narration.setPaused(playbackPaused);
					void playTarget(request.target, request.recordTimings, request.previewTarget, false, false, request.restoreTail);
					return;
				}
				request.paused = !request.paused;
				if (request.paused && currentRoutedReplay() && request.rerouted) {
					coordinator?.cancelSpeechAcquisition();
					playbackRequestEpoch += 1;
					pendingReplay = { ...request, epoch: playbackRequestEpoch, waiting: false, acquiring: false };
				}
				playbackPaused = request.paused;
				narration.setPaused(playbackPaused);
				vocalizer.setPlaybackPaused(request.paused);
				if (request.paused) {
					const announcement = announceWaiting(true, false, true);
					if (announcement) {
						queueIncomingWhilePaused = true;
						void announcement.then(current => { if (current) { refreshStatus(); refreshPlaybackTimeline(); } });
					}
				}
				refreshStatus();
				refreshPlaybackTimeline();
				if (!request.waiting && !request.paused) {
					void playTarget(request.target, request.recordTimings, request.previewTarget, true, false, request.restoreTail);
				}
				return;
			}
			if (pendingSpeechPreemption) {
				notifyVoice(ctx, "Handoff waiting · stopping the previous device", "warning");
				return;
			}
			restoreBottomAfterSpeech = restoreTail && !narrationManuallyFramed;
			bottomPinned = false;
			if (playbackPaused) {
				if (lastPlaybackTick) narration.setPlayback(lastPlaybackTick.utterance, lastPlaybackTick.position, true);
				if (!await adoptCurrentConnection(requestEpoch) || requestEpoch !== playbackRequestEpoch) return;
				playbackPaused = false;
				if (speechPurpose === "replay" && !liveTurnNarrationActive && (!liveSource || liveSource.final)) queueIncomingWhilePaused = false;
				narration.setPaused(playbackPaused);
				if (liveTurnNarrationActive && ownsSpeech && speechPurpose === "turn" && !ownerTurnEnded && !queueIncomingWhilePaused) {
					vocalizer.setPlaybackPaused(false);
					pausedOwnerUtterance = undefined;
					refreshStatus();
					refreshPlaybackTimeline();
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
				notifyVoice(ctx, "Nothing playing · ↺ F5 to replay", "warning");
			}
		},
	});

	pi.registerShortcut("f9", {
		description: "↷ Next sentence/newline; follow tail after the last",
		handler: ctx => stepSentence(ctx, 1),
	});

	pi.registerShortcut("f10", {
		description: "⏭ Next message; follow tail after the last",
		handler: async ctx => {
			if (!requireEnabledVoice(ctx) || playbackTailState(ctx).waiting) return;
			const target = previewHistoricalTarget(ctx, 1);
			if (target) void playTarget(target, true, true, false, true, false, ctx);
			else {
				followTranscriptTail(ctx);
			}
		},
	});

	pi.registerShortcut("f5", {
		description: "↺ Replay this project's response",
		handler: async ctx => { await replaySelected(ctx); },
	});

	const registeredTalkShortcut = config.talkShortcut;
	const effectiveTalkShortcuts = new Set<string>();
	if (config.talkShortcut !== "disabled") {
		const registerTalkShortcut = (key: Exclude<VoiceConfig["talkShortcut"], "disabled">): void => {
			effectiveTalkShortcuts.add(key);
			pi.registerShortcut(key, {
				description: "🎙 Start or stop dictation",
				handler: ctx => {
					void talk(ctx);
				},
			});
		};
		registerTalkShortcut(config.talkShortcut);
		if (config.talkShortcut !== "f4") registerTalkShortcut("f4");
	}

	const scrollToNarration = (ctx: ExtensionContext): void => {
		if (!ownsSpeech || narration.activeWordStart === undefined) {
			notifyVoice(ctx, "No narrated position · replay first, then Alt+V to follow", "warning");
			return;
		}
		restoreBottomAfterSpeech = false;
		armNarrationFollow(true);
		requestNarrationAutoScroll(true, true);
	};

	if (config.scrollToShortcut !== "disabled" && config.scrollToShortcut !== config.scrollBottomShortcut) {
		pi.registerShortcut(config.scrollToShortcut, {
			description: "Follow the narrated position without resuming",
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

	const devicePickerConflict = [config.talkShortcut, config.scrollToShortcut, config.scrollBottomShortcut].includes("alt+s");
	if (!devicePickerConflict) pi.registerShortcut("alt+s", {
		description: "Choose voice device",
		handler: pickDevice,
	});
	pi.on("session_start", (_event, ctx) => {
		if (devicePickerConflict && supportsInteractiveVoice(ctx.mode)) notifyVoice(ctx,
			"Alt+S device picker not bound: a configured voice control already uses it; use /voice devices", "warning");
	});

	pi.registerCommand("voice", {
		description: "Voice playback and dictation · /voice help",
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
				"help",
				"devices",
				"code-narration",
				"code-budget",
				"code-retry",
				"code-preprocess",
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
					{ value: "device auto", label: "auto", description: "Select by priority; use the picker to pin separately" },
					{ value: "device local", label: "local", description: "Use devices on the machine running Pi" },
					{ value: "device next", label: "next", description: "Select the next registered device (stable ID order)" },
					{ value: "device prev", label: "prev", description: "Select the previous registered device" },
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
			if (parts[0] === "timing") {
				if (parts.length === 2) return ["workers", "retry"]
					.filter(value => value.startsWith(parts[1]))
					.map(value => ({ value: `timing ${value}`, label: value }));
				if (parts[1] === "retry" && parts.length === 3) return ["current", "all"]
					.filter(value => value.startsWith(parts[2]))
					.map(value => ({ value: `timing retry ${value}`, label: value }));
				if (parts[1] === "workers" && parts.length === 3) return ["auto", "1", "2", "3", "4", "5", "6", "7", "8"]
					.filter(value => value.startsWith(parts[2]))
					.map(value => ({ value: `timing workers ${value}`, label: value }));
				return null;
			}
			if (parts[0] === "code-preprocess" || parts[0] === "tts-workers" || parts[0] === "tts-worker") {
				const choices = ["1", "2", "3", "4", "5", "6", "7", "8"];
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
					{ value: "output auto", label: "auto", description: "Use the selected connection's output; no fallback from an unavailable pin" },
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
					{ value: "input auto", label: "auto", description: "Use the selected connection's microphone; no fallback from an unavailable pin" },
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
			// Timing queries and invalid arguments must not touch playback, recording or follow state.
			if (normalizedAction === "timing") {
				if (value.toLowerCase() === "retry" && restArgs.length === 1) {
					retryMessageTimings(ctx, restArgs[0]);
					return;
				}
				const workers = () => `${config.timingPreprocessConcurrency} → ${resolveTimingConcurrency(config.timingPreprocessConcurrency, config.ttsDtype)}${timingPreprocessing ? `; active batch=${timingWorkers.length}` : ""}`;
				if (!value) {
					notifyVoice(ctx, `${playbackTimingStatus(playbackHistory.status()?.wordTimingCoverage)}\n${narration.timingSummary()}\nTiming workers: ${workers()}${timingRetry ? `\nTiming retry: ${timingRetry.progress}` : ""}`, "info");
					return;
				}
				if (value.toLowerCase() === "workers" && restArgs.length === 0) {
					notifyVoice(ctx, `timing workers: ${workers()}`, "info");
					return;
				}
				if (value.toLowerCase() === "workers" && restArgs.length === 1 && /^(auto|[1-8])$/i.test(restArgs[0])) {
					const concurrency = normalizePreprocessConcurrency(restArgs[0].toLowerCase() === "auto" ? "auto" : Number(restArgs[0]))!;
					await updateConfig({ ...config, timingPreprocessConcurrency: concurrency });
					notifyVoice(ctx, `timing workers: ${workers()}`, "info");
					return;
				}
				notifyVoice(ctx, "Usage: /voice timing [workers [auto|<1..8>]|retry current|all|<min>-<max>|<exact-id>]", "error");
				return;
			}
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
					if (normalizedAction === "device") {
						const devices = deviceRouter.connected();
						notifyVoice(ctx, `Available devices (metadata only): ${devices.length ? devices.map(device => `${device.name} (${device.id})`).join("; ") : "none"}`, "info");
					}
					const selection = activeDeviceId ?? deviceSelection;
					if (normalizedAction !== "device" && config[normalizedAction] !== "auto") {
						notifyVoice(ctx, `${normalizedAction}: ${config[normalizedAction]} (explicit)`, "info");
						return;
					}
					let device;
					try { device = deviceRouter.resolve(selection); } catch (error) {
						notifyVoice(ctx, `${normalizedAction}: ${normalizedAction === "device" ? selection : config[normalizedAction]} → unavailable (${error instanceof Error ? error.message : String(error)}); metadata only`, "info");
						return;
					}
					const current = normalizedAction === "device"
						? `${deviceSelection} → ${device ? `${device.id} (${device.name})` : "local"}`
						: `${config[normalizedAction]} → ${normalizedAction === "output"
							? (config.output === "auto" ? device?.audioEndpoint ?? "local" : config.output)
							: (activeInputEndpoint ?? (config.input === "auto" ? device?.inputEndpoint ?? "local" : config.input))}`;
					notifyVoice(ctx, `${normalizedAction}: ${current}`, "info");
					return;
				}
				if (Object.hasOwn(queries, normalizedAction)) {
					const current = queries[normalizedAction]();
					const label = normalizedAction === "tts-worker" ? "tts-workers" : normalizedAction;
					notifyVoice(ctx, `${label}${label === "tts-workers" ? " " : ": "}${typeof current === "boolean" ? (current ? "on" : "off") : current}`, "info");
					return;
				}
			}
			if (!["", "status", "timing", "help", "bottom", "tts-workers", "tts-worker", "device", "devices"].includes(normalizedAction)) {
				restoreBottomAfterSpeech = false;
				bottomPinned = false;
			}
			switch (normalizedAction) {
				case "on":
					await updateConfig({ ...config, enabled: true });
					notifyVoice(ctx, "Mode on", "info");
					return;
				case "off":
					await updateConfig({ ...config, enabled: false });
					notifyVoice(ctx, "Mode off", "info");
					return;
				case "toggle":
					await toggle(ctx);
					return;
				case "stop": {
					cancelTimingRetry();
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
					releaseAfterTransportCancellation(cancelId, false, inputCancelled, true);
					state = "idle";
					refreshStatus();
					refreshPlaybackTimeline();
					notifyVoice(ctx, "Stop requested · draft preserved", "info");
					return;
				}
				case "talk":
					void talk(ctx);
					return;
				case "attention":
					await attendNextProject(ctx);
					return;
				case "setup":
					notifyVoice(ctx, "Loading speech synthesis and word-alignment models…", "info");
					try {
						await warmModels();
						notifyVoice(ctx, "Speech synthesis and word-alignment models ready", "info");
					} catch (error) {
						notifyVoice(ctx, error instanceof Error ? error.message : String(error), "error");
					}
					return;
				case "tts-model":
				case "stt-model":
				case "alignment-model": {
					const model = normalizeModelId(value);
					if (!model) {
						notifyVoice(ctx, `Usage: /voice ${action} <model-repo>`, "error");
						return;
					}
					if (inputInProgress && action.toLowerCase() === "stt-model") await cancelActiveInput();
					if (action.toLowerCase() === "tts-model") await updateConfig({ ...config, ttsModel: model });
					else if (action.toLowerCase() === "stt-model") await updateConfig({ ...config, sttModel: model });
					else await updateConfig({ ...config, alignmentModel: model });
					notifyVoice(ctx, `${action}: ${model} · downloads on first use if not cached`, "info");
					return;
				}
				case "tts-dtype":
				case "stt-dtype":
				case "alignment-dtype": {
					const dtype = normalizeModelDtype(value.toLowerCase());
					if (!dtype) {
						notifyVoice(ctx, `Usage: /voice ${action} fp32|q8|q4`, "error");
						return;
					}
					if (inputInProgress && action.toLowerCase() === "stt-dtype") await cancelActiveInput();
					if (action.toLowerCase() === "tts-dtype") await updateConfig({ ...config, ttsDtype: dtype });
					else if (action.toLowerCase() === "stt-dtype") await updateConfig({ ...config, sttDtype: dtype });
					else await updateConfig({ ...config, alignmentDtype: dtype });
					notifyVoice(ctx, `${action}: ${dtype}`, "info");
					return;
				}
				case "stt-candidates": {
					const count = normalizeSttCandidates(Number(value));
					if (!count) {
						notifyVoice(ctx, "Usage: /voice stt-candidates <1..8>", "error");
						return;
					}
					await updateConfig({ ...config, sttCandidates: count });
					notifyVoice(ctx, `stt-candidates: ${count}`, "info");
					return;
				}
				case "reconnect": {
					const notificationOnly = !!pendingNotification && lastOwnerUtterance === undefined && !pendingReplay;
					routeIntent = undefined;
					const epoch = ++playbackRequestEpoch;
					const paused = playbackPaused || !!pendingReplay || (ownsSpeech &&
						(lastOwnerUtterance !== undefined || (speechPurpose === "turn" && liveTurnNarrationActive && !ownerTurnEnded)));
					pendingReplay = undefined;
					if (paused) {
						playbackPaused = true;
						narration.setPaused(playbackPaused);
						vocalizer.setPlaybackPaused(true);
					}
					if (await adoptCurrentConnection(epoch, true, undefined, undefined, undefined, true)) {
						playbackPaused = paused;
						narration.setPaused(playbackPaused);
						vocalizer.setPlaybackPaused(playbackPaused);
						if (notificationOnly && !paused) releaseSpeechOwnership(false);
						refreshStatus();
					}
					return;
				}
				case "devices":
					await pickDevice(ctx);
					return;
				case "device": {
					if (value === "forget" && restArgs.length === 1 && routing) {
						const id = restArgs[0];
						try { routing.store.forget(id); }
						catch (error) { notifyVoice(ctx, String(error), "error"); return; }
						if (devicePin === id) { devicePin = undefined; persistDevice(); }
						pollDeviceRouting();
						notifyVoice(ctx, "Device priority forgotten; available devices can be discovered again", "info");
						return;
					}
					let requested: VoiceDeviceSelection;
					try { requested = deviceRouter.select(args.slice(action.length), activeDeviceId ?? deviceSelection); }
					catch (error) { notifyVoice(ctx, String(error), "error"); return; }
					await selectDevice(ctx, requested);
					return;
				}
				case "audio-cache": {
					const enabled = value.toLowerCase();
					if (enabled !== "on" && enabled !== "off") {
						notifyVoice(ctx, "Usage: /voice audio-cache on|off", "error");
						return;
					}
					await updateConfig({ ...config, audioCache: enabled === "on" });
					notifyVoice(ctx, `audio-cache: ${enabled}`, "info");
					return;
				}
				case "audio-bitrate": {
					const bitrate = normalizeAudioCacheBitrate(Number(value));
					if (bitrate === undefined) {
						notifyVoice(ctx, "Usage: /voice audio-bitrate <12..128>", "error");
						return;
					}
					await updateConfig({ ...config, audioCacheBitrate: bitrate });
					notifyVoice(ctx, `audio-bitrate: ${bitrate} kbps (Opus)`, "info");
					return;
				}
				case "tts-worker":
				case "tts-workers": {
					const workers = /^[1-8]$/.test(value) && restArgs.length === 0 ? normalizeWorkerCount(Number(value)) : undefined;
					if (workers === undefined) {
						notifyVoice(ctx, "Usage: /voice tts-workers <1..8>", "error");
						break;
					}
					const next = { ...config, ttsWorkers: workers };
					await saveVoiceConfig(next);
					config = next;
					// Scheduling only: do not reset playback, assets, preprocessing or its budget.
					vocalizer.setTtsWorkers(workers);
					notifyVoice(ctx, `tts-workers concurrency: ${workers}`, "info");
					break;
				}
				case "code-preprocess": {
					const concurrency = normalizeWorkerCount(Number(value));
					if (concurrency === undefined) {
						notifyVoice(ctx, "Usage: /voice code-preprocess <1..8>", "error");
						return;
					}
					await updateConfig({ ...config, codeDescriptionPreprocessConcurrency: concurrency });
					notifyVoice(ctx, `code-preprocess: ${concurrency} workers`, "info");
					return;
				}
				case "code-budget": {
					const parsed = normalizeBackfillBudget(value.toLowerCase() === "unlimited" ? "unlimited" : Number(value));
					if (parsed === undefined) {
						notifyVoice(ctx, "Usage: /voice code-budget <0..n|unlimited>", "error");
						return;
					}
					// Session-runtime only; the persisted config keeps its own budget.
					backfillAllowance = parsed;
					backfillUsed = 0;
					backfillExhaustionReported = false;
					if (activeContext) scheduleMissingCodeDescriptions(activeContext);
					notifyVoice(ctx, `code-budget: ${parsed} requests · this session`, "info");
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
							notifyVoice(ctx, "No failed descriptions on this message", "info");
							return;
						}
						notifyVoice(ctx, `↺ Retrying ${retryKeys(keys)} descriptions · current message`, "info");
						return;
					}
					if (mode0 !== "historical") {
						notifyVoice(ctx, "Usage: /voice code-retry current | historical [all|<message-id>]", "error");
						return;
					}
					const arg1 = retryArgs[1];
					if (!arg1 && ctx.hasUI) {
						void (async () => {
							try {
								const failed = collectFailed();
								if (failed.length === 0) {
									notifyVoice(ctx, "No failed descriptions to retry", "info");
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
								const picked = await ctx.ui.select("Voice · ↺ Retry a failed description", labels);
								if (!picked) return;
								if (picked === "Retry ALL failed descriptions") {
									notifyVoice(ctx, `↺ Retrying ${retryKeys(new Set(failed.map(entry => entry.key)))} descriptions`, "info");
									return;
								}
								const chosen = ordered[labels.indexOf(picked)];
								if (chosen) notifyVoice(ctx, `↺ Retrying ${retryKeys(new Set([chosen.key]))} descriptions`, "info");
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
						notifyVoice(ctx, "No matching failed descriptions to retry", "info");
						return;
					}
					notifyVoice(ctx, `↺ Retrying ${retryKeys(keys)} descriptions`, "info");
					return;
				}
				case "code-narration": {
					const narrationMode = value.toLowerCase();
					if (narrationMode !== "guided" && narrationMode !== "summary") {
						notifyVoice(ctx, "Usage: /voice code-narration guided|summary", "error");
						return;
					}
					await updateConfig({ ...config, codeNarration: narrationMode });
					notifyVoice(ctx, `code-narration: ${narrationMode}`, "info");
					return;
				}
				case "highlight": {
					const normalized = value.toLowerCase();
					if (normalized !== "on" && normalized !== "off") {
						notifyVoice(ctx, "Usage: /voice highlight on|off", "error");
						return;
					}
					await updateConfig({ ...config, playbackHighlight: normalized === "on" });
					requestNarrationRender(true);
					notifyVoice(ctx, `highlight: ${normalized}`, "info");
					return;
				}
				case "autoscroll": {
					const normalized = value.toLowerCase();
					if (normalized !== "on" && normalized !== "off") {
						notifyVoice(ctx, "Usage: /voice autoscroll on|off", "error");
						return;
					}
					await updateConfig({ ...config, autoScroll: normalized === "on" });
					// Display settings retain paused/playing state and manual framing.
					hideFollowHint();
					requestNarrationRender(true);
					notifyVoice(ctx, `autoscroll: ${normalized} · Alt+V still follows the narrated position`, "info");
					return;
				}
				case "edit-model": {
					const model = normalizeEditModel(value);
					if (!model) {
						notifyVoice(ctx, "Usage: /voice edit-model current|provider/model-id", "error");
						return;
					}
					if (model !== "current") {
						const separator = model.indexOf("/");
						if (!ctx.modelRegistry.find(model.slice(0, separator), model.slice(separator + 1))) {
							notifyVoice(ctx, `Editing model unavailable in Pi: ${model}`, "error");
							return;
						}
					}
					await updateConfig({ ...config, editModel: model });
					notifyVoice(ctx, `edit-model: ${model}`, "info");
					return;
				}
				case "mode": {
					const mode = parseMode(value.toLowerCase());
					if (!mode) {
						notifyVoice(ctx, "Usage: /voice mode assistant|all|yield", "error");
						return;
					}
					await updateConfig({ ...config, mode });
					notifyVoice(ctx, `mode: ${mode}`, "info");
					return;
				}
				case "voice": {
					const selected = value;
					if (!isVoice(selected)) {
						notifyVoice(ctx, "Unknown voice · /voice voice <voice-id>; Tab lists voices", "error");
						return;
					}
					await updateConfig({ ...config, voice: selected });
					notifyVoice(ctx, `voice: ${selected}`, "info");
					return;
				}
				case "speed": {
					const speed = Number(value);
					if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
						notifyVoice(ctx, "Usage: /voice speed <0.5..2>", "error");
						return;
					}
					await updateConfig({ ...config, speed });
					notifyVoice(ctx, `speed: ${speed}`, "info");
					return;
				}
				case "output": {
					const output = normalizeVoiceOutput(value);
					if (!output) {
						notifyVoice(ctx, "Usage: /voice output auto|local|tcp://host:port|unix:///path", "error");
						return;
					}
					if (!await prepareDeviceSetting(ctx, true)) return;
					await updateConfig({ ...config, output });
					notifyConnectedDevice(ctx, "output");
					return;
				}
				case "edit": {
					const editMode = parseEditMode(value.toLowerCase());
					if (!editMode) {
						notifyVoice(ctx, "Usage: /voice edit smart|append", "error");
						return;
					}
					await updateConfig({ ...config, editMode });
					notifyVoice(ctx,
						editMode === "smart"
							? "edit: smart · apply spoken corrections after transcript resolution"
							: "edit: append · no spoken corrections",
						"info",
					);
					return;
				}
				case "submit": {
					const submitMode = parseSubmitMode(value.toLowerCase());
					if (!submitMode) {
						notifyVoice(ctx, "Usage: /voice submit review|auto", "error");
						return;
					}
					await updateConfig({ ...config, submitMode });
					notifyVoice(ctx, `submit: ${submitMode}`, "info");
					return;
				}
				case "shortcut": {
					const shortcut = normalizeTalkShortcut(value);
					if (!shortcut) {
						notifyVoice(ctx, "Usage: /voice shortcut <key|disabled> · e.g. alt+m or f8", "error");
						return;
					}
					await updateConfig({ ...config, talkShortcut: shortcut });
					notifyVoice(ctx,
						`shortcut: ${shortcut} · /reload to apply`,
						"info",
					);
					return;
				}
				case "input": {
					const input = normalizeVoiceInput(value);
					if (!input) {
						notifyVoice(ctx, "Usage: /voice input auto|local|disabled|tcp://host:port|unix:///path", "error");
						return;
					}
					if (!await prepareDeviceSetting(ctx, false)) return;
					if (speechReservedForInput) releaseSpeechOwnership(false);
					await updateConfig({ ...config, input });
					notifyConnectedDevice(ctx, "input");
					return;
				}
				case "test": {
					if (!config.enabled) {
						notifyVoice(ctx, "Mode off · /voice on to enable", "warning");
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
				case "status":
				case "":
					notifyVoice(ctx, [
						`${config.enabled ? "On" : "Off"} · mode: ${config.mode} · voice: ${config.voice} · speed: ${config.speed}`,
						`Playback · ${playbackPaused ? "paused" : state} · device: ${deviceSelection}${activeDeviceId ? ` → ${activeDeviceId}` : ""} · output: ${config.output}`,
						`Synthesis · ${config.ttsModel}@${config.ttsDtype} · tts-workers: ${config.ttsWorkers} · audio-cache: ${config.audioCache ? `${config.audioCacheBitrate} kbps` : "off"}`,
						`Word alignment · ${config.alignmentModel}@${config.alignmentDtype} · /voice timing for quality`,
						`🎙 Input · ${config.input} · ${config.sttModel}@${config.sttDtype} · candidates: ${config.sttCandidates} · shortcut: ${config.talkShortcut}`,
						`Dictation · edit: ${config.editMode} · model: ${config.editModel} · submit: ${config.submitMode}`,
						`Descriptions · ${config.codeNarration} · ${config.codeDescriptionContext} · workers: ${config.codeDescriptionPreprocessConcurrency} · scope: ${config.codeDescriptionPreprocessScope} · budget: ${backfillUsed}/${backfillAllowance}`,
						`Timing recovery · workers: ${config.timingPreprocessConcurrency} · measures audio; new word timing is estimated`,
						`View · highlight: ${config.playbackHighlight ? "on" : "off"} · autoscroll: ${config.autoScroll ? "on" : "off"} · ${config.scrollToShortcut}: follow · ${config.scrollBottomShortcut}: tail`,
					].join("\n"),
						"info",
					);
					return;
				case "help":
				default:
					notifyVoice(ctx, [
						"/voice <command> · settings without a value show the current value",
						"🎙 talk · ↺ F5 replay this project · ⏯ F8 pause/resume",
						"⏮/⏭ F6/F10 previous/next message · ↶/↷ F7/F9 previous/next sentence",
						`${config.scrollToShortcut}: follow narrated position · ${config.scrollBottomShortcut}: transcript tail`,
						"Control · on | off | toggle | stop | attention | reconnect | setup | test",
						"Playback · mode | voice | speed | device | output | highlight | autoscroll | scroll-to | bottom",
						"Models · tts-model | tts-dtype | tts-workers | alignment-model | alignment-dtype",
						"Input · input | shortcut | stt-model | stt-dtype | stt-candidates | edit | edit-model | submit",
						"Device selection is temporary until a connection/ranking event; pinning is the persistent priority-0 override. Disconnect waits; switching requires stop proof. /voice device forget <id> removes remembered priority, not registration.",
						`Devices · /voice devices picker · ${devicePickerConflict ? "Alt+S reserved by configured voice control" : "Alt+S"} · click existing [device] in supported fullscreen Pi`,
						"Cache · code-narration | code-preprocess | code-budget | code-retry current|historical | audio-cache | audio-bitrate",
						"Timing · timing (quality, latency, workers) | timing workers [auto|<1..8>] | timing retry current|all|<min>-<max>|<exact-id>",
						"Inspect · status | help",
					].join("\n"),
						normalizedAction === "help" ? "info" : "error",
					);
			}
		},
	});
}
