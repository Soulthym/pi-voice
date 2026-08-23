import assert from "node:assert/strict";
import test from "node:test";
import { codeDescriptionCacheKey, fallbackCodeDescription } from "../src/code-describer.js";

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
