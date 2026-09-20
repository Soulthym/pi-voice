import assert from "node:assert/strict";
import test from "node:test";
import { NarrationProgress } from "../src/narration-progress.js";
import { PlaybackHistory } from "../src/playback-history.js";
import { playbackTimingStatus } from "../src/status-text.js";

test("quality follows mapped words, including estimates for unmatched words and legacy events", () => {
	const narration = new NarrationProgress();
	narration.setCompletedText("Alpha beta gamma.");
	narration.registerSegment({ id: 1, utterance: 1, text: "Alpha beta gamma.", source: { start: 0, end: 17 } });
	narration.setSegmentAudio(1, 0, 6);
	assert.equal(narration.timingQuality(1), "estimated");
	narration.setAlignment(1, [
		{ text: "Alpha", start: 0, end: 1, quality: "ctc-refined" },
		{ text: "beta", start: 2, end: 3, quality: "estimated" },
		{ text: "gamma", start: 4, end: 5, quality: "ctc-refined" },
	], "mixed");
	assert.equal(narration.timingQuality(1), "mixed");
	assert.deepEqual(narration.sourceWordTimings(1).map(word => word.quality), ["ctc-refined", "estimated", "ctc-refined"]);
	narration.setAlignment(1, [{ text: "Alpha", start: 0, end: 1 }]);
	assert.equal(narration.timingQuality(1), "mixed", "unmatched interpolated words remain estimated");
	narration.setAlignment(1, ["Alpha", "beta", "gamma"].map((text, index) => ({ text, start: index, end: index + 1 })));
	assert.equal(narration.timingQuality(1), "ctc-refined", "old workers emitted CTC-only alignment events");
	narration.setAlignment(1, [{ text: "unmatched", start: 0, end: 1 }], "estimated");
	assert.equal(narration.timingQuality(1), "ctc-refined", "rejected alignment must not relabel retained timestamps");
});

test("quality survives snapshots, unit recovery and version switches without selecting or moving playback", () => {
	const history = new PlaybackHistory();
	const message = { id: "message", text: "Alpha beta.", renderKey: "A" };
	history.sync([message]);
	history.beginCapture(message.id, message.text);
	history.registerSegment({ id: 1, utterance: 1, text: message.text, source: { start: 0, end: message.text.length } });
	history.setSegmentAudio(1, 0, 4);
	history.setWordTimings(1, [{ time: 2, sourceOffset: 6, quality: "ctc-refined" }]);
	history.setPlayback(1, 1);
	history.setTimingQuality(1, "mixed");
	assert.equal(history.status()?.position, 1);
	assert.equal(history.status()?.timingQuality, "mixed");
	assert.equal(history.timingForUnit(message.id, "A", { sourceOffset: 0, skipUnits: 0 })?.[0].quality, "mixed");
	history.finishTimingGeneration(1);
	const snapshot = history.snapshotForUtterance(1)!;
	assert.equal(snapshot.checkpoints[1].quality, "ctc-refined");
	const restored = new PlaybackHistory();
	restored.sync([message]);
	restored.restore([JSON.parse(JSON.stringify(snapshot))]);
	assert.equal(restored.status()?.timingQuality, "mixed");
	history.sync([{ ...message, renderKey: "B" }]);
	history.setTimingQuality(1, "ctc-refined");
	assert.equal(history.status()?.timingQuality, undefined, "obsolete capture cannot relabel new assets");
	history.sync([message]);
	assert.equal(history.status()?.timingQuality, "mixed");
	const legacy = { ...snapshot, checkpoints: snapshot.checkpoints.map(({ quality, ...point }) => point) };
	restored.restore([legacy]);
	assert.equal(restored.status()?.timingQuality, undefined, "unlabeled cached timing is not claimed as aligned");
});

test("code-description quality is retained without inserting description offsets into source checkpoints", () => {
	const history = new PlaybackHistory();
	const text = "```ts\nconst x = 1;\n```";
	history.sync([{ id: "code", text, renderKey: "code-A" }]);
	history.beginCapture("code", text);
	history.registerSegment({ id: 2, utterance: 2, text: "Assign one.", source: { start: 0, end: text.length },
		codeDescription: { blockSource: { start: 0, end: text.length }, text: "Assign one.", offset: 0 } });
	history.setSegmentAudio(2, 0, 3);
	history.setTimingQuality(2, "ctc-refined");
	history.setWordTimings(2, [{ time: 1, sourceOffset: 7, quality: "ctc-refined" }]);
	history.finishTimingGeneration(2);
	assert.equal(history.status()?.timingQuality, "ctc-refined");
	assert.deepEqual(history.snapshotForUtterance(2)?.checkpoints,
		[{ time: 0, duration: 3, sourceOffset: 0, quality: "ctc-refined" }]);
});

test("replay quality updates saved unit identity, not the regenerated audio clock", () => {
	const history = new PlaybackHistory();
	const text = "First. Second.";
	history.sync([{ id: "m", text, renderKey: "A" }]);
	history.restore([{ version: 3, messageId: "m", renderKey: "A", duration: 10, checkpoints: [
		{ time: 0, duration: 5, sourceOffset: 0, quality: "ctc-refined" },
		{ time: 5, duration: 5, sourceOffset: 7, quality: "estimated" },
	] }]);
	history.beginCapture("m", text, 0, false);
	history.registerSegment({ id: 9, utterance: 9, text: "Second.", source: { start: 7, end: text.length } });
	history.setSegmentAudio(9, 4.8, 5);
	assert.equal(history.status()?.timingQuality, "mixed", "listening alone does not refine estimates");
	history.setTimingQuality(9, "ctc-refined");
	assert.equal(history.status()?.timingQuality, "ctc-refined");
	const snapshot = history.snapshotForUtterance(9)!;
	const restored = new PlaybackHistory();
	restored.sync([{ id: "m", text, renderKey: "A" }]);
	restored.restore([snapshot]);
	assert.equal(restored.status()?.timingQuality, "ctc-refined");
});

test("word timing labels require word coverage, never aggregate or clock quality", () => {
	assert.equal(playbackTimingStatus({ estimated: 3, total: 3 }), "Word timing: 3/3 estimated");
	assert.equal(playbackTimingStatus({ estimated: 1, total: 3 }), "Word timing: 1/3 estimated");
	assert.equal(playbackTimingStatus({ estimated: 0, total: 3 }), "Word timing: 0/3 estimated");
	assert.equal(playbackTimingStatus(undefined), "Word timing: unknown/pending");
});
