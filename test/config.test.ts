import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVoiceInput, normalizeVoiceOutput } from "../src/config.js";

test("accepts local playback and SSH tunnel endpoints", () => {
	assert.equal(normalizeVoiceOutput("local"), "local");
	assert.equal(normalizeVoiceOutput("tcp://127.0.0.1:8765"), "tcp://127.0.0.1:8765");
	assert.equal(normalizeVoiceInput("tcp://127.0.0.1:8766"), "tcp://127.0.0.1:8766");
	assert.equal(normalizeVoiceInput("disabled"), "disabled");
});

test("rejects unsafe or malformed tunnel endpoints", () => {
	assert.equal(normalizeVoiceOutput("http://127.0.0.1:8765"), undefined);
	assert.equal(normalizeVoiceOutput("tcp://user@127.0.0.1:8765"), undefined);
	assert.equal(normalizeVoiceInput("tcp://127.0.0.1"), undefined);
});
