import assert from "node:assert/strict";
import test from "node:test";
import { describeCodeBlock } from "../src/code-describer.js";
import { parseCodeDescriptionCacheSnapshot } from "../src/code-description-cache.js";

test("summary generation and restoration share bounded validation without truncation", async () => {
	let calls = 0;
	const model = { provider: "test", id: "test", contextWindow: 8192 };
	const speech = "It registers the command. ".repeat(66).trim();
	const ctx = { model, modelRegistry: { complete: async () => {
		calls++;
		return { content: [{ type: "text", text: calls === 1 ? speech : "It registers the command." }], stopReason: "stop" };
	} } } as never;
	const plan = await describeCodeBlock(ctx, { language: "ts", code: "register();" }, "current", "summary");
	assert.equal(calls, 2);
	assert.equal(plan.records[0].speech, "It registers the command.");
	assert.deepEqual(parseCodeDescriptionCacheSnapshot({ version: 1, key: "a".repeat(64), plan })?.plan, plan);
});
