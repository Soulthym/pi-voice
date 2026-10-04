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

for (const position of [-1, NaN, Infinity, -Infinity, 30]) test(`invalid position ${position} cannot advance an unheard unit`, () => {
	const { history } = fixture();
	for (const heard of [false, true]) {
		if (heard) history.setPlayback(1, 3, false);
		const before = history.resumeSnapshot(true);
		history.setPlayback(1, position, false);
		assert.deepEqual(history.resumeSnapshot(true), before);
	}
});

test("valid position 15 advances to the second unit, but reordered feedback cannot rewind it", () => {
	const { history } = fixture();
	history.setPlayback(1, 15, false);
	assert.equal(history.resumeSnapshot()?.sourceOffset, 16);
	assert.deepEqual(history.resumeSnapshot()?.audioOffset, { seconds: 5, audioIdentity: "pcm-2" });
	const before = history.resumeSnapshot();
	history.setPlayback(1, 3, false);
	assert.deepEqual(history.resumeSnapshot(), before);
});

for (const fault of ["gap", "unknown-audio", "outside-source", "negative-source", "overlap"] as const) test(`${fault} feedback leaves the trusted cursor alone`, () => {
	const { history, message } = fixture();
	history.setPlayback(1, 3, false);
	if (fault === "gap") history.setSegmentAudio(2, 15, 10, "estimated", "pcm-2");
	if (fault === "overlap") history.setSegmentAudio(2, 5, 10, "estimated", "pcm-2");
	if (["unknown-audio", "outside-source", "negative-source"].includes(fault)) {
		history.registerSegment({ id: 3, utterance: 1, text: "Invalid", source: {
			start: fault === "outside-source" ? message.text.length : fault === "negative-source" ? -1 : 16, end: message.text.length } });
		if (fault !== "unknown-audio") history.setSegmentAudio(3, 20, 10, "estimated", "pcm-3");
	}
	const before = history.resumeSnapshot();
	history.setPlayback(1, fault === "gap" ? 12 : fault === "overlap" ? 7 : 25, false);
	assert.deepEqual(history.resumeSnapshot(), before);
});

test("exact boundaries use the next known unit or conservatively repeat a lone EOF", () => {
	const { history } = fixture();
	for (const [position, sourceOffset] of [[10, 16], [20, 16]]) {
		history.setPlayback(1, position - 5, false);
		history.setPlayback(1, position, false);
		assert.equal(history.resumeSnapshot()?.sourceOffset, sourceOffset);
		assert.deepEqual(history.resumeSnapshot()?.audioOffset, position === 10 ? { seconds: 0, audioIdentity: "pcm-2" } : undefined);
		assert.equal(history.resumeSnapshot()?.position, position);
	}
});

for (const estimated of [false, true]) test(`PCM sample-clock EOF tolerates only floating-point roundoff (estimated=${estimated})`, () => {
	const { history } = fixture();
	const rate = 24_000;
	history.setSegmentAudio(1, 0, 2400 / rate, "estimated", "pcm-1");
	history.setSegmentAudio(2, 2400 / rate, 16800 / rate, "estimated", "pcm-2");
	assert.equal(history.setPlayback(1, 0.05, estimated), true);
	const before = history.resumeSnapshot();
	for (const position of [19201 / rate, 0.800000001]) {
		assert.equal(history.setPlayback(1, position, estimated), false);
		assert.deepEqual(history.resumeSnapshot(), before);
	}
	assert.equal(history.setPlayback(1, (2400 + 16800) / rate, estimated), true);
	assert.equal(history.resumeSnapshot()?.sourceOffset, 16);
	assert.equal(history.resumeSnapshot()?.audioOffset, undefined, "EOF conservatively repeats the unit");
	assert.equal(history.resumeSnapshot()?.position, 2400 / rate + 16800 / rate);
	const eof = history.resumeSnapshot();
	assert.equal(history.setPlayback(1, 0.4, estimated), false);
	assert.deepEqual(history.resumeSnapshot(), eof);
});

test("sample-sized gaps remain invalid while rounded shared boundaries select the next unit", () => {
	const { history, message } = fixture();
	const end = 2400 / 24_000 + 16800 / 24_000;
	history.setSegmentAudio(1, 0, end, "estimated", "pcm-1");
	history.setSegmentAudio(2, 0.8, 0.1, "estimated", "pcm-2");
	assert.equal(history.setPlayback(1, end, false), true);
	assert.equal(history.resumeSnapshot()?.sourceOffset, 16);
	assert.deepEqual(history.resumeSnapshot()?.audioOffset, { seconds: 0, audioIdentity: "pcm-2" });
	history.registerSegment({ id: 3, utterance: 1, text: "Third", source: { start: 20, end: message.text.length } });
	history.setSegmentAudio(3, 0.9 + 2 / 24_000, 0.1, "estimated", "pcm-3");
	const before = history.resumeSnapshot();
	assert.equal(history.setPlayback(1, 0.9 + 1 / 24_000, false), false);
	assert.deepEqual(history.resumeSnapshot(), before);
});

test("canonicalization can snapshot a specific paused record without selecting it", () => {
	const { history, message } = fixture();
	history.setPlayback(1, 3, false);
	const before = history.resumeSnapshot(true);
	history.sync([message, { id: "other", text: "Queued." }], true);
	assert.equal(history.selected()?.id, "other");
	assert.deepEqual(history.resumeSnapshot(true, message.id), before);
	assert.equal(history.selected()?.id, "other");
	assert.equal(history.resumeSnapshot(true, "missing"), undefined);
});
