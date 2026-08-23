import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import type { PlaybackMessage, PlaybackTimingSnapshot } from "../src/playback-history.js";
import { PlaybackHistory } from "../src/playback-history.js";
import { narrationRenderKey } from "../src/render-identity.js";

/**
 * Reconstructs the pre-version-2 render identity. Version 2 exists precisely
 * because these keys were recorded against literal fenced-code narration, so a
 * legacy fixture must never satisfy the current implementation.
 */
function legacyVersion1Key(text: string, codeDependencies: readonly string[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				1,
				text,
				DEFAULT_VOICE_CONFIG.ttsModel,
				DEFAULT_VOICE_CONFIG.ttsDtype,
				DEFAULT_VOICE_CONFIG.voice,
				DEFAULT_VOICE_CONFIG.speed,
				DEFAULT_VOICE_CONFIG.codeNarration,
				DEFAULT_VOICE_CONFIG.audioCache ? ["opus", DEFAULT_VOICE_CONFIG.audioCacheBitrate] : ["pcm"],
				codeDependencies,
			]),
		)
		.digest("hex");
}

const TEXT = "Answer.\n```ts\nrun();\n```";
const CURRENT_KEY = narrationRenderKey(TEXT, DEFAULT_VOICE_CONFIG, ["code-a"]);

function message(id: string, renderKey: string): PlaybackMessage {
	return { id, text: TEXT, renderKey };
}

function snapshot(version: 1 | 2, id: string, renderKey: string): PlaybackTimingSnapshot {
	return {
		version,
		messageId: id,
		renderKey,
		duration: 2.5,
		checkpoints: [{ time: 0, duration: 2.5, sourceOffset: 0 }],
	} as PlaybackTimingSnapshot;
}

test("persisted version-1 timing identities can never satisfy the current key", () => {
	const legacy = legacyVersion1Key(TEXT, ["code-a"]);
	assert.notEqual(legacy, CURRENT_KEY);
	// Even identical inputs must differ purely through the identity version.
	assert.notEqual(legacyVersion1Key("Other", []), narrationRenderKey("Other", DEFAULT_VOICE_CONFIG, []));
});

test("restore rejects the legacy fixture while accepting equivalent current data", () => {
	const history = new PlaybackHistory();
	history.sync([message("m1", CURRENT_KEY)]);

	history.restore([snapshot(1, "m1", legacyVersion1Key(TEXT, ["code-a"]))]);
	assert.equal(history.status()!.hasTimings, false, "version-1 data must be rejected outright");

	history.restore([snapshot(2, "m1", legacyVersion1Key(TEXT, ["code-a"]))]);
	assert.equal(history.status()!.hasTimings, false, "stale keys must be rejected even under version 2");

	history.restore([snapshot(2, "m1", CURRENT_KEY)]);
	assert.equal(history.status()!.hasTimings, true);
});

test("rejecting legacy data preserves other messages and accepts later fresh work", () => {
	const history = new PlaybackHistory();
	const freshText = "Fresh answer without fences.";
	const freshKey = narrationRenderKey(freshText, DEFAULT_VOICE_CONFIG, []);
	history.sync([
		message("legacy-message", CURRENT_KEY),
		{ id: "fresh-message", text: freshText, renderKey: freshKey },
	]);

	history.restore([snapshot(2, "fresh-message", freshKey), snapshot(1, "legacy-message", legacyVersion1Key(TEXT, ["code-a"]))]);

	assert.equal(history.status()!.hasTimings, true, "unrelated accepted timings must survive a rejected snapshot");

	// Freshly recorded work for the formerly legacy message is still restorable.
	const refreshed = narrationRenderKey(TEXT, DEFAULT_VOICE_CONFIG, []);
	history.sync([message("legacy-message", refreshed)]);
	history.restore([snapshot(2, "legacy-message", refreshed)]);
	assert.equal(history.status()!.hasTimings, true);
});
