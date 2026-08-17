import assert from "node:assert/strict";
import test from "node:test";
import { buildSpokenEditRequest, cleanRevisedPrompt } from "../src/prompt-editor.js";

test("separates the existing draft from new spoken editing instructions", () => {
	const request = buildSpokenEditRequest("Use port 8000.", "Actually, replace 8000 with 8080.");
	assert.match(request, /<existing_draft>\nUse port 8000\.\n<\/existing_draft>/);
	assert.match(request, /<new_dictation>\nActually, replace 8000 with 8080\.\n<\/new_dictation>/);
});

test("cleans fenced model output before placing it in the editor", () => {
	assert.equal(cleanRevisedPrompt("```text\nUse port 8080.\n```"), "Use port 8080.");
	assert.equal(cleanRevisedPrompt("  Keep this exact draft.  "), "Keep this exact draft.");
});
