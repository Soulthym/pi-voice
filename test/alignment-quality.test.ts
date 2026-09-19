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

test("word timing and estimated transport clocks have independent labels", () => {
	assert.equal(playbackTimingStatus("estimated", false), " · word timing: estimated");
	assert.equal(playbackTimingStatus("mixed", false), " · word timing: mixed (includes estimates)");
	assert.equal(playbackTimingStatus("ctc-refined", true), " · word timing: CTC-refined · playback clock: estimated");
	assert.equal(playbackTimingStatus(undefined, false), " · word timing: quality unknown");
});
