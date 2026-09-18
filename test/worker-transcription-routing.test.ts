import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

test("the real worker routes candidates and bounds full-sequence alignment",  { timeout: 10_000 }, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-worker-routing-"));
	const oldCache = process.env.PI_VOICE_CACHE_DIR;
	process.env.PI_VOICE_CACHE_DIR = root;
	const hf = await import("@huggingface/transformers");
	const oldEnv = { cacheDir: hf.env.cacheDir, allowRemoteModels: hf.env.allowRemoteModels };
	let calls = 0;
	const transcriber = Object.assign(async () => ({ text: `candidate ${++calls}` }), { model: { config: { model_type: "whisper" } } });
	mock.module("@huggingface/transformers", { namedExports: { ...hf, pipeline: async () => transcriber } });
	const lines = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: () => lines } });
	mock.module("kokoro-js", { namedExports: { KokoroTTS: { from_pretrained: async () => ({
		generate: async (text: string) => new hf.RawAudio(new Float32Array((text === "long" ? 31 : 30) * 24000), 24000),
	}) } } });
	let alignmentRequests = 0;
	let alignmentStops = 0;
	const stopped = Promise.withResolvers<void>();
	const exits: unknown[] = [];
	mock.method(process, "exit", (code?: unknown): never => { exits.push(code); return undefined as never; });
	mock.module("node:child_process", { namedExports: { ...(await import("node:child_process")),
		fork: () => {
			const child = Object.assign(new EventEmitter(), {
				send: ({ id, operation }: any) => queueMicrotask(() => child.emit("message", { id,
					audio: { pcm: new Float32Array((operation.text === "long" ? 31 : 30) * 24000), sampleRate: 24000 } })),
				kill: () => {},
			});
			return child;
		},
		spawn: () =>
		Object.assign(new EventEmitter(), {
			exitCode: null, kill: () => { alignmentStops++; },
			stdin: { write: () => { alignmentRequests++; return true; }, end: () => {} },
		}),
	} });
	mock.module("../src/playback-controller.mjs", { namedExports: { createPlaybackController: () => ({
		startPlayer: () => ({ ready: Promise.resolve(), stopped: false, samplesWritten: 0 }),
		writeAudio: async () => {},
		resetPlayerPaused: () => {},
		stopPlayer: () => stopped.promise,
	}) } });
	let response = Promise.withResolvers<{ candidates: string[] }>();
	let audioReady = Promise.withResolvers<void>();
	const stdout = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		try {
			const event = JSON.parse(String(chunk));
			if (event.type === "transcript") response.resolve(event);
			if (event.type === "segment-audio") audioReady.resolve();
			if (event.type === "error") response.reject(new Error(event.message));
		} catch { /* Non-protocol output is not part of this check. */ }
		return true;
	});
	t.after(async () => {
		stdout.mock.restore(); mock.reset(); Object.assign(hf.env, oldEnv);
		if (oldCache === undefined) delete process.env.PI_VOICE_CACHE_DIR; else process.env.PI_VOICE_CACHE_DIR = oldCache;
		await fs.rm(root, { recursive: true, force: true });
	});
	await import(new URL("../src/worker.mjs", import.meta.url).href);
	const message = { type: "transcribe-pcm", requestId: "live", audio: Buffer.alloc(4).toString("base64"), candidateCount: 3 };
	lines.emit("line", JSON.stringify(message));
	assert.equal((await response.promise).candidates.length, 3);
	assert.equal(calls, 3);
	response = Promise.withResolvers<{ candidates: string[] }>();
	lines.emit("line", JSON.stringify({ ...message, requestId: "invalid", candidateCount: 99 }));
	assert.equal((await response.promise).candidates.length, 1);
	assert.equal(calls, 4);
	const segment = { type: "segment", utterance: 1, segmentId: 1, voice: "af_heart", speed: 1, text: "long" };
	lines.emit("line", JSON.stringify(segment));
	await audioReady.promise;
	assert.equal(alignmentRequests, 0, "long sentences must not allocate unbounded full-sequence CTC attention");
	audioReady = Promise.withResolvers<void>();
	lines.emit("line", JSON.stringify({ ...segment, segmentId: 2, text: "short" }));
	await audioReady.promise;
	assert.equal(alignmentRequests, 1, "normal sentences retain actual forced alignment");
	lines.emit("line", JSON.stringify({ type: "shutdown" }));
	lines.emit("close");
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(exits, [], "worker exit must wait for player stop acknowledgement");
	stopped.resolve();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(exits, [0], "shutdown and stdin close must share one idempotent teardown");
	assert.equal(alignmentStops, 1);
});
