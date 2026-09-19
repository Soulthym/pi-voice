import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";

function segment(id: number, utterance: number, start: number) {
	return {
		id,
		utterance,
		text: `segment ${id}`,
		source: { start, end: start + 10 },
	};
}

test("timings restore A to B to A in memory and after reload, fencing late audio", () => {
	const history = new PlaybackHistory();
	const a = { id: "one", text: "First sentence.", renderKey: "A" };
	const snapshot = { version: 3 as const, messageId: a.id, renderKey: "A", duration: 2,
		checkpoints: [{ time: 0, duration: 2, sourceOffset: 0 }] };
	history.sync([a]); history.restore([snapshot]);
	history.sync([{ ...a, renderKey: "B" }]);
	assert.equal(history.hasCompleteTimingFor(a.id), false);
	history.sync([a]);
	assert.equal(history.hasCompleteTimingFor(a.id), true);
	const reloaded = new PlaybackHistory();
	reloaded.sync([{ ...a, renderKey: "B" }]); reloaded.restore([snapshot]);
	reloaded.sync([a]);
	assert.equal(reloaded.hasCompleteTimingFor(a.id), true);
	history.beginCapture(a.id, a.text); history.bindUtterance(1);
	history.registerSegment(segment(1, 1, 0));
	history.sync([{ ...a, renderKey: "B" }]);
	history.setSegmentAudio(1, 0, 999);
	history.finishTimingGeneration(1);
	assert.equal(history.snapshotForUtterance(1), undefined);
	assert.equal(history.hasCompleteTimingFor(a.id), false);
	history.sync([a]);
	assert.equal(history.status()?.duration, 2, "late A audio cannot mutate either version");
});

test("maps playback time to approximate source checkpoints without audio storage", () => {
	const history = new PlaybackHistory();
	history.sync([{ id: "message", text: "x".repeat(120), renderKey: "render-a" }], true);
	history.beginCapture("message", "x".repeat(120));
	for (const [id, start, source] of [
		[1, 0, 0],
		[2, 8, 40],
		[3, 16, 80],
	] as const) {
		history.registerSegment(segment(id, 1, source));
		history.setSegmentAudio(id, start, 8);
	}
	history.setPlayback(1, 20);
	assert.deepEqual(history.status(), {
		messageId: "message",
		position: 20,
		duration: 24,
		messageIndex: 0,
		messageCount: 1,
		hasTimings: true,
		timingsComplete: false,
		timingQuality: "estimated",
	});
	assert.deepEqual(history.seekTarget(-10), {
		id: "message",
		text: "x".repeat(120),
		time: 8,
		sourceOffset: 40,
	});
	assert.deepEqual(history.seekTarget(10), {
		id: "message",
		text: "x".repeat(120),
		time: 16,
		sourceOffset: 80,
	});
	assert.equal(history.canSeekForward(), false);

	history.finishUtterance(1);
	assert.equal(history.status()?.position, 24);
	assert.equal(history.status()?.timingsComplete, true);
	const snapshot = history.snapshotForUtterance(1);
	assert.ok(snapshot);
	assert.equal(history.snapshotForUtterance(1), undefined);
	const restored = new PlaybackHistory();
	restored.sync([{ id: "message", text: "x".repeat(120), renderKey: "render-a" }], true);
	restored.restore([snapshot]);
	assert.equal(restored.status()?.timingsComplete, true, "persisted timing snapshots are complete");
	assert.deepEqual(restored.seekTarget(10), {
		id: "message",
		text: "x".repeat(120),
		time: 8,
		sourceOffset: 40,
	});
});

test("quality includes estimated suffix units after seeking beyond a refined prefix", () => {
	const history = new PlaybackHistory();
	const text = "First sentence. Second sentence.";
	const offset = text.indexOf("Second");
	history.sync([{ id: "message", text, renderKey: "render" }]);
	history.beginCapture("message", text);
	history.registerSegment(segment(1, 1, 0));
	history.setSegmentAudio(1, 0, 4, "ctc-refined");
	assert.equal(history.status()?.timingQuality, "ctc-refined");

	const target = history.sentenceTarget(1)!;
	assert.equal(target.sourceOffset, offset);
	history.beginCapture(target.id, text, target.time, false, offset);
	history.registerSegment(segment(2, 2, 0));
	history.setSegmentAudio(2, 0, 4);
	const before = history.status()!;
	assert.equal(before.timingsComplete, false);
	assert.equal(before.timingQuality, "mixed", "relative suffix estimates must not be reported as CTC");

	history.setTimingQuality(2, "ctc-refined");
	assert.deepEqual(history.status(), { ...before, timingQuality: "ctc-refined" },
		"late refinement changes quality only, not position or completeness");
});

