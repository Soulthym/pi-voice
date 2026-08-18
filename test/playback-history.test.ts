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
	history.sync([{ id: "message", text: "x".repeat(120) }], true);
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

	const snapshot = history.snapshotForUtterance(1);
	assert.ok(snapshot);
	assert.equal(history.snapshotForUtterance(1), undefined);
	const restored = new PlaybackHistory();
	restored.sync([{ id: "message", text: "x".repeat(120) }], true);
	restored.restore([snapshot]);
	assert.deepEqual(restored.seekTarget(10), {
		id: "message",
		text: "x".repeat(120),
		time: 8,
		sourceOffset: 40,
	});
});

test("navigates session messages and preserves a live record when it receives its session id", () => {
	const history = new PlaybackHistory();
	history.sync(
		[
			{ id: "one", text: "First" },
			{ id: "two", text: "Second" },
		],
		true,
	);
	assert.equal(history.move(-1)?.id, "one");
	assert.equal(history.move(1)?.id, "two");

	history.beginCapture("live:1", "");
	history.registerSegment(segment(4, 2, 0));
	history.setSegmentAudio(4, 0, 3);
	history.rename("live:1", { id: "three", text: "Third" });
	history.sync(
		[
			{ id: "one", text: "First" },
			{ id: "two", text: "Second" },
			{ id: "three", text: "Third" },
		],
	);
	assert.equal(history.selected()?.id, "three");
	assert.equal(history.hasTimings(), true);
});
