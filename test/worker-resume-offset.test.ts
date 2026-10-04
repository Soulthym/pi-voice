import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("real worker crops only matching existing PCM and retains canonical metadata", async t => {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "voice-offset-"));
	const environment = { ...process.env };
	process.env.PI_VOICE_CACHE_DIR = root;
	process.env.PI_VOICE_AUDIO_CACHE_DIR = root;
	process.env.PI_VOICE_PLAYER = process.execPath;
	process.env.PI_VOICE_TTS_WORKERS = "1";
	mock.module("@huggingface/transformers", { namedExports: { env: {}, RawAudio: class {}, Tensor: class {}, pipeline: () => assert.fail("No inference") } });
	mock.module("kokoro-js", { namedExports: { KokoroTTS: { from_pretrained: () => assert.fail("No model loading") } } });
	const input = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: () => input } });
	const send = (event: object) => input.emit("line", JSON.stringify(event));
	const pcm = Float32Array.from({ length: 24_000 }, (_, i) => i / 24_000);
	const bytes = Buffer.from(pcm.buffer);
	const text = "Synthetic sentence.";
	const key = createHash("sha256").update(JSON.stringify([2, "inert", "q8", "test", 1, 24, text])).digest("hex");
	const file = path.join(root, key.slice(0, 2), `${key}.opus`);
	const identity = `${key}:${createHash("sha256").update(bytes).digest("hex")}`;
	const cache = new Map([[file, bytes]]);
	const removals: string[] = [], decodes: string[] = [];
	const access = fs.promises.access;
	mock.method(fs.promises, "access", async (file: any, mode: any) => {
		if (!String(file).endsWith(".opus")) return access(file, mode);
		if (!cache.has(String(file))) throw Error("Cache miss");
	});
	const rm = fs.promises.rm;
	mock.method(fs.promises, "rm", async (file: any, options: any) => {
		if (!String(file).endsWith(".opus")) return rm(file, options);
		removals.push(String(file));
	});
	const played: Buffer[][] = [], aligned: any[] = [];
	let synthesis = 0;
	mock.module("node:child_process", { namedExports: {
		fork: () => {
			const child = Object.assign(new EventEmitter(), {
				send: ({ id }: any) => {
					synthesis++;
					// Even an identical fresh result cannot authorize cropping after a miss.
					queueMicrotask(() => child.emit("message", { id, audio: { pcm, sampleRate: 24_000, audioIdentity: identity, cacheHit: true } }));
				}, kill: () => {},
			});
			return child;
		},
		spawn: (command: string, args: string[]) => {
			const child = Object.assign(new EventEmitter(), {
				stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
				exitCode: null as number | null,
				kill: (signal: string) => { if (signal === "SIGKILL" || signal === "SIGTERM") { child.exitCode = 0; child.emit("exit", 0); } },
			});
			if (command === "ffmpeg") {
				assert.ok(args.includes("-i"));
				const file = args[args.indexOf("-i") + 1]!;
				decodes.push(file);
				const cached = cache.get(file)!;
				queueMicrotask(() => { child.stdout.write(cached); child.emit("exit", 0); });
			} else if (args[0]?.endsWith("alignment-worker.mjs")) {
				child.stdin.on("data", chunk => { const event = JSON.parse(String(chunk)); if (event.type === "align") aligned.push(event); });
			} else {
				assert.equal(command, process.execPath);
				assert.equal(args[0], "--raw");
				const chunks: Buffer[] = []; played.push(chunks);
				child.stdin.on("data", chunk => chunks.push(Buffer.from(chunk)));
				child.stdin.on("finish", () => { child.exitCode = 0; child.emit("exit", 0); });
				queueMicrotask(() => child.emit("spawn"));
			}
			return child;
		},
	} });
	const events: any[] = [];
	mock.method(process.stdout, "write", ((chunk: any) => { events.push(JSON.parse(String(chunk))); return true; }) as any);
	mock.method(process, "exit", (() => {}) as any);
	t.after(async () => {
		send({ type: "shutdown" }); await tick(); mock.reset();
		for (const key of ["PI_VOICE_CACHE_DIR", "PI_VOICE_AUDIO_CACHE_DIR", "PI_VOICE_PLAYER", "PI_VOICE_TTS_WORKERS"]) {
			if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
		}
		await fs.promises.rm(root, { recursive: true, force: true });
	});
	await import(new URL("../src/worker.mjs", import.meta.url).href);
	let utterance = 0;
	const run = async (resumeAudioOffset?: object, extra = {}, second = false) => {
		utterance++;
		const operation = { type: "segment", utterance, segmentId: utterance * 2, text, model: "inert", dtype: "q8", voice: "test", speed: 1, audioCache: true, audioCacheBitrate: 24, resumeAudioOffset, ...extra };
		send(operation);
		if (second) send({ ...operation, segmentId: utterance * 2 + 1 });
		send({ type: "end", utterance });
		for (let i = 0; i < 100 && !events.some(e => e.type === "idle" && e.utterance === utterance); i++) await tick();
		assert.ok(events.some(e => e.type === "idle" && e.utterance === utterance), JSON.stringify(events.slice(-5)));
		return { audio: events.filter(e => e.type === "segment-audio" && e.utterance === utterance),
			pcm: Buffer.concat(played.at(-1)!), playback: events.filter(e => e.type === "playback" && e.utterance === utterance) };
	};
	const ordinary = await run();
	assert.deepEqual(ordinary.pcm, bytes);
	assert.equal(ordinary.audio[0].audioIdentity, identity);
	const resumed = await run({ seconds: 0.25001, audioIdentity: identity }, {}, true);
	assert.deepEqual(resumed.pcm, Buffer.concat([bytes.subarray(6000 * 4), bytes]));
	assert.deepEqual(resumed.audio.map(e => [e.start, e.duration, e.resumeOffset, e.audioIdentity]), [[0, 1, 0.25, identity], [1, 1, 0, identity]]);
	assert.equal(resumed.playback.at(-1).position, 2, "physical cropped duration maps to canonical cumulative time");
	assert.equal(resumed.playback.at(-1).estimated, true, "local EOF is not confirmed device feedback");
	assert.ok(aligned.every(e => e.text === text && e.duration === 1 && e.sampleRate === 24_000 && Buffer.from(e.audio, "base64").equals(bytes)), "alignment always receives complete canonical PCM");
	assert.deepEqual(cache.get(file), bytes, "cache remains full");
	assert.deepEqual(removals, []);
	for (const seconds of [0, -1, 1, 2, NaN, Infinity, "0.25"]) {
		const result = await run({ seconds, audioIdentity: identity });
		assert.deepEqual(result.pcm, bytes, `fallback for ${seconds}`);
		assert.equal(result.audio[0].resumeOffset, 0);
	}
	for (const audioIdentity of [undefined, "wrong"]) assert.deepEqual((await run({ seconds: 0.25, audioIdentity })).pcm, bytes);
	const replaced = Buffer.from(new Float32Array(24_000).fill(0.5).buffer);
	cache.set(file, replaced);
	const replacement = await run({ seconds: 0.25, audioIdentity: identity });
	assert.deepEqual(replacement.pcm, replaced);
	assert.notEqual(replacement.audio[0].audioIdentity, identity);
	cache.delete(file);
	assert.deepEqual((await run({ seconds: 0.25, audioIdentity: identity })).pcm, bytes, "missing cache cannot trim freshly generated identical audio");
	cache.set(file, bytes);
	for (const extra of [{ model: "other" }, { voice: "other" }, { speed: 1.1 }, { audioCacheBitrate: 32 }, { audioCache: false }]) {
		assert.deepEqual((await run({ seconds: 0.25, audioIdentity: identity }, extra)).pcm, bytes, "changed provenance falls back");
	}
	assert.equal(synthesis, 6);
	assert.ok(decodes.length > 10);
	assert.ok(!events.some(e => e.type === "error"));
});
