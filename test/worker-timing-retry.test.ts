import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { MAX_ALIGNMENT_BYTES, MAX_ALIGNMENT_TEXT } from "../src/alignment-windows.mjs";

test("timing retry is read-only, bounded, silent and never calls the TTS factory", async t => {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "voice-retry-"));
	const previous = process.env.PI_VOICE_CACHE_DIR, previousAudio = process.env.PI_VOICE_AUDIO_CACHE_DIR;
	process.env.PI_VOICE_CACHE_DIR = root;
	process.env.PI_VOICE_AUDIO_CACHE_DIR = root;
	mock.module("@huggingface/transformers", { namedExports: { env: {}, RawAudio: class {}, Tensor: class {}, pipeline: () => assert.fail("No real inference") } });
	let factories = 0;
	mock.module("kokoro-js", { namedExports: { KokoroTTS: { from_pretrained: () => { factories++; throw new Error("Forbidden TTS"); } } } });
	let present = true, pcm = Buffer.alloc(24_000 * 4), hold = false, decodes = 0, alignments = 0, kills = 0, removals = 0;
	let player: object | null = null;
	mock.module("../src/playback-controller.mjs", { namedExports: { createPlaybackController: () => ({
		get currentPlayer() { return player; },
		setPlayerPaused: () => {}, resetPlayerPaused: () => {}, stopPlayer: async () => {},
		startPlayer: () => assert.fail("Retry must not start playback"),
	}) } });
	const paths: string[] = [];
	const access = fs.promises.access, rm = fs.promises.rm;
	mock.method(fs.promises, "access", async (file: string) => {
		if (!String(file).endsWith(".opus")) return access(file);
		paths.push(file); if (!present) throw new Error("MISS");
	});
	mock.method(fs.promises, "rm", async (file: string, options: any) => {
		if (String(file).endsWith(".opus")) { removals++; return; }
		return rm(file, options);
	});
	mock.module("node:child_process", { namedExports: {
		fork: () => assert.fail("No synthesis child"),
		spawn: (command: string, args: string[], options: any) => {
			const child = Object.assign(new EventEmitter(), {
				stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
				kill: () => { kills++; return true; },
			});
			options.signal?.addEventListener("abort", () => child.emit("error", new Error("Aborted")), { once: true });
			if (command === "ffmpeg") {
				decodes++;
				assert.ok(args.includes("f32le"));
				queueMicrotask(() => { child.stdout.write(pcm); child.emit("exit", 0); });
			} else {
				assert.equal(command, process.execPath);
				assert.match(args[0], /alignment-worker\.mjs$/);
				alignments++;
				child.stdin.once("data", chunk => {
					const operation = JSON.parse(String(chunk));
					assert.equal(operation.type, "align");
					assert.equal(operation.text, "Synthetic sentence.");
					assert.equal(operation.sampleRate, 24_000);
					assert.equal(Buffer.from(operation.audio, "base64").length, 96_000);
					if (!hold) queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "alignment", words: [
						{ text: "Synthetic", start: 0, end: 0.5, quality: "ctc-refined" },
						{ text: "sentence", start: 0.5, end: 1, quality: "estimated" },
					], quality: "mixed" }) + "\n"));
				});
			}
			return child;
		},
	} });
	const input = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: (options: any) => options.input === process.stdin ? input : createInterface(options) } });
	const events: any[] = [];
	const stdout = process.stdout.write.bind(process.stdout);
	mock.method(process.stdout, "write", (chunk: any, ...args: any[]) => {
		try { events.push(JSON.parse(String(chunk))); return true; } catch { return (stdout as any)(chunk, ...args); }
	});
	mock.method(process, "exit", (() => {}) as any);
	const send = (message: any) => input.emit("line", JSON.stringify(message));
	const tick = () => new Promise(resolve => setImmediate(resolve));
	t.after(async () => {
		send({ type: "shutdown" }); await tick(); mock.reset();
		if (previous === undefined) delete process.env.PI_VOICE_CACHE_DIR; else process.env.PI_VOICE_CACHE_DIR = previous;
		if (previousAudio === undefined) delete process.env.PI_VOICE_AUDIO_CACHE_DIR; else process.env.PI_VOICE_AUDIO_CACHE_DIR = previousAudio;
		await fs.promises.rm(root, { recursive: true, force: true });
	});
	await import(new URL("../src/worker.mjs", import.meta.url).href);
	let next = 0;
	const request = async (extra = {}) => {
		const requestId = String(++next);
		send({ type: "retry-timing", requestId, text: "Synthetic sentence.", model: "inert", dtype: "q8", voice: "test", speed: 1, audioCacheBitrate: 24, ...extra });
		for (let i = 0; i < 30 && !events.some(event => event.requestId === requestId); i++) await tick();
		return events.find(event => event.requestId === requestId);
	};
	for (const audioCache of [true, false]) {
		const hit = await request({ audioCache });
		assert.equal(hit.result.status, "timing"); assert.equal(hit.result.duration, 1);
		assert.equal(hit.result.quality, "mixed"); assert.equal(hit.result.words.length, 2);
	}
	assert.equal(paths[0], paths[1], "Cache key is unchanged by disabled normal caching");
	present = false;
	assert.deepEqual((await request({ audioCache: false })).result, { status: "cache-miss" });
	present = true;
	for (const invalid of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(MAX_ALIGNMENT_BYTES + 4), Buffer.from(new Float32Array([NaN]).buffer)]) {
		pcm = invalid;
		assert.deepEqual((await request()).result, { status: "cache-miss" });
	}
	const before = decodes;
	assert.equal((await request({ text: "x".repeat(MAX_ALIGNMENT_TEXT + 1) })).type, "timing-retry-error");
	assert.equal(decodes, before);
	pcm = Buffer.alloc(96_000); hold = true;
	await request();
	send({ type: "cancel-timing-retry", requestId: String(next) }); await tick();
	assert.equal(events.find(event => event.requestId === String(next))?.type, "timing-retry-error");
	player = {};
	assert.equal((await request()).type, "timing-retry-error", "Active playback takes priority");
	send({ type: "pause", paused: true }); hold = false;
	assert.equal((await request()).result.status, "timing", "Paused playback permits silent retry");
	hold = true; await request();
	send({ type: "pause", paused: false }); await tick();
	assert.equal(events.find(event => event.requestId === String(next))?.type, "timing-retry-error", "Resume cancels retry only");
	assert.notEqual(player, null);
	assert.equal(factories, 0); assert.equal(removals, 0); assert.equal(alignments, 5); assert.ok(kills >= 5);
	assert.ok(events.every(event => ["timing-retry", "timing-retry-error"].includes(event.type)), "No playback or foreground events");
});
