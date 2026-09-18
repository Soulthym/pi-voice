// Offline, synthetic TTS only: no playback, provider calls, or saved PCM.
// Run: node scripts/benchmark-sentences.mjs
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sentences = [
	"The next sentence should arrive before the current one finishes playing.",
	"We can improve throughput without making the beginning of the conversation feel slow.",
	"Keep the generated sentences in their original order.",
	"A short pause between paragraphs is natural, but an empty audio queue should not cause a long interruption.",
	"The benchmark uses synthetic text and never reads a conversation transcript.",
	"Compare repeated measurements rather than trusting a single fast result.",
	"Local inference should leave enough processing capacity for the interactive terminal and the microphone.",
	"Choose the fastest setting that stays within the latency limit.",
];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const children = [];

async function receive(child) {
	const [message] = await once(child, "message", { signal: AbortSignal.timeout(180_000) });
	if (message.error) throw new Error(message.error);
	return message;
}
async function request(child, text) {
	const result = receive(child);
	child.send({ text });
	return result;
}

async function main() {
	const config = JSON.parse(await readFile(process.env.PI_VOICE_CONFIG ?? path.join(os.homedir(), ".pi/agent/pi-voice.json"), "utf8"));
	const settings = { model: config.ttsModel, dtype: config.ttsDtype, voice: config.voice, speed: config.speed };
	console.log(JSON.stringify({ settings, rounds: 3, sentences: sentences.length, maxWorkers: 8, offline: true }));
	let baseline;
	let best;
	for (let concurrency = 1; concurrency <= 8; concurrency++) {
		const coldStart = performance.now();
		const child = fork(fileURLToPath(import.meta.url), ["--worker", JSON.stringify(settings)], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		children.push(child);
		await receive(child);
		await request(child, "Warm up this local speech model before measuring sentence inference.");
		const coldMs = performance.now() - coldStart;
		const rounds = [];
		for (let repeat = 0; repeat < 3; repeat++) {
			const start = performance.now();
			let next = 0;
			const finished = [];
			const durations = [];
			await Promise.all(children.map(async worker => {
				while (next < sentences.length) {
					const index = next++;
					const result = await request(worker, sentences[index]);
					finished[index] = performance.now() - start;
					durations[index] = result.duration;
				}
			}));
			let ready = 0;
			const ordered = finished.map(time => (ready = Math.max(ready, time)));
			rounds.push({ ordered, throughput: durations.reduce((sum, value) => sum + value, 0) / ((performance.now() - start) / 1000) });
		}
		const ordered = sentences.map((_, index) => median(rounds.map(round => round.ordered[index])));
		baseline ??= ordered;
		const result = { concurrency, throughput: median(rounds.map(round => round.throughput)),
			firstAudioMs: ordered[0], maxOrderedLatencyRatio: Math.max(...ordered.map((time, i) => time / baseline[i])), coldWorkerMs: coldMs };
		console.log(JSON.stringify(result));
		if (result.maxOrderedLatencyRatio > 2 || (best && result.throughput <= best.throughput)) break;
		best = result;
	}
	console.log(JSON.stringify({ selected: best, latencyDefinition: "maximum median ordered-prefix readiness versus sequential; includes first audio" }));
}

if (process.argv[2] === "--worker") {
	try {
		const settings = JSON.parse(process.argv[3]);
		const { env } = await import("@huggingface/transformers");
		env.cacheDir = process.env.PI_VOICE_CACHE_DIR ?? path.join(os.homedir(), ".cache/pi-voice/models");
		env.allowRemoteModels = false;
		env.allowLocalModels = true;
		env.useBrowserCache = false;
		env.logLevel = "error";
		if (env.backends?.onnx) env.backends.onnx.logLevel = "error";
		const { KokoroTTS } = await import("kokoro-js");
		const { generateSentenceAudio } = await import("../src/sentence-audio.mjs");
		const model = await KokoroTTS.from_pretrained(settings.model, { dtype: settings.dtype, device: "cpu" });
		process.on("message", async ({ text }) => {
			try {
				const audio = await generateSentenceAudio(model, text, { voice: settings.voice, speed: settings.speed });
				process.send({ duration: audio.audio.length / audio.sampling_rate });
			} catch (error) { process.send({ error: String(error) }); }
		});
		process.send({ ready: true });
	} catch (error) { process.send({ error: String(error) }, () => process.exit(1)); }
} else {
	for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
		for (const child of children) child.kill("SIGKILL");
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
	try { await main(); }
	finally { for (const child of children) child.kill("SIGKILL"); }
}
