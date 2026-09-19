import type { Message } from "@earendil-works/pi-ai";
import type { VoiceConfig } from "./config.js";
import { fallbackCodeDescription } from "./code-describer.js";
import {
	chunkCodeNarration,
	plainCodeNarration,
	type CodeNarrationPlan,
} from "./code-narration.js";
import type { NarrationSegment } from "./narration-progress.js";
import { SpeakableStream, type FencedCodeBlock, type SpeakableItem, type SpeakableSourceRange } from "./speakable.js";
import { VoiceWorkerClient, type WorkerEvent } from "./worker-client.js";

const IDLE_FLUSH_MS = 1_000;

export interface CodeDescriptionSourceContext {
	beforeBlock: string;
	throughBlock: string;
	/** Absolute end offset in the replay/display source. */
	sourceEnd: number;
	/** Provider-compatible context, resolved lazily at the canonical boundary. */
	providerMessages?: readonly Message[] | ((signal: AbortSignal) => Promise<readonly Message[]>);
}

type CodeDescriber = (
	block: FencedCodeBlock,
	context: CodeDescriptionSourceContext,
	signal: AbortSignal,
) => Promise<CodeNarrationPlan>;
type VoiceWorker = Pick<
	VoiceWorkerClient,
	| "sendSegment"
	| "measureSegment"
	| "endUtterance"
	| "transcribe"
	| "transcribePcm"
	| "preload"
	| "preloadAlignment"
	| "terminate"
> & {
	cancel(): number | undefined | void;
	setPlaybackPaused?(paused: boolean): void;
	setTtsWorkers?(workers: number): void;
	transcribePcmCandidates?: VoiceWorkerClient["transcribePcmCandidates"];
};

export class Vocalizer {
	#worker: VoiceWorker;
	#getConfig: () => VoiceConfig;
	#describeCode: CodeDescriber | undefined;
	#speakable: SpeakableStream | null = null;
	#utterance: number | null = null;
	#nextUtterance = 0;
	#nextSegment = 0;
	#skipUnits = 0;
	#onNarrationSegment: ((segment: NarrationSegment) => void) | undefined;
	#onUtteranceAllocated: ((utterance: number) => void) | undefined;
	#onUtteranceEnded: ((utterance: number) => void) | undefined;
	#idleTimer: NodeJS.Timeout | null = null;
	#deliveryBarrier: Promise<void> | null = null;
	#descriptionControllers = new Set<AbortController>();
	#generation = 0;
	#sourceOffset = 0;
	#nextSourceOffset = 0;
	#trackNarration = true;
	#sourceText = "";
	#codeDescriptionMessages: readonly Message[] | ((sourceEnd: number, signal: AbortSignal) => Promise<readonly Message[]>) | undefined;

	constructor(
		getConfig: () => VoiceConfig,
		onEvent: (event: WorkerEvent) => void,
		describeCode?: CodeDescriber,
		onNarrationSegment?: (segment: NarrationSegment) => void,
		worker: VoiceWorker = new VoiceWorkerClient(onEvent),
		onUtteranceAllocated?: (utterance: number) => void,
		onUtteranceEnded?: (utterance: number) => void,
	) {
		this.#getConfig = getConfig;
		this.#worker = worker;
		this.#describeCode = describeCode;
		this.#onNarrationSegment = onNarrationSegment;
		this.#onUtteranceAllocated = onUtteranceAllocated;
		this.#onUtteranceEnded = onUtteranceEnded;
	}

	setNarrationSourceOffset(offset: number, skipUnits = 0): void {
		this.#nextSourceOffset = Math.max(0, offset);
		this.#skipUnits = Math.max(0, Math.floor(skipUnits));
	}

	setCodeDescriptionMessages(messages: readonly Message[] | ((sourceEnd: number, signal: AbortSignal) => Promise<readonly Message[]>) | undefined): void {
		this.#codeDescriptionMessages = messages;
	}

	pushDelta(text: string): void {
		if (!this.#getConfig().enabled || text.length === 0) return;
		if (!this.#speakable) {
			this.#speakable = new SpeakableStream();
			this.#sourceOffset = this.#nextSourceOffset;
			this.#sourceText = "";
		}
		const current = this.#speakable;
		this.#sourceText += text;
		this.#pushItems(current.push(text));
		this.#armIdle(() => {
			if (this.#speakable !== current) return;
			this.#pushItems(current.flushIdle());
		});
	}

