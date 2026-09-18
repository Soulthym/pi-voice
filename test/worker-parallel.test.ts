import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("real playback queue bounds lookahead, preserves order, fences cancellation and closes children", async t => {
	const hf = await import("@huggingface/transformers");
	mock.module("@huggingface/transformers", { namedExports: { ...hf, pipeline: () => { throw Error("Unexpected inference"); } } });
	const children: any[] = [];
	const requests: any[] = [];
	mock.module("node:child_process", { namedExports: { fork: () => {
		const child = Object.assign(new EventEmitter(), {
			killed: false,
			send: (packet: any) => requests.push({ child, ...packet }),
			kill: () => { child.killed = true; child.emit("exit", null, "SIGKILL"); },
		});
		children.push(child); return child;
	}, spawn: () => { throw Error("No real playback/alignment process allowed"); } } });
	const lines = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: () => lines } });
	let written = Promise.withResolvers<void>();
	let stopped = Promise.withResolvers<void>();
	const played: number[] = [];
	const sink = { ready: Promise.resolve(), stopped: false, samplesWritten: 0 };
	mock.module("../src/playback-controller.mjs", { namedExports: { createPlaybackController: () => ({
		startPlayer: () => sink,
		writeAudio: async (_sink: unknown, pcm: Float32Array) => { played.push(pcm[0]!); await written.promise; },
		resetPlayerPaused: () => {}, stopPlayer: () => { written.resolve(); return stopped.promise; },
	}) } });
	const events: any[] = [];
	const stdout = process.stdout.write.bind(process.stdout);
	mock.method(process.stdout, "write", (chunk: any, ...args: any[]) => {
		try { events.push(JSON.parse(String(chunk))); return true; }
		catch { return (stdout as any)(chunk, ...args); }
	});
	const exits: unknown[] = [];
	mock.method(process, "exit", (code?: unknown): never => { exits.push(code); return undefined as never; });
	const previous = process.env.PI_VOICE_TTS_WORKERS;
	process.env.PI_VOICE_TTS_WORKERS = "4";
	t.after(() => { mock.reset(); if (previous === undefined) delete process.env.PI_VOICE_TTS_WORKERS; else process.env.PI_VOICE_TTS_WORKERS = previous; });
	await import(new URL("../src/worker.mjs", import.meta.url).href);
	const enqueue = (id: number) => lines.emit("line", JSON.stringify({ type: "segment", utterance: 1, segmentId: id, text: `sentence ${id}` }));
	for (let id = 1; id <= 8; id++) enqueue(id);
	await tick();
	assert.equal(requests.length, 4);
	const complete = (request: any) => request.child.emit("message", { id: request.id,
		audio: { pcm: Float32Array.of(request.operation.segmentId), sampleRate: 24000 } });
	for (const request of requests.slice(1, 4)) complete(request);
	await tick();
	assert.equal(events.filter(event => event.type === "segment-audio").length, 0);
	assert.equal(requests.length, 4, "completed out-of-order PCM must not expand the lookahead window");
	complete(requests[0]);
	await tick();
	assert.deepEqual(played, [1]);
	assert.equal(requests.length, 4, "a paused/backpressured sink bounds completed PCM too");
	written.resolve();
	await tick();
	assert.deepEqual(played.slice(0, 4), [1, 2, 3, 4]);
	assert.ok(requests.length <= 8);
	lines.emit("line", JSON.stringify({ type: "cancel", cancelId: 1 }));
	enqueue(9);
	await tick();
	assert.ok(children.some(child => child.killed), "busy native inference must be interrupted");
	for (const request of requests.filter(request => request.operation.segmentId <= 8)) complete(request);
	await tick();
	assert.deepEqual(played, [1, 2, 3, 4], "stale completions must not start a replacement sink");
	stopped.resolve();
	await tick();
	const replacement = requests.find(request => request.operation.segmentId === 9);
	assert.ok(replacement);
	complete(replacement); await tick();
	assert.deepEqual(played, [1, 2, 3, 4, 9]);
	lines.emit("line", JSON.stringify({ type: "shutdown" }));
	await tick();
	assert.deepEqual(exits, [0]);
	assert.ok(children.every(child => child.killed));
});
