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

	history.finishUtterance(1);
	assert.equal(history.status()?.position, 24);
	const snapshot = history.snapshotForUtterance(1);
	assert.ok(snapshot);
	assert.equal(history.snapshotForUtterance(1), undefined);
	const restored = new PlaybackHistory();
	restored.sync([{ id: "message", text: "x".repeat(120), renderKey: "render-a" }], true);
	restored.restore([snapshot]);
	assert.deepEqual(restored.seekTarget(10), {
		id: "message",
		text: "x".repeat(120),
		time: 8,
		sourceOffset: 40,
	});
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
			version: 2,
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
	assert.deepEqual(replacement.checkpoints, [{ time: 0, duration: 4, sourceOffset: 0 }]);
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
