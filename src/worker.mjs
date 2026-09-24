import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { env as transformersEnv, pipeline } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { stopRemotePlayback, validStreamId, RemotePlaybackUnconfirmedError } from "./remote-playback.mjs";
import { createPlaybackController } from "./playback-controller.mjs";
import { generateSentenceAudio } from "./sentence-audio.mjs";
import { SentencePool } from "./sentence-pool.mjs";
import { MAX_ALIGNMENT_BYTES, MAX_ALIGNMENT_TEXT } from "./alignment-windows.mjs";

const DEFAULT_TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_TTS_DTYPE = "q8";
const DEFAULT_STT_MODEL = "onnx-community/whisper-tiny.en";
const DEFAULT_STT_DTYPE = "fp32";
const DEFAULT_ALIGNMENT_MODEL = "onnx-community/wav2vec2-base-960h-ONNX";
const DEFAULT_ALIGNMENT_DTYPE = "q8";
const DEFAULT_SAMPLE_RATE = 24_000;
const cacheDir = process.env.PI_VOICE_CACHE_DIR ?? path.join(os.homedir(), ".cache", "pi-voice", "models");
const audioCacheDir = process.env.PI_VOICE_AUDIO_CACHE_DIR ?? path.join(os.homedir(), ".cache", "pi-voice", "audio");
fs.mkdirSync(cacheDir, { recursive: true });
transformersEnv.cacheDir = cacheDir;
transformersEnv.allowLocalModels = true;
transformersEnv.allowRemoteModels = process.env.HF_HUB_OFFLINE !== "1";
transformersEnv.useBrowserCache = false;
transformersEnv.logLevel = "error";
if (transformersEnv.backends?.onnx) transformersEnv.backends.onnx.logLevel = "error";

const ttsModels = new Map();
const loadedTtsModels = new Set();
let synthesisJobId;
const sttModels = new Map();
let epoch = 0;
let queue = [];
let pumping = false;
let cancelBarrier = Promise.resolve();
let alignmentChild = null;
const pendingAlignmentPreloads = new Set();
let shuttingDown = false;
const synthesisChild = Boolean(process.send && process.env.PI_VOICE_SENTENCE_CHILD === "1");
const requestedWorkers = Number(process.env.PI_VOICE_TTS_WORKERS ?? 3);
let synthesisWorkers = Number.isInteger(requestedWorkers) && requestedWorkers >= 1 && requestedWorkers <= 8 ? requestedWorkers : 3;
const sentencePool = new SentencePool(synthesisWorkers, event => {
	if (!playback.currentPlayer && !shuttingDown) send(event);
});
let activeOperation;
let timingRetry;
let playbackPaused = false;

