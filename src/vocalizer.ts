import type { VoiceConfig } from "./config.js";
import { fallbackCodeDescription } from "./code-describer.js";
import { SpeakableStream, type FencedCodeBlock, type SpeakableItem } from "./speakable.js";
import { VoiceWorkerClient, type WorkerEvent } from "./worker-client.js";

const IDLE_FLUSH_MS = 1_000;

type CodeDescriber = (block: FencedCodeBlock, signal: AbortSignal) => Promise<string>;
type VoiceWorker = Pick<
	VoiceWorkerClient,
	"sendSegment" | "endUtterance" | "cancel" | "transcribe" | "transcribePcm" | "preload" | "terminate"
>;

export class Vocalizer {
	#worker: VoiceWorker;
	#getConfig: () => VoiceConfig;
	#describeCode: CodeDescriber | undefined;
	#speakable: SpeakableStream | null = null;
	#utterance: number | null = null;
	#nextUtterance = 0;
	#idleTimer: NodeJS.Timeout | null = null;
	#deliveryBarrier: Promise<void> | null = null;
	#descriptionControllers = new Set<AbortController>();
	#generation = 0;

	constructor(
		getConfig: () => VoiceConfig,
		onEvent: (event: WorkerEvent) => void,
		describeCode?: CodeDescriber,
		worker: VoiceWorker = new VoiceWorkerClient(onEvent),
	) {
		this.#getConfig = getConfig;
		this.#worker = worker;
		this.#describeCode = describeCode;
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

	async shutdown(): Promise<void> {
		this.clear();
		await this.#worker.terminate();
	}

	#pushItems(items: SpeakableItem[]): void {
		for (const item of items) {
			if (item.kind === "speech") this.#scheduleSpeech(item.text);
			else this.#scheduleCodeDescription(item.block);
		}
	}

	#scheduleSpeech(text: string): void {
		if (!this.#deliveryBarrier) {
			this.#sendSegments([text]);
			return;
		}
		const generation = this.#generation;
		const utterance = this.#ensureUtterance();
		this.#deliveryBarrier = this.#deliveryBarrier.then(() => {
			if (generation === this.#generation) this.#sendSegments([text], utterance);
		});
	}

	#scheduleCodeDescription(block: FencedCodeBlock): void {
		const utterance = this.#ensureUtterance();
		const generation = this.#generation;
		const controller = new AbortController();
		this.#descriptionControllers.add(controller);
		let description: Promise<string>;
		try {
			description = this.#describeCode
				? this.#describeCode(block, controller.signal)
				: Promise.resolve(fallbackCodeDescription(block));
		} catch (error) {
			description = Promise.reject(error);
		}
		const ready = description
			.catch(() => fallbackCodeDescription(block))
			.finally(() => this.#descriptionControllers.delete(controller));
		const before = this.#deliveryBarrier ?? Promise.resolve();
		this.#deliveryBarrier = before.then(async () => {
			const spoken = await ready;
			if (generation !== this.#generation) return;
			this.#sendDescription(spoken, block, utterance);
		});
	}

	#sendDescription(description: string, block: FencedCodeBlock, utterance: number): void {
		const stream = new SpeakableStream();
		const items = [...stream.push(description), ...stream.flush()];
		let segments = items.filter((item): item is Extract<SpeakableItem, { kind: "speech" }> => item.kind === "speech").map(item => item.text);
		if (segments.length === 0) segments = [fallbackCodeDescription(block)];
		this.#sendSegments(segments, utterance);
	}

	#ensureUtterance(): number {
		this.#utterance ??= ++this.#nextUtterance;
		return this.#utterance;
	}

	#sendSegments(segments: string[], utterance = this.#ensureUtterance()): void {
		if (segments.length === 0) return;
		const config = this.#getConfig();
		for (const segment of segments) this.#worker.sendSegment(utterance, segment, config);
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
