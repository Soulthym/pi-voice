import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { env as transformersEnv, pipeline } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { createPlaybackController } from "./playback-controller.mjs";

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
transformersEnv.allowRemoteModels = true;
transformersEnv.useBrowserCache = false;
transformersEnv.logLevel = "error";
if (transformersEnv.backends?.onnx) transformersEnv.backends.onnx.logLevel = "error";

const ttsModels = new Map();
const sttModels = new Map();
let epoch = 0;
let queue = [];
let pumping = false;
let cancelBarrier = Promise.resolve();
let alignmentChild = null;
let shuttingDown = false;

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

const playback = createPlaybackController({ send });

function ensureAlignmentChild() {
	if (alignmentChild && alignmentChild.exitCode === null) return alignmentChild;
	const child = spawn(process.execPath, [fileURLToPath(new URL("./alignment-worker.mjs", import.meta.url))], {
		// Alignment events bypass this synthesis process and reach Pi directly,
		// even while native Kokoro inference is blocking this event loop.
		stdio: ["pipe", "inherit", "ignore"],
		env: { ...process.env },
	});
	alignmentChild = child;
	child.on("error", () => {
		if (alignmentChild === child) alignmentChild = null;
	});
	child.on("exit", () => {
		if (alignmentChild === child) alignmentChild = null;
	});
	return child;
}