test("quality reports suffix-only timings before absolute checkpoints exist", () => {
	const history = new PlaybackHistory();
	const text = "First sentence. Second sentence.";
	history.sync([{ id: "message", text, renderKey: "render" }]);
	history.beginCapture("message", text, 0, false, text.indexOf("Second"));
	history.registerSegment(segment(1, 1, 0));
	history.setSegmentAudio(1, 0, 4);
	assert.equal(history.status()?.hasTimings, false);
	assert.equal(history.status()?.timingQuality, "estimated");
	history.setTimingQuality(1, "mixed");
	assert.equal(history.status()?.timingQuality, "mixed");
	history.setTimingQuality(1, "ctc-refined");
	assert.equal(history.status()?.timingQuality, "ctc-refined");
});

test("directional scrubs advance across ties until the final checkpoint", () => {
	const text = "x".repeat(100);
	const history = new PlaybackHistory();
	history.sync([{ id: "message", text, renderKey: "sparse" }], true);
	history.beginCapture("message", text);
	history.registerSegment(segment(10, 2, 0));
	history.registerSegment(segment(11, 2, 50));
	history.setSegmentAudio(10, 0, 20);
	history.setSegmentAudio(11, 20, 20);
	history.setPlayback(2, 0);
	assert.equal(history.canSeekForward(), true);
	assert.equal(history.seekTarget(10)?.time, 20, "a midpoint tie must advance to the next checkpoint");
	history.setPlayback(2, 20);
	assert.equal(history.canSeekForward(), false);
	assert.equal(history.status()?.timingsComplete, false, "the last known checkpoint is not necessarily final");
	assert.equal(history.hasCompleteTimingFor("message"), false);
	history.finishTimingGeneration(2);
	assert.equal(history.status()?.timingsComplete, true);
	assert.equal(history.hasCompleteTimingFor("message"), true);
});

test("uses aligned word checkpoints to land close to a ten-second scrub", () => {
	const text = "x".repeat(200);
	const history = new PlaybackHistory();
	history.sync([{ id: "message", text, renderKey: "render-words" }], true);
	history.beginCapture("message", text);
	history.registerSegment(segment(20, 4, 0));
	history.setSegmentAudio(20, 0, 30);
	history.setWordTimings(20, [
		{ time: 0, sourceOffset: 0 },
		{ time: 9.9, sourceOffset: 40 },
		{ time: 14.8, sourceOffset: 60 },
		{ time: 20.2, sourceOffset: 80 },
	]);
	history.setPlayback(4, 5);
	assert.deepEqual(history.seekTarget(10), {
		id: "message",
		text,
		time: 14.8,
		sourceOffset: 60,
	});
});

test("invalidates and replaces timing checkpoints for a full rerender", () => {
	const text = "x".repeat(80);
	const history = new PlaybackHistory();
	history.sync([{ id: "message", text, renderKey: "old-render" }], true);
	history.restore([
		{
			version: 3,
			messageId: "message",
			renderKey: "old-render",
			duration: 9,
			checkpoints: [{ time: 0, duration: 9, sourceOffset: 0 }],
		},
	]);
	assert.equal(history.status()?.duration, 9);
	history.sync([{ id: "message", text, renderKey: "old-render" }]);
	assert.equal(history.status()?.duration, 9);

	history.sync([{ id: "message", text, renderKey: "new-render" }]);
	assert.equal(history.status()?.hasTimings, false);
	history.beginCapture("message", text, 0, true);
	history.registerSegment(segment(10, 3, 0));
	history.setSegmentAudio(10, 0, 4);
	history.finishUtterance(3);
	const replacement = history.snapshotForUtterance(3);
	assert.ok(replacement);
	assert.equal(replacement.renderKey, "new-render");
	assert.equal(replacement.duration, 4);
	history.setPlayback(3, 0.5);
	assert.equal(history.status()?.position, 4, "completion before any tick still fences buffered ticks");
	assert.deepEqual(replacement.checkpoints, [{ time: 0, duration: 4, sourceOffset: 0, quality: "estimated" }]);
});

