import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("host-local playhead continues through EOF drain and stops on actual exit or cancellation", { timeout: 5000 }, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-drain-"));
	const oldCache = process.env.PI_VOICE_CACHE_DIR, oldPlayer = process.env.PI_VOICE_PLAYER;
	process.env.PI_VOICE_CACHE_DIR = root; process.env.PI_VOICE_PLAYER = process.execPath;
	const lines = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: () => lines } });
	const hf = await import("@huggingface/transformers"); const oldEnv = { ...hf.env };
	mock.module("@huggingface/transformers", { namedExports: { ...hf, pipeline: () => { throw Error("No inference"); } } });
	mock.module("kokoro-js", { namedExports: { KokoroTTS: {} } });
	const players: any[] = [];
	mock.module("node:child_process", { namedExports: { ...(await import("node:child_process")),
		fork: () => {
			const child = Object.assign(new EventEmitter(), { send: ({ id }: any) => queueMicrotask(() =>
				child.emit("message", { id, audio: { pcm: new Float32Array(48000), sampleRate: 24000 } })), kill: () => {} });
			return child;
		},
		spawn: (_command: string, args: string[]) => {
			if (args[0] !== "--raw") throw Error("Optional alignment unavailable");
			const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(),
				exitCode: null as number | null, kill: (signal: string) => {
					if (signal === "SIGKILL") { child.exitCode = 137; child.emit("exit", null); }
				} });
			child.stdin.resume(); players.push(child); queueMicrotask(() => child.emit("spawn")); return child;
		},
	} });
	mock.method(process, "exit", (() => {}) as any);
	const events: any[] = [];
	const stdout = mock.method(process.stdout, "write", (chunk: any) => {
		try { events.push(JSON.parse(String(chunk))); } catch {} return true;
	});
	const send = (message: any) => lines.emit("line", JSON.stringify(message));
	t.after(async () => {
		send({ type: "shutdown" }); await wait(0);
		stdout.mock.restore(); mock.reset(); Object.assign(hf.env, oldEnv);
		if (oldCache === undefined) delete process.env.PI_VOICE_CACHE_DIR; else process.env.PI_VOICE_CACHE_DIR = oldCache;
		if (oldPlayer === undefined) delete process.env.PI_VOICE_PLAYER; else process.env.PI_VOICE_PLAYER = oldPlayer;
		await fs.rm(root, { recursive: true, force: true });
	});
	await import(new URL("../src/worker.mjs", import.meta.url).href);
	const segment = { type: "segment", utterance: 1, segmentId: 1, text: "Drain test.", voice: "af_heart", speed: 1 };
	send(segment); send({ type: "end", utterance: 1 });
	await wait(1100);
	assert.equal(players[0].stdin.writableEnded, true, "EOF has been submitted");
	assert.ok(events.some(e => e.type === "playback" && e.position > 0), "clock must continue while player drains");
	assert.ok(!events.some(e => e.type === "idle"));
	send({ type: "pause", paused: true }); await wait(150);
	const paused = events.filter(e => e.type === "playback").at(-1).position;
	await wait(150);
	assert.equal(events.filter(e => e.type === "playback").at(-1).position, paused);
	send({ type: "pause", paused: false });
	players[0].exitCode = 0; players[0].emit("exit", 0); await wait(0);
	assert.equal(events.filter(e => e.type === "playback").at(-1).position, 2);
	assert.equal(events.at(-1).type, "idle");
	const count = events.length; await wait(150); assert.equal(events.length, count);
	send({ ...segment, utterance: 2, segmentId: 2 }); await wait(150);
	send({ type: "cancel" }); await wait(0);
	const cancelled = events.length; await wait(150); assert.equal(events.length, cancelled);
});
