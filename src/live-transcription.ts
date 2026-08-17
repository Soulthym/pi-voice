import { StreamEndpointer, type EndpointerEvent } from "./endpointer.js";

export interface LiveTranscriptionCallbacks {
	onPartial(text: string): void;
	onSegment(text: string): void;
}

/**
 * Coalesces non-streaming Whisper decodes into a responsive live transcript.
 * Finalized speech segments take priority; only the newest pending preview is
 * decoded when inference is slower than incoming audio.
 */
export class LiveTranscriptionSession {
	readonly #transcribe: (audio: Float32Array) => Promise<string>;
	readonly #callbacks: LiveTranscriptionCallbacks;
	readonly #endpointer = new StreamEndpointer();
	readonly #segments: Float32Array[] = [];
	#pendingPartial: Float32Array | null = null;
	#committed: string[] = [];
	#pumping = false;
	#ended = false;
	#cancelled = false;
	#settled = false;
	readonly #done = Promise.withResolvers<string>();

	constructor(transcribe: (audio: Float32Array) => Promise<string>, callbacks: LiveTranscriptionCallbacks) {
		this.#transcribe = transcribe;
		this.#callbacks = callbacks;
	}

	push(audio: Float32Array): void {
		if (this.#ended || this.#cancelled || audio.length === 0) return;
		this.#ingest(this.#endpointer.push(audio));
		void this.#pump();
	}

	finish(): Promise<string> {
		if (!this.#ended) {
			this.#ended = true;
			this.#pendingPartial = null;
			this.#ingest(this.#endpointer.flush());
			void this.#pump();
		}
		return this.#done.promise;
	}

	cancel(): void {
		if (this.#settled) return;
		this.#cancelled = true;
		this.#segments.length = 0;
		this.#pendingPartial = null;
		this.#settled = true;
		this.#done.resolve("");
	}

	#ingest(events: EndpointerEvent[]): void {
		for (const event of events) {
			if (event.kind === "segment") this.#segments.push(event.audio);
			else this.#pendingPartial = event.audio;
		}
	}

	async #pump(): Promise<void> {
		if (this.#pumping || this.#cancelled) return;
		this.#pumping = true;
		try {
			while (!this.#cancelled) {
				if (this.#segments.length > 0) {
					const audio = this.#segments.shift()!;
					this.#pendingPartial = null;
					const text = (await this.#transcribe(audio)).replace(/\s+/g, " ").trim();
					if (this.#cancelled) return;
					if (text) {
						this.#committed.push(text);
						this.#callbacks.onSegment(text);
					}
					continue;
				}
				if (this.#pendingPartial) {
					const audio = this.#pendingPartial;
					this.#pendingPartial = null;
					const text = (await this.#transcribe(audio)).replace(/\s+/g, " ").trim();
					if (this.#cancelled) return;
					if (this.#segments.length === 0 && text) this.#callbacks.onPartial(text);
					continue;
				}
				break;
			}
			if (this.#ended && !this.#settled && this.#segments.length === 0 && !this.#pendingPartial) {
				this.#settled = true;
				this.#done.resolve(this.#committed.join(" "));
			}
		} catch (error) {
			this.#cancelled = true;
			if (!this.#settled) {
				this.#settled = true;
				this.#done.reject(error);
			}
		} finally {
			this.#pumping = false;
			if (!this.#settled && (this.#segments.length > 0 || this.#pendingPartial)) void this.#pump();
		}
	}
}
