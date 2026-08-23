import assert from "node:assert/strict";
import test from "node:test";
import { pendingPlaybackTiming, preprocessingStatus, voiceProgressLines } from "../src/status-text.js";

test("distinguishes session preprocessing progress from selected-message playback state", () => {
	assert.equal(
		preprocessingStatus({ label: "Speech timing", processed: 109, total: 284 }),
		"Preprocessing · speech timing: 109/284 ready",
	);
	assert.equal(pendingPlaybackTiming(279, 284), "Playback · message 280/284: speech timing pending");
	assert.equal(pendingPlaybackTiming(-1, 284), "Playback · current response: speech timing pending");
});

test("orders immediate input, playback, and background preprocessing consistently", () => {
	assert.deepEqual(
		voiceProgressLines("🎙 Listening", "▶ Playback", [
			{ label: "Code descriptions", processed: 2, total: 5 },
			{ label: "Speech timing", processed: 3, total: 8 },
		]),
		[
			{ kind: "input", text: "🎙 Listening" },
			{ kind: "playback", text: "▶ Playback" },
			{ kind: "preprocessing", text: "Preprocessing · code descriptions: 2/5 ready" },
			{ kind: "preprocessing", text: "Preprocessing · speech timing: 3/8 ready" },
		],
	);
});
