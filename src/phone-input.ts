import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const RECORDING_TIMEOUT_MS = 2 * 60_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;
const SPEECH_THRESHOLD = 0.012;
const SILENCE_SECONDS = 1.35;
const NO_SPEECH_TIMEOUT_SECONDS = 12;

type InputConnection = EventEmitter & {
	write(data: string): void;
	destroy(): void;
	setNoDelay?(enabled: boolean): void;
	setEncoding?(encoding: BufferEncoding): void;
};

class LocalInputConnection extends EventEmitter implements InputConnection {
	#child: ChildProcessWithoutNullStreams;

	constructor() {
		super();
		const script = fileURLToPath(new URL("../client/pi-voice-stt-session", import.meta.url));
		this.#child = spawn("bash", [script], { stdio: ["pipe", "pipe", "pipe"] });
		this.#child.stdout.on("data", chunk => this.emit("data", chunk));
		this.#child.once("error", error => this.emit("error", error));
		this.#child.once("close", () => this.emit("close"));
		queueMicrotask(() => this.emit("connect"));
	}

	write(data: string): void {
		if (!this.#child.stdin.destroyed) this.#child.stdin.write(data);
	}

	destroy(): void {
		this.#child.stdin.destroy();
		this.#child.kill("SIGTERM");
	}
}

function connectEndpoint(endpoint: string): InputConnection {
	if (endpoint === "local") return new LocalInputConnection();
	const url = new URL(endpoint);
	if (url.protocol === "tcp:" && url.hostname && url.port) {
		return net.createConnection({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) });
	}
	if (url.protocol === "unix:" && !url.hostname && url.pathname.startsWith("/")) {
		return net.createConnection({ path: decodeURIComponent(url.pathname) });
	}
	throw new Error(`Invalid voice input endpoint: ${endpoint}`);
}

export type PhoneCapture = { type: "audio"; data: Buffer } | { type: "text"; data: string };
export type PhoneCaptureProgress = {
	elapsedSeconds: number;
	level: number;
	speechDetected: boolean;
};

export interface PhoneCaptureOptions {
	onProgress?(progress: PhoneCaptureProgress): void;
	onAudio?(audio: Float32Array): void;
}

class LiveVoiceDetector {
	#child: ChildProcessWithoutNullStreams;
	#carry = Buffer.alloc(0);
	#drained = Promise.withResolvers<void>();
	#discard = false;
	#sumSquares = 0;
	#frameSamples = 0;
	#totalSamples = 0;
	#lastSpeechSample = 0;
	#consecutiveSpeechFrames = 0;
	#speechDetected = false;
	#stopRequested = false;
	#lastProgressAt = 0;

