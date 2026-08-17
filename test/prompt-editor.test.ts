import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCandidateResolutionRequest,
	buildSessionContextExcerpt,
	buildSpokenEditRequest,
	cleanRevisedPrompt,
	parseEditModelSelector,
} from "../src/prompt-editor.js";

test("separates the draft, context, and ASR alternatives for spoken edits", () => {
	const request = buildSpokenEditRequest(
		"Use port 8000.",
		["Actually, replace 8000 with 8080.", "Actually replace port eight thousand with eighty eighty."],
		"user: Configure the HTTP port.",
	);
	assert.match(request, /<recent_session_context_json>\n"user: Configure the HTTP port\."/);
	assert.match(request, /<existing_draft_json>\n"Use port 8000\."/);
	assert.match(request, /"Actually, replace 8000 with 8080\."/);
	assert.match(request, /"Actually replace port eight thousand with eighty eighty\."/);
});

test("builds the same bounded evidence payload for append-mode resolution", () => {
	const request = buildCandidateResolutionRequest("Run pi-voice.", ["Clear the cash.", "Clear the cache."]);
	assert.match(request, /<asr_candidates_json>/);
	assert.match(request, /"Clear the cash\."/);
	assert.match(request, /"Clear the cache\."/);
});

test("extracts recent user and assistant text without tool content", () => {
	const excerpt = buildSessionContextExcerpt([
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Work on pi-voice." }] } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "secret tool output" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "The cache is local." }] } },
	]);
	assert.equal(excerpt, "user: Work on pi-voice.\n\nassistant: The cache is local.");
	assert.doesNotMatch(excerpt, /secret tool output/);
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
