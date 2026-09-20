import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { PassThrough } from "node:stream";
import * as readline from "node:readline";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";

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
	const transport = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
		exitCode: null as number | null, signalCode: null, kill: () => {},
	});
	mock.module("node:child_process", { namedExports: {
		fork: () => {
			const child = Object.assign(new EventEmitter(), {
				killed: false,
				send: (packet: any) => requests.push({ child, ...packet }),
				kill: () => { child.killed = true; child.emit("exit", null, "SIGKILL"); },
			});
			children.push(child); return child;
		},
		spawn: (_command: string, args: string[]) => {
			if (args[0]?.endsWith("/worker.mjs")) return transport;
			throw Error("No real playback/alignment allowed");
		},
	} });
	const lines = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: (options: any) => options.input === process.stdin ? lines : readline.createInterface(options) } });
	transport.stdin.on("data", bytes => lines.emit("line", String(bytes).trim()));
	const played: number[] = [];
	const sink = { ready: Promise.resolve(), stopped: false, samplesWritten: 0 };
	mock.module("../src/playback-controller.mjs", { namedExports: { createPlaybackController: ({ send }: any) => ({
		startPlayer: () => { send({ type: "speaking" }); return sink; },
		writeAudio: async (_sink: unknown, pcm: Float32Array) => { played.push(pcm[0]!); },
		resetPlayerPaused: () => {}, setPlayerPaused: () => {}, stopPlayer: async () => {},
	}) } });
	const stdout = process.stdout.write.bind(process.stdout);
	mock.method(process.stdout, "write", (chunk: any, ...args: any[]) => {
		try { events.push(JSON.parse(String(chunk))); transport.stdout.write(chunk); return true; }
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

	const { VoiceWorkerClient } = await import("../src/worker-client.js");
	let state = "idle";
	let paused = false;
	const ui = () => paused && state === "speaking" ? "paused" : state;
	const clientEvents: string[] = [];
	const client = new VoiceWorkerClient(event => {
		clientEvents.push(event.type);
		if (event.type === "ready") state = "idle";
		if (event.type === "speaking") state = "speaking";
	});
	let completed = false;
	const warm = client.preload({ ...DEFAULT_VOICE_CONFIG, ttsWorkers: 3 }).then(() => { completed = true; });
	await tick();
	const warming = requests.slice();
	assert.equal(warming.length, 3);
	segment(1); segment(2); segment(3); await tick();
	complete(warming[0]); await tick();
	const first = requests.find(request => request.operation.segmentId === 1);
	assert.ok(first, "one ready worker must synthesize while two still warm");
	complete(first); await tick();
	assert.deepEqual(played, [1], "first playback must not await aggregate preload readiness");
	assert.equal(ui(), "speaking");
	assert.equal(completed, false);
	complete(warming[1]); await tick();
	assert.equal(ui(), "speaking", "second warm slot cannot reset playing UI");
	paused = true;
	complete(warming[2]); await warm;
	assert.equal(ui(), "paused", "aggregate warm completion cannot reset paused UI");
	assert.deepEqual(results("1"), [{ type: "preload-ready", requestId: "1" }]);
	assert.ok(!clientEvents.includes("preload-ready"), "request completion stays out of playback UI");
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

	const failedStart = requests.length;
	const failedRequest = client.preload({ ...DEFAULT_VOICE_CONFIG, ttsWorkers: 3 });
	const rejected = assert.rejects(failedRequest, /warm failed/);
	await tick();
	const failed = requests.slice(failedStart);
	complete(failed[0], "warm failed"); await rejected;
	assert.equal(results("2")[0]?.type, "error");
	assert.match(results("2")[0].message, /warm failed/);
	complete(failed[1]); complete(failed[2]); await tick();
	assert.equal(results("2").length, 1);

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
	// Ordinary cold-model readiness still reaches the UI unchanged.
	transport.stdout.write('{"type":"ready"}\n');
	assert.equal(state, "idle");
	transport.exitCode = 0;
	transport.emit("close", 0);
	await client.terminate();
});
