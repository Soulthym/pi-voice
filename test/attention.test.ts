import assert from "node:assert/strict";
import test from "node:test";
import { requiresVoiceAttention } from "../src/attention.js";

test("does not request attention for a tool-only assistant message", () => {
	assert.equal(requiresVoiceAttention("", "assistant", "toolUse"), false);
});

test("requests attention for prose or narrated code before a tool call", () => {
	assert.equal(requiresVoiceAttention("I will update the installation.", "assistant", "toolUse"), true);
	assert.equal(requiresVoiceAttention("```bash\nnpm install\n```", "assistant", "toolUse"), true);
});

test("keeps strict yield mode quiet for intermediate tool-use responses", () => {
	assert.equal(requiresVoiceAttention("Intermediate explanation", "yield", "toolUse"), false);
	assert.equal(requiresVoiceAttention("Final answer", "yield", "stop"), true);
});
