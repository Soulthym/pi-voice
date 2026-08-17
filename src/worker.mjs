import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { env as transformersEnv, pipeline } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

const DEFAULT_TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_TTS_DTYPE = "q8";
const DEFAULT_STT_MODEL = "onnx-community/whisper-tiny.en";
const DEFAULT_STT_DTYPE = "fp32";
const DEFAULT_SAMPLE_RATE = 24_000;
const cacheDir = process.env.PI_VOICE_CACHE_DIR ?? path.join(os.homedir(), ".cache", "pi-voice", "models");
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
let player = null;
let playerUtterance = null;
let playerOutput = null;
let shuttingDown = false;

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function progressPercent(info) {
	if (typeof info?.progress === "number") return Math.round(info.progress);
	if (typeof info?.loaded === "number" && typeof info?.total === "number" && info.total > 0) {
		return Math.round((info.loaded / info.total) * 100);
	}
	return undefined;
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
			reject(new Error("ffmpeg is required on the desktop for phone microphone input"));
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
				reject(new Error("Decoded phone recording exceeded 32 MB"));
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
	const ffplay = executable(process.platform === "win32" ? "ffplay.exe" : "ffplay");
	if (ffplay) {
		return {
			command: ffplay,
			args: ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "f32le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0"],
		};
	}
	throw new Error("No audio player found. Install PipeWire (pw-play) or ffmpeg (ffplay).");
}

function createLocalSink(sampleRate) {
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
	const sink = {
		writable: child.stdin,
		ready,
		async close() {
			await ready;
			if (child.exitCode !== null) return;
			const exited = new Promise(resolve => child.once("exit", resolve));
			child.stdin.end();
			await exited;
		},
		stop() {
			child.stdin.destroy();
			child.kill("SIGKILL");
		},
	};
	child.stdin.on("error", error => {
		if (player === sink && !shuttingDown) send({ type: "error", message: error.message });
	});
	child.on("exit", code => {
		if (player === sink) clearCurrentPlayer();
		if (code !== 0 && code !== null && !shuttingDown) {
			send({ type: "error", message: stderr.trim() || `Audio player exited with code ${code}` });
		}
	});
	return sink;
}

function parseTcpEndpoint(output) {
	const url = new URL(output);
	if (url.protocol !== "tcp:" || !url.hostname || !url.port) throw new Error(`Invalid TCP voice output: ${output}`);
	return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) };
}

function createTcpSink(output, sampleRate) {
	const { host, port } = parseTcpEndpoint(output);
	const socket = net.createConnection({ host, port });
	socket.setNoDelay(true);
	let connected = false;
	const ready = new Promise((resolve, reject) => {
		socket.once("connect", () => {
			connected = true;
			resolve();
		});
		socket.once("error", reject);
	});
	const sink = {
		writable: socket,
		ready,
		async close() {
			await ready;
			if (socket.destroyed) return;
			// Android/Termux audio output can buffer well over half a second. Keep
			// the stream alive with silence so EOF cannot discard the final word.
			const padding = Buffer.alloc(Math.round(sampleRate * 1) * Float32Array.BYTES_PER_ELEMENT);
			if (!socket.write(padding)) await new Promise(resolve => socket.once("drain", resolve));
			const closed = new Promise(resolve => socket.once("close", resolve));
			socket.end();
			await closed;
		},
		stop() {
			socket.destroy();
		},
	};
	socket.on("error", error => {
		if (connected && player === sink && !shuttingDown) send({ type: "error", message: error.message });
	});
	socket.on("close", () => {
		if (player === sink) clearCurrentPlayer();
	});
	return sink;
}

function clearCurrentPlayer() {
	player = null;
	playerUtterance = null;
	playerOutput = null;
}

function startPlayer(sampleRate, utterance, output) {
	if (player && playerUtterance === utterance && playerOutput === output) return player;
	if (player) stopPlayer();
	const sink = output.startsWith("tcp://") ? createTcpSink(output, sampleRate) : createLocalSink(sampleRate);
	player = sink;
	playerUtterance = utterance;
	playerOutput = output;
	send({ type: "speaking" });
	return sink;
}

function stopPlayer() {
	const sink = player;
	clearCurrentPlayer();
	if (!sink) return;
	try {
		sink.stop();
	} catch {
		// Best-effort interruption.
	}
}

async function writeAudio(sink, audio) {
	const pcm = Array.isArray(audio) ? audio[0] : audio;
	if (!(pcm instanceof Float32Array) || pcm.length === 0) return;
	await sink.ready;
	const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	if (!sink.writable.write(bytes)) await new Promise(resolve => sink.writable.once("drain", resolve));
}

async function closePlayer(utterance) {
	const sink = player;
	if (!sink || playerUtterance !== utterance) return;
	clearCurrentPlayer();
	await sink.close();
	send({ type: "idle" });
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
		await closePlayer(operation.utterance);
		return;
	}
	const model = await getModel(operation.model, operation.dtype);
	if (operation.epoch !== epoch) return;
	const output = await model.generate(operation.text, { voice: operation.voice, speed: operation.speed });
	if (operation.epoch !== epoch) return;
	const sampleRate = output.sampling_rate || DEFAULT_SAMPLE_RATE;
	const sink = startPlayer(sampleRate, operation.utterance, operation.output);
	await writeAudio(sink, output.audio);
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
				send({ type: "error", message: error instanceof Error ? error.message : String(error) });
				stopPlayer();
			}
		}
	} finally {
		pumping = false;
		if (queue.length > 0 && !shuttingDown) void pump();
	}
}

function enqueue(operation) {
	queue.push({ ...operation, epoch });
	void pump();
}

function cancel() {
	epoch += 1;
	queue = queue
		.filter(
			operation =>
				operation.type === "preload" || operation.type === "transcribe" || operation.type === "transcribe-pcm",
		)
		.map(operation => ({ ...operation, epoch }));
	stopPlayer();
	send({ type: "idle" });
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
				text: message.text,
				voice: message.voice,
				speed: message.speed,
				output: message.output ?? "local",
				model: message.model ?? DEFAULT_TTS_MODEL,
				dtype: message.dtype ?? DEFAULT_TTS_DTYPE,
			});
			break;
		case "end":
			enqueue({ type: "end", utterance: message.utterance });
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
		case "cancel":
			cancel();
			break;
		case "shutdown":
			shuttingDown = true;
			cancel();
			process.exit(0);
	}
});
lines.on("close", () => {
	shuttingDown = true;
	stopPlayer();
	process.exit(0);
});