function send(message) {
	if (synthesisChild) {
		if (process.connected) process.send({ id: synthesisJobId, event: message }, () => {});
	} else process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(error, fields = {}) {
	send({ type: "error", message: error instanceof Error ? error.message : String(error),
		...(error instanceof RemotePlaybackUnconfirmedError ? { code: error.code } : {}), ...fields });
}

const playback = createPlaybackController({ send });

function ensureAlignmentChild() {
	if (alignmentChild && alignmentChild.exitCode === null) return alignmentChild;
	stopAlignment();
	const child = spawn(process.execPath, [fileURLToPath(new URL("./alignment-worker.mjs", import.meta.url))], {
		// Alignment events bypass this synthesis process and reach Pi directly,
		// even while native Kokoro inference is blocking this event loop.
		stdio: ["pipe", "inherit", "ignore", "ipc"],
		env: { ...process.env },
	});
	alignmentChild = child;
	child.stdin.on?.("error", () => {
		if (alignmentChild === child) stopAlignment();
	});
	child.on("message", message => {
		if (alignmentChild === child &&
			(message.type === "alignment-ready" || message.type === "alignment-preload-error") &&
			pendingAlignmentPreloads.delete(message.requestId)) send(message);
	});
	child.on("error", () => {
		if (alignmentChild === child) stopAlignment();
	});
	child.on("exit", () => {
		if (alignmentChild === child) stopAlignment();
	});
	return child;
}

function preloadAlignment(requestId, model, dtype) {
	try {
		const input = ensureAlignmentChild().stdin;
		if (input.writableNeedDrain || input.writableLength > 0 || input.destroyed) throw new Error("Alignment busy; estimated timings remain available");
		pendingAlignmentPreloads.add(requestId);
		input.write(`${JSON.stringify({ type: "preload", epoch, requestId, model, dtype })}\n`);
	} catch (error) {
		pendingAlignmentPreloads.delete(requestId);
		send({
			type: "alignment-preload-error",
			requestId,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

function requestAlignment(operation, pcm, sampleRate) {
	try {
		if (pcm.byteLength > MAX_ALIGNMENT_BYTES || operation.text.length > MAX_ALIGNMENT_TEXT) throw new Error("Alignment resource limit");
		const input = ensureAlignmentChild().stdin;
		// Never wait for alignment. At most one bounded JSON/PCM write may be buffered.
		if (input.writableNeedDrain || input.writableLength > 0 || input.destroyed) throw new Error("Alignment overloaded");
		const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		input.write(
			`${JSON.stringify({
				type: "align",
				epoch,
				segmentId: operation.segmentId,
				text: operation.text,
				audio: bytes.toString("base64"),
				sampleRate,
				duration: pcm.length / sampleRate,
				model: operation.alignmentModel,
				dtype: operation.alignmentDtype,
			})}\n`,
		);
	} catch (error) {
		send({ type: "alignment-error", epoch, segmentId: operation.segmentId, quality: "estimated",
			message: error instanceof Error ? error.message : String(error) });
	}
}

function cancelAlignment() {
	// Terminate native inference and buffered stdin too, rather than queue a cancel
	// behind megabytes of PCM. The next request lazily starts a fresh child.
	stopAlignment();
}

function stopAlignment() {
	const child = alignmentChild;
	alignmentChild = null;
	for (const requestId of pendingAlignmentPreloads) {
		send({ type: "alignment-preload-error", requestId, message: "Speech alignment worker stopped before setup completed" });
	}
	pendingAlignmentPreloads.clear();
	if (!child) return;
	try {
		child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
		child.kill("SIGTERM");
	} catch {
		// Best effort.
	}
}

function progressPercent(info) {
	if (typeof info?.progress === "number") return Math.round(info.progress);
	if (typeof info?.loaded === "number" && typeof info?.total === "number" && info.total > 0) {
		return Math.round((info.loaded / info.total) * 100);
	}
	return undefined;
}

function audioCachePath(operation) {
	if (!operation.audioCache) return undefined;
	const bitrate = Number(operation.audioCacheBitrate);
	if (!Number.isInteger(bitrate) || bitrate < 12 || bitrate > 128) return undefined;
	const key = createHash("sha256")
		.update(
			JSON.stringify([
				2, // Older audio can contain silently truncated phonemes.
				operation.model,
				operation.dtype,
				operation.voice,
				operation.speed,
				bitrate,
				operation.text,
			]),
		)
		.digest("hex");
	return path.join(audioCacheDir, key.slice(0, 2), `${key}.opus`);
}

function runFfmpeg(args, input, { signal, maxBytes = Infinity } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("ffmpeg", ["-v", "error", ...args], { stdio: ["pipe", "pipe", "pipe"], signal, killSignal: "SIGKILL" });
		const stdout = [];
		let size = 0;
		let stderr = "";
		child.stdout.on("data", chunk => {
			size += chunk.length;
			if (size > maxBytes) {
				child.kill("SIGKILL");
				reject(new Error("Alignment resource limit"));
			} else stdout.push(chunk);
		});
		child.stderr.on("data", chunk => {
			stderr = `${stderr}${String(chunk)}`.slice(-4_096);
		});
		child.once("error", reject);
		child.once("exit", code => {
			if (code === 0) resolve(Buffer.concat(stdout));
			else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code ?? "unknown"}`));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

async function readCachedAudio(file, onDecode, options) {
	try {
		await fs.promises.access(file, fs.constants.R_OK);
		onDecode?.();
		const bytes = await runFfmpeg(["-i", file, "-f", "f32le", "-ar", String(DEFAULT_SAMPLE_RATE), "-ac", "1", "pipe:1"], undefined, options);
		if (bytes.length === 0 || bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error("Empty audio cache entry");
		const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		const pcm = new Float32Array(array);
		if (options && !pcm.every(Number.isFinite)) throw new Error("Invalid cached PCM");
		return pcm;
	} catch {
		if (!options) await fs.promises.rm(file, { force: true }).catch(() => {});
		return undefined;
	}
}

function cancelTimingRetry(requestId) {
	if (timingRetry && (requestId === undefined || timingRetry.requestId === requestId)) timingRetry.controller.abort();
}

async function retryTiming(operation) {
	cancelTimingRetry();
	const controller = new AbortController();
	const job = { requestId: operation.requestId, controller };
	timingRetry = job;
	const timer = setTimeout(() => controller.abort(), 60_000);
	let child;
	try {
		if (typeof operation.text !== "string" || !operation.text.trim() || operation.text.length > MAX_ALIGNMENT_TEXT) {
			throw new Error("Alignment text resource limit");
		}
		if (shuttingDown || (!playbackPaused && playback.currentPlayer) ||
			(activeOperation && !(playbackPaused && activeOperation.type === "end")) || queue.length) {
			throw new Error("Timing retry yielded to foreground work");
		}
		// Explicit retry reads existing assets even when normal cache use is disabled.
		// Never route this operation through audioForOperation (which can synthesize).
		const file = audioCachePath({ ...operation, audioCache: true,
			model: operation.model ?? DEFAULT_TTS_MODEL, dtype: operation.dtype ?? DEFAULT_TTS_DTYPE });
		const pcm = file && await readCachedAudio(file, undefined, { signal: controller.signal, maxBytes: MAX_ALIGNMENT_BYTES });
		controller.signal.throwIfAborted();
		if (!pcm) {
			send({ type: "timing-retry", requestId: operation.requestId, result: { status: "cache-miss" } });
			return;
		}
		const duration = pcm.length / DEFAULT_SAMPLE_RATE;
		// Dedicated child: aborting this consumer must not cancel playback alignment.
		child = spawn(process.execPath, [fileURLToPath(new URL("./alignment-worker.mjs", import.meta.url))], {
			stdio: ["pipe", "pipe", "ignore"], signal: controller.signal, killSignal: "SIGKILL", env: { ...process.env },
		});
		const result = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", () => reject(new Error("Timing retry alignment worker stopped")));
			child.stdin.on("error", reject);
			const lines = readline.createInterface({ input: child.stdout });
			lines.on("line", line => {
				try {
					const event = JSON.parse(line);
					if (event.type === "alignment") resolve({ status: "timing", duration, words: event.words, quality: event.quality });
					else if (event.type === "alignment-error") reject(new Error(event.message));
				} catch (error) { reject(error); }
			});
			child.stdin.write(`${JSON.stringify({ type: "align", epoch: 0, segmentId: 0,
				text: operation.text, audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
				sampleRate: DEFAULT_SAMPLE_RATE, duration,
				model: operation.alignmentModel ?? DEFAULT_ALIGNMENT_MODEL,
				dtype: operation.alignmentDtype ?? DEFAULT_ALIGNMENT_DTYPE })}\n`);
		});
		controller.signal.throwIfAborted();
		send({ type: "timing-retry", requestId: operation.requestId, result });
	} catch (error) {
		send({ type: "timing-retry-error", requestId: operation.requestId, message: error instanceof Error ? error.message : String(error) });
	} finally {
		clearTimeout(timer);
		child?.kill("SIGKILL");
		if (timingRetry === job) timingRetry = undefined;
	}
}

async function writeCachedAudio(file, pcm, bitrate) {
	const directory = path.dirname(file);
	const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp.opus`;
	try {
		await fs.promises.mkdir(directory, { recursive: true });
		const input = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		await runFfmpeg(
			[
				"-f",
				"f32le",
				"-ar",
				String(DEFAULT_SAMPLE_RATE),
				"-ac",
				"1",
				"-i",
				"pipe:0",
				"-c:a",
				"libopus",
				"-b:a",
				`${bitrate}k`,
				"-vbr",
				"on",
				"-application",
				"audio",
				"-y",
				temporary,
			],
			input,
		);
		await fs.promises.rename(temporary, file);
		await fs.promises.chmod(file, 0o600);
	} catch {
		await fs.promises.rm(temporary, { force: true }).catch(() => {});
	}
}

function reportPlaybackPhase(operation, phase) {
	operation.phase = phase;
	if (operation.type !== "segment" || operation.epoch !== epoch || shuttingDown) return;
	// Lookahead is not foreground work. The client gives buffered playback precedence.
	if (activeOperation !== operation) return;
	send({ type: "playback-phase", utterance: operation.utterance, segmentId: operation.segmentId, phase });
}

async function audioForOperation(operation) {
	const report = phase => {
		if (operation.type === "segment") reportPlaybackPhase(operation, phase === "cache-decode" ? "loading" : phase);
		if (operation.type === "synthesis") send({ type: "synthesis-phase", phase: phase === "cache-decode" ? "loading" : phase });
		if (operation.type === "measure" && operation.epoch === epoch && (phase === "synthesis" || phase === "cache-decode")) {
			send({ type: "measurement-progress", requestId: operation.requestId, phase });
		}
	};
	const file = audioCachePath(operation);
	if (file) {
		const cached = await readCachedAudio(file, () => report("cache-decode"));
		if (cached) return { pcm: cached, sampleRate: DEFAULT_SAMPLE_RATE };
	}
	if (operation.type === "segment" && !synthesisChild) {
		if (operation.epoch !== epoch) throw new Error("Sentence generation cancelled");
		const { audioPromise, ...input } = operation;
		reportPlaybackPhase(operation, "queued");
		return sentencePool.generate(input, event => {
			if (operation.epoch !== epoch) return;
			if (event.type === "synthesis-phase") reportPlaybackPhase(operation, event.phase);
			else sentencePool.onEvent(event); // Preserve legacy model download events.
		});
	}
	if (operation.type === "measure") report("synthesis");
	const operationEpoch = epoch;
	const model = await getModel(operation.model, operation.dtype, () => report("loading"));
	if (operation.type !== "measure") report("synthesizing");
	const output = await generateSentenceAudio(model, operation.text,
		{ voice: operation.voice, speed: operation.speed }, () => operationEpoch !== epoch);
	const sampleRate = output.sampling_rate || DEFAULT_SAMPLE_RATE;
	const pcm = Array.isArray(output.audio) ? output.audio[0] : output.audio;
	if (file && pcm instanceof Float32Array && sampleRate === DEFAULT_SAMPLE_RATE) {
		await writeCachedAudio(file, pcm, Number(operation.audioCacheBitrate));
		const cached = await readCachedAudio(file, () => report("cache-decode"));
		if (cached) return { pcm: cached, sampleRate: DEFAULT_SAMPLE_RATE };
	}
	return { pcm, sampleRate };
}

async function getModel(modelId = DEFAULT_TTS_MODEL, dtype = DEFAULT_TTS_DTYPE, onLoading) {
	const key = `${modelId}\0${dtype}`;
	if (!loadedTtsModels.has(key)) onLoading?.();
	const cached = ttsModels.get(key);
	if (cached) return cached;
	send({ type: "loading" });
	const loading = KokoroTTS.from_pretrained(modelId, {
		dtype,
		device: "cpu",
		progress_callback: info => {
			const percent = progressPercent(info);
			const file = typeof info?.file === "string" ? info.file : undefined;
			send({ type: "progress", ...(percent === undefined ? {} : { percent }), ...(file ? { file } : {}) });
		},
	}).catch(error => {
		ttsModels.delete(key);
		throw error;
	});
	ttsModels.set(key, loading);
	const model = await loading;
	loadedTtsModels.add(key);
	send({ type: "ready" });
	return model;
}

async function getTranscriber(modelId = DEFAULT_STT_MODEL, dtype = DEFAULT_STT_DTYPE) {
	const key = `${modelId}\0${dtype}`;
	const cached = sttModels.get(key);
	if (cached) return cached;
	const loading = pipeline("automatic-speech-recognition", modelId, {
		dtype,
		device: "cpu",
		progress_callback: info => {
			const percent = progressPercent(info);
			const file = typeof info?.file === "string" ? info.file : undefined;
			send({ type: "progress", ...(percent === undefined ? {} : { percent }), ...(file ? { file } : {}) });
		},
	}).catch(error => {
		sttModels.delete(key);
		throw error;
	});
	sttModels.set(key, loading);
	return loading;
}

function decodePhoneAudio(encoded) {
	return new Promise((resolve, reject) => {
		const ffmpeg = executable("ffmpeg");
		if (!ffmpeg) {
			reject(new Error("ffmpeg is required on the Pi host for microphone input"));
			return;
		}
		const child = spawn(
			ffmpeg,
			["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		const chunks = [];
		let bytes = 0;
		let stderr = "";
		child.stdout.on("data", chunk => {
			bytes += chunk.length;
			if (bytes > 32 * 1024 * 1024) {
				child.kill("SIGKILL");
				reject(new Error("Decoded microphone recording exceeded 32 MB"));
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.on("data", chunk => {
			stderr = `${stderr}${String(chunk)}`.slice(-4_000);
		});
		child.on("error", reject);
		child.on("exit", code => {
			if (code !== 0) {
				reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
				return;
			}
			const decoded = Buffer.concat(chunks);
			resolve(new Float32Array(decoded.buffer, decoded.byteOffset, Math.floor(decoded.byteLength / 4)));
		});
		child.stdin.end(Buffer.from(encoded, "base64"));
	});
}

function transcriptText(result) {
	const first = Array.isArray(result) ? result[0] : result;
	return typeof first?.text === "string" ? first.text.replace(/\s+/g, " ").trim() : "";
}

async function runTranscriber(audio, modelId, dtype, candidateCount = 1) {
	const transcriber = await getTranscriber(modelId, dtype);
	const commonOptions = {
		chunk_length_s: 30,
		stride_length_s: 5,
		return_timestamps: false,
	};
	const primary = transcriptText(await transcriber(audio, commonOptions));
	const candidates = primary ? [primary] : [];
	const modelType = transcriber.model?.config?.model_type;
	if ((modelType !== "whisper" && modelType !== "lite-whisper") || candidateCount <= 1) return candidates;

	// Transformers.js 3.x does not retain multiple beam-search sequences. Generate
	// low-temperature alternatives with the same model and let the configured
	// editing model resolve them against the current session context.
	for (let attempt = 1; candidates.length < candidateCount && attempt < candidateCount; attempt += 1) {
		const temperature = Math.min(0.2 + (attempt - 1) * 0.1, 0.8);
		const alternative = transcriptText(
			await transcriber(audio, {
				...commonOptions,
				do_sample: true,
				temperature,
				top_k: 50,
			}),
		);
		if (alternative && !candidates.includes(alternative)) candidates.push(alternative);
	}
	return candidates;
}

async function transcribePhoneAudio(encoded, modelId, dtype, candidateCount) {
	send({ type: "transcribing" });
	const audio = await decodePhoneAudio(encoded);
	return runTranscriber(audio, modelId, dtype, candidateCount);
}

async function transcribePcmAudio(encoded, modelId, dtype, candidateCount) {
	const bytes = Buffer.from(encoded, "base64");
	const audio = new Float32Array(Math.floor(bytes.length / Float32Array.BYTES_PER_ELEMENT));
	for (let index = 0; index < audio.length; index += 1) {
		audio[index] = bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
	}
	return runTranscriber(audio, modelId, dtype, candidateCount);
}

function executable(name) {
	if (name.includes(path.sep)) return fs.existsSync(name) ? name : null;
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.join(directory, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// Keep searching PATH.
		}
	}
	return null;
}

function playerCommand(sampleRate) {
	const override = process.env.PI_VOICE_PLAYER;
	if (override) {
		const command = executable(override);
		if (!command) throw new Error(`PI_VOICE_PLAYER is not executable: ${override}`);
		return { command, args: ["--raw", "--format", "f32", "--rate", String(sampleRate), "--channels", "1", "-"] };
	}
	const pipewire = executable("pw-play");
	if (pipewire) {
		return {
			command: pipewire,
			args: ["--raw", "--format", "f32", "--rate", String(sampleRate), "--channels", "1", "--latency", "100ms", "-"],
		};
	}
	const mpv = executable("mpv");
	if (mpv) {
		return {
			command: mpv,
			args: [
				"--really-quiet",
				"--no-video",
				"--cache=no",
				"--demuxer=rawaudio",
				"--demuxer-rawaudio-format=floatle",
				"--demuxer-rawaudio-rate=" + String(sampleRate),
				"--demuxer-rawaudio-channels=mono",
				"-",
			],
		};
	}
	const ffplay = executable(process.platform === "win32" ? "ffplay.exe" : "ffplay");
	if (ffplay) {
		return {
			command: ffplay,
			args: ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "f32le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0"],
		};
	}
	throw new Error("No audio player found. Install PipeWire (pw-play), mpv, or ffmpeg (ffplay).");
}

export function attachPlaybackClock(sink, sampleRate, utterance, expectFeedback = false) {
	let updatedAt = null;
	let position = 0;
	let paused = false;
	let lastFeedbackAt = expectFeedback ? performance.now() : -Infinity;
	sink.samplesWritten = 0;
	const advance = () => {
		const now = performance.now();
		if (updatedAt !== null && !paused) {
			position = Math.min(position + (now - updatedAt) / 1_000, sink.samplesWritten / sampleRate);
		}
		updatedAt = now;
	};
	sink.noteAudio = samples => {
		// Settle against the OLD buffer limit so starvation cannot consume new PCM.
		advance();
		sink.samplesWritten += samples;
	};
	sink.reportPlayback = (reportedPosition, estimated = false) => {
		if (!Number.isFinite(reportedPosition) || reportedPosition < 0) return;
		if (!estimated) {
			updatedAt = lastFeedbackAt = performance.now();
			position = reportedPosition;
		}
		send({ type: "playback", utterance, position: reportedPosition, ...(estimated ? { estimated: true } : {}) });
	};
	const timer = setInterval(() => {
		if (sink.samplesWritten === 0 || performance.now() - lastFeedbackAt < 750) return;
		advance();
		sink.reportPlayback(position, true);
	}, 125);
	timer.unref?.();
	sink.setPlaybackClockPaused = value => {
		advance();
		paused = value;
	};
	sink.stopPlaybackClock = () => clearInterval(timer);
	return sink;
}

function createLocalSink(sampleRate, utterance) {
	const { command, args } = playerCommand(sampleRate);
	const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
	let stderr = "";
	const ready = new Promise((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	child.stderr.on("data", chunk => {
		stderr = `${stderr}${String(chunk)}`.slice(-2_000);
	});
	const sink = attachPlaybackClock({
		writable: child.stdin,
		ready,
		stopped: false,
		async close() {
			try {
				await ready;
				if (child.exitCode !== null) return;
				const exited = new Promise(resolve => child.once("exit", resolve));
				child.stdin.end();
				await exited;
			} finally {
				this.stopPlaybackClock();
			}
		},
		stop() {
			this.stopped = true;
			this.stopPlaybackClock();
			child.stdin.destroy();
			if (child.exitCode !== null) return Promise.resolve();
			const exited = new Promise(resolve => child.once("exit", resolve));
			child.kill("SIGKILL");
			return exited.then(() => {});
		},
		setPaused(paused) {
			this.setPlaybackClockPaused(paused);
			child.kill(paused ? "SIGSTOP" : "SIGCONT");
		},
	}, sampleRate, utterance);
	child.stdin.on("error", error => {
		if (playback.currentPlayer === sink && !shuttingDown) send({ type: "error", message: error.message, utterance });
	});
	child.on("error", () => sink.stopPlaybackClock());
	child.on("exit", code => {
		sink.stopPlaybackClock();
		if (!sink.stopped && code === 0) sink.reportPlayback(sink.samplesWritten / sampleRate, true);
		if (playback.currentPlayer === sink) playback.clearCurrentPlayer();
		if (code !== 0 && code !== null && !shuttingDown) {
			send({ type: "error", message: stderr.trim() || `Audio player exited with code ${code}`, utterance });
		}
	});
	return sink;
}

function validateNetworkEndpoint(output) {
	const url = new URL(output);
	if (url.protocol === "tcp:" && url.hostname && url.port) return;
	if (url.protocol === "unix:" && !url.hostname && url.pathname.startsWith("/")) return;
	throw new Error(`Invalid network voice output: ${output}`);
}

function waitForDrainOrClose(writable) {
	return new Promise(resolve => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			writable.removeListener("drain", finish);
			writable.removeListener("close", finish);
			writable.removeListener("error", finish);
			resolve();
		};
		writable.once("drain", finish);
		writable.once("close", finish);
		writable.once("error", finish);
		if (writable.destroyed) finish();
	});
}

function createNetworkSink(output, sampleRate, utterance) {
	validateNetworkEndpoint(output);
	const helperPath = fileURLToPath(new URL("./tcp-playback.mjs", import.meta.url));
	const child = spawn(process.execPath, [helperPath, output, String(sampleRate), String(utterance)], {
		// The helper inherits stdout so playback events bypass blocked Kokoro
		// inference and flow directly into VoiceWorkerClient's JSON event stream.
		stdio: ["pipe", "inherit", "pipe", "pipe"],
		env: { ...process.env },
	});
	let stderr = "";
	let readySettled = false;
	let intentionallyStopped = false;
	let noAudio = false;
	let audioAdmitted = false;
	let session;
	const exited = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => code === 0 || code === 2 && noAudio && !audioAdmitted ? resolve() : reject(new RemotePlaybackUnconfirmedError(`helper exited ${code ?? signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
	});
	void exited.catch(() => {});
	const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers();
	const control = child.stdio[3];
	const controlLines = readline.createInterface({ input: control });
	controlLines.on("line", line => {
		if (line.startsWith("session ") && validStreamId(line.slice(8))) { session = line.slice(8); return; }
		if (line === "no-audio") { noAudio = true; return; }
		if (line === "ready") audioAdmitted = true;
		if (readySettled) return;
		readySettled = true;
		if (line === "ready") resolveReady();
		else rejectReady(noAudio ? new Error(line.replace(/^error\s*/, "")) : new RemotePlaybackUnconfirmedError(line.replace(/^error\s*/, "") || "TCP playback helper failed"));
	});
	child.stderr.on("data", chunk => {
		stderr = `${stderr}${String(chunk)}`.slice(-2_000);
	});
	child.on("error", error => {
		if (!readySettled) {
			readySettled = true;
			if (intentionallyStopped) resolveReady();
			else rejectReady(error);
		}
	});
	control.on("error", error => { stderr = error.message; });
	controlLines.on("error", error => { stderr = error.message; });
	const sink = {
		requiresStopProof: true,
		writable: child.stdin,
		ready,
		stopped: false,
		samplesWritten: 0,
		noteAudio(samples) {
			this.samplesWritten += samples;
		},
		async close() {
			await ready;
			if (child.exitCode !== null || child.signalCode !== null) return exited;
			// Android/Termux audio output can buffer well over half a second. Keep
			// the stream alive with silence so EOF cannot discard the final word.
			const padding = Buffer.alloc(Math.round(sampleRate * 1) * Float32Array.BYTES_PER_ELEMENT);
			if (!child.stdin.write(padding)) await waitForDrainOrClose(child.stdin);
			if (this.stopped) return exited;
			child.stdin.end();
			await exited;
		},
		stop() {
			this.stopped = true;
			intentionallyStopped = true;
			if (!readySettled) {
				readySettled = true;
				resolveReady();
			}
			// Stop the remote mpv explicitly before killing the local helper. EOF
			// alone lets buffered PCM drain and overlap a replacement timeline seek.
			try {
				control.write("stop\n");
			} catch {
				// The helper may have failed before its control fd became writable.
			}
			child.stdin.destroy();
			const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
			killTimer.unref?.();
			return exited.catch(async error => {
				if (!session) throw error;
				await stopRemotePlayback({ output, id: session });
				send({ type: "remote-released", id: session });
			}).finally(() => clearTimeout(killTimer));
		},
		setPaused(paused) {
			control.write(`${paused ? "pause" : "resume"}\n`);
		},
	};
	child.stdin.on("error", error => {
		if (playback.currentPlayer === sink && !shuttingDown) sendError(new RemotePlaybackUnconfirmedError(error.message, { cause: error }), { utterance });
	});
	child.on("exit", code => {
		if (!readySettled) {
			readySettled = true;
			if (intentionallyStopped) resolveReady();
			else rejectReady(new Error(stderr.trim() || `TCP playback helper exited with code ${code ?? "unknown"}`));
		}
	});
	child.on("close", code => {
		// Classify only after fd3 drains; exit can precede the no-audio marker.
		// Keep failed remote transports owned: helper death is not sink stop proof.
		if (code === 2 && noAudio && !audioAdmitted && session) send({ type: "remote-not-admitted", id: session });
		if ((code === 0 || code === 2 && noAudio && !audioAdmitted) && playback.currentPlayer === sink) playback.clearCurrentPlayer();
	});
	return sink;
}

function clearCurrentPlayer() {
	playback.clearCurrentPlayer();
}

function startPlayer(sampleRate, utterance, output) {
	return playback.startPlayer(sampleRate, utterance, output, (sinkOutput, sinkRate, sinkUtterance) =>
		sinkOutput.startsWith("tcp://") || sinkOutput.startsWith("unix://")
			? createNetworkSink(sinkOutput, sinkRate, sinkUtterance)
			: createLocalSink(sinkRate, sinkUtterance),
	);
}

function setPlayerPaused(paused) {
	playbackPaused = paused;
	if (!paused) cancelTimingRetry();
	playback.setPlayerPaused(paused);
}

async function stopPlayer() {
	await playback.stopPlayer();
}

async function writeAudio(sink, pcm) {
	return playback.writeAudio(sink, pcm);
}

async function closePlayer(utterance) {
	return playback.closePlayer(utterance);
}

async function runOperation(operation) {
	if (operation.type === "transcribe-pcm") {
		try {
			const candidates = await transcribePcmAudio(operation.audio, operation.model, operation.dtype, operation.candidateCount);
			send({ type: "transcript", requestId: operation.requestId, text: candidates[0] ?? "", candidates, preview: true });
		} catch (error) {
			send({
				type: "error",
				requestId: operation.requestId,
				message: error instanceof Error ? error.message : String(error),
				preview: true,
			});
		}
		return;
	}
	if (operation.type === "transcribe") {
		try {
			const candidates = await transcribePhoneAudio(
				operation.audio,
				operation.model,
				operation.dtype,
				operation.candidateCount,
			);
			send({ type: "transcript", requestId: operation.requestId, text: candidates[0] ?? "", candidates });
		} catch (error) {
			send({
				type: "error",
				requestId: operation.requestId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}
	if (operation.type === "preload") {
		// Warm every slot, but let the ordered pump use the first available worker.
		void (async () => {
			try {
				if (shuttingDown || operation.epoch !== epoch) throw new Error("Sentence preload cancelled");
				await Promise.all(Array.from({ length: synthesisWorkers }, () => sentencePool.generate(operation)));
				if (shuttingDown || operation.epoch !== epoch) throw new Error("Sentence preload cancelled");
				send({ type: "preload-ready", requestId: operation.requestId });
			} catch (error) {
				send({ type: "error", requestId: operation.requestId, message: error instanceof Error ? error.message : String(error) });
			}
		})();
		return;
	}
	if (operation.type === "end") {
		const completed = await closePlayer(operation.utterance);
		// Empty utterances complete, but cancelled drains must await the stop ACK.
		if (!completed && operation.epoch === epoch && !playback.currentPlayer) send({ type: "idle", utterance: operation.utterance });
		return;
	}
	if (operation.type === "measure") {
		try {
			const audio = await audioForOperation(operation);
			if (operation.epoch !== epoch) return;
			const duration = audio.pcm instanceof Float32Array ? audio.pcm.length / audio.sampleRate : 0;
			send({ type: "measurement", requestId: operation.requestId, duration });
		} catch (error) {
			send({
				type: "error",
				requestId: operation.requestId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}
	reportPlaybackPhase(operation, operation.phase ?? "queued");
	const audio = await (operation.audioPromise ?? audioForOperation(operation));
	if (operation.epoch !== epoch) return;
	const sampleRate = audio.sampleRate;
	const pcm = audio.pcm;
	if (!(pcm instanceof Float32Array) || pcm.length === 0) return;
	reportPlaybackPhase(operation, "connecting");
	const sink = startPlayer(sampleRate, operation.utterance, operation.output);
	await sink.ready;
	if (operation.epoch !== epoch || sink.stopped) return;
	reportPlaybackPhase(operation, "playing");
	const start = sink.samplesWritten / sampleRate;
	const duration = pcm.length / sampleRate;
	send({ type: "segment-audio", utterance: operation.utterance, segmentId: operation.segmentId, start, duration, timingQuality: "estimated" });
	const writing = writeAudio(sink, pcm);
	// Let playback submit PCM before spending CPU on optional alignment encoding.
	await Promise.resolve();
	if (operation.epoch === epoch && !sink.stopped) requestAlignment(operation, pcm, sampleRate);
	await writing;
}

function primeAudio() {
	// Bound new PCM/inference lookahead, even while paused. A decrease retains
	// already-started promises outside the smaller window until ordered playback drains them.
	let remaining = synthesisWorkers;
	for (const operation of [activeOperation, ...queue]) {
		if (!operation) continue;
		if (operation.type === "end") continue;
		if (operation.type !== "segment" || operation.epoch !== epoch || remaining-- <= 0) break;
		if (!operation.audioPromise) {
			operation.audioPromise = audioForOperation(operation);
			// Later slots can fail before the ordered consumer reaches them.
			void operation.audioPromise.catch(() => {});
		}
	}
}

async function pump() {
	if (pumping) return;
	pumping = true;
	try {
		while (queue.length > 0 && !shuttingDown) {
			const operation = queue.shift();
			await cancelBarrier;
			if (shuttingDown || (operation.epoch !== epoch && ["segment", "end", "measure"].includes(operation.type))) continue;
			activeOperation = operation;
			primeAudio();
			try {
				await runOperation(operation);
			} catch (error) {
				if (operation.epoch !== epoch) continue;
				sendError(error, Number.isInteger(operation.utterance) ? { utterance: operation.utterance } : {});
				// Terminal synthesis/sink failure invalidates the remaining utterance;
				// otherwise queued segments can create a second uncontrolled player.
				await scheduleCancel();
			}
		}
	} finally {
		activeOperation = undefined;
		pumping = false;
		if (queue.length > 0 && !shuttingDown) void cancelBarrier.then(() => pump()).catch(error => sendError(error));
	}
}

function enqueue(operation) {
	if (shuttingDown) return;
	cancelTimingRetry();
	const queued = { ...operation, epoch };
	if (operation.type === "measure") queue.push(queued);
	else {
		const backgroundAt = queue.findIndex(candidate => candidate.type === "measure");
		if (backgroundAt < 0) queue.push(queued);
		else queue.splice(backgroundAt, 0, queued);
	}
	primeAudio();
	void cancelBarrier.then(() => pump()).catch(error => sendError(error));
}

function scheduleCancel(cancelId) {
	// Invalidate queued/current synthesis synchronously so segment messages that
	// arrive in the same stdin chunk are stamped with the replacement epoch.
	epoch += 1;
	cancelTimingRetry();
	playbackPaused = false;
	sentencePool.cancel();
	cancelAlignment();
	playback.resetPlayerPaused();
	queue = queue
		.filter(
			operation =>
				operation.type === "preload" || operation.type === "transcribe" || operation.type === "transcribe-pcm",
		)
		.map(operation => ({ ...operation, epoch }));
	// A rejected stop blocks ordinary work, but an explicit cancel retries the same sink.
	cancelBarrier = cancelBarrier.catch(() => {}).then(async () => {
		await stopPlayer();
		send({ type: "idle", ...(Number.isInteger(cancelId) ? { cancelId } : {}) });
	});
	return cancelBarrier;
}

function shutdown(cancelId) {
	if (shuttingDown) return;
	shuttingDown = true;
	// Wait for transport stop before exiting; otherwise children can outlive the speech lease.
	void scheduleCancel(cancelId).then(() => {
		sentencePool.close();
		stopAlignment();
		process.exit(0);
	}, error => {
		sendError(error);
		process.exit(1);
	});
}

if (synthesisChild) {
	process.on("disconnect", () => process.exit(0));
	process.on("message", async ({ id, operation }) => {
		synthesisJobId = id;
		let response;
		try {
			const audio = operation.type === "preload"
				? (await getModel(operation.model, operation.dtype), undefined)
				: await audioForOperation({ ...operation, type: "synthesis" });
			response = { id, audio };
		} catch (error) { response = { id, error: String(error) }; }
		if (process.connected) process.send(response, error => { if (error) process.exit(1); });
	});
} else {
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	switch (message.type) {
		case "retry-timing":
			void retryTiming(message);
			break;
		case "cancel-timing-retry":
			cancelTimingRetry(message.requestId);
			break;
		case "tts-workers":
			if (Number.isInteger(message.workers) && message.workers >= 1 && message.workers <= 8) {
				synthesisWorkers = message.workers;
				sentencePool.resize(synthesisWorkers);
				primeAudio();
			}
			break;
		case "segment":
			enqueue({
				type: "segment",
				utterance: message.utterance,
				segmentId: message.segmentId,
				text: message.text,
				voice: message.voice,
				speed: message.speed,
				output: message.output ?? "local",
				model: message.model ?? DEFAULT_TTS_MODEL,
				dtype: message.dtype ?? DEFAULT_TTS_DTYPE,
				alignmentModel: message.alignmentModel ?? DEFAULT_ALIGNMENT_MODEL,
				alignmentDtype: message.alignmentDtype ?? DEFAULT_ALIGNMENT_DTYPE,
				audioCache: message.audioCache === true,
				audioCacheBitrate: message.audioCacheBitrate,
			});
			break;
		case "measure":
			enqueue({
				type: "measure",
				requestId: message.requestId,
				text: message.text,
				voice: message.voice,
				speed: message.speed,
				model: message.model ?? DEFAULT_TTS_MODEL,
				dtype: message.dtype ?? DEFAULT_TTS_DTYPE,
				audioCache: message.audioCache === true,
				audioCacheBitrate: message.audioCacheBitrate,
			});
			break;
		case "end":
			enqueue({ type: "end", utterance: message.utterance });
			break;
		case "preload-alignment":
			preloadAlignment(
				message.requestId,
				message.model ?? DEFAULT_ALIGNMENT_MODEL,
				message.dtype ?? DEFAULT_ALIGNMENT_DTYPE,
			);
			break;
		case "preload":
			enqueue({
				type: "preload",
				requestId: message.requestId,
				model: message.model ?? DEFAULT_TTS_MODEL,
				dtype: message.dtype ?? DEFAULT_TTS_DTYPE,
			});
			break;
		case "transcribe":
		case "transcribe-pcm":
			enqueue({
				type: message.type,
				requestId: message.requestId,
				audio: message.audio,
				model: message.model ?? DEFAULT_STT_MODEL,
				dtype: message.dtype ?? DEFAULT_STT_DTYPE,
				candidateCount:
					Number.isInteger(message.candidateCount) && message.candidateCount >= 1 && message.candidateCount <= 8
						? message.candidateCount
						: 1,
			});
			break;
		case "pause":
			setPlayerPaused(message.paused === true);
			break;
		case "cancel":
			void scheduleCancel(message.cancelId).catch(error => sendError(error));
			break;
		case "shutdown":
			shutdown(message.cancelId);
			break;
	}
});
lines.on("close", shutdown);
}
