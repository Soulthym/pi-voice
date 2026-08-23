import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { narrationRenderKey } from "../src/render-identity.js";

test("render identity changes only with text or audio dependencies", () => {
	const base = narrationRenderKey("Hello", DEFAULT_VOICE_CONFIG, ["code-a"]);
	assert.equal(narrationRenderKey("Hello", { ...DEFAULT_VOICE_CONFIG }, ["code-a"]), base);
	assert.notEqual(narrationRenderKey("Changed", DEFAULT_VOICE_CONFIG, ["code-a"]), base);
	assert.notEqual(narrationRenderKey("Hello", { ...DEFAULT_VOICE_CONFIG, speed: 1.1 }, ["code-a"]), base);
	assert.notEqual(narrationRenderKey("Hello", { ...DEFAULT_VOICE_CONFIG, audioCacheBitrate: 24 }, ["code-a"]), base);
	assert.notEqual(narrationRenderKey("Hello", DEFAULT_VOICE_CONFIG, ["code-b"]), base);
	assert.equal(
		narrationRenderKey("Hello", { ...DEFAULT_VOICE_CONFIG, playbackHighlight: false }, ["code-a"]),
		base,
	);
});