	constructor(onStop: () => void, options: PhoneCaptureOptions = {}) {
		this.#child = spawn(
			"ffmpeg",
			["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		this.#drained.promise.catch(() => {});
		this.#child.on("error", () => this.#drained.reject(new Error("Microphone decoder failed to start")));
		this.#child.once("close", code => {
			if (code === 0 && this.#carry.length === 0) this.#drained.resolve();
			else this.#drained.reject(new Error("Microphone audio decoding failed"));
		});
		this.#child.stderr.resume(); // Never retain decoder diagnostics containing input details.
		this.#child.stdout.on("data", chunk => {
			if (this.#discard) return;
			const bytes = this.#carry.length === 0 ? chunk : Buffer.concat([this.#carry, chunk]);
			const completeBytes = bytes.length - (bytes.length % Float32Array.BYTES_PER_ELEMENT);
			const samples = new Float32Array(completeBytes / Float32Array.BYTES_PER_ELEMENT);
			for (let offset = 0; offset < completeBytes; offset += Float32Array.BYTES_PER_ELEMENT) {
				const decoded = bytes.readFloatLE(offset);
				if (!Number.isFinite(decoded)) {
					this.#discard = true;
					this.#child.kill("SIGKILL");
					this.#drained.reject(new Error("Invalid decoded microphone samples"));
					onStop();
					return;
				}
				// Lossy codecs can overshoot full scale despite valid PCM16 input.
				const sample = Math.max(-1, Math.min(1, decoded));
				samples[offset / Float32Array.BYTES_PER_ELEMENT] = sample;
				this.#sumSquares += sample * sample;
				this.#frameSamples += 1;
				this.#totalSamples += 1;
				if (this.#frameSamples !== FRAME_SAMPLES) continue;

				const level = Math.sqrt(this.#sumSquares / this.#frameSamples);
				if (level >= SPEECH_THRESHOLD) {
					this.#consecutiveSpeechFrames += 1;
					this.#lastSpeechSample = this.#totalSamples;
					if (this.#consecutiveSpeechFrames >= 3) this.#speechDetected = true;
				} else {
					this.#consecutiveSpeechFrames = 0;
				}
				const elapsedSeconds = this.#totalSamples / SAMPLE_RATE;
				const silenceSeconds = (this.#totalSamples - this.#lastSpeechSample) / SAMPLE_RATE;
				const now = Date.now();
				if (options.onProgress && now - this.#lastProgressAt >= 250) {
					this.#lastProgressAt = now;
					options.onProgress({ elapsedSeconds, level, speechDetected: this.#speechDetected });
				}
				if (
					!this.#stopRequested &&
					((this.#speechDetected && silenceSeconds >= SILENCE_SECONDS) ||
						(!this.#speechDetected && elapsedSeconds >= NO_SPEECH_TIMEOUT_SECONDS))
				) {
					this.#stopRequested = true;
					onStop();
				}
				this.#sumSquares = 0;
				this.#frameSamples = 0;
			}
			if (samples.length > 0) options.onAudio?.(samples);
			this.#carry = bytes.subarray(completeBytes);
		});
		// Avoid unhandled EPIPE when the decoder exits during cancellation.
		this.#child.stdin.on("error", () => {});
	}

	write(chunk: Buffer): void {
		if (!this.#child.stdin.destroyed) this.#child.stdin.write(chunk);
	}

	async close(discard = false): Promise<void> {
		this.#discard = discard;
		if (discard) this.#child.kill("SIGKILL");
		if (!this.#child.stdin.destroyed) this.#child.stdin.end();
		const timer = setTimeout(() => this.#child.kill("SIGKILL"), 10_000);
		try { await this.#drained.promise; }
		finally { clearTimeout(timer); }
	}
}

export class PhoneInputClient {
	#socket: InputConnection | null = null;
	#activeEndpoint: string | null = null;
	#cancellation: Promise<void> = Promise.resolve();
	#cancelCapture: (() => void) | null = null;
	#stopPending: Promise<void> | null = null;

	cancel(): Promise<void> {
		const endpoint = this.#activeEndpoint;
		if (this.#cancelCapture) this.#cancelCapture();
		else if (endpoint) void this.stop(endpoint).catch(() => {});
		this.#socket?.destroy();
		this.#socket = null;
		return this.#cancellation;
	}

	stop(endpoint: string): Promise<void> {
		if (this.#stopPending) return this.#stopPending;
		// All stop sources (VAD, timeout, UI, cancellation) must finish before a new recording.
		const pending = this.#cancellation.catch(() => {}).then(() => new Promise<void>((resolve, reject) => {
			const socket = connectEndpoint(endpoint);
			let response = "";
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error);
				else {
					if (this.#activeEndpoint === endpoint) this.#activeEndpoint = null;
					resolve();
				}
			};
			const timer = setTimeout(() => finish(new Error("Voice microphone stop timed out")), 10_000);
			timer.unref?.();
			socket.setEncoding?.("utf8");
			socket.on("connect", () => socket.write("stop\n"));
			socket.on("data", chunk => {
				response += chunk;
				const newline = response.indexOf("\n");
				if (newline === -1) return;
				const line = response.slice(0, newline).trim();
				const [status, payload = ""] = line.split(" ", 2);
				const message = Buffer.from(payload, "base64").toString("utf8");
				if (status === "ok" && message === "stopped") finish();
				else finish(new Error(status === "ok" ? "Microphone stop not confirmed; update the recorder client" : message || "Unable to stop phone microphone"));
			});
			socket.on("error", finish);
			socket.on("close", () => {
				if (!settled) finish(new Error("Voice microphone stop connection closed"));
			});
		}));
		this.#cancellation = pending;
		this.#stopPending = pending;
		void pending.finally(() => { if (this.#stopPending === pending) this.#stopPending = null; }).catch(() => {});
		void pending.catch(() => {}); // Observed by cancel/capture; never turn failure into an ACK.
		return pending;
	}

	async capture(endpoint: string, options: PhoneCaptureOptions = {}): Promise<PhoneCapture> {
		await this.cancel();
		const socket = connectEndpoint(endpoint);
		this.#socket = socket;
		this.#activeEndpoint = endpoint;
		socket.setNoDelay?.(true);

		return new Promise<PhoneCapture>((resolve, reject) => {
			let settled = false;
			let headerBuffer = Buffer.alloc(0);
			let streamMode = false;
			let streamBytes = 0;
			const audioChunks: Buffer[] = [];
			let detector: LiveVoiceDetector | null = null;

			const finish = (error?: Error, capture?: PhoneCapture): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (this.#socket === socket) {
					this.#socket = null;
					this.#cancelCapture = null;
				}
				const stopped = error || streamMode ? this.stop(endpoint) : Promise.resolve();
				void stopped.catch(() => {});
				if (!error && !streamMode && this.#activeEndpoint === endpoint) this.#activeEndpoint = null;
				socket.destroy();
				// Child 'close' follows stdout drainage; socket EOF alone can precede final PCM.
				void Promise.all([detector?.close(!!error), ...(error ? [] : [stopped])]).then(() => {
					if (error) reject(error);
					else if (capture) resolve(capture);
					else reject(new Error("Voice device returned no capture"));
				}, decoderError => reject(error ?? decoderError));
			};
			const timer = setTimeout(() => {
				finish(new Error("Voice microphone timed out"));
			}, RECORDING_TIMEOUT_MS);
			timer.unref?.();
			this.#cancelCapture = () => finish(new Error("Voice microphone cancelled"));

			const acceptAudio = (chunk: Buffer): void => {
				if (settled || chunk.length === 0) return;
				streamBytes += chunk.length;
				if (streamBytes > MAX_RESPONSE_BYTES) {
					finish(new Error("Voice microphone stream exceeded 32 MB"));
					return;
				}
				audioChunks.push(chunk);
				detector?.write(chunk);
			};

			socket.on("connect", () => socket.write("record\n"));
			socket.on("data", (raw: Buffer) => {
				if (settled) return;
				if (streamMode) {
					acceptAudio(raw);
					return;
				}
				headerBuffer = Buffer.concat([headerBuffer, raw]);
				if (headerBuffer.length > MAX_RESPONSE_BYTES) {
					finish(new Error("Voice microphone response was too large"));
					return;
				}
				const newline = headerBuffer.indexOf(0x0a);
				if (newline === -1) return;
				const header = headerBuffer.subarray(0, newline).toString("utf8").trim();
				const remainder = headerBuffer.subarray(newline + 1);
				if (header === "stream") {
					streamMode = true;
					detector = new LiveVoiceDetector(
						() => {
							if (!settled && this.#socket === socket) void this.stop(endpoint).catch(error => finish(error));
						},
						options,
					);
					acceptAudio(remainder);
					return;
				}
				const separator = header.indexOf(" ");
				const status = separator === -1 ? header : header.slice(0, separator);
				const payload = separator === -1 ? "" : header.slice(separator + 1);
				if (status === "audio") {
					const audio = Buffer.from(payload, "base64");
					if (audio.length === 0) finish(new Error("Voice device returned an empty recording"));
					else finish(undefined, { type: "audio", data: audio });
					return;
				}
				const decoded = Buffer.from(payload, "base64").toString("utf8").trim();
				if (status === "ok") finish(undefined, { type: "text", data: decoded });
				else finish(new Error(decoded || "Voice microphone failed"));
			});
			socket.on("error", error => finish(error));
			socket.on("close", () => {
				if (settled) return;
				if (streamMode && streamBytes > 0) {
					finish(undefined, { type: "audio", data: Buffer.concat(audioChunks, streamBytes) });
				} else {
					finish(new Error("Voice microphone connection closed before returning audio"));
				}
			});
		});
	}
}
