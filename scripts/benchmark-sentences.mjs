// Offline production-pool benchmark: synthetic text, no playback/cache/provider calls or saved PCM.
// Run: node scripts/benchmark-sentences.mjs
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SentencePool } from "../src/sentence-pool.mjs";

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
process.env.HF_HUB_OFFLINE = "1";
const pool = new SentencePool(1);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
	pool.close(); process.exit(signal === "SIGINT" ? 130 : 143);
});

try {
	const config = JSON.parse(await readFile(process.env.PI_VOICE_CONFIG ?? path.join(os.homedir(), ".pi/agent/pi-voice.json"), "utf8"));
	const settings = { type: "segment", model: config.ttsModel, dtype: config.ttsDtype, voice: config.voice, speed: config.speed, audioCache: false };
	console.log(JSON.stringify({ settings, rounds: 3, sentences: sentences.length, maxWorkers: 8, offline: true, productionPool: true }));
	let baseline;
	let best;
	for (let concurrency = 1; concurrency <= 8; concurrency++) {
		pool.size = concurrency;
		const coldStart = performance.now();
		await Promise.all(Array.from({ length: concurrency }, () => pool.generate({ ...settings, text: "Warm up this local speech model before measuring sentence inference." })));
		const warmPoolMs = performance.now() - coldStart;
		const rounds = [];
		for (let repeat = 0; repeat < 3; repeat++) {
			const start = performance.now();
			const finished = [];
			const durations = [];
			await Promise.all(sentences.map(async (text, index) => {
				const audio = await pool.generate({ ...settings, text });
				if (!(audio.pcm instanceof Float32Array) || !audio.pcm.length || !(audio.sampleRate > 0)) throw Error("Invalid generated audio");
				finished[index] = performance.now() - start;
				durations[index] = audio.pcm.length / audio.sampleRate;
			}));
			let ready = 0;
			const ordered = finished.map(time => (ready = Math.max(ready, time)));
			rounds.push({ ordered, throughput: durations.reduce((sum, value) => sum + value, 0) / ((performance.now() - start) / 1000) });
		}
		const ordered = sentences.map((_, index) => median(rounds.map(round => round.ordered[index])));
		baseline ??= ordered;
		const result = { concurrency, throughput: median(rounds.map(round => round.throughput)),
			firstAudioMs: ordered[0], maxOrderedLatencyRatio: Math.max(...ordered.map((time, i) => time / baseline[i])), warmPoolMs };
		console.log(JSON.stringify(result));
		if (result.maxOrderedLatencyRatio > 2 || (best && result.throughput <= best.throughput)) break;
		best = result;
	}
	console.log(JSON.stringify({ selected: best, latencyDefinition: "maximum median ordered-prefix readiness versus sequential; includes first audio" }));
} finally { pool.close(); }