test("capture ahead and delayed registration leave navigation and dirty resume on audible text", () => {
	const history = new PlaybackHistory();
	const text = "First sentence. Second sentence. Third sentence.";
	const second = text.indexOf("Second");
	const messages = ["before", "audible", "queued"].map(id => ({ id, text, renderKey: id }));
	history.sync(messages);
	history.beginCapture("audible", text, 0, true, 0, 0, false);
	history.bindUtterance(1);
	// The next block is captured before the earlier asynchronous description registers.
	history.beginCapture("queued", text, 0, true, 0, 0, false);
	history.bindUtterance(2);
	history.registerSegment(segment(3, 2, 0));
	history.setSegmentAudio(3, 0, 4);
	history.registerSegment(segment(1, 1, 0));
	history.registerSegment(segment(2, 1, second));
	history.setSegmentAudio(1, 0, 4);
	history.setSegmentAudio(2, 4, 4);
	history.setPlayback(1, 5);
	assert.equal(history.selected()?.id, "audible");
	assert.equal(history.status()?.position, 5);
	assert.equal(history.seekTarget(-5)?.id, "audible");
	assert.equal(history.restartTarget()?.id, "audible");

	// A further capture and registration must not steal an already audible cursor.
	history.beginCapture("later", text, 0, true, 0, 0, false);
	history.bindUtterance(3);
	history.registerSegment(segment(4, 3, 0));
	history.setPlayback(1, 6);
	assert.equal(history.status()?.position, 6);
	// Speed/render changes discard timing, but preserve the audible source unit.
	history.sync(messages.map(message => ({ ...message, renderKey: `${message.id}-new-speed` })));
	assert.deepEqual(history.resumeTarget(), {
		id: "audible", text, time: 0, sourceOffset: second, skipUnits: 0,
	});
	assert.equal(history.sentenceTarget(1)?.sourceOffset, text.indexOf("Third"));
	assert.equal(history.move(-1)?.id, "before");
});

test("audible transitions ignore delayed earlier registrations and ticks", () => {
	const history = new PlaybackHistory();
	const text = "First sentence. Second sentence.";
	history.sync(["one", "two"].map(id => ({ id, text, renderKey: id })));
	for (const [id, utterance] of [["one", 1], ["two", 2]] as const) {
		history.beginCapture(id, text, 0, true, 0, 0, false);
		history.bindUtterance(utterance);
		history.registerSegment(segment(utterance, utterance, 0));
		history.setSegmentAudio(utterance, 0, 4);
	}
	history.setPlayback(1, 1);
	history.setPlayback(2, Number.NaN);
	assert.equal(history.selected()?.id, "one");
	history.setPlayback(2, 2);
	history.registerSegment(segment(3, 1, text.indexOf("Second")));
	history.setSegmentAudio(3, 4, 4);
	history.setPlayback(1, 5);
	history.finishUtterance(1);
	assert.equal(history.selected()?.id, "two");
	assert.equal(history.status()?.position, 2);
	assert.equal(history.snapshotForUtterance(1)?.duration, 8, "earlier timing still completes");
	history.finishUtterance(2);
	history.setPlayback(2, 0.5);
	history.setPlayback(1, 6);
	assert.equal(history.status()?.position, 4, "completion must not reopen earlier ticks");
});

test("explicit replay selects immediately and fences displaced captures without losing their timings", () => {
	const history = new PlaybackHistory();
	const text = "First sentence. Second sentence.";
	history.sync(["one", "two"].map(id => ({ id, text, renderKey: id })));
	history.beginCapture("one", text, 0, true, 0, 0, false);
	history.bindUtterance(1);
	history.beginCapture("two", text, 0, true, 0, 0, false);
	history.bindUtterance(2);
	history.setPlayback(1, 1);
	// Replay the audible message's suffix, including while waiting/paused.
	const offset = text.indexOf("Second");
	history.beginCapture("one", text, 4, false, offset, 1);
	assert.deepEqual(history.resumeTarget(), { id: "one", text, time: 0, sourceOffset: offset, skipUnits: 1 });
	history.registerSegment(segment(2, 2, 0));
	history.setSegmentAudio(2, 0, 4);
	history.setPlayback(2, 3);
	history.setPlayback(1, 3);
	history.finishUtterance(2);
	assert.equal(history.selected()?.id, "one");
	assert.equal(history.resumeTarget()?.sourceOffset, offset);
	assert.equal(history.snapshotForUtterance(2)?.duration, 4);
	history.bindUtterance(3);
	history.registerSegment(segment(3, 3, 0));
	history.setSegmentAudio(3, 0, 4);
	history.setPlayback(3, 2);
	assert.equal(history.status()?.position, 6);
	assert.equal(history.resumeTarget()?.skipUnits, 1);
});

test("navigates session messages and preserves a live record when it receives its session id", () => {
	const history = new PlaybackHistory();
	history.sync(
		[
			{ id: "one", text: "First", renderKey: "one" },
			{ id: "two", text: "Second", renderKey: "two" },
		],
		true,
	);
	assert.equal(history.move(-1)?.id, "one");
	assert.equal(history.move(1)?.id, "two");

	history.beginCapture("live:1", "");
	history.registerSegment(segment(4, 2, 0));
	history.setSegmentAudio(4, 0, 3);
	history.rename("live:1", { id: "three", text: "Third", renderKey: "three" });
	history.sync(
		[
			{ id: "one", text: "First", renderKey: "one" },
			{ id: "two", text: "Second", renderKey: "two" },
			{ id: "three", text: "Third", renderKey: "three" },
		],
	);
	assert.equal(history.selected()?.id, "three");
	assert.equal(history.hasTimings(), true);
});
