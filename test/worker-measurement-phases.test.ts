import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";

test("measurement reports cached decoding or synthesis, never runs word alignment", async t => {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "voice-measure-phase-"));
	const previous = process.env.PI_VOICE_CACHE_DIR;
	process.env.PI_VOICE_CACHE_DIR = root;
	const hf = await import("@huggingface/transformers"), oldEnv = { ...hf.env };
	mock.module("@huggingface/transformers", { namedExports: { ...hf, pipeline: () => assert.fail("No alignment/inference") } });
	let generated = 0, decoded = 0;
	mock.module("kokoro-js", { namedExports: { KokoroTTS: { from_pretrained: async () => ({}) } } });
	mock.module("../src/sentence-audio.mjs", { namedExports: { generateSentenceAudio: async () => {
		generated++; return { audio: new Float32Array(24_000), sampling_rate: 24_000 };
	} } });
	// Synthetic cache hit: no personal audio or real ffmpeg/model process is accessed.
	mock.method(fs.promises, "access", async () => {});
	mock.module("node:child_process", { namedExports: { fork: () => assert.fail("No synthesis/alignment child"), spawn: (command: string) => {
		assert.equal(command, "ffmpeg"); decoded++;
		const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
		queueMicrotask(() => { child.stdout.write(Buffer.alloc(24_000 * 4)); child.emit("exit", 0); });
		return child;
	} } });
	const input = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: () => input } });
	const events: any[] = [];
	const stdout = process.stdout.write.bind(process.stdout);
	mock.method(process.stdout, "write", (chunk: any, ...args: any[]) => {
		try { events.push(JSON.parse(String(chunk))); return true; } catch { return (stdout as any)(chunk, ...args); }
	});
	mock.method(process, "exit", (() => {}) as any);
	const send = (message: any) => input.emit("line", JSON.stringify(message));
	t.after(async () => {
		send({ type: "shutdown" }); await new Promise(resolve => setImmediate(resolve));
		mock.reset(); Object.assign(hf.env, oldEnv);
		if (previous === undefined) delete process.env.PI_VOICE_CACHE_DIR; else process.env.PI_VOICE_CACHE_DIR = previous;
		await fs.promises.rm(root, { recursive: true, force: true });
	});
	await import(new URL("../src/worker.mjs", import.meta.url).href);
	for (const audioCache of [true, false]) {
		const requestId = String(audioCache);
		send({ type: "measure", requestId, text: "Synthetic sentence.", model: "test/model", dtype: "q8", voice: "test", speed: 1, audioCache, audioCacheBitrate: 24 });
		for (let i = 0; i < 20 && !events.some(event => event.type === "measurement" && event.requestId === requestId); i++) {
			await new Promise(resolve => setImmediate(resolve));
		}
		assert.deepEqual(events.filter(event => event.requestId === requestId), [
			{ type: "measurement-progress", requestId, phase: audioCache ? "cache-decode" : "synthesis" },
			{ type: "measurement", requestId, duration: 1 },
		]);
	}
	assert.equal(decoded, 1);
	assert.equal(generated, 1);
});
