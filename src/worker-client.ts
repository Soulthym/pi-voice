import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import type { VoiceConfig } from "./config.js";

export type WorkerEvent =
	| { type: "loading" }
	| { type: "progress"; percent?: number; file?: string }
	| { type: "ready"; requestId?: string }
	| { type: "speaking" }
	| { type: "segment-audio"; utterance: number; segmentId: number; start: number; duration: number }
	| { type: "measurement"; requestId: string; duration: number }
	| { type: "alignment"; segmentId: number; words: Array<{ text: string; start: number; end: number }> }
	| { type: "playback"; utterance: number; position: number; estimated?: boolean }
	| { type: "alignment-error"; segmentId: number; message: string }
	| { type: "alignment-ready"; requestId: string }
	| { type: "alignment-preload-error"; requestId: string; message: string }
	| { type: "transcribing" }
	| { type: "transcript"; text: string; candidates?: string[]; requestId: string; preview?: boolean }
	| { type: "idle"; utterance?: number }
	| { type: "error"; message: string; requestId?: string; preview?: boolean };

type PendingPreload = {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

type PendingMeasurement = {
	resolve: (duration: number) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

type PendingTranscription = {
	resolve: (candidates: string[]) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

export class VoiceWorkerClient {
	#child: ChildProcessWithoutNullStreams | null = null;
	#pendingPreloads = new Map<string, PendingPreload>();
	#pendingTranscriptions = new Map<string, PendingTranscription>();
	#pendingMeasurements = new Map<string, PendingMeasurement>();
	#nextRequestId = 0;
	#onEvent: (event: WorkerEvent) => void;

	constructor(onEvent: (event: WorkerEvent) => void) {
		this.#onEvent = onEvent;
	}

	sendSegment(utterance: number, segmentId: number, text: string, config: VoiceConfig): void {
		this.#send({
			type: "segment",
			utterance,
			segmentId,
			text,
			voice: config.voice,
			speed: config.speed,
			model: config.ttsModel,
			dtype: config.ttsDtype,
			alignmentModel: config.alignmentModel,
			alignmentDtype: config.alignmentDtype,
			audioCache: config.audioCache,
			audioCacheBitrate: config.audioCacheBitrate,
			output: config.output,
		});
	}

	endUtterance(utterance: number): void {
		this.#send({ type: "end", utterance });
	}

	cancel(): void {
		for (const pending of this.#pendingMeasurements.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Speech timing measurement interrupted"));
		}
		this.#pendingMeasurements.clear();
		if (!this.#child) return;
		this.#send({ type: "cancel" });
	}

	measureSegment(text: string, config: VoiceConfig): Promise<number> {
		const requestId = String(++this.#nextRequestId);
		const { promise, resolve, reject } = Promise.withResolvers<number>();
		const timer = setTimeout(() => {
			this.#pendingMeasurements.delete(requestId);
			reject(new Error("Speech timing measurement timed out after 10 minutes"));
		}, 10 * 60_000);
		timer.unref?.();
		this.#pendingMeasurements.set(requestId, { resolve, reject, timer });
		this.#send({
			type: "measure",
			requestId,
			text,
			voice: config.voice,
			speed: config.speed,
			model: config.ttsModel,
			dtype: config.ttsDtype,
			audioCache: config.audioCache,
			audioCacheBitrate: config.audioCacheBitrate,
		});
		return promise;
	}

	transcribe(audio: Buffer, config: VoiceConfig): Promise<string[]> {
		return this.#requestTranscription({
			type: "transcribe",
			audio: audio.toString("base64"),
			model: config.sttModel,
			dtype: config.sttDtype,
			candidateCount: config.sttCandidates,
		});
	}

	async transcribePcm(audio: Float32Array, config: VoiceConfig): Promise<string> {
		const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
		const candidates = await this.#requestTranscription({
			type: "transcribe-pcm",
			audio: bytes.toString("base64"),
			model: config.sttModel,
			dtype: config.sttDtype,
			candidateCount: 1,
		});
		return candidates[0] ?? "";
	}

	#requestTranscription(message: {
		type: "transcribe" | "transcribe-pcm";
		audio: string;
		model: string;
		dtype: string;
		candidateCount: number;
	}): Promise<string[]> {
		const requestId = String(++this.#nextRequestId);
		const { promise, resolve, reject } = Promise.withResolvers<string[]>();
		const timer = setTimeout(() => {
			this.#pendingTranscriptions.delete(requestId);
			reject(new Error("Local speech transcription timed out after 10 minutes"));
		}, 10 * 60_000);
		timer.unref?.();
		this.#pendingTranscriptions.set(requestId, { resolve, reject, timer });
		this.#send({ ...message, requestId });
		return promise;
	}

	preload(config: VoiceConfig): Promise<void> {
		return this.#requestPreload("Kokoro", {
			type: "preload",
			model: config.ttsModel,
			dtype: config.ttsDtype,
		});
	}

	preloadAlignment(config: VoiceConfig): Promise<void> {
		return this.#requestPreload("Speech alignment", {
			type: "preload-alignment",
			model: config.alignmentModel,
			dtype: config.alignmentDtype,
		});
	}

	#requestPreload(label: string, message: object): Promise<void> {
		const requestId = String(++this.#nextRequestId);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			this.#pendingPreloads.delete(requestId);
			reject(new Error(`${label} setup timed out after 10 minutes`));
		}, 10 * 60_000);
		timer.unref?.();
		this.#pendingPreloads.set(requestId, { resolve, reject, timer });
		this.#send({ ...message, requestId });
		return promise;
	}

	async terminate(): Promise<void> {
		const child = this.#child;
		this.#child = null;
		if (!child) return;
		for (const pending of this.#pendingPreloads.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Voice worker stopped"));
		}
		this.#pendingPreloads.clear();
		for (const pending of this.#pendingTranscriptions.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Voice worker stopped"));
		}
		this.#pendingTranscriptions.clear();
		for (const pending of this.#pendingMeasurements.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Voice worker stopped"));
		}
		this.#pendingMeasurements.clear();
		try {
			child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
			child.stdin.end();
		} catch {
			// The worker may already be gone.
		}
		if (child.exitCode !== null) return;
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 2_000);
			timer.unref?.();
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	#ensureChild(): ChildProcessWithoutNullStreams {
		if (this.#child && this.#child.exitCode === null) return this.#child;
		const workerPath = fileURLToPath(new URL("./worker.mjs", import.meta.url));
		const child = spawn(process.execPath, [workerPath], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		this.#child = child;
		child.stdin.on("error", error => {
			if (this.#child === child) this.#handleFailure(error);
		});
		const lines = readline.createInterface({ input: child.stdout });
		lines.on("line", line => this.#handleLine(line));
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr = `${stderr}${String(chunk)}`.slice(-4_000);
		});
		child.on("error", error => this.#handleFailure(error));
		child.on("exit", code => {
			if (this.#child !== child) return;
			this.#child = null;
			if (code !== 0) {
				const detail = stderr.trim();
				this.#handleFailure(new Error(detail || `Voice worker exited with code ${code ?? "unknown"}`));
			}
		});
		return child;
	}

	#send(message: object): void {
		try {
			this.#ensureChild().stdin.write(`${JSON.stringify(message)}\n`);
		} catch (error) {
			this.#handleFailure(error instanceof Error ? error : new Error(String(error)));
		}
	}

	#handleLine(line: string): void {
		let event: WorkerEvent;
		try {
			event = JSON.parse(line) as WorkerEvent;
		} catch {
			return;
		}
		if (
			(event.type === "ready" ||
				event.type === "error" ||
				event.type === "alignment-ready" ||
				event.type === "alignment-preload-error") &&
			event.requestId
		) {
			const pending = this.#pendingPreloads.get(event.requestId);
			if (pending) {
				this.#pendingPreloads.delete(event.requestId);
				clearTimeout(pending.timer);
				if (event.type === "ready" || event.type === "alignment-ready") pending.resolve();
				else pending.reject(new Error(event.message));
			}
		}
		if ((event.type === "measurement" || event.type === "error") && event.requestId) {
			const pending = this.#pendingMeasurements.get(event.requestId);
			if (pending) {
				this.#pendingMeasurements.delete(event.requestId);
				clearTimeout(pending.timer);
				if (event.type === "measurement") pending.resolve(event.duration);
				else pending.reject(new Error(event.message));
			}
		}
		if ((event.type === "transcript" || event.type === "error") && event.requestId) {
			const pending = this.#pendingTranscriptions.get(event.requestId);
			if (pending) {
				this.#pendingTranscriptions.delete(event.requestId);
				clearTimeout(pending.timer);
				if (event.type === "transcript") {
					pending.resolve(event.candidates?.length ? event.candidates : event.text ? [event.text] : []);
				}
				else pending.reject(new Error(event.message));
			}
		}
		this.#onEvent(event);
	}

	#handleFailure(error: Error): void {
		for (const pending of this.#pendingPreloads.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pendingPreloads.clear();
		for (const pending of this.#pendingTranscriptions.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pendingTranscriptions.clear();
		for (const pending of this.#pendingMeasurements.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pendingMeasurements.clear();
		this.#onEvent({ type: "error", message: error.message });
	}
}
