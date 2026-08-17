import type { VoiceConfig } from "./config.js";
import { SpeakableStream } from "./speakable.js";
import { VoiceWorkerClient, type WorkerEvent } from "./worker-client.js";

const IDLE_FLUSH_MS = 1_000;

export class Vocalizer {
	#worker: VoiceWorkerClient;
	#getConfig: () => VoiceConfig;
	#speakable: SpeakableStream | null = null;
	#utterance: number | null = null;
	#nextUtterance = 0;
	#idleTimer: NodeJS.Timeout | null = null;

	constructor(getConfig: () => VoiceConfig, onEvent: (event: WorkerEvent) => void) {
		this.#getConfig = getConfig;
		this.#worker = new VoiceWorkerClient(onEvent);
	}

	pushDelta(text: string): void {
		if (!this.#getConfig().enabled || text.length === 0) return;
		this.#speakable ??= new SpeakableStream();
		const current = this.#speakable;
		this.#pushSegments(current.push(text));
		this.#armIdle(() => {
			if (this.#speakable !== current) return;
			this.#pushSegments(current.flushIdle());
		});
	}

	flush(): void {
		this.#clearIdleTimer();
		const speakable = this.#speakable;
		this.#speakable = null;
		if (speakable) this.#pushSegments(speakable.flush());
		if (this.#utterance !== null) {
			this.#worker.endUtterance(this.#utterance);
			this.#utterance = null;
		}
	}

	speak(text: string): void {
		if (!this.#getConfig().enabled) return;
		this.pushDelta(text);
		this.flush();
	}

	clear(): void {
		this.#clearIdleTimer();
		this.#speakable = null;
		this.#utterance = null;
		this.#worker.cancel();
	}

	transcribe(audio: Buffer): Promise<string> {
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

	#pushSegments(segments: string[]): void {
		if (segments.length === 0) return;
		this.#utterance ??= ++this.#nextUtterance;
		const config = this.#getConfig();
		for (const segment of segments) this.#worker.sendSegment(this.#utterance, segment, config);
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
