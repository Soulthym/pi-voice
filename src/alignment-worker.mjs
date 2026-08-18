import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { env as transformersEnv, pipeline } from "@huggingface/transformers";

const DEFAULT_ALIGNMENT_MODEL = "onnx-community/wav2vec2-base-960h-ONNX";
const DEFAULT_ALIGNMENT_DTYPE = "q8";
const cacheDir = process.env.PI_VOICE_CACHE_DIR ?? path.join(os.homedir(), ".cache", "pi-voice", "models");
fs.mkdirSync(cacheDir, { recursive: true });
transformersEnv.cacheDir = cacheDir;
transformersEnv.allowLocalModels = true;
transformersEnv.allowRemoteModels = true;
transformersEnv.useBrowserCache = false;
transformersEnv.logLevel = "error";
if (transformersEnv.backends?.onnx) transformersEnv.backends.onnx.logLevel = "error";

const models = new Map();
let epoch = 0;
let queue = [];
let pumping = false;
let shuttingDown = false;

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function getAligner(modelId, dtype) {
	const key = `${modelId}\0${dtype}`;
	const cached = models.get(key);
	if (cached) return cached;
	const loading = pipeline("automatic-speech-recognition", modelId, { dtype, device: "cpu" }).catch(error => {
		models.delete(key);
		throw error;
	});
	models.set(key, loading);
	return loading;
}

function decodePcm(encoded) {
	const bytes = Buffer.from(encoded, "base64");
	const audio = new Float32Array(Math.floor(bytes.length / Float32Array.BYTES_PER_ELEMENT));
	for (let index = 0; index < audio.length; index += 1) {
		audio[index] = bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
	}
	return audio;
}

function resample(audio, sourceRate, targetRate) {
	if (sourceRate === targetRate) return audio;
	const length = Math.max(1, Math.round((audio.length * targetRate) / sourceRate));
	const output = new Float32Array(length);
	const scale = sourceRate / targetRate;
	for (let index = 0; index < length; index += 1) {
		const source = index * scale;
		const left = Math.min(audio.length - 1, Math.floor(source));
		const right = Math.min(audio.length - 1, left + 1);
		const fraction = source - left;
		output[index] = (audio[left] ?? 0) * (1 - fraction) + (audio[right] ?? 0) * fraction;
	}
	return output;
}

