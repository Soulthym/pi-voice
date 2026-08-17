import assert from "node:assert/strict";
import test from "node:test";
import {
	normalizeEditModel,
	normalizeModelDtype,
	normalizeModelId,
	normalizeTalkShortcut,
	normalizeVoiceInput,
	normalizeVoiceOutput,
} from "../src/config.js";

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

test("normalizes configurable model selections", () => {
	assert.equal(normalizeModelId("onnx-community/whisper-small.en"), "onnx-community/whisper-small.en");
	assert.equal(normalizeModelId("bad model"), undefined);
	assert.equal(normalizeModelDtype("q4"), "q4");
	assert.equal(normalizeModelDtype("int3"), undefined);
	assert.equal(normalizeEditModel("current"), "current");
	assert.equal(normalizeEditModel("openai-codex/gpt-5.6-sol"), "openai-codex/gpt-5.6-sol");
	assert.equal(normalizeEditModel("missing-provider"), undefined);
});

test("normalizes configurable microphone shortcuts", () => {
	assert.equal(normalizeTalkShortcut("Alt+M"), "alt+m");
	assert.equal(normalizeTalkShortcut("ctrl+shift+m"), "ctrl+shift+m");
	assert.equal(normalizeTalkShortcut("PAGEUP"), "pageUp");
	assert.equal(normalizeTalkShortcut("ctrl++"), "ctrl++");
	assert.equal(normalizeTalkShortcut("disabled"), "disabled");
	assert.equal(normalizeTalkShortcut("ctrl+ctrl+m"), undefined);
	assert.equal(normalizeTalkShortcut("hyper+m"), undefined);
	assert.equal(normalizeTalkShortcut("not-a-key"), undefined);
});
