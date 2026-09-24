import assert from "node:assert/strict";
import test from "node:test";
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

test("description phases are cancellation fenced and never override playing or paused intent", async () => {
	let description = Promise.withResolvers<CodeNarrationPlan>();
	const sent: number[] = [];
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), () => {},
		() => description.promise, undefined, { ...worker, sendSegment(utterance: number) { sent.push(utterance); } });
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
		() => description.promise, undefined, worker);
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
