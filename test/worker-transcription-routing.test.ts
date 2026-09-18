import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

test("the real worker PCM router forwards and validates candidate count", { timeout: 10_000 }, async t => {
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
	let response = Promise.withResolvers<{ candidates: string[] }>();
	const stdout = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
		try {
			const event = JSON.parse(String(chunk));
			if (event.type === "transcript") response.resolve(event);
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
});
