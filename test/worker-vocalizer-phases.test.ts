import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { plainCodeNarration, type CodeNarrationPlan } from "../src/code-narration.js";
import { Vocalizer } from "../src/vocalizer.js";
import type { WorkerEvent } from "../src/worker-client.js";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("real worker protocol distinguishes caught-up streams, queued segments and whole-queue failure/cancel", async t => {
	const hf = await import("@huggingface/transformers");
	const oldEnv = { ...hf.env };
	mock.module("@huggingface/transformers", { namedExports: { ...hf, pipeline: () => assert.fail("No inference") } });
	mock.module("node:child_process", { namedExports: {
		spawn: () => { throw Error("No hardware/alignment process"); },
		fork: () => assert.fail("No inference process"),
	} });
	const jobs: any[] = [];
	mock.module("../src/sentence-pool.mjs", { namedExports: { SentencePool: class {
		generate(operation: any, report: any) {
			const result = Promise.withResolvers<any>();
			jobs.push({ ...result, operation, report });
			return result.promise;
		}
		cancel() { for (const job of jobs) job.reject(Error("Cancelled")); }
		close() {}
		resize() {}
	} } });
	const input = new EventEmitter();
	mock.module("node:readline", { namedExports: { createInterface: () => input } });
	const send = (message: object) => input.emit("line", JSON.stringify(message));
	let stop = Promise.withResolvers<void>();
	let emit!: (event: WorkerEvent) => void;
	let sink: any;
	mock.module("../src/playback-controller.mjs", { namedExports: { createPlaybackController: (options: any) => {
		emit = options.send;
		return {
			get currentPlayer() { return sink; },
			startPlayer(_rate: number, utterance: number) {
				return sink ??= { ready: Promise.resolve(), stopped: false, samplesWritten: 0, utterance };
			},
			async writeAudio(current: any, pcm: Float32Array) { current.samplesWritten += pcm.length; },
			async closePlayer(utterance: number) { sink = undefined; emit({ type: "idle", utterance }); return true; },
			resetPlayerPaused() {},
			async stopPlayer() { await stop.promise; sink = undefined; },
		};
	} } });
	const events: WorkerEvent[] = [];
	const stdout = process.stdout.write.bind(process.stdout);
	let vocalizer: Vocalizer;
	mock.method(process.stdout, "write", (chunk: any, ...args: any[]) => {
		let event: WorkerEvent;
		try { event = JSON.parse(String(chunk)); } catch { return (stdout as any)(chunk, ...args); }
		events.push(event);
		vocalizer?.handleWorkerEvent(event);
		return true;
	});
	mock.method(process, "exit", (() => {}) as any);
	const description = Promise.withResolvers<CodeNarrationPlan>();
	vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), () => {},
		() => description.promise, undefined, {
			sendSegment: (utterance, segmentId, text) => { send({ type: "segment", utterance, segmentId, text }); },
			endUtterance: utterance => { send({ type: "end", utterance }); },
			cancel: () => { send({ type: "cancel", cancelId: 1 }); },
			async measureSegment() { return 1; }, async transcribe() { return []; },
			async transcribePcm() { return ""; }, async preload() {}, async preloadAlignment() {}, async terminate() {},
		});
	t.after(async () => {
		vocalizer.clear(); stop.resolve(); send({ type: "shutdown" }); await tick();
		mock.reset(); Object.assign(hf.env, oldEnv);
	});
	await import(new URL("../src/worker.mjs", import.meta.url).href);
	send({ type: "tts-workers", workers: 3 });
	const complete = async (job: any) => { job.resolve({ pcm: new Float32Array(24_000), sampleRate: 24_000 }); await tick(); };
	const position = (utterance: number, value: number) => emit({ type: "playback", utterance, position: value });

	vocalizer.pushDelta("First sentence. Second sentence. "); await tick();
	await complete(jobs[0]);
	assert.equal(vocalizer.playbackPhase, "playing");
	position(1, 1);
	assert.equal(vocalizer.playbackPhase, "queued", "later submitted segment must not look caught up");
	jobs[1].report({ type: "synthesis-phase", phase: "synthesizing" });
	assert.equal(vocalizer.playbackPhase, "synthesizing");
	await complete(jobs[1]); position(1, 2);
	assert.equal(vocalizer.playbackPhase, "idle", "all submitted audio consumed, even before stream closes");
	assert.ok(!events.some(event => event.type === "idle" && event.utterance === 1));
	vocalizer.pushDelta("Third sentence. "); await tick();
	assert.equal(vocalizer.playbackPhase, "queued");
	await complete(jobs[2]);
	assert.equal(vocalizer.playbackPhase, "playing");
	position(1, 3); vocalizer.flush(); await tick();

	vocalizer.speak("Fails first."); vocalizer.speak("Cancelled second.");
	vocalizer.speak("```js\nconst x = 1;\n```"); await tick();
	const failing = jobs[3];
	failing.reject(Error("Synthetic terminal failure")); await tick();
	assert.equal(vocalizer.playbackPhase, "idle", "terminal worker failure clears every queued utterance");
	description.resolve(plainCodeNarration("Cancelled description.")); await tick();
	vocalizer.speak("Replacement."); await tick();
	assert.equal(vocalizer.playbackPhase, "queued");
	emit({ type: "error", utterance: failing.operation.utterance, message: "Stale failure" });
	emit({ type: "idle", utterance: 3 });
	assert.equal(vocalizer.playbackPhase, "queued");
	stop.resolve(); await tick();
	assert.ok(events.some(event => event.type === "idle" && event.utterance === undefined && event.cancelId === undefined));
	assert.equal(vocalizer.playbackPhase, "queued", "unscoped cancellation idle cannot clear replacement");
	assert.deepEqual(jobs.map(job => job.operation.text), ["First sentence.", "Second sentence.", "Third sentence.", "Fails first.", "Cancelled second.", "Replacement."]);
	await complete(jobs.at(-1));
	assert.equal(vocalizer.playbackPhase, "idle", "closed replacement completed rather than masked by cancelled queue");

	stop = Promise.withResolvers<void>();
	vocalizer.pushDelta("Cancel active stream. "); await tick();
	const cancelled = jobs.at(-1);
	vocalizer.clear(); vocalizer.pushDelta("New live stream. "); await tick();
	cancelled.report({ type: "synthesis-phase", phase: "playing" });
	assert.equal(vocalizer.playbackPhase, "queued");
	stop.resolve(); await tick(); await complete(jobs.at(-1));
	assert.equal(vocalizer.playbackPhase, "playing");
	assert.ok(events.some(event => event.type === "idle" && event.cancelId === 1));
});
