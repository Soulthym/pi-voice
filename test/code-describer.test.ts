import assert from "node:assert/strict";
import test from "node:test";
import {
	codeDescriptionCacheKey,
	CodeDescriptionContextOverflowError,
	describeCodeBlock,
	fallbackCodeDescription,
} from "../src/code-describer.js";

test("keys identical blocks by their transcript context", () => {
	const model = { provider: "test", id: "model" };
	const ctx = { model, modelRegistry: { find: () => model } } as never;
	const block = { language: "json", code: '{ "enabled": true }' };
	const first = codeDescriptionCacheKey(ctx, block, "current", "guided", "Enable voice here.\n```json\n{ \"enabled\": true }\n```");
	const same = codeDescriptionCacheKey(ctx, block, "current", "guided", "Enable voice here.\n```json\n{ \"enabled\": true }\n```");
	const different = codeDescriptionCacheKey(ctx, block, "current", "guided", "Disable voice here.\n```json\n{ \"enabled\": true }\n```");
	assert.equal(first, same);
	assert.notEqual(first, different);
});

test("sends prior discussion and the concerned block exactly once", async () => {
	const model = { provider: "test", id: "model", contextWindow: 8_192, maxTokens: 1_024 };
	let request = "";
	const ctx = {
		model,
		modelRegistry: {
			find: () => model,
			complete: async (_model: unknown, context: { messages: Array<{ content: Array<{ text: string }> }> }) => {
				request = context.messages[0].content[0].text;
				return {
					role: "assistant",
					content: [{ type: "text", text: "It demonstrates the relevant behavior." }],
					stopReason: "stop",
				};
			},
		},
	} as never;
	const body = "UNIQUE_CONCERNED_BODY";

	await describeCodeBlock(ctx, { language: "ts", code: body }, "current", "summary", "User:\nExplain this example.");

	assert.match(request, /<discussion_before_block>[\s\S]*Explain this example\.[\s\S]*<\/discussion_before_block>/);
	assert.equal(request.split(body).length - 1, 1);
	assert.doesNotMatch(request, /transcript_through_block/);
});

test("rejects requests that cannot fit the selected model context", async () => {
	const model = { provider: "test", id: "tiny", contextWindow: 700, maxTokens: 128 };
	let completions = 0;
	const ctx = {
		model,
		modelRegistry: {
			find: () => model,
			complete: async () => {
				completions += 1;
				throw new Error("must not be called");
			},
		},
	} as never;

	await assert.rejects(
		describeCodeBlock(
			ctx,
			{ language: "ts", code: "const value = 1;" },
			"current",
			"summary",
			"A".repeat(200),
		),
		CodeDescriptionContextOverflowError,
	);
	assert.equal(completions, 0);
});

test("describes patch structure when model summarization is unavailable", () => {
	const description = fallbackCodeDescription({
		language: "diff",
		code: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n+line",
	});
	assert.equal(description, "A patch updates src/a.ts, with 2 additions and 1 deletion.");
});

test("semantically describes shell installation steps when model summarization is unavailable", () => {
	const description = fallbackCodeDescription({
		language: "bash",
		code: "cd ~/pi-voice\ngit pull\nmkdir -p ~/.local/bin\ninstall -m755 client/pi-voice-* ~/.local/bin/",
	});
	assert.equal(
		description,
		"This shell sequence opens the ~/pi-voice checkout, downloads the latest repository changes, ensures ~/.local/bin exists, and installs the Pi voice client scripts into ~/.local/bin/ with executable permissions.",
	);
});

test("describes the language and size of a non-patch fallback", () => {
	assert.equal(
		fallbackCodeDescription({ language: "ts", code: "const one = 1;\nconst two = 2;" }),
		"A TypeScript block contains 2 lines.",
	);
});
