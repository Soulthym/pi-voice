import assert from "node:assert/strict";
import test from "node:test";
import { buildSpokenEditRequest, cleanRevisedPrompt, parseEditModelSelector } from "../src/prompt-editor.js";

test("separates the existing draft from new spoken editing instructions", () => {
	const request = buildSpokenEditRequest("Use port 8000.", "Actually, replace 8000 with 8080.");
	assert.match(request, /<existing_draft>\nUse port 8000\.\n<\/existing_draft>/);
	assert.match(request, /<new_dictation>\nActually, replace 8000 with 8080\.\n<\/new_dictation>/);
});

test("resolves current and explicitly selected editing models", () => {
	assert.equal(parseEditModelSelector("current"), undefined);
	assert.deepEqual(parseEditModelSelector("openai-codex/gpt-5.6-sol"), {
		provider: "openai-codex",
		modelId: "gpt-5.6-sol",
	});
	assert.throws(() => parseEditModelSelector("missing-provider"), /Invalid editing model/);
});

test("cleans fenced model output before placing it in the editor", () => {
	assert.equal(cleanRevisedPrompt("```text\nUse port 8080.\n```"), "Use port 8080.");
	assert.equal(cleanRevisedPrompt("  Keep this exact draft.  "), "Keep this exact draft.");
});
