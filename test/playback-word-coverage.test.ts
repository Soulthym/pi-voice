import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";
import { NarrationProgress } from "../src/narration-progress.js";

const message = { id: "message", text: "Alpha beta gamma. Delta epsilon.", renderKey: "A" };
function setup() {
	const history = new PlaybackHistory();
	history.sync([message]);
	history.beginCapture(message.id, message.text);
	history.registerSegment({ id: 1, utterance: 1, text: "Alpha beta gamma.", source: { start: 0, end: 17 } });
	history.setSegmentAudio(1, 0, 4);
	return history;
}
const words = [
	{ time: 0, sourceOffset: 0, quality: "ctc-refined" as const },
	{ time: 0.1, sourceOffset: 6, quality: "estimated" as const },
	{ time: 0.2, sourceOffset: 11, quality: "ctc-refined" as const },
];

test("coverage uses full narration words before checkpoint throttling and metadata preserves paused position/cursor", () => {
	const history = setup();
	const narration = new NarrationProgress();
	narration.setCompletedText(message.text);
	narration.registerSegment({ id: 1, utterance: 1, text: "Alpha beta gamma.", source: { start: 0, end: 17 } });
	narration.setSegmentAudio(1, 0, 4);
	history.setWordTimings(1, narration.sourceWordTimings(1));
	assert.deepEqual(history.status()?.wordTimingCoverage, { estimated: 3, total: 3 });
	history.registerSegment({ id: 2, utterance: 1, text: "Delta epsilon.", source: { start: 18, end: message.text.length } });
	assert.equal(history.status()?.wordTimingCoverage, undefined, "registered but untimed sentence keeps coverage pending");
	history.setSegmentAudio(2, 4, 4);
	assert.equal(history.status()?.wordTimingCoverage, undefined);
	history.setWordTimings(2, [{ time: 0, sourceOffset: 18, quality: "estimated" }]);
	history.setPlayback(1, 5);
	history.finishUtterance(1, false);
	const before = history.status();
	narration.setAlignment(1, [
		{ text: "Alpha", start: 0, end: 0.1, quality: "ctc-refined" },
		{ text: "beta", start: 0.1, end: 0.2, quality: "estimated" },
		{ text: "gamma", start: 0.2, end: 0.3, quality: "ctc-refined" },
	], "mixed");
	history.setTimingQuality(1, narration.timingQuality(1));
	history.setWordTimings(1, narration.sourceWordTimings(1));
	assert.deepEqual(history.status(), { ...before, timingQuality: "mixed", wordTimingCoverage: { estimated: 2, total: 4 } });
	assert.equal(history.timingForUnit(message.id, "A", { sourceOffset: 0, skipUnits: 0 })?.length, 2);
	history.setTimingQuality(1, "estimated");
	assert.deepEqual(history.status()?.wordTimingCoverage, { estimated: 2, total: 4 }, "aggregate quality cannot change actual counts");
	history.setWordTimings(1, words);
	assert.deepEqual(history.status()?.wordTimingCoverage, { estimated: 2, total: 4 }, "replacement is not additive");
	assert.equal(history.status()?.position, 5);
	assert.equal(history.resumeTarget()?.sourceOffset, 18, "metadata did not reset the paused cursor");
});

test("unknown per-word provenance and sparse recovery never fabricate coverage", () => {
	const history = setup();
	for (const quality of [undefined, "mixed"] as const) {
		history.setWordTimings(1, [{ ...words[0], quality }]);
		assert.equal(history.status()?.wordTimingCoverage, undefined);
	}
	history.setWordTimings(1, words);
	history.finishTimingGeneration(1);
	const snapshot = history.snapshotForUtterance(1)!;
	const restored = new PlaybackHistory();
	restored.sync([message]);
	restored.restore([snapshot]);
	assert.equal(restored.status()?.wordTimingCoverage, undefined);
	restored.retainTimingUnit(message.id, "A", { sourceOffset: 0, skipUnits: 0 }, snapshot.checkpoints);
	assert.equal(restored.status()?.wordTimingCoverage, undefined);
	history.retainTimingUnit(message.id, "A", { sourceOffset: 18, skipUnits: 0 }, [{ time: 0, duration: 3, sourceOffset: 18, quality: "estimated" }]);
	assert.equal(history.status()?.wordTimingCoverage, undefined, "unknown unit makes combined coverage unknown");
});

test("compatible in-memory variants retain counts, incompatible text/identity and stale callbacks do not", () => {
	const history = setup();
	history.setWordTimings(1, words);
	history.finishTimingGeneration(1);
	const snapshot = history.snapshotForUtterance(1)!;
	history.sync([{ ...message, renderKey: "B" }]);
	history.restore([snapshot]);
	history.setWordTimings(1, words);
	assert.equal(history.status()?.wordTimingCoverage, undefined);
	history.sync([message]);
	assert.deepEqual(history.status()?.wordTimingCoverage, { estimated: 1, total: 3 });
	history.restore([snapshot]);
	assert.deepEqual(history.status()?.wordTimingCoverage, { estimated: 1, total: 3 });
	history.sync([{ ...message, text: "Different text." }]);
	assert.equal(history.status()?.wordTimingCoverage, undefined);
	const updated = setup();
	updated.setWordTimings(1, words);
	updated.updateText(message.id, "Replacement");
	assert.equal(updated.status()?.wordTimingCoverage, undefined);
	const renamed = setup();
	renamed.setWordTimings(1, words);
	renamed.rename(message.id, { ...message, renderKey: "B" });
	assert.equal(renamed.status()?.wordTimingCoverage, undefined);
});

test("code description timings do not count as source words; suffix offsets count before navigation filtering", () => {
	const history = setup();
	history.setWordTimings(1, words);
	history.registerSegment({ id: 2, utterance: 1, text: "Description", source: { start: 18, end: message.text.length },
		codeDescription: { blockSource: { start: 18, end: message.text.length }, text: "Description", offset: 0 } });
	history.setSegmentAudio(2, 4, 4);
	history.setWordTimings(2, [{ time: 0, sourceOffset: 1000, quality: "estimated" }]);
	assert.deepEqual(history.status()?.wordTimingCoverage, { estimated: 1, total: 3 });
	const suffix = new PlaybackHistory();
	suffix.sync([message]);
	suffix.beginCapture(message.id, message.text, 0, false, 18);
	suffix.registerSegment({ id: 3, utterance: 2, text: "Delta epsilon.", source: { start: 0, end: 14 }, sourceBase: 100 });
	suffix.setSegmentAudio(3, 0, 4);
	suffix.setWordTimings(3, [{ time: 0, sourceOffset: 100, quality: "estimated" }, { time: 0.1, sourceOffset: 106, quality: "ctc-refined" }]);
	assert.deepEqual(suffix.status()?.wordTimingCoverage, { estimated: 1, total: 2 });
	assert.equal(suffix.status()?.hasTimings, false);
});
