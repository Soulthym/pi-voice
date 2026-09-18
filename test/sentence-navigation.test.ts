import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";

test("sentence/newline stepping works without timings, at boundaries, and from transcript tail", () => {
	const history = new PlaybackHistory();
	const text = "First sentence. Second sentence.\nFinal line";
	history.sync([{ id: "m", text, renderKey: "key" }]);
	assert.equal(history.sentenceTarget(1)?.sourceOffset, text.indexOf("Second"));
	assert.equal(history.sentenceTarget(1)?.sourceOffset, text.indexOf("Final"));
	assert.equal(history.sentenceTarget(1), undefined);
	assert.equal(history.sentenceTarget(-1)?.sourceOffset, text.indexOf("Second"));
	assert.equal(history.sentenceTarget(-1)?.sourceOffset, 0);
	assert.equal(history.sentenceTarget(-1)?.sourceOffset, 0);
	assert.equal(history.sentenceTarget(-1, undefined, true)?.sourceOffset, text.indexOf("Final"));
	assert.equal(history.hasCompleteTimingFor("m"), false);
});

test("code sentence ordinals survive playback, pause-style repeated steps and resume", () => {
	const history = new PlaybackHistory();
	const text = "```ts\nrun();\n```\nDone.";
	const units = [{ sourceOffset: 0, skipUnits: 0 }, { sourceOffset: 0, skipUnits: 1 }, { sourceOffset: text.indexOf("Done."), skipUnits: 0 }];
	history.sync([{ id: "m", text, renderKey: "key" }]);
	history.beginCapture("m", text);
	for (let index = 0; index < 3; index++) {
		history.registerSegment({ id: index + 1, utterance: 1, text: `Sentence ${index}`, source: { start: units[index]!.sourceOffset, end: units[index]!.sourceOffset },
			...(index < 2 ? { codeDescription: { blockSource: { start: 0, end: text.indexOf("Done.") }, text: "Two code sentences.", offset: index * 10 } } : {}),
		});
		history.setSegmentAudio(index + 1, index * 5, 5);
		if (index < 2) history.setWordTimings(index + 1, [{ time: 1, sourceOffset: 5 }]);
	}
	history.finishTimingGeneration(1);
	history.setPlayback(1, 5); // Exact boundary belongs to the second sentence.
	assert.equal(history.resumeTarget()?.skipUnits, 1);
	history.setPlayback(1, 7); // In the middle of the second description sentence.
	assert.equal(history.resumeTarget()?.skipUnits, 1);
	assert.equal(history.sentenceTarget(-1, units)?.skipUnits, 0);
	const second = history.sentenceTarget(1, units)!;
	assert.equal(second.skipUnits, 1); assert.equal(second.time, 5); assert.equal(second.sourceOffset, 0);
	assert.equal(history.sentenceTarget(1, units)?.sourceOffset, text.indexOf("Done."));
	const snapshot = history.snapshotForUtterance(1)!;
	assert.equal(snapshot.checkpoints.length, 3, "description-relative words must not become raw Markdown offsets");
	history.restore([snapshot]);
	assert.equal(history.status()?.position, 10, "restoration must not rewind an existing navigation position");
	history.beginCapture("m", text, 5, false, 0, 1);
	history.registerSegment({ id: 4, utterance: 2, text: "Second sentence", source: { start: 0, end: 0 } });
	history.setSegmentAudio(4, 0, 5);
	history.setPlayback(2, 1);
	assert.equal(history.resumeTarget()?.skipUnits, 1, "a suffix replay must retain the original code ordinal");
});

test("a suffix capture never upgrades incomplete whole-message timing", () => {
	const history = new PlaybackHistory();
	history.sync([{ id: "m", text: "First. Second.", renderKey: "key" }]);
	history.beginCapture("m", "First. Second.", 0, false, 7);
	history.registerSegment({ id: 1, utterance: 1, text: "Second.", source: { start: 0, end: 7 }, sourceBase: 7 });
	history.setSegmentAudio(1, 0, 2);
	history.finishTimingGeneration(1);
	assert.equal(history.hasCompleteTimingFor("m"), false);
	assert.equal(history.snapshotForUtterance(1), undefined);
	history.setPlayback(1, 1);
	assert.equal(history.resumeTarget()?.sourceOffset, 7);
});

test("large timing snapshots retain every sentence boundary", () => {
	const history = new PlaybackHistory();
	const text = "Go.\n".repeat(2_100);
	history.sync([{ id: "m", text, renderKey: "key" }]);
	history.beginCapture("m", text);
	for (let i = 0; i < 2_100; i++) {
		history.registerSegment({ id: i, utterance: 1, text: "Go.", source: { start: i * 4, end: i * 4 + 3 } });
		history.setSegmentAudio(i, i, 1);
	}
	history.finishTimingGeneration(1);
	const snapshot = history.snapshotForUtterance(1)!;
	assert.equal(snapshot.checkpoints.length, 2_100);
	const restored = new PlaybackHistory();
	restored.sync([{ id: "m", text, renderKey: "key" }]);
	restored.restore([snapshot]);
	assert.equal(restored.sentenceTarget(-1, undefined, true)?.time, 2_099);
});

test("word refinement keeps sentence checkpoints and normalizes multi-message source bases", () => {
	const history = new PlaybackHistory();
	history.sync([{ id: "m", text: "A sentence. Another sentence.", renderKey: "key" }]);
	history.beginCapture("m", "A sentence. Another sentence.");
	history.registerSegment({ id: 1, utterance: 1, text: "A sentence.", source: { start: 0, end: 11 }, sourceBase: 100 });
	history.setSegmentAudio(1, 0, 2);
	history.setWordTimings(1, [{ time: 0.5, sourceOffset: 112 }]);
	history.registerSegment({ id: 2, utterance: 1, text: "Another sentence.", source: { start: 12, end: 29 }, sourceBase: 100 });
	history.setSegmentAudio(2, 2, 2);
	history.setWordTimings(1, [{ time: 0.6, sourceOffset: 105 }]);
	history.finishTimingGeneration(1);
	const snapshot = history.snapshotForUtterance(1)!;
	assert.deepEqual(snapshot.checkpoints.filter(point => point.duration > 0).map(point => point.sourceOffset), [0, 12]);
	assert.equal(snapshot.checkpoints.find(point => point.duration === 0)?.sourceOffset, 5);
});
