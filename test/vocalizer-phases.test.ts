import assert from "node:assert/strict";
import test from "node:test";
import { CodeDescriptionCache } from "../src/code-description-cache.js";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { plainCodeNarration, type CodeNarrationPlan } from "../src/code-narration.js";
import { Vocalizer, type PlaybackPhase } from "../src/vocalizer.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const worker = {
	sendSegment() {}, endUtterance() {}, cancel() {}, setPlaybackPaused() {},
	async measureSegment() { return 1; }, async transcribe() { return []; },
	async transcribePcm() { return ""; }, async preload() {}, async preloadAlignment() {}, async terminate() {},
};

test("foreground phases follow lifecycle, pause intent, completion and cancellation, not background events", () => {
	const phases: PlaybackPhase[] = [];
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), () => {},
		undefined, undefined, worker, undefined, undefined, phase => phases.push(phase));
	assert.equal(vocalizer.playbackPhase, "idle");
	vocalizer.speak("First sentence.");
	assert.equal(vocalizer.playbackPhase, "queued");
	const phase = (utterance: number, phase: "loading" | "synthesizing" | "connecting" | "playing") =>
		vocalizer.handleWorkerEvent({ type: "playback-phase", utterance, segmentId: utterance, phase });
	phase(1, "loading"); phase(1, "synthesizing");
	vocalizer.setPlaybackPaused(true);
	phase(1, "connecting"); phase(1, "playing");
	assert.equal(vocalizer.playbackPhase, "paused");
	vocalizer.setPlaybackPaused(false);
	assert.equal(vocalizer.playbackPhase, "playing");
	vocalizer.handleWorkerEvent({ type: "loading" });
	vocalizer.handleWorkerEvent({ type: "ready" });
	vocalizer.handleWorkerEvent({ type: "measurement-progress", requestId: "background", phase: "synthesis" });
	vocalizer.handleWorkerEvent({ type: "error", requestId: "background", message: "timing failed" });
	assert.equal(vocalizer.playbackPhase, "playing");
	vocalizer.speak("Second sentence.");
	vocalizer.handleWorkerEvent({ type: "idle", utterance: 1 });
	assert.equal(vocalizer.playbackPhase, "queued");
	phase(2, "connecting"); phase(2, "playing");
	vocalizer.clear();
	phase(2, "loading"); phase(2, "playing");
	vocalizer.speak("Replacement.");
	vocalizer.handleWorkerEvent({ type: "idle", cancelId: 1 });
	vocalizer.handleWorkerEvent({ type: "error", utterance: 2, message: "late" });
	phase(2, "connecting");
	assert.equal(vocalizer.playbackPhase, "queued");
	phase(3, "playing");
	vocalizer.handleWorkerEvent({ type: "idle", utterance: 3 });
	assert.equal(vocalizer.playbackPhase, "idle");
	assert.deepEqual(phases, ["queued", "loading", "synthesizing", "paused", "playing", "queued", "connecting", "playing", "idle", "queued", "playing", "idle"]);
});

test("playback source and phase stay together across queued and audible utterances", () => {
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), () => {},
		undefined, undefined, worker);
	vocalizer.speak("Source A.");
	vocalizer.handleWorkerEvent({ type: "segment-audio", utterance: 1, segmentId: 1, start: 0, duration: 2 });
	vocalizer.handleWorkerEvent({ type: "playback", utterance: 1, position: 1 });
	vocalizer.speak("Source B.");
	vocalizer.handleWorkerEvent({ type: "playback-phase", utterance: 2, segmentId: 2, phase: "synthesizing" });
	assert.equal(vocalizer.playbackUtterance, 1);
	assert.equal(vocalizer.playbackPhase, "playing");
	vocalizer.handleWorkerEvent({ type: "playback", utterance: 1, position: 2 });
	assert.equal(vocalizer.playbackUtterance, 2);
	assert.equal(vocalizer.playbackPhase, "synthesizing");
	vocalizer.handleWorkerEvent({ type: "idle", utterance: 1 });
	vocalizer.speak("Source C.");
	// Playback evidence outranks older pending work even if its completion event is missing.
	vocalizer.handleWorkerEvent({ type: "segment-audio", utterance: 3, segmentId: 3, start: 0, duration: 2 });
	vocalizer.handleWorkerEvent({ type: "playback", utterance: 3, position: 1 });
	assert.equal(vocalizer.playbackUtterance, 3);
	assert.equal(vocalizer.playbackPhase, "playing");
	vocalizer.clear();
});

test("description phases are cancellation fenced and never override playing or paused intent", async () => {
	let description = Promise.withResolvers<CodeNarrationPlan>();
	const sent: number[] = [];
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), () => {},
		(_block, _context, _signal, activity) => { activity(true); return description.promise; },
		undefined, { ...worker, sendSegment(utterance: number) { sent.push(utterance); } });
	vocalizer.speak("```js\nconst x = 1;\n```");
	assert.equal(vocalizer.playbackPhase, "describing");
	vocalizer.setPlaybackPaused(true);
	description.resolve(plainCodeNarration("Defines x.")); await tick();
	assert.equal(vocalizer.playbackPhase, "paused");
	vocalizer.setPlaybackPaused(false);
	assert.equal(vocalizer.playbackPhase, "queued");
	vocalizer.handleWorkerEvent({ type: "playback-phase", utterance: 1, segmentId: 1, phase: "playing" });
	description = Promise.withResolvers<CodeNarrationPlan>();
	vocalizer.speak("```js\nconst y = 2;\n```");
	assert.equal(vocalizer.playbackPhase, "playing");
	vocalizer.handleWorkerEvent({ type: "idle", utterance: 1 });
	assert.equal(vocalizer.playbackPhase, "describing");
	vocalizer.clear();
	vocalizer.speak("Replacement.");
	description.resolve(plainCodeNarration("Stale description.")); await tick();
	assert.equal(vocalizer.playbackPhase, "queued");
	assert.deepEqual(sent, [1, 3]);
});


