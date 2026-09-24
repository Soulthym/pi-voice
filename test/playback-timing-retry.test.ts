import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";

test("retry metadata round-trips sparse units without completing or moving a cursor; refined and unknown units survive", () => {
	const history = new PlaybackHistory();
	const message = { id: "a", text: "Alpha beta. Gamma delta.", renderKey: "plan" };
	history.sync([message]);
	const unit = { sourceOffset: 12, skipUnits: 0 };
	history.restore([{ version: 3, messageId: "a", renderKey: "plan", duration: 0, complete: false, checkpoints: [],
		units: [{ unit, checkpoints: [{ time: 0, duration: 2, sourceOffset: 12, quality: "estimated" }] }] }]);
	const before = history.status();
	const snapshot = history.refineTimingUnit("a", "plan", unit, [
		{ time: 0, duration: 2, sourceOffset: 12, quality: "ctc-refined" },
		{ time: 1, duration: 0, sourceOffset: 18, quality: "ctc-refined" },
	], { estimated: 0, total: 2 })!;
	history.syncMessage(message);
	assert.equal(history.timingForUnit("a", "plan", unit)?.[0].quality, "ctc-refined", "ordinary sync must not restore a stale sparse snapshot");
	assert.equal(snapshot.complete, false);
	assert.deepEqual(snapshot.checkpoints, []);
	assert.equal(history.status()?.position, before?.position);
	assert.equal(history.status()?.timingsComplete, false);
	assert.equal(history.refineTimingUnit("a", "plan", unit, [], { estimated: 0, total: 0 }), undefined);
	const restored = new PlaybackHistory();
	restored.sync([message]);
	restored.restore(JSON.parse(JSON.stringify([snapshot])));
	assert.equal(restored.status()?.timingsComplete, false);
	assert.deepEqual(restored.timingForUnit("a", "plan", unit), history.timingForUnit("a", "plan", unit));
	assert.deepEqual(restored.status()?.wordTimingCoverage, { estimated: 0, total: 2 });
	const unknown = { sourceOffset: 0, skipUnits: 0 };
	restored.retainTimingUnit("a", "plan", unknown, [{ time: 0, duration: 2, sourceOffset: 0 }]);
	assert.equal(restored.refineTimingUnit("a", "plan", unknown, [], { estimated: 0, total: 0 }), undefined);
	assert.equal(restored.refineTimingUnit("a", "different-plan", unit, [], { estimated: 0, total: 0 }), undefined);
});

const message = { id: "a", text: "Alpha beta. Gamma delta. Epsilon zeta.", renderKey: "plan" };
const unit = { sourceOffset: 0, skipUnits: 0 };
const refined = [
	{ time: 0, duration: 2, sourceOffset: 0, quality: "ctc-refined" as const },
	{ time: 0.8, duration: 0, sourceOffset: 6, quality: "ctc-refined" as const },
];
function capture() {
	const history = new PlaybackHistory();
	history.sync([message]);
	history.beginCapture(message.id, message.text);
	for (const [index, start] of [0, 12, 25].entries()) {
		history.registerSegment({ id: index + 1, utterance: 1, text: message.text.slice(start), source: { start, end: message.text.length } });
	}
	history.setSegmentAudio(1, 0, 2);
	history.setWordTimings(1, [{ time: 0, sourceOffset: 0, quality: "estimated" }, { time: 1, sourceOffset: 6, quality: "estimated" }]);
	return history;
}

test("unimproved retry leaves pending original CTC eligible but cannot revive stale segment IDs", () => {
	const history = capture();
	history.setPlayback(1, 1);
	assert.ok(history.refineTimingUnit("a", "plan", unit, [
		{ time: 0, duration: 2, sourceOffset: 0, quality: "estimated" },
		{ time: 1.5, duration: 0, sourceOffset: 6, quality: "estimated" },
	], { estimated: 2, total: 2 }));
	history.setTimingQuality(1, "ctc-refined");
	history.setWordTimings(1, refined.map(point => ({ time: point.time, sourceOffset: point.sourceOffset, quality: point.quality })));
	const withFirstWord = [refined[0], { ...refined[0], duration: 0 }, refined[1]];
	assert.deepEqual(history.timingForUnit("a", "plan", unit), withFirstWord);
	assert.equal(history.status()?.position, 1);
	history.beginCapture(message.id, message.text);
	history.setTimingQuality(1, "estimated");
	history.setWordTimings(1, [{ time: 1.5, sourceOffset: 6, quality: "estimated" }]);
	history.setSegmentAudio(1, 0, 9);
	assert.deepEqual(history.timingForUnit("a", "plan", unit), withFirstWord, "retired ID cannot change quality, words or duration");
});

test("partial retry snapshot cannot rewind a newer capture during sync", () => {
	const history = capture();
	assert.ok(history.refineTimingUnit("a", "plan", unit, refined, { estimated: 0, total: 2 }));
	history.setSegmentAudio(2, 2, 2);
	history.syncMessage(message);
	assert.equal(history.status()?.duration, 4);
	history.finishTimingGeneration(1);
	history.setSegmentAudio(3, 4, 2);
	const snapshot = history.snapshotForUtterance(1)!;
	assert.equal(snapshot.duration, 6);
	assert.deepEqual(snapshot.checkpoints.filter(point => point.duration > 0).map(point => point.sourceOffset), [0, 12, 25]);
	assert.deepEqual(history.timingForUnit("a", "plan", unit), refined);
});

test("paused original consumers cannot overwrite retry refinement; resumed idle preserves measured coverage", () => {
	const history = capture();
	for (const [id, start, sourceOffset] of [[2, 2, 12], [3, 4, 25]]) {
		history.setSegmentAudio(id, start, 2);
		history.setWordTimings(id, [{ time: 0, sourceOffset, quality: "estimated" }]);
	}
	history.setPlayback(1, 1);
	history.finishUtterance(1, false);
	const before = history.status();
	const retry = history.refineTimingUnit("a", "plan", unit, refined, { estimated: 0, total: 5 })!;
	// Same metadata calls as the original capture's late alignment/error handlers.
	history.setTimingQuality(1, "estimated");
	history.setWordTimings(1, [{ time: 1.5, sourceOffset: 6, quality: "estimated" }]);
	history.setSegmentAudio(1, 0, 2, "estimated");
	assert.deepEqual(history.timingForUnit("a", "plan", unit), refined);
	assert.equal(history.status()?.position, before?.position);
	assert.deepEqual(history.status()?.wordTimingCoverage, { estimated: 2, total: 7 });
	assert.equal(history.resumeTarget()?.sourceOffset, 0);
	// Resume the same transport; refinement must not invalidate playback.
	history.finishUtterance(1);
	assert.equal(history.status()?.position, 6);
	const idle = history.snapshotForUtterance(1)!;
	assert.deepEqual(idle.checkpoints, retry.checkpoints);
	for (const snapshot of [retry, idle]) {
		const restored = new PlaybackHistory();
		restored.sync([message]);
		restored.restore(JSON.parse(JSON.stringify([snapshot])));
		assert.deepEqual(restored.status()?.wordTimingCoverage, { estimated: 2, total: 7 });
		assert.deepEqual(restored.timingForUnit("a", "plan", unit), refined);
	}
});