function preloadAlignment(requestId, model, dtype) {
	try {
		ensureAlignmentChild().stdin.write(
			`${JSON.stringify({ type: "preload", epoch, requestId, model, dtype })}\n`,
		);
	} catch (error) {
		send({
			type: "alignment-preload-error",
			requestId,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

function requestAlignment(operation, pcm, sampleRate) {
	try {
		const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		ensureAlignmentChild().stdin.write(
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
	} catch {
		// Estimated word timings remain available if the aligner cannot start.
	}
}

function cancelAlignment() {
	try {
		alignmentChild?.stdin.write(`${JSON.stringify({ type: "cancel", epoch })}\n`);
	} catch {
		// Best effort.
	}
}

function stopAlignment() {
	const child = alignmentChild;
	alignmentChild = null;
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
				1,
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

function runFfmpeg(args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn("ffmpeg", ["-v", "error", ...args], { stdio: ["pipe", "pipe", "pipe"] });
		const stdout = [];
		let stderr = "";
		child.stdout.on("data", chunk => stdout.push(chunk));
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

async function readCachedAudio(file) {
	try {
		await fs.promises.access(file, fs.constants.R_OK);
		const bytes = await runFfmpeg(["-i", file, "-f", "f32le", "-ar", String(DEFAULT_SAMPLE_RATE), "-ac", "1", "pipe:1"]);
		if (bytes.length === 0 || bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error("Empty audio cache entry");
		const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		return new Float32Array(array);
	} catch {
		await fs.promises.rm(file, { force: true }).catch(() => {});
		return undefined;
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

async function audioForOperation(operation) {
	const file = audioCachePath(operation);
	if (file) {
		const cached = await readCachedAudio(file);
		if (cached) return { pcm: cached, sampleRate: DEFAULT_SAMPLE_RATE };
	}
	const model = await getModel(operation.model, operation.dtype);
	const output = await model.generate(operation.text, { voice: operation.voice, speed: operation.speed });
	const sampleRate = output.sampling_rate || DEFAULT_SAMPLE_RATE;
	const pcm = Array.isArray(output.audio) ? output.audio[0] : output.audio;
	if (file && pcm instanceof Float32Array && sampleRate === DEFAULT_SAMPLE_RATE) {
		await writeCachedAudio(file, pcm, Number(operation.audioCacheBitrate));
		const cached = await readCachedAudio(file);
		if (cached) return { pcm: cached, sampleRate: DEFAULT_SAMPLE_RATE };
	}
	return { pcm, sampleRate };
}

async function getModel(modelId = DEFAULT_TTS_MODEL, dtype = DEFAULT_TTS_DTYPE) {
	const key = `${modelId}\0${dtype}`;
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

async function transcribePcmAudio(encoded, modelId, dtype) {
	const bytes = Buffer.from(encoded, "base64");
	const audio = new Float32Array(Math.floor(bytes.length / Float32Array.BYTES_PER_ELEMENT));
	for (let index = 0; index < audio.length; index += 1) {
		audio[index] = bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
	}
	return runTranscriber(audio, modelId, dtype, 1);
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

function attachPlaybackClock(sink, sampleRate, utterance, expectFeedback = false) {
	let startedAt = null;
	let pausedAt = null;
	let pausedDuration = 0;
	let lastFeedbackAt = expectFeedback ? performance.now() : 0;
	sink.samplesWritten = 0;
	sink.noteAudio = samples => {
		if (startedAt === null) startedAt = performance.now();
		sink.samplesWritten += samples;
	};
	sink.reportPlayback = (position, estimated = false) => {
		if (!Number.isFinite(position) || position < 0) return;
		if (!estimated) lastFeedbackAt = performance.now();
		send({ type: "playback", utterance, position, ...(estimated ? { estimated: true } : {}) });
	};
	const timer = setInterval(() => {
		if (startedAt === null || performance.now() - lastFeedbackAt < 750) return;
		const now = performance.now();
		const paused = pausedDuration + (pausedAt === null ? 0 : now - pausedAt);
		const elapsed = (now - startedAt - paused) / 1_000;
		sink.reportPlayback(Math.min(elapsed, sink.samplesWritten / sampleRate), true);
	}, 125);
	timer.unref?.();
	sink.setPlaybackClockPaused = paused => {
		const now = performance.now();
		if (paused && pausedAt === null) pausedAt = now;
		else if (!paused && pausedAt !== null) {
			pausedDuration += now - pausedAt;
			pausedAt = null;
		}
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
			this.stopPlaybackClock();
			await ready;
			if (child.exitCode !== null) return;
			const exited = new Promise(resolve => child.once("exit", resolve));
			child.stdin.end();
			await exited;
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
	child.on("exit", code => {
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
	const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers();
	const control = child.stdio[3];
	const controlLines = readline.createInterface({ input: control });
	controlLines.on("line", line => {
		if (readySettled) return;
		readySettled = true;
		if (line === "ready") resolveReady();
		else rejectReady(new Error(line.replace(/^error\s*/, "") || "TCP playback helper failed"));
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
	const sink = {
		writable: child.stdin,
		ready,
		stopped: false,
		samplesWritten: 0,
		noteAudio(samples) {
			this.samplesWritten += samples;
		},
		async close() {
			await ready;
			if (child.exitCode !== null) return;
			// Android/Termux audio output can buffer well over half a second. Keep
			// the stream alive with silence so EOF cannot discard the final word.
			const padding = Buffer.alloc(Math.round(sampleRate * 1) * Float32Array.BYTES_PER_ELEMENT);
			if (!child.stdin.write(padding)) await waitForDrainOrClose(child.stdin);
			if (this.stopped) return;
			const exited = new Promise(resolve => child.once("exit", resolve));
			child.stdin.end();
			await exited;
		},
		stop() {
			this.stopped = true;
			intentionallyStopped = true;
			const exited = child.exitCode !== null
				? Promise.resolve()
				: new Promise(resolve => child.once("exit", resolve));
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
			const killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
			killTimer.unref?.();
			return exited.then(() => clearTimeout(killTimer));
		},
		setPaused(paused) {
			control.write(`${paused ? "pause" : "resume"}\n`);
		},
	};
	child.stdin.on("error", error => {
		if (playback.currentPlayer === sink && !shuttingDown) send({ type: "error", message: error.message, utterance });
	});
	child.on("exit", code => {
		if (!readySettled) {
			readySettled = true;
			if (intentionallyStopped) resolveReady();
			else rejectReady(new Error(stderr.trim() || `TCP playback helper exited with code ${code ?? "unknown"}`));
		}
		if (playback.currentPlayer === sink) playback.clearCurrentPlayer();
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
	playback.setPlayerPaused(paused);
}

function stopPlayer() {
	return playback.stopPlayer();
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
			const candidates = await transcribePcmAudio(operation.audio, operation.model, operation.dtype);
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
		try {
			await getModel(operation.model, operation.dtype);
			send({ type: "ready", requestId: operation.requestId });
		} catch (error) {
			send({ type: "error", requestId: operation.requestId, message: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (operation.type === "end") {
		const completed = await closePlayer(operation.utterance);
		// Code-only omissions and failed/replaced sinks still need a terminal
		// utterance event so the extension cannot retain the device lease forever.
		if (!completed) send({ type: "idle", utterance: operation.utterance });
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
	const audio = await audioForOperation(operation);
	if (operation.epoch !== epoch) return;
	const sampleRate = audio.sampleRate;
	const pcm = audio.pcm;
	if (!(pcm instanceof Float32Array) || pcm.length === 0) return;
	const sink = startPlayer(sampleRate, operation.utterance, operation.output);
	await sink.ready;
	if (operation.epoch !== epoch || sink.stopped) return;
	const start = sink.samplesWritten / sampleRate;
	const duration = pcm.length / sampleRate;
	send({ type: "segment-audio", utterance: operation.utterance, segmentId: operation.segmentId, start, duration });
	requestAlignment(operation, pcm, sampleRate);
	await writeAudio(sink, pcm);
}

async function pump() {
	if (pumping) return;
	pumping = true;
	try {
		while (queue.length > 0 && !shuttingDown) {
			const operation = queue.shift();
			try {
				await runOperation(operation);
			} catch (error) {
				if (operation.epoch !== epoch) continue;
				send({
					type: "error",
					message: error instanceof Error ? error.message : String(error),
					...(Number.isInteger(operation.utterance) ? { utterance: operation.utterance } : {}),
				});
				// Terminal synthesis/sink failure invalidates the remaining utterance;
				// otherwise queued segments can create a second uncontrolled player.
				await scheduleCancel();
			}
		}
	} finally {
		pumping = false;
		if (queue.length > 0 && !shuttingDown) void cancelBarrier.then(() => pump());
	}
}

function enqueue(operation) {
	const queued = { ...operation, epoch };
	if (operation.type === "measure") queue.push(queued);
	else {
		const backgroundAt = queue.findIndex(candidate => candidate.type === "measure");
		if (backgroundAt < 0) queue.push(queued);
		else queue.splice(backgroundAt, 0, queued);
	}
	void cancelBarrier.then(() => pump());
}

function scheduleCancel(cancelId) {
	// Invalidate queued/current synthesis synchronously so segment messages that
	// arrive in the same stdin chunk are stamped with the replacement epoch.
	epoch += 1;
	cancelAlignment();
	playback.resetPlayerPaused();
	queue = queue
		.filter(
			operation =>
				operation.type === "preload" || operation.type === "transcribe" || operation.type === "transcribe-pcm",
		)
		.map(operation => ({ ...operation, epoch }));
	cancelBarrier = cancelBarrier.then(async () => {
		await stopPlayer();
		send({ type: "idle", ...(Number.isInteger(cancelId) ? { cancelId } : {}) });
	});
	return cancelBarrier;
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	switch (message.type) {
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
			enqueue({
				type: "transcribe",
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
		case "transcribe-pcm":
			enqueue({
				type: "transcribe-pcm",
				requestId: message.requestId,
				audio: message.audio,
				model: message.model ?? DEFAULT_STT_MODEL,
				dtype: message.dtype ?? DEFAULT_STT_DTYPE,
			});
			break;
		case "pause":
			setPlayerPaused(message.paused === true);
			break;
		case "cancel":
			void scheduleCancel(message.cancelId);
			break;
		case "shutdown":
			shuttingDown = true;
			cancel();
			stopAlignment();
			process.exit(0);
	}
});
lines.on("close", () => {
	shuttingDown = true;
	stopPlayer();
	stopAlignment();
	process.exit(0);
});
