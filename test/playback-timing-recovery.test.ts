import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackHistory, type PlaybackTimingSnapshot } from "../src/playback-history.js";

const message = { id: "message", text: "First sentence. Second sentence. Third sentence.", renderKey: "A" };
const segment = (id: number, utterance: number, start: number) => ({
	id, utterance, text: "sentence", source: { start, end: start + 10 },
});

test("seek preserves compatible prefix and suffix units without claiming full coverage or moving the cursor", () => {
	const history = new PlaybackHistory();
	history.sync([message]);
	history.beginCapture(message.id, message.text);
	history.registerSegment(segment(1, 1, 0));
	history.registerSegment(segment(2, 1, 16));
	history.setSegmentAudio(1, 0, 2);
	history.setWordTimings(1, [{ time: 0.7, sourceOffset: 6 }]);
	history.finishTimingGeneration(1);
	assert.equal(history.hasCompleteTimingFor(message.id), false);
	const first = history.timingForUnit(message.id, "A", { sourceOffset: 0, skipUnits: 0 });
	history.beginCapture(message.id, message.text, 0, true, 33);
	history.registerSegment(segment(3, 2, 0));
	history.setSegmentAudio(3, 0, 3);
	history.setWordTimings(3, [{ time: 1, sourceOffset: 6 }]);
	history.finishTimingGeneration(2);
	assert.deepEqual(history.timingForUnit(message.id, "A", { sourceOffset: 0, skipUnits: 0 }), first);
	assert.deepEqual(history.timingForUnit(message.id, "A", { sourceOffset: 33, skipUnits: 0 }), [
		{ time: 0, duration: 3, sourceOffset: 33, quality: "estimated" }, { time: 1, duration: 0, sourceOffset: 39 },
	]);
	assert.equal(history.status()?.duration, 2, "unknown suffix origin must not relabel absolute timing");
	assert.equal(history.hasCompleteTimingFor(message.id), false);
	assert.equal(history.snapshotForUtterance(2), undefined);
	const before = history.resumeTarget();
	history.retainTimingUnit(message.id, "A", { sourceOffset: 16, skipUnits: 0 }, [{ time: 0, duration: 4, sourceOffset: 16 }]);
	assert.deepEqual(history.resumeTarget(), before, "background partial results never navigate");
	history.setSegmentAudio(2, 2, 999);
	assert.equal(history.timingForUnit(message.id, "A", { sourceOffset: 16, skipUnits: 0 })?.[0].duration, 4, "displaced capture is fenced");
	history.sync([{ ...message, renderKey: "B" }]);
	history.retainTimingUnit(message.id, "A", { sourceOffset: 16, skipUnits: 0 }, [{ time: 0, duration: 999, sourceOffset: 16 }]);
	assert.equal(history.timingForUnit(message.id, "B", { sourceOffset: 16, skipUnits: 0 }), undefined);
	history.sync([message]);
	assert.equal(history.timingForUnit(message.id, "A", { sourceOffset: 16, skipUnits: 0 })?.[0].duration, 4);
});

test("recovery hydration fills missing compatible units without replacing current metadata", () => {
	const history = new PlaybackHistory();
	history.sync([message]);
	const first = { sourceOffset: 0, skipUnits: 0 };
	const second = { sourceOffset: 16, skipUnits: 0 };
	const refined = [{ time: 0, duration: 2, sourceOffset: 0, quality: "ctc-refined" as const }];
	const current: PlaybackTimingSnapshot = { version: 3, messageId: message.id, renderKey: "A", duration: 2,
		complete: false, checkpoints: refined, units: [{ unit: first, checkpoints: refined, coverage: { estimated: 0, total: 2 } }] };
	history.restore([current]);
	const before = history.resumeTarget();
	const estimated = [{ time: 0, duration: 2, sourceOffset: 0, quality: "estimated" as const }];
	const missing = [{ time: 0, duration: 3, sourceOffset: 16, quality: "estimated" as const }];
	const saved: PlaybackTimingSnapshot = { ...current, duration: 5, complete: true,
		checkpoints: [...estimated, { ...missing[0], time: 2 }], units: [
			{ unit: first, checkpoints: estimated, coverage: { estimated: 2, total: 2 } },
			{ unit: second, checkpoints: missing, coverage: { estimated: 2, total: 2 } },
		] };
	history.restore([saved], true);
	assert.deepEqual(history.timingForUnit(message.id, "A", first), refined);
	assert.deepEqual(history.timingForUnit(message.id, "A", second), missing);
	assert.deepEqual(history.status()?.wordTimingCoverage, { estimated: 2, total: 4 });
	assert.equal(history.status()?.duration, 2);
	assert.equal(history.hasCompleteTimingFor(message.id), false);
	assert.deepEqual(history.resumeTarget(), before);
	// Existing absolute checkpoints also protect a unit when no relative unit map exists.
	const absolute = new PlaybackHistory();
	absolute.sync([message]);
	absolute.restore([{ ...current, units: undefined }]);
	absolute.restore([saved], true);
	assert.deepEqual(absolute.timingForUnit(message.id, "A", first), refined);
	// A fresh record still gets both the clock and coverage on hydration.
	const fresh = new PlaybackHistory();
	fresh.sync([message]);
	fresh.restore([saved], true);
	assert.deepEqual(fresh.status()?.wordTimingCoverage, { estimated: 4, total: 4 });
	assert.equal(fresh.hasCompleteTimingFor(message.id), true);
	history.sync([{ ...message, renderKey: "B" }]);
	history.restore([saved], true);
	assert.equal(history.timingForUnit(message.id, "B", first), undefined);
	assert.equal(history.status()?.wordTimingCoverage, undefined);
	assert.equal(history.hasCompleteTimingFor(message.id), false);
});

test("code chunk ordinals stay distinct and invalid audio cannot complete a target", () => {
	const history = new PlaybackHistory();
	history.sync([message]);
	history.beginCapture(message.id, message.text);
	history.registerSegment(segment(1, 1, 0));
	history.registerSegment(segment(2, 1, 0));
	history.setSegmentAudio(1, 0, 2);
	history.setSegmentAudio(2, 2, 0);
	history.finishTimingGeneration(1);
	assert.equal(history.hasCompleteTimingFor(message.id), false);
	history.beginCapture(message.id, message.text, 0, false, 0, 1);
	history.registerSegment(segment(3, 2, 0));
	history.setSegmentAudio(3, 0, 5);
	assert.equal(history.timingForUnit(message.id, "A", { sourceOffset: 0, skipUnits: 0 })?.[0].duration, 2);
	assert.equal(history.timingForUnit(message.id, "A", { sourceOffset: 0, skipUnits: 1 })?.[0].duration, 5);
});