	flush(): void {
		this.#clearIdleTimer();
		const speakable = this.#speakable;
		this.#speakable = null;
		if (speakable) this.#pushItems(speakable.flush());
		const utterance = this.#utterance;
		this.#utterance = null;
		// Keep delivery ordered across source targets, including a description
		// waiting on prose in the next content block of this same message.
		const barrier = this.#deliveryBarrier;
		if (utterance === null) return;
		const endUtterance = (): void => {
			this.#worker.endUtterance(utterance);
			this.#onUtteranceEnded?.(utterance);
		};
		if (barrier) {
			const generation = this.#generation;
			this.#deliveryBarrier = barrier.then(() => {
				if (generation === this.#generation) endUtterance();
			});
		} else {
			endUtterance();
		}
	}

	speak(text: string): void {
		this.speakFrom(text, 0);
	}

	/** Speaks a coordinator prompt without attaching it to message highlighting or timing metadata. */
	speakUntracked(text: string): number | undefined {
		const before = this.#nextUtterance;
		this.#trackNarration = false;
		try {
			this.speakFrom(text, 0);
		} finally {
			this.#trackNarration = true;
		}
		return this.#nextUtterance > before ? this.#nextUtterance : undefined;
	}

	speakFrom(text: string, sourceOffset: number, skipUnits = 0): void {
		if (!this.#getConfig().enabled) return;
		this.#skipUnits = Math.max(0, Math.floor(skipUnits));
		this.#speakable = new SpeakableStream();
		this.#sourceText = text;
		this.#sourceOffset = Math.max(0, sourceOffset);
		this.#nextSourceOffset = this.#sourceOffset;
		this.#pushItems(this.#speakable.push(text));
		this.flush();
	}

	setTtsWorkers(workers: number): void {
		this.#worker.setTtsWorkers?.(workers);
	}

	setPlaybackPaused(paused: boolean): void {
		this.#worker.setPlaybackPaused?.(paused);
	}

	clear(): number | undefined {
		this.#generation += 1;
		this.#clearIdleTimer();
		this.#speakable = null;
		this.#utterance = null;
		this.#deliveryBarrier = null;
		this.#sourceOffset = 0;
		this.#nextSourceOffset = 0;
		this.#skipUnits = 0;
		this.#sourceText = "";
		this.#codeDescriptionMessages = undefined;
		for (const controller of this.#descriptionControllers) controller.abort();
		this.#descriptionControllers.clear();
		return this.#worker.cancel() as number | undefined;
	}

	measureSegment(text: string): Promise<number> {
		return this.#worker.measureSegment(text, this.#getConfig());
	}

	transcribe(audio: Buffer): Promise<string[]> {
		return this.#worker.transcribe(audio, this.#getConfig());
	}

	transcribePcm(audio: Float32Array): Promise<string> {
		return this.#worker.transcribePcm(audio, this.#getConfig());
	}

	async transcribePcmCandidates(audio: Float32Array): Promise<string[]> {
		if (this.#worker.transcribePcmCandidates) return this.#worker.transcribePcmCandidates(audio, this.#getConfig());
		const text = await this.transcribePcm(audio);
		return text ? [text] : [];
	}

	preload(): Promise<void> {
		return this.#worker.preload(this.#getConfig());
	}

	preloadAlignment(): Promise<void> {
		return this.#worker.preloadAlignment(this.#getConfig());
	}

	async warm(): Promise<void> {
		await Promise.all([this.preload(), this.preloadAlignment()]);
	}

	async shutdown(): Promise<void> {
		this.clear();
		await this.#worker.terminate();
	}

	#pushItems(items: SpeakableItem[]): void {
		for (const item of items) {
			const source = {
				start: item.source.start + this.#sourceOffset,
				end: item.source.end + this.#sourceOffset,
			};
			if (item.kind === "speech") this.#scheduleSpeech(item.text, source);
			else {
				const messages = this.#codeDescriptionMessages;
				const text = this.#sourceText;
				this.#scheduleCodeDescription(item.block, source, {
					get beforeBlock() { return text.slice(0, item.source.start); },
					get throughBlock() { return text.slice(0, item.source.end); },
					sourceEnd: source.end,
					...(messages ? { providerMessages: typeof messages === "function"
						? (signal: AbortSignal) => messages(item.source.end, signal) : messages } : {}),
				});
			}
		}
	}

	#scheduleSpeech(text: string, source: SpeakableSourceRange): void {
		const sourceBase = this.#sourceOffset;
		if (!this.#deliveryBarrier) {
			this.#sendSegments([text], undefined, source, false, undefined, undefined, sourceBase);
			return;
		}
		const generation = this.#generation;
		const trackNarration = this.#trackNarration;
		const utterance = this.#ensureUtterance();
		this.#deliveryBarrier = this.#deliveryBarrier.then(() => {
			if (generation === this.#generation) this.#sendSegments([text], utterance, source, false, undefined, undefined, sourceBase, trackNarration);
		});
	}

	#scheduleCodeDescription(
		block: FencedCodeBlock,
		source: SpeakableSourceRange,
		context: CodeDescriptionSourceContext,
	): void {
		const utterance = this.#ensureUtterance();
		const generation = this.#generation;
		const sourceBase = this.#sourceOffset;
		const skipUnits = this.#skipUnits;
		this.#skipUnits = 0;
		const controller = new AbortController();
		this.#descriptionControllers.add(controller);
		let description: Promise<CodeNarrationPlan>;
		try {
			description = this.#describeCode
				? this.#describeCode(block, context, controller.signal)
				: Promise.resolve(plainCodeNarration(fallbackCodeDescription(block)));
		} catch (error) {
			description = Promise.reject(error);
		}
		const ready = description
			.catch(() => plainCodeNarration(fallbackCodeDescription(block)))
			.finally(() => this.#descriptionControllers.delete(controller));
		const before = this.#deliveryBarrier ?? Promise.resolve();
		this.#deliveryBarrier = before.then(async () => {
			const spoken = await ready;
			if (generation !== this.#generation) return;
			this.#sendDescription(spoken, block, source, utterance, sourceBase, skipUnits);
		});
	}

	#sendDescription(
		plan: CodeNarrationPlan,
		block: FencedCodeBlock,
		source: SpeakableSourceRange,
		utterance: number,
		sourceBase: number,
		requestedSkip: number,
	): void {
		let chunks = chunkCodeNarration(plan);
		if (plan.omitted) return; // No semantic description: stay silent rather than speak filler.
		if (chunks.length === 0) chunks = chunkCodeNarration(plainCodeNarration(fallbackCodeDescription(block)));
		const description = chunks.map(chunk => chunk.text).join(" ");
		let descriptionOffset = 0;
		const skip = Math.min(requestedSkip, Math.max(0, chunks.length - 1));
		const inherited = chunks.slice(0, skip).flatMap(chunk => chunk.cues.flatMap(cue => cue.operations));
		for (const [index, chunk] of chunks.entries()) {
			if (index < skip) { descriptionOffset += chunk.text.length + 1; continue; }
			if (index === skip && inherited.length) chunk.cues.unshift({ offset: 0, operations: inherited });
			this.#sendSegments(
				[chunk.text],
				utterance,
				{ start: source.start, end: source.start },
				true,
				plan.guided ? { blockSource: source, code: block.code, language: block.language, cues: chunk.cues } : undefined,
				{ blockSource: source, text: description, offset: descriptionOffset },
				sourceBase,
			);
			descriptionOffset += chunk.text.length + 1;
		}
	}

	#ensureUtterance(): number {
		if (this.#utterance === null) {
			this.#utterance = ++this.#nextUtterance;
			this.#onUtteranceAllocated?.(this.#utterance);
		}
		return this.#utterance;
	}

	#sendSegments(
		segments: string[],
		utterance = this.#ensureUtterance(),
		source?: SpeakableSourceRange,
		revealAtEnd = false,
		code?: NarrationSegment["code"],
		codeDescription?: NarrationSegment["codeDescription"],
		sourceBase = this.#sourceOffset,
		trackNarration = this.#trackNarration,
	): void {
		if (segments.length === 0) return;
		const config = this.#getConfig();
		segments.forEach((text, index) => {
			const id = ++this.#nextSegment;
			const narrationSource = source
				? revealAtEnd && index < segments.length - 1
					? { start: source.start, end: source.start }
					: source
				: { start: 0, end: 0 };
			if (trackNarration) {
				this.#onNarrationSegment?.({
					id,
					utterance,
					text,
					sourceBase,
					source: narrationSource,
					revealAtEnd,
					code,
					codeDescription,
				});
			}
			this.#worker.sendSegment(utterance, id, text, config);
		});
	}

	#armIdle(callback: () => void): void {
		this.#clearIdleTimer();
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = null;
			callback();
		}, IDLE_FLUSH_MS);
		this.#idleTimer.unref?.();
	}

	#clearIdleTimer(): void {
		if (!this.#idleTimer) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = null;
	}
}
