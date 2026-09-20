import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("preload warms asynchronously, reports aggregate results and fences cancellation/teardown", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tts-preload-"));
	const previous = { cache: process.env.PI_VOICE_CACHE_DIR, workers: process.env.PI_VOICE_TTS_WORKERS };
	process.env.PI_VOICE_CACHE_DIR = root;
	process.env.PI_VOICE_TTS_WORKERS = "3";
	mock.module("@huggingface/transformers", { namedExports: {
		env: {}, RawAudio: class {}, Tensor: class {}, pipeline: () => { throw Error("No inference allowed"); },
	} });
	mock.module("kokoro-js", { namedExports: { KokoroTTS: {} } });
	const children: any[] = [], requests: any[] = [], events: any[] = [];
	mock.module("node:child_process", { namedExports: {
		fork: () => {
			const child = Object.assign(new EventEmitter(), {
				killed: false,
				send: (packet: any) => requests.push({ child, ...packet }),
				kill: () => { child.killed = true; child.emit("exit", null, "SIGKILL"); },
			});
			children.push(child); return child;
		},
		spawn: () => { throw Error("No real playback/alignment allowed"); },
	} });
	const lines = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: () => lines } });
	const played: number[] = [];
	const sink = { ready: Promise.resolve(), stopped: false, samplesWritten: 0 };
	mock.module("../src/playback-controller.mjs", { namedExports: { createPlaybackController: () => ({
		startPlayer: () => sink,
		writeAudio: async (_sink: unknown, pcm: Float32Array) => { played.push(pcm[0]!); },
		resetPlayerPaused: () => {}, stopPlayer: async () => {},
	}) } });
	const stdout = process.stdout.write.bind(process.stdout);
	mock.method(process.stdout, "write", (chunk: any, ...args: any[]) => {
		try { events.push(JSON.parse(String(chunk))); return true; }
		catch { return (stdout as any)(chunk, ...args); }
	});
	const exits: unknown[] = [];
	mock.method(process, "exit", (code?: unknown): never => { exits.push(code); return undefined as never; });
	const send = (message: any) => lines.emit("line", JSON.stringify(message));
	t.after(async () => {
		send({ type: "shutdown" }); await tick(); mock.reset();
		for (const [key, value] of [["PI_VOICE_CACHE_DIR", previous.cache], ["PI_VOICE_TTS_WORKERS", previous.workers]]) {
			if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	await import(new URL("../src/worker.mjs", import.meta.url).href);
	const results = (id: string) => events.filter(event => event.requestId === id);
	const preload = async (requestId: string) => {
		const start = requests.length;
		send({ type: "preload", requestId }); await tick();
		return requests.slice(start);
	};
	const segment = (segmentId: number) => send({ type: "segment", utterance: 1, segmentId, text: `sentence ${segmentId}` });
	const complete = (request: any, error?: string) => request.child.emit("message", {
		id: request.id, error,
		audio: request.operation.type === "preload" ? undefined : { pcm: Float32Array.of(request.operation.segmentId), sampleRate: 24000 },
	});

	const warming = await preload("warm");
	assert.equal(warming.length, 3);
	segment(1); segment(2); segment(3); await tick();
	complete(warming[0]); await tick();
	const first = requests.find(request => request.operation.segmentId === 1);
	assert.ok(first, "one ready worker must synthesize while two still warm");
	complete(first); await tick();
	assert.deepEqual(played, [1], "first playback must not await aggregate preload readiness");
	assert.deepEqual(results("warm"), []);
	complete(warming[1]); complete(warming[2]); await tick();
	assert.deepEqual(results("warm"), [{ type: "ready", requestId: "warm" }]);
	// Resizing while warm/playback jobs overlap retains the pool's ordered results.
	send({ type: "tts-workers", workers: 1 });
	const second = requests.find(request => request.operation.segmentId === 2);
	const third = requests.find(request => request.operation.segmentId === 3);
	assert.ok(second && third);
	complete(third); await tick();
	assert.deepEqual(played, [1]);
	complete(second); await tick();
	assert.deepEqual(played, [1, 2, 3]);
	assert.equal(children.filter(child => !child.killed).length, 1);
	send({ type: "tts-workers", workers: 3 });

	const failed = await preload("failed");
	complete(failed[0], "warm failed"); await tick();
	assert.equal(results("failed")[0]?.type, "error");
	assert.match(results("failed")[0].message, /warm failed/);
	complete(failed[1]); complete(failed[2]); await tick();
	assert.equal(results("failed").length, 1);

	const cancelled = await preload("cancelled");
	send({ type: "cancel", cancelId: 1 }); await tick();
	cancelled.forEach(request => complete(request)); await tick();
	assert.equal(results("cancelled").length, 1);
	assert.equal(results("cancelled")[0]?.type, "error");
	assert.match(results("cancelled")[0].message, /cancelled/);

	// All pool promises may resolve before their aggregate continuation runs.
	const raced = await preload("raced");
	raced.forEach(request => complete(request));
	send({ type: "cancel", cancelId: 2 }); await tick();
	assert.equal(results("raced").length, 1);
	assert.equal(results("raced")[0]?.type, "error", "old epoch cannot announce ready");

	const closing = await preload("closing");
	send({ type: "shutdown" }); await tick();
	closing.forEach(request => complete(request)); await tick();
	assert.equal(results("closing").length, 1);
	assert.equal(results("closing")[0]?.type, "error");
	assert.ok(children.every(child => child.killed));
	assert.deepEqual(exits, [0]);
});
