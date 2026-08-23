import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_VOICE_CONFIG,
	normalizeAudioCacheBitrate,
	normalizeCodeDescriptionContext,
	normalizeEditModel,
	normalizeModelDtype,
	normalizeModelId,
	normalizePreprocessConcurrency,
	normalizeSttCandidates,
	normalizeTalkShortcut,
	normalizeVoiceInput,
	normalizeVoiceOutput,
	normalizeWorkerCount,
} from "../src/config.js";

test("defaults code descriptions to block-only context", () => {
	assert.equal(DEFAULT_VOICE_CONFIG.codeDescriptionContext, "block-only");
});

test("accepts local playback and SSH tunnel endpoints", () => {
	assert.equal(normalizeVoiceOutput("auto"), "auto");
	assert.equal(normalizeVoiceOutput("local"), "local");
	assert.equal(normalizeVoiceOutput("tcp://127.0.0.1:8765"), "tcp://127.0.0.1:8765");
	assert.equal(normalizeVoiceInput("tcp://127.0.0.1:8766"), "tcp://127.0.0.1:8766");
	assert.equal(normalizeVoiceInput("auto"), "auto");
	assert.equal(normalizeVoiceInput("local"), "local");
	assert.equal(normalizeVoiceInput("disabled"), "disabled");
	assert.equal(normalizeVoiceOutput("unix:///tmp/pi-voice.sock"), "unix:///tmp/pi-voice.sock");
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
	assert.equal(normalizeCodeDescriptionContext("block-only"), "block-only");
	assert.equal(normalizeCodeDescriptionContext("conversation"), "conversation");
	assert.equal(normalizeCodeDescriptionContext("session"), undefined);
	assert.equal(normalizeSttCandidates(3), 3);
	assert.equal(normalizeSttCandidates(0), undefined);
	assert.equal(normalizeSttCandidates(9), undefined);
	assert.equal(normalizeSttCandidates(2.5), undefined);
	assert.equal(normalizePreprocessConcurrency("AUTO"), "auto");
	assert.equal(normalizePreprocessConcurrency(4), 4);
	assert.equal(normalizePreprocessConcurrency(0), undefined);
	assert.equal(normalizePreprocessConcurrency(9), undefined);
	assert.equal(normalizeWorkerCount(4), 4);
	assert.equal(normalizeWorkerCount("auto"), undefined);
	assert.equal(normalizeAudioCacheBitrate(32), 32);
	assert.equal(normalizeAudioCacheBitrate(11), undefined);
	assert.equal(normalizeAudioCacheBitrate(129), undefined);
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
