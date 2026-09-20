import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";
import { chunkCodeNarration } from "../src/code-narration.js";
import { NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";

test("formatted report sentence navigation agrees with prose and code synthesis boundaries", () => {
	const first = `${NARRATION_ACTIVE_MARKER}**494 tests passed; native-TUI checks 10/10.**${NARRATION_ACTIVE_MARKER}`;
	const second = "Run /reload, then test paused navigation after manually scrolling away and watch the timing row for flicker.";
	const text = `${first} ${second}`;
	const history = new PlaybackHistory();
	history.sync([{ id: "m", text, renderKey: "key" }]);
	assert.equal(history.sentenceTarget(1)?.sourceOffset, text.indexOf("Run"));
	assert.equal(history.resumeTarget()?.sourceOffset, text.indexOf("Run"));
	assert.equal(history.sentenceTarget(-1)?.sourceOffset, 0);

	const operation = { kind: "line-add" as const, id: "line", range: { startLine: 1, endLine: 1 } };
	const chunks = chunkCodeNarration({ guided: true, records: [
		{ speech: first, operations: [] }, { speech: second, operations: [operation] },
	] });
	assert.deepEqual(chunks.map(chunk => chunk.text), [first, second]);
	assert.deepEqual(chunks[1]!.cues, [
		{ offset: 0, operations: [operation] },
		{ offset: second.length, operations: [{ kind: "reset" }] },
	]);
	const code = "```ts\nrun();\n```";
	history.sync([{ id: "code", text: code, renderKey: "key" }]);
	const units = chunks.map((_, skipUnits) => ({ sourceOffset: 0, skipUnits }));
	assert.equal(history.sentenceTarget(1, units)?.skipUnits, 1);
	assert.equal(history.resumeTarget()?.skipUnits, 1);
	assert.equal(history.sentenceTarget(-1, units)?.skipUnits, 0);
});

test("prose navigation preserves list prefixes and numeric tokens with plain and formatted endings", () => {
	for (const first of [
		"1. First option.", "Use 3.14 and version 1.2.3.", "🦊 Done.",
		"494 tests passed; native-TUI checks 10/10.", "10/10.",
	]) {
		for (const formatted of [false, true]) {
			const head = formatted ? `${NARRATION_ACTIVE_MARKER}**${first}**${NARRATION_ACTIVE_MARKER}` : first;
			const second = "2. second option.";
			const text = `${head} ${second}\nfinal line`;
			const history = new PlaybackHistory();
			history.sync([{ id: "m", text, renderKey: "key" }]);
			assert.equal(history.sentenceTarget(1)?.sourceOffset, text.indexOf(second), text);
			assert.equal(history.sentenceTarget(1)?.sourceOffset, text.indexOf("final"), text);
			assert.equal(history.sentenceTarget(-1)?.sourceOffset, text.indexOf(second), text);
			assert.equal(history.sentenceTarget(-1)?.sourceOffset, 0, text);
		}
	}
});

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
