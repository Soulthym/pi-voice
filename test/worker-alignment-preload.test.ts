import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

const turn = () => new Promise(resolve => setImmediate(resolve));
test("alignment preloads settle on cancellation, exit, errors and shutdown", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-preload-"));
	const oldCache = process.env.PI_VOICE_CACHE_DIR;
	process.env.PI_VOICE_CACHE_DIR = root;
	const lines = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: () => lines } });
	const hf = await import("@huggingface/transformers"), oldEnv = { ...hf.env };
	mock.module("@huggingface/transformers", { namedExports: { ...hf, pipeline: () => { throw Error("No inference"); } } });
	mock.module("kokoro-js", { namedExports: { KokoroTTS: {} } });
	const children: any[] = [];
	mock.module("node:child_process", { namedExports: { ...(await import("node:child_process")),
		spawn: (_command: string, _args: string[], options: any) => {
			assert.deepEqual(options.stdio, ["pipe", "inherit", "ignore", "ipc"]);
			const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), exitCode: null,
				kill: mock.fn(() => true), inputs: [] as any[] });
			child.stdin.on("data", chunk => child.inputs.push(JSON.parse(String(chunk))));
			children.push(child); return child;
		},
	} });
	mock.method(process, "exit", (() => {}) as any);
	const events: any[] = [];
	const stdout = mock.method(process.stdout, "write", (chunk: any) => {
		try { events.push(JSON.parse(String(chunk))); } catch {} return true;
	});
	const send = (message: any) => lines.emit("line", JSON.stringify(message));
	const preload = (requestId: string) => send({ type: "preload-alignment", requestId });
	const results = (requestId: string) => events.filter(e => e.requestId === requestId);
	t.after(async () => {
		send({ type: "shutdown" }); await turn();
		stdout.mock.restore(); mock.reset(); Object.assign(hf.env, oldEnv);
		if (oldCache === undefined) delete process.env.PI_VOICE_CACHE_DIR; else process.env.PI_VOICE_CACHE_DIR = oldCache;
		await fs.rm(root, { recursive: true, force: true });
	});
	await import(new URL("../src/worker.mjs", import.meta.url).href);
	preload("cancel-1"); preload("cancel-2");
	assert.equal(children[0].inputs[0].epoch, 0);
	send({ type: "cancel", cancelId: 42 });
	for (const id of ["cancel-1", "cancel-2"]) assert.equal(results(id)[0]?.type, "alignment-preload-error");
	assert.equal(children[0].kill.mock.calls[0].arguments[0], "SIGTERM");
	await turn();
	assert.ok(events.some(e => e.type === "idle" && e.cancelId === 42));
	preload("ready");
	assert.equal(children[1].inputs[0].epoch, 1);
	children[0].emit("message", { type: "alignment-ready", requestId: "cancel-1" });
	children[0].emit("exit", 0);
	assert.equal(results("cancel-1").length, 1);
	assert.equal(results("ready").length, 0, "old child exit must not reject new requests");
	children[1].emit("message", { type: "alignment-ready", requestId: "ready" });
	preload("failed");
	children[1].emit("message", { type: "alignment-preload-error", requestId: "failed", message: "model failed" });
	preload("exit"); children[1].emit("exit", 1);
	assert.equal(results("exit")[0]?.type, "alignment-preload-error");
	assert.equal(results("ready").length, 1);
	assert.equal(results("failed").length, 1);
	for (const target of ["child", "stdin"]) {
		preload(target);
		const child = children.at(-1);
		(target === "stdin" ? child.stdin : child).emit("error", Error("broken"));
		assert.equal(results(target)[0]?.type, "alignment-preload-error");
	}
	preload("shutdown"); send({ type: "shutdown" }); await turn();
	assert.equal(results("shutdown")[0]?.type, "alignment-preload-error");
	assert.equal(results("shutdown").length, 1);
});
