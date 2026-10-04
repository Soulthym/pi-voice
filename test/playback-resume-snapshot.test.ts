import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";

function fixture(id = "message", renderKey: string | undefined = id.startsWith("live:") ? undefined : "voice-speed-model") {
	const history = new PlaybackHistory();
	const message = { id, text: "First sentence. Second sentence.", renderKey };
	history.sync([message]);
	history.beginCapture(id, message.text);
	for (const [segmentId, source, time] of [[1, 0, 0], [2, 16, 10]]) {
		history.registerSegment({ id: segmentId, utterance: 1, text: message.text.slice(source), source: { start: source, end: message.text.length } });
		history.setSegmentAudio(segmentId, time, 10, "estimated", `pcm-${segmentId}`);
	}
	return { history, message };
}

test("paused mid-unit snapshot is detached and nonmutating and uses last physical feedback not estimates", () => {
	const { history, message } = fixture();
	history.setPlayback(1, 13.25, false);
	history.setPlayback(1, 14.5, true);
	const before = history.status();
	const snapshot = history.resumeSnapshot(true)!;
	assert.deepEqual(snapshot, { ...message, time: 10, sourceOffset: 16, skipUnits: 0,
		position: 14.5, paused: true, confirmedPosition: 13.25, audioOffset: { seconds: 3.25, audioIdentity: "pcm-2" } });
	assert.deepEqual(history.status(), before);
	assert.deepEqual(history.resumeSnapshot(true), snapshot);
	snapshot.audioOffset!.seconds = 9;
	assert.equal(history.resumeSnapshot(true)?.audioOffset?.seconds, 3.25);
});

test("live unfinished unit retains offset without final timing or render identity", () => {
	const { history } = fixture("live:1", undefined);
	history.setPlayback(1, 2.5, false);
	assert.equal(history.status()?.timingsComplete, false);
	assert.equal(history.resumeSnapshot()?.renderKey, undefined);
	assert.deepEqual(history.resumeSnapshot(false)?.audioOffset, { seconds: 2.5, audioIdentity: "pcm-1" });
});

test("estimated-only and legacy position ticks fall back to the unit beginning without moving display", () => {
	for (const estimated of [true, undefined]) {
		const { history } = fixture();
		history.setPlayback(1, 13, estimated);
		const snapshot = history.resumeSnapshot(true)!;
		assert.equal(snapshot.time, 10);
		assert.equal(snapshot.position, 13);
		assert.equal(snapshot.audioOffset, undefined);
		assert.equal(snapshot.confirmedPosition, undefined);
		assert.equal(history.status()?.position, 13);
	}
});

for (const change of ["voice/speed/model", "canonicalization", "dirty", "audio", "missing-identity"] as const) {
	test(`${change} invalidates offset confidence without skipping words`, () => {
		const { history, message } = fixture();
		history.setPlayback(1, 13, false);
		if (change === "voice/speed/model") history.syncMessage({ ...message, renderKey: "different" });
		if (change === "canonicalization") history.rename(message.id, { ...message, id: "canonical" });
		if (change === "dirty") history.invalidateCaptures();
		if (change === "audio") history.setSegmentAudio(2, 10, 10, "estimated", "replacement-pcm");
		if (change === "missing-identity") history.setSegmentAudio(2, 10, 10, "estimated");
		const before = history.status();
		const snapshot = history.resumeSnapshot(true)!;
		assert.equal(snapshot.sourceOffset, 16);
		assert.equal(snapshot.audioOffset, undefined);
		assert.deepEqual(history.status(), before);
	});
}

for (const invalidate of ["dirty", "render", "canonicalization", "audio"] as const) {
	test(`${invalidate} fallback cannot follow estimates past the last physically heard unit`, () => {
		const { history, message } = fixture();
		history.setPlayback(1, 8, false);
		history.setPlayback(1, 12, true);
		if (invalidate === "dirty") history.invalidateCaptures();
		if (invalidate === "render") history.syncMessage({ ...message, renderKey: "changed" });
		if (invalidate === "canonicalization") history.rename(message.id, { ...message, id: "canonical" });
		if (invalidate === "audio") history.setSegmentAudio(1, 0, 10, "estimated", "replaced");
		const snapshot = history.resumeSnapshot(true)!;
		assert.equal(snapshot.sourceOffset, 0);
		assert.equal(snapshot.audioOffset, undefined);
		assert.equal(snapshot.position, 12);
		assert.equal(history.status()?.position, 12);
	});
}

test("destructive source edits cannot reuse old physical source offsets", () => {
	for (const rename of [false, true]) {
		const { history, message } = fixture();
		history.setPlayback(1, 12, false);
		if (rename) history.rename(message.id, { ...message, id: "canonical", text: "Replacement." });
		else history.updateText(message.id, "Replacement.");
		assert.equal(history.resumeSnapshot()?.sourceOffset, 0);
		assert.equal(history.resumeSnapshot()?.audioOffset, undefined);
	}
});

test("physical progress in an uncacheable unit replaces the old unit's offset with a boundary fallback", () => {
	const { history } = fixture();
	history.setPlayback(1, 8, false);
	history.setSegmentAudio(2, 10, 10, "estimated");
	history.setPlayback(1, 12, false);
	assert.equal(history.resumeSnapshot()?.sourceOffset, 16);
	assert.equal(history.resumeSnapshot()?.audioOffset, undefined);
	assert.equal(history.resumeSnapshot()?.position, 12);
});

test("a queued utterance's metadata cannot become the audible offset provenance", () => {
	const { history, message } = fixture();
	history.registerSegment({ id: 3, utterance: 2, text: "queued", source: { start: 20, end: message.text.length } });
	history.setSegmentAudio(3, 0, 10, "estimated", "queued-pcm");
	history.setPlayback(1, 3, false);
	assert.equal(history.resumeSnapshot()?.sourceOffset, 0);
	assert.deepEqual(history.resumeSnapshot()?.audioOffset, { seconds: 3, audioIdentity: "pcm-1" });
});

test("out-of-range positions cannot create an offset or auto-advance to an unheard unit", () => {
	const { history } = fixture();
	history.setPlayback(1, 30, false);
	assert.equal(history.resumeSnapshot()?.audioOffset, undefined);
	assert.equal(history.resumeSnapshot()?.sourceOffset, 16);
});
