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

type CodeDescriber = (block: FencedCodeBlock, signal: AbortSignal) => Promise<CodeNarrationPlan>;
type VoiceWorker = Pick<
	VoiceWorkerClient,
	| "sendSegment"
	| "endUtterance"
	| "cancel"
	| "transcribe"
	| "transcribePcm"
	| "preload"
	| "preloadAlignment"
	| "terminate"
>;

export class Vocalizer {
	#worker: VoiceWorker;
	#getConfig: () => VoiceConfig;
	#describeCode: CodeDescriber | undefined;
	#speakable: SpeakableStream | null = null;
	#utterance: number | null = null;
	#nextUtterance = 0;
	#nextSegment = 0;
	#onNarrationSegment: ((segment: NarrationSegment) => void) | undefined;
	#idleTimer: NodeJS.Timeout | null = null;
	#deliveryBarrier: Promise<void> | null = null;
	#descriptionControllers = new Set<AbortController>();
	#generation = 0;

	constructor(
		getConfig: () => VoiceConfig,
		onEvent: (event: WorkerEvent) => void,
		describeCode?: CodeDescriber,
		onNarrationSegment?: (segment: NarrationSegment) => void,
		worker: VoiceWorker = new VoiceWorkerClient(onEvent),
	) {
		this.#getConfig = getConfig;
		this.#worker = worker;
		this.#describeCode = describeCode;
		this.#onNarrationSegment = onNarrationSegment;
	}

	pushDelta(text: string): void {
		if (!this.#getConfig().enabled || text.length === 0) return;
		this.#speakable ??= new SpeakableStream();
		const current = this.#speakable;
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
		if (barrier) {
			const generation = this.#generation;
			void barrier.then(() => {
				if (generation === this.#generation) this.#worker.endUtterance(utterance);
			});
		} else {
			this.#worker.endUtterance(utterance);
		}
	}

	speak(text: string): void {
		if (!this.#getConfig().enabled) return;
		this.pushDelta(text);
		this.flush();
	}

	clear(): void {
		this.#generation += 1;
		this.#clearIdleTimer();
		this.#speakable = null;
		this.#utterance = null;
		this.#deliveryBarrier = null;
		for (const controller of this.#descriptionControllers) controller.abort();
		this.#descriptionControllers.clear();
		this.#worker.cancel();
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
			if (item.kind === "speech") this.#scheduleSpeech(item.text, item.source);
			else this.#scheduleCodeDescription(item.block, item.source);
		}
	}

	#scheduleSpeech(text: string, source: SpeakableSourceRange): void {
		if (!this.#deliveryBarrier) {
			this.#sendSegments([text], undefined, source);
			return;
		}
		const generation = this.#generation;
		const utterance = this.#ensureUtterance();
		this.#deliveryBarrier = this.#deliveryBarrier.then(() => {
			if (generation === this.#generation) this.#sendSegments([text], utterance, source);
		});
	}

	#scheduleCodeDescription(block: FencedCodeBlock, source: SpeakableSourceRange): void {
		const utterance = this.#ensureUtterance();
		const generation = this.#generation;
		const controller = new AbortController();
		this.#descriptionControllers.add(controller);
		let description: Promise<CodeNarrationPlan>;
		try {
			description = this.#describeCode
				? this.#describeCode(block, controller.signal)
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
			this.#sendDescription(spoken, block, source, utterance);
		});
	}

	#sendDescription(
		plan: CodeNarrationPlan,
		block: FencedCodeBlock,
		source: SpeakableSourceRange,
		utterance: number,
	): void {
		let chunks = chunkCodeNarration(plan);
		if (chunks.length === 0) chunks = chunkCodeNarration(plainCodeNarration(fallbackCodeDescription(block)));
		for (const chunk of chunks) {
			this.#sendSegments(
				[chunk.text],
				utterance,
				{ start: source.start, end: source.start },
				true,
				plan.guided ? { blockSource: source, code: block.code, cues: chunk.cues } : undefined,
			);
		}
	}

	#ensureUtterance(): number {
		this.#utterance ??= ++this.#nextUtterance;
		return this.#utterance;
	}

	#sendSegments(
		segments: string[],
		utterance = this.#ensureUtterance(),
		source?: SpeakableSourceRange,
		revealAtEnd = false,
		code?: NarrationSegment["code"],
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
			this.#onNarrationSegment?.({ id, utterance, text, source: narrationSource, revealAtEnd, code });
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
