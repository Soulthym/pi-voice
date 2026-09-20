import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { normalizeWorkerCount, type VoiceConfig } from "./config.js";

import type { AlignmentWord, TimingQuality } from "./narration-progress.js";

export type MeasurementPhase = "cache-decode" | "synthesis";

export type WorkerEvent =
	| { type: "loading" }
	| { type: "progress"; percent?: number; file?: string }
	| { type: "ready"; requestId?: string }
	| { type: "speaking" }
	| { type: "segment-audio"; utterance: number; segmentId: number; start: number; duration: number; timingQuality?: TimingQuality }
	| { type: "measurement"; requestId: string; duration: number }
	| { type: "measurement-progress"; requestId: string; phase: MeasurementPhase }
	| { type: "alignment"; segmentId: number; words: AlignmentWord[]; quality?: TimingQuality }
	| { type: "playback"; utterance: number; position: number; estimated?: boolean }
	| { type: "alignment-error"; segmentId: number; message: string; quality?: "estimated" }
	| { type: "alignment-ready"; requestId: string }
	| { type: "alignment-preload-error"; requestId: string; message: string }
	| { type: "transcribing" }
	| { type: "transcript"; text: string; candidates?: string[]; requestId: string; preview?: boolean }
	| { type: "idle"; utterance?: number; cancelId?: number }
	| { type: "error"; message: string; requestId?: string; preview?: boolean; utterance?: number };

