import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

const turn = () => new Promise(resolve => setImmediate(resolve));
test("real alignment worker bounds windows and pending work and fences cancellation", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-align-"));
	const oldCache = process.env.PI_VOICE_CACHE_DIR;
	process.env.PI_VOICE_CACHE_DIR = root;
	const lines = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: () => lines } });
	const hf = await import("@huggingface/transformers");
	const oldEnv = { ...hf.env };
	const lengths: number[] = [];
	let barrier: Promise<void> | undefined;
	let nextLogits: any;
	const model = Object.assign(async () => { await barrier; const logits = nextLogits; nextLogits = undefined;
		return logits ? { logits: [logits] } : {}; }, { config: { model_type: "wav2vec2", pad_token_id: 0 } });
	const vocab = ["_", "|", "A", "B", "C", "D", "E", "F"];
	const tokenizer = Object.assign((text: string) => ({ input_ids: { data: [...text].map(char => vocab.indexOf(char)) } }),
		{ decode: (ids: number[]) => ids.filter((id, i) => !i || id !== ids[i - 1]).filter(id => id !== 0)
			.map(id => vocab[id]).join("").replaceAll("|", " "), model: { vocab } });
	mock.module("@huggingface/transformers", { namedExports: { ...hf, pipeline: async () => ({ model, tokenizer,
		processor: Object.assign(async (audio: Float32Array) => { lengths.push(audio.length); return {}; },
			{ feature_extractor: { config: { sampling_rate: 8000 } } }) }) } });
	const events: any[] = [];
	const stdout = mock.method(process.stdout, "write", (chunk: any) => {
		try { events.push(JSON.parse(String(chunk))); } catch {} return true;
	});
	t.after(async () => {
		stdout.mock.restore(); mock.reset(); Object.assign(hf.env, oldEnv);
		if (oldCache === undefined) delete process.env.PI_VOICE_CACHE_DIR; else process.env.PI_VOICE_CACHE_DIR = oldCache;
		await fs.rm(root, { recursive: true, force: true });
	});
	await import(new URL("../src/alignment-worker.mjs", import.meta.url).href);
	const send = (message: any) => lines.emit("line", JSON.stringify(message));
	const audio = Buffer.alloc(65 * 8000 * 4).toString("base64");
	const job = { type: "align", epoch: 0, text: "one two three four", audio, sampleRate: 8000 };
	send({ ...job, segmentId: 1 });
	for (let i = 0; i < 20 && !events.some(e => e.type === "alignment"); i++) await turn();
	assert.deepEqual(lengths, [30 * 8000, 30 * 8000, 17 * 8000]);
	assert.equal(events.find(e => e.type === "alignment").quality, "estimated", "missing logits must never claim refinement");
	const held = Promise.withResolvers<void>(); barrier = held.promise;
	send({ ...job, segmentId: 2 }); await turn();
	for (let segmentId = 3; segmentId <= 20; segmentId++) send({ ...job, segmentId });
	held.resolve(); barrier = undefined;
	for (let i = 0; i < 30; i++) await turn();
	assert.deepEqual(events.filter(e => e.type === "alignment").map(e => e.segmentId), [1, 2, 20]);
	assert.equal(events.filter(e => e.type === "alignment-error").length, 17, "only newest pending unit retained");
	const cancelled = Promise.withResolvers<void>(); barrier = cancelled.promise;
	send({ ...job, segmentId: 21 }); await turn();
	send({ type: "cancel", epoch: 1 });
	cancelled.resolve(); barrier = undefined;
	send({ ...job, segmentId: 22 }); // old-epoch input cannot resurrect cancelled work
	for (let i = 0; i < 10; i++) await turn();
	assert.ok(!events.some(e => e.type === "alignment" && e.segmentId >= 21));
	assert.ok(lengths.every(length => length <= 30 * 8000));
	// Synthetic confident CTC emissions exercise recognition -> forced alignment ->
	// source merge, not just the helper. No real model or provider is invoked.
	const data = new Float32Array(300 * vocab.length).fill(-20);
	for (let frame = 0; frame < 300; frame++) data[frame * vocab.length] = 20;
	for (const [token, frame] of [[2, 10], [2, 20], [2, 30], [1, 40],
		[3, 120], [3, 130], [3, 140], [1, 150], [4, 220], [4, 230], [4, 240], [1, 250],
		[5, 280], [5, 285], [5, 290]]) {
		data[frame * vocab.length] = -20; data[frame * vocab.length + token] = 20;
	}
	nextLogits = { dims: [300, vocab.length], data };
	send({ ...job, epoch: 1, segmentId: 23, text: "AAA BBB CCC DDD EEE FFF" });
	for (let i = 0; i < 20 && !events.some(e => e.segmentId === 23); i++) await turn();
	const aligned = events.find(e => e.segmentId === 23);
	assert.equal(aligned.quality, "mixed");
	assert.equal(aligned.words[1].quality, "ctc-refined");
	assert.deepEqual(aligned.words.map((word: any) => word.text), ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]);
	assert.ok(aligned.words.every((word: any, i: number) => !i || word.start >= aligned.words[i - 1].end));
});
