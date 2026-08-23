import assert from "node:assert/strict";
import test from "node:test";
import { pendingPlaybackTiming, preprocessingStatus } from "../src/status-text.js";

test("distinguishes session preprocessing progress from selected-message playback state", () => {
	assert.equal(
		preprocessingStatus({ label: "Speech timing", processed: 109, total: 284 }),
		"Preprocessing · speech timing: 109/284 ready",
	);
	assert.equal(pendingPlaybackTiming(279, 284), "Playback · message 280/284: speech timing pending");
});