type PendingPreload = {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

type PendingMeasurement = {
	onPhase?: (phase: MeasurementPhase) => void;
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
	#nextCancelId = 0;
	#paused = false;
	#termination: Promise<void> | undefined;
	#retiring = new Set<ChildProcessWithoutNullStreams>();
	#signalled = new Set<ChildProcessWithoutNullStreams>();
	#remoteUnconfirmed = false;
	#remoteGeneration = 0;
	#cancelGenerations = new Map<number, number>();
	#ttsWorkers: number | undefined;
	#activeUtterance: number | undefined;
	#onEvent: (event: WorkerEvent) => void;

	constructor(onEvent: (event: WorkerEvent) => void) {
		this.#onEvent = onEvent;
	}

	sendSegment(utterance: number, segmentId: number, text: string, config: VoiceConfig): void {
		this.setTtsWorkers(config.ttsWorkers);
		this.#activeUtterance = utterance;
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
		if (/^(tcp|unix):/.test(config.output)) {
			this.#remoteUnconfirmed = true;
			this.#remoteGeneration += 1;
		}
	}

	endUtterance(utterance: number): void {
		this.#send({ type: "end", utterance });
	}

	setTtsWorkers(workers: number): void {
		if (normalizeWorkerCount(workers) === undefined) throw new RangeError("TTS workers must be 1–8");
		if (this.#ttsWorkers === workers) return;
		this.#ttsWorkers = workers;
		// Settings alone must not launch a worker or resume playback.
		if (this.#child) this.#send({ type: "tts-workers", workers });
	}

	setPlaybackPaused(paused: boolean): void {
		this.#paused = paused;
		if (!this.#child) return;
		this.#send({ type: "pause", paused });
	}

	cancel(): number | undefined {
		this.#paused = false;
		for (const pending of this.#pendingMeasurements.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Speech timing measurement interrupted"));
		}
		this.#pendingMeasurements.clear();
		if (!this.#child) return undefined;
		const cancelId = ++this.#nextCancelId;
		this.#cancelGenerations.set(cancelId, this.#remoteGeneration);
		this.#send({ type: "cancel", cancelId });
		return cancelId;
	}

	measureSegment(text: string, config: VoiceConfig, onPhase?: (phase: MeasurementPhase) => void): Promise<number> {
		const requestId = String(++this.#nextRequestId);
		const { promise, resolve, reject } = Promise.withResolvers<number>();
		const timer = setTimeout(() => {
			this.#pendingMeasurements.delete(requestId);
			reject(new Error("Speech timing measurement timed out after 10 minutes"));
		}, 10 * 60_000);
		timer.unref?.();
		this.#pendingMeasurements.set(requestId, { resolve, reject, timer, onPhase });
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
		return (await this.transcribePcmCandidates(audio, { ...config, sttCandidates: 1 }))[0] ?? "";
	}

	transcribePcmCandidates(audio: Float32Array, config: VoiceConfig): Promise<string[]> {
		const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
		return this.#requestTranscription({
			type: "transcribe-pcm",
			audio: bytes.toString("base64"),
			model: config.sttModel,
			dtype: config.sttDtype,
			candidateCount: config.sttCandidates,
		});
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
		this.setTtsWorkers(config.ttsWorkers);
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

	/** Escalation after a missing cancel ACK (e.g. 1s). Rejection means keep the speech lease. */
	terminate(): Promise<void> {
		if (this.#termination) return this.#termination;
		const pending = this.#terminate();
		this.#termination = pending;
		void pending.finally(() => { if (this.#termination === pending) this.#termination = undefined; }).catch(() => {});
		return pending;
	}

	async #terminate(): Promise<void> {
		const child = this.#child;
		this.#child = null;
		if (child) this.#retiring.add(child);
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
		for (const owned of this.#retiring) await this.#stopOwned(owned);
		if (this.#remoteUnconfirmed) throw new Error("Remote playback stop unconfirmed; retain speech lease (host termination cannot stop buffered device audio)");
	}

	async #stopOwned(child: ChildProcessWithoutNullStreams): Promise<void> {
		try {
			const cancelId = ++this.#nextCancelId;
			this.#cancelGenerations.set(cancelId, this.#remoteGeneration);
			child.stdin.write(`${JSON.stringify({ type: "shutdown", cancelId })}\n`);
			child.stdin.end();
		} catch {
			// The worker may already be gone.
		}
		const alreadyExited = child.exitCode !== null || child.signalCode != null;
		let killedGroup: number | undefined;
		await new Promise<void>((resolve, reject) => {
			const closeDeadline = setTimeout(() => reject(new Error("Owned transport pipes did not close; retain speech lease")), 4_000);
			const killOwned = () => {
				try {
					// Only this detached worker's process group, never the caller's group.
					if (process.platform !== "win32" && child.pid) {
						killedGroup = -child.pid;
						if (!this.#signalled.has(child)) {
							this.#signalled.add(child);
							process.kill(killedGroup, "SIGKILL");
						}
					} else child.kill("SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
				}
				// A signal request is not termination. Wait for transport pipes to close.
			};
			if (alreadyExited) { clearTimeout(closeDeadline); killOwned(); resolve(); return; }
			const timer = setTimeout(killOwned, 2_000);
			child.once("close", () => {
				clearTimeout(timer);
				clearTimeout(closeDeadline);
				// Even a clean leader exit may leave local descendants behind.
				if (killedGroup === undefined) killOwned();
				resolve();
			});
		});
		if (process.platform === "win32") throw new Error("Owned descendant cleanup cannot be confirmed on Windows; retain speech lease");
		// Closing the leader's pipes need not mean its players exited. Never signal
		// again here: only observe the group we killed, retaining ownership if uncertain.
		const deadline = Date.now() + 2_000;
		while (killedGroup !== undefined) {
			try { process.kill(killedGroup, 0); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
				throw error;
			}
			if (Date.now() >= deadline) throw new Error("Owned worker group cleanup unconfirmed; retain speech lease");
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		this.#retiring.delete(child);
		this.#signalled.delete(child);
	}

	#ensureChild(): ChildProcessWithoutNullStreams {
		if (this.#termination || this.#retiring.size || this.#remoteUnconfirmed && !this.#child) throw new Error("Voice worker transport cleanup is unconfirmed");
		if (this.#child && this.#child.exitCode === null) return this.#child;
		const workerPath = fileURLToPath(new URL("./worker.mjs", import.meta.url));
		const child = spawn(process.execPath, [workerPath], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env: { ...process.env },
		});
		this.#child = child;
		child.stdin.on("error", error => {
			if (this.#child === child) this.#handleFailure(error);
		});
		const lines = readline.createInterface({ input: child.stdout });
		lines.on("line", line => this.#handleLine(line, this.#child !== child));
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr = `${stderr}${String(chunk)}`.slice(-4_000);
		});
		child.on("error", error => { if (this.#child === child) this.#handleFailure(error); });
		child.on("exit", code => {
			if (this.#child !== child) return;
			this.#retiring.add(child);
			this.#child = null;
			// Retire immediately while the detached group identity is still owned.
			void this.terminate().catch(error => this.#handleFailure(error));
			if (code !== 0) {
				const detail = stderr.trim();
				this.#handleFailure(new Error(detail || `Voice worker exited with code ${code ?? "unknown"}`));
			}
		});
		child.stdin.write(`${JSON.stringify({ type: "pause", paused: this.#paused })}\n`);
		if (this.#ttsWorkers !== undefined) {
			child.stdin.write(`${JSON.stringify({ type: "tts-workers", workers: this.#ttsWorkers })}\n`);
		}
		return child;
	}

	#send(message: object): void {
		try {
			this.#ensureChild().stdin.write(`${JSON.stringify(message)}\n`);
		} catch (error) {
			this.#handleFailure(error instanceof Error ? error : new Error(String(error)));
		}
	}

	#handleLine(line: string, retired: boolean): void {
		let event: WorkerEvent;
		try {
			event = JSON.parse(line) as WorkerEvent;
		} catch {
			return;
		}
		if (event.type === "idle") {
			if (event.cancelId !== undefined) {
				if (this.#cancelGenerations.get(event.cancelId) === this.#remoteGeneration) this.#remoteUnconfirmed = false;
				this.#cancelGenerations.delete(event.cancelId);
			} else if (event.utterance !== undefined && event.utterance === this.#activeUtterance) this.#remoteUnconfirmed = false;
		}
		if (retired) {
			if (event.type === "idle" && event.cancelId !== undefined) this.#onEvent(event);
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
		if (event.type === "measurement-progress") {
			if (event.phase === "cache-decode" || event.phase === "synthesis") {
				this.#pendingMeasurements.get(event.requestId)?.onPhase?.(event.phase);
			}
			return;
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
		if (
			(event.type === "idle" && event.utterance === this.#activeUtterance) ||
			(event.type === "error" && event.utterance === this.#activeUtterance)
		) {
			this.#activeUtterance = undefined;
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
		this.#onEvent({
			type: "error",
			message: error.message,
			...(this.#activeUtterance !== undefined ? { utterance: this.#activeUtterance } : {}),
		});
		this.#activeUtterance = undefined;
	}
}
