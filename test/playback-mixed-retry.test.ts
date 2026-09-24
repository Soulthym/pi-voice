import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";
import type { PlaybackTimingSnapshot } from "../src/playback-history.js";
type TimingCheckpoint = PlaybackTimingSnapshot["checkpoints"][number];

const message = { id: "a", text: "Intro. Alpha beta gamma.", renderKey: "plan" };
const unit = { sourceOffset: 7, skipUnits: 0 };
const offsets = [7, 13, 18];
const anchor: TimingCheckpoint = { time: 0, duration: 3, sourceOffset: 7, quality: "mixed" };
const word = (i: number, time: number, quality: "estimated" | "ctc-refined"): TimingCheckpoint =>
	({ time, duration: 0, sourceOffset: offsets[i], quality });
function setup(points: TimingCheckpoint[], coverage?: { total: number; estimated: number }) {
	const history = new PlaybackHistory();
	history.sync([message]);
	history.restore([{ version: 3, messageId: "a", renderKey: "plan", duration: 8, complete: true,
		checkpoints: points.map(point => ({ ...point, time: point.time + 5 })),
		units: [{ unit, checkpoints: points, coverage }] }]);
	return history;
}

test("mixed retry preserves first-word CTC, absolute unit base, metadata and refines remaining words on second retry", () => {
	const first = word(0, 0.25, "ctc-refined");
	const history = setup([anchor, first], { total: 3, estimated: 2 });
	const before = history.status();
	assert.ok(history.retryableTimingUnit("a", "plan", unit, offsets));
	const once = history.refineTimingUnit("a", "plan", unit,
		[anchor, word(0, 0.1, "estimated"), word(1, 1, "ctc-refined"), word(2, 2, "estimated")],
		{ total: 3, estimated: 2 }, offsets)!;
	assert.deepEqual(once.units![0].coverage, { total: 3, estimated: 1 });
	assert.deepEqual(once.units![0].checkpoints[1], first);
	assert.equal(once.units![0].checkpoints[0].quality, "mixed", "anchor is aggregate, not first-word quality");
	const twice = history.refineTimingUnit("a", "plan", unit,
		[anchor, word(0, 0, "ctc-refined"), word(1, 0.9, "ctc-refined"), word(2, 2.2, "ctc-refined")],
		{ total: 99, estimated: 0 }, offsets)!;
	assert.deepEqual(twice.units![0].coverage, { total: 3, estimated: 0 }, "coverage counts actual source words");
	assert.deepEqual(twice.units![0].checkpoints.slice(1), [first, word(1, 1, "ctc-refined"), word(2, 2.2, "ctc-refined")]);
	assert.equal(twice.checkpoints[1].time, 5.25);
	assert.equal(twice.duration, 8);
	assert.equal(twice.complete, true);
	assert.equal(history.status()?.position, before?.position);
	assert.equal(history.status()?.messageId, before?.messageId);
	assert.equal(history.retryableTimingUnit("a", "plan", unit, offsets), false);
});

test("replayed source offsets retain the actual first-word CTC timestamp separately from aggregate quality", () => {
	const history = setup([anchor, word(1, 1, "estimated")]);
	history.beginCapture("a", message.text, 5, false, 7);
	history.registerSegment({ id: 1, utterance: 1, text: "Alpha beta gamma.", source: { start: 0, end: 17 } });
	history.setSegmentAudio(1, 0, 3);
	history.setTimingQuality(1, "mixed");
	history.setWordTimings(1, [
		{ time: 0.3, sourceOffset: 0, quality: "ctc-refined" },
		{ time: 1, sourceOffset: 6, quality: "estimated" },
		{ time: 2, sourceOffset: 11, quality: "estimated" },
	]);
	assert.deepEqual(history.timingForUnit("a", "plan", unit), [anchor, word(0, 0.3, "ctc-refined"), word(1, 1, "estimated"), word(2, 2, "estimated")]);
	assert.equal(history.snapshotForSegment(1)?.checkpoints.find(point => point.duration === 0 && point.sourceOffset === 7)?.time, 5.3);
});

test("dense labels suffice; sparse unknown, missing, duplicate or off-plan CTC cannot invent provenance", () => {
	assert.ok(setup([anchor, word(0, 0.2, "ctc-refined"), word(1, 1, "estimated"), word(2, 2, "estimated")])
		.retryableTimingUnit("a", "plan", unit, offsets));
	for (const [points, coverage] of [
		[[anchor, word(0, 0.2, "ctc-refined")], undefined],
		[[anchor, word(0, 0.2, "ctc-refined")], { total: 3, estimated: 1 }],
		[[anchor, word(0, 0.2, "ctc-refined"), word(0, 0.3, "ctc-refined")], { total: 3, estimated: 1 }],
		[[anchor, { ...word(0, 0.2, "ctc-refined"), sourceOffset: 8 }], { total: 3, estimated: 2 }],
	] as Array<[TimingCheckpoint[], { total: number; estimated: number } | undefined]>) {
		assert.equal(setup(points, coverage).retryableTimingUnit("a", "plan", unit, offsets), false);
	}
});

test("commit revalidates async improvements and rejects crossing candidates or changed duration", () => {
	const history = setup([{ ...anchor, quality: "estimated" }]);
	assert.ok(history.retryableTimingUnit("a", "plan", unit, offsets));
	const better = [anchor, word(0, 0.4, "ctc-refined"), word(1, 1.5, "ctc-refined")];
	history.retainTimingUnit("a", "plan", unit, better, { total: 3, estimated: 1 });
	const candidate = [anchor, word(0, 0, "ctc-refined"), word(1, 1, "estimated"), word(2, 1.2, "ctc-refined")];
	assert.equal(history.refineTimingUnit("a", "plan", unit, candidate, { total: 3, estimated: 1 }, offsets), undefined);
	assert.deepEqual(history.timingForUnit("a", "plan", unit), better);
	candidate[3].time = 2;
	const merged = history.refineTimingUnit("a", "plan", unit, candidate, { total: 3, estimated: 1 }, offsets)!;
	assert.deepEqual(merged.units![0].checkpoints.slice(1, 3), better.slice(1));
	assert.equal(history.refineTimingUnit("a", "plan", unit, candidate, { total: 3, estimated: 1 }, offsets), undefined);
	const changed = setup([anchor, word(0, 0.4, "ctc-refined")], { total: 3, estimated: 2 });
	assert.equal(changed.refineTimingUnit("a", "plan", unit, [{ ...anchor, duration: 4 }, ...candidate.slice(1)], { total: 3, estimated: 1 }, offsets), undefined);
});
