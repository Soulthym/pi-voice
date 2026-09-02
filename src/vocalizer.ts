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
	/** Exact provider context captured from a live assistant partial. */
	providerMessages?: readonly Message[];
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
> & { cancel(): number | undefined | void; setPlaybackPaused?(paused: boolean): void };

export class Vocalizer {
	#worker: VoiceWorker;
	#getConfig: () => VoiceConfig;
	#describeCode: CodeDescriber | undefined;
	#speakable: SpeakableStream | null = null;
	#utterance: number | null = null;
	#nextUtterance = 0;
	#nextSegment = 0;
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
	#codeDescriptionMessages: readonly Message[] | undefined;

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

	setNarrationSourceOffset(offset: number): void {
		this.#nextSourceOffset = Math.max(0, offset);
	}

	setCodeDescriptionMessages(messages: readonly Message[] | undefined): void {
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
		const barrier = this.#deliveryBarrier;
		this.#deliveryBarrier = null;
		if (utterance === null) return;
		const endUtterance = (): void => {
			this.#worker.endUtterance(utterance);
			this.#onUtteranceEnded?.(utterance);
		};
		if (barrier) {
			const generation = this.#generation;
			void barrier.then(() => {
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

	speakFrom(text: string, sourceOffset: number): void {
		if (!this.#getConfig().enabled) return;
		this.#speakable = new SpeakableStream();
		this.#sourceText = text;
		this.#sourceOffset = Math.max(0, sourceOffset);
		this.#nextSourceOffset = this.#sourceOffset;
		this.#pushItems(this.#speakable.push(text));
		this.flush();
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
				this.#scheduleCodeDescription(item.block, source, {
					beforeBlock: this.#sourceText.slice(0, item.source.start),
					throughBlock: this.#sourceText.slice(0, item.source.end),
					sourceEnd: source.end,
					...(this.#codeDescriptionMessages ? { providerMessages: [...this.#codeDescriptionMessages] } : {}),
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
		const utterance = this.#ensureUtterance();
		this.#deliveryBarrier = this.#deliveryBarrier.then(() => {
			if (generation === this.#generation) this.#sendSegments([text], utterance, source, false, undefined, undefined, sourceBase);
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
			this.#sendDescription(spoken, block, source, utterance, sourceBase);
		});
	}

	#sendDescription(
		plan: CodeNarrationPlan,
		block: FencedCodeBlock,
		source: SpeakableSourceRange,
		utterance: number,
		sourceBase: number,
	): void {
		let chunks = chunkCodeNarration(plan);
		if (plan.omitted) return; // No semantic description: stay silent rather than speak filler.
		if (chunks.length === 0) chunks = chunkCodeNarration(plainCodeNarration(fallbackCodeDescription(block)));
		const description = chunks.map(chunk => chunk.text).join(" ");
		let descriptionOffset = 0;
		for (const chunk of chunks) {
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
			if (this.#trackNarration) {
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