test("buffered playback wins over synthesis until consumed, then exposes real pending work", async () => {
	const description = Promise.withResolvers<CodeNarrationPlan>();
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), () => {},
		(_block, _context, _signal, activity) => { activity(true); return description.promise; }, undefined, worker);
	vocalizer.pushDelta("First sentence. ");
	vocalizer.handleWorkerEvent({ type: "playback-phase", utterance: 1, segmentId: 1, phase: "playing" });
	vocalizer.handleWorkerEvent({ type: "segment-audio", utterance: 1, segmentId: 1, start: 0, duration: 1 });
	vocalizer.pushDelta("Second sentence. ");
	vocalizer.handleWorkerEvent({ type: "playback-phase", utterance: 1, segmentId: 2, phase: "synthesizing" });
	assert.equal(vocalizer.playbackPhase, "playing");
	vocalizer.handleWorkerEvent({ type: "playback", utterance: 1, position: 1 });
	assert.equal(vocalizer.playbackPhase, "synthesizing");
	vocalizer.handleWorkerEvent({ type: "playback-phase", utterance: 1, segmentId: 2, phase: "playing" });
	vocalizer.handleWorkerEvent({ type: "segment-audio", utterance: 1, segmentId: 2, start: 1, duration: 1 });
	vocalizer.pushDelta("\n```js\nconst x = 1;\n```\n");
	assert.equal(vocalizer.playbackPhase, "playing");
	vocalizer.handleWorkerEvent({ type: "playback", utterance: 1, position: 2 });
	assert.equal(vocalizer.playbackPhase, "describing");
	description.resolve(plainCodeNarration("Defines x.")); await tick();
	assert.equal(vocalizer.playbackPhase, "queued");
	vocalizer.clear();
	vocalizer.handleWorkerEvent({ type: "segment-audio", utterance: 1, segmentId: 3, start: 2, duration: 1 });
	assert.equal(vocalizer.playbackPhase, "idle");
});


test("description dependency waits are queued; active coalesced work is describing and cache hits are free", async () => {
	const cache = new CodeDescriptionCache();
	const context = Promise.withResolvers<void>();
	const resource = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<CodeNarrationPlan>();
	let attempts = 0;
	let producerSignal: AbortSignal | undefined;
	const create = async (signal: AbortSignal, activity: (active: boolean) => void) => {
		producerSignal = signal;
		await resource.promise;
		signal.throwIfAborted();
		attempts++;
		activity(true);
		try { return await reply.promise; } finally { activity(false); }
	};
	const background = cache.getOrCreate("shared", create);
	const phases: PlaybackPhase[] = [];
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), () => {},
		async (_block, _context, signal, activity) => {
			await context.promise;
			return cache.getOrCreate("shared", create, undefined, undefined, signal, activity);
		}, undefined, worker, undefined, undefined, phase => phases.push(phase));
	const fence = "```js\nrun();\n```";
	vocalizer.speak(fence);
	assert.equal(vocalizer.playbackPhase, "queued", "next-fence context wait");
	context.resolve(); await tick();
	assert.equal(vocalizer.playbackPhase, "queued", "coordinator resource wait");
	resource.resolve(); await tick();
	assert.equal(vocalizer.playbackPhase, "describing");
	vocalizer.clear();
	assert.equal(producerSignal?.aborted, false, "background consumer keeps producer alive");
	vocalizer.speak(fence); await tick();
	assert.equal(vocalizer.playbackPhase, "describing", "joining already-active background producer");
	reply.resolve(plainCodeNarration("Runs the requested operation."));
	await background; await tick();
	assert.equal(vocalizer.playbackPhase, "queued");
	vocalizer.clear(); phases.length = 0;
	vocalizer.speak(fence); await tick();
	assert.equal(phases.includes("describing"), false);
	assert.equal(attempts, 1);
	vocalizer.clear();
});

test("last-consumer cancellation detaches activity and stale producers cannot affect replacements", async () => {
	const cache = new CodeDescriptionCache();
	const stale = Promise.withResolvers<CodeNarrationPlan>();
	let oldActivity!: (active: boolean) => void;
	let oldSignal!: AbortSignal;
	const controller = new AbortController();
	const events: boolean[] = [];
	const pending = cache.getOrCreate("key", (signal, activity) => {
		oldSignal = signal; oldActivity = activity; activity(true); return stale.promise;
	}, undefined, undefined, controller.signal, active => events.push(active));
	await tick();
	controller.abort();
	await assert.rejects(pending);
	assert.equal(oldSignal.aborted, true);
	const afterCancel = [...events];
	const replacement = plainCodeNarration("Keeps the replacement result.");
	await cache.getOrCreate("key", async () => replacement);
	oldActivity(true);
	stale.resolve(plainCodeNarration("Stale result must not be stored.")); await tick();
	assert.deepEqual(events, afterCancel);
	assert.equal(cache.get("key"), replacement);
});