function alignmentTargets(tokenizer, text) {
	const words = text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toUpperCase()
		.match(/[A-Z]+(?:'[A-Z]+)*/g) ?? [];
	const delimiter = tokenizer.model?.tokens_to_ids?.get?.("|") ?? tokenizer.model?.vocab?.indexOf("|");
	const tokens = [];
	const spans = [];
	for (const word of words) {
		const encoded = tokenizer(word, { add_special_tokens: false }).input_ids?.data;
		const ids = encoded ? [...encoded].map(Number) : [];
		if (ids.length === 0) continue;
		if (tokens.length > 0 && Number.isInteger(delimiter) && delimiter >= 0) tokens.push(delimiter);
		const start = tokens.length;
		tokens.push(...ids);
		spans.push({ text: word, start, end: tokens.length });
	}
	return { tokens, spans };
}

/** Viterbi alignment through the blank-interleaved CTC state graph. */
function forceAlign(logits, targets, blankId, duration) {
	const dimensions = logits.dims ?? [];
	const frames = dimensions[0] ?? 0;
	const vocabulary = dimensions[1] ?? 0;
	if (frames <= 0 || vocabulary <= 0 || targets.length === 0) return undefined;
	const states = targets.length * 2 + 1;
	if (states > frames * 2 + 1) return undefined;
	const emissions = logits.data;
	const backpointers = Array.from({ length: frames }, () => new Uint8Array(states));
	let previous = new Float64Array(states).fill(Number.NEGATIVE_INFINITY);
	previous[0] = Number(emissions[blankId] ?? Number.NEGATIVE_INFINITY);
	if (states > 1) previous[1] = Number(emissions[targets[0]] ?? Number.NEGATIVE_INFINITY);

	for (let frame = 1; frame < frames; frame += 1) {
		const current = new Float64Array(states).fill(Number.NEGATIVE_INFINITY);
		const row = frame * vocabulary;
		for (let state = 0; state < states; state += 1) {
			let best = previous[state];
			let transition = 0;
			if (state > 0 && previous[state - 1] > best) {
				best = previous[state - 1];
				transition = 1;
			}
			if (
				state >= 3 &&
				state % 2 === 1 &&
				targets[(state - 1) / 2] !== targets[(state - 3) / 2] &&
				previous[state - 2] > best
			) {
				best = previous[state - 2];
				transition = 2;
			}
			const token = state % 2 === 0 ? blankId : targets[(state - 1) / 2];
			current[state] = best + Number(emissions[row + token] ?? Number.NEGATIVE_INFINITY);
			backpointers[frame][state] = transition;
		}
		previous = current;
	}

	let state = states - 1;
	if (states > 1 && previous[states - 2] > previous[state]) state = states - 2;
	if (!Number.isFinite(previous[state])) return undefined;
	const tokenStarts = new Int32Array(targets.length).fill(-1);
	const tokenEnds = new Int32Array(targets.length).fill(-1);
	for (let frame = frames - 1; frame >= 0; frame -= 1) {
		if (state % 2 === 1) {
			const tokenIndex = (state - 1) / 2;
			tokenStarts[tokenIndex] = frame;
			if (tokenEnds[tokenIndex] < 0) tokenEnds[tokenIndex] = frame + 1;
		}
		if (frame > 0) state -= backpointers[frame][state];
	}
	const secondsPerFrame = duration / frames;
	return {
		starts: [...tokenStarts].map(frame => Math.max(0, frame) * secondsPerFrame),
		ends: [...tokenEnds].map(frame => Math.max(0, frame) * secondsPerFrame),
	};
}

async function align(operation) {
	const aligner = await getAligner(operation.model, operation.dtype);
	if (operation.epoch !== epoch) return;
	const modelType = aligner.model?.config?.model_type;
	if (modelType !== "wav2vec2" && modelType !== "hubert" && modelType !== "unispeech") {
		throw new Error(`Forced alignment requires a CTC acoustic model, not ${modelType ?? "this architecture"}`);
	}
	const inputRate = Number(operation.sampleRate) || 24_000;
	const targetRate = aligner.processor?.feature_extractor?.config?.sampling_rate ?? 16_000;
	const audio = resample(decodePcm(operation.audio), inputRate, targetRate);
	const inputs = await aligner.processor(audio);
	const output = await aligner.model(inputs);
	if (operation.epoch !== epoch) return;
	const logits = output.logits?.[0];
	const target = alignmentTargets(aligner.tokenizer, operation.text);
	const duration = Number(operation.duration) || audio.length / targetRate;
	const alignment = logits
		? forceAlign(logits, target.tokens, Number(aligner.model.config.pad_token_id ?? 0), duration)
		: undefined;
	if (!alignment) throw new Error("The CTC model could not align this synthesized segment");
	const words = target.spans.map(span => ({
		text: span.text,
		start: alignment.starts[span.start] ?? 0,
		end: alignment.ends[span.end - 1] ?? duration,
	}));
	send({ type: "alignment", epoch: operation.epoch, segmentId: operation.segmentId, words });
}

async function pump() {
	if (pumping) return;
	pumping = true;
	try {
		while (queue.length > 0 && !shuttingDown) {
			const operation = queue.shift();
			try {
				await align(operation);
			} catch (error) {
				if (operation.epoch === epoch) {
					send({
						type: "alignment-error",
						epoch: operation.epoch,
						segmentId: operation.segmentId,
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	} finally {
		pumping = false;
		if (queue.length > 0 && !shuttingDown) void pump();
	}
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.type === "align") {
		epoch = Number.isInteger(message.epoch) ? message.epoch : epoch;
		queue.push({
			type: "align",
			epoch,
			segmentId: message.segmentId,
			audio: message.audio,
			text: message.text,
			sampleRate: message.sampleRate,
			duration: message.duration,
			model: message.model ?? DEFAULT_ALIGNMENT_MODEL,
			dtype: message.dtype ?? DEFAULT_ALIGNMENT_DTYPE,
		});
		void pump();
	} else if (message.type === "cancel") {
		epoch = Number.isInteger(message.epoch) ? message.epoch : epoch + 1;
		queue = [];
	} else if (message.type === "shutdown") {
		shuttingDown = true;
		queue = [];
		process.exit(0);
	}
});
lines.on("close", () => process.exit(0));
