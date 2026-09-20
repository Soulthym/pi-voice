import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { narrationRenderKey } from "../src/render-identity.js";

test("formatted sentence boundaries invalidate prior render timing identities", () => {
	const config = DEFAULT_VOICE_CONFIG;
	const text = "**First.** Second.";
	const oldKey = createHash("sha256").update(JSON.stringify([
		3, text, config.ttsModel, config.ttsDtype, config.voice, config.speed,
		config.codeNarration, config.audioCache ? ["opus", config.audioCacheBitrate] : ["pcm"], [],
	])).digest("hex");
	assert.notEqual(narrationRenderKey(text, config, []), oldKey);
});

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
