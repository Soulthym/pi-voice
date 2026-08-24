import assert from "node:assert/strict";
import test from "node:test";
import {
	assessCodeDescriptionQuality,
	classifyCodeDescriptionFailure,
	codeDescriptionCacheKey,
	CodeDescriptionBudgetExhaustedError,
	CodeDescriptionContextOverflowError,
	CodeDescriptionQualityError,
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
	assert.notEqual(
		codeDescriptionCacheKey(ctx, block, "current", "guided", "", "block-only"),
		codeDescriptionCacheKey(ctx, block, "current", "guided", "", "conversation"),
	);
});

test("extends the normal prompt prefix and sends the concerned block exactly once", async () => {
	const model = { provider: "test", id: "model", contextWindow: 8_192, maxTokens: 1_024 };
	const prior = { role: "user", content: [{ type: "text", text: "Explain this example." }], timestamp: 1 };
	const normalTool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
	let submitted:
		| { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }>; tools?: unknown[] }
		| undefined;
	let options: { cacheRetention?: string; sessionId?: string } | undefined;
	const ctx = {
		model,
		modelRegistry: {
			find: () => model,
			complete: async (
				_model: unknown,
				context: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }>; tools?: unknown[] },
				requestOptions: { cacheRetention?: string; sessionId?: string },
			) => {
				submitted = context;
				options = requestOptions;
				return {
					role: "assistant",
					content: [{ type: "text", text: "It demonstrates the relevant behavior." }],
					stopReason: "stop",
				};
			},
		},
	} as never;
	const body = "UNIQUE_CONCERNED_BODY";
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: `Here it is.\n\`\`\`ts\n${body}\n\`\`\`` }],
	};

	await describeCodeBlock(ctx, { language: "ts", code: body }, "current", "summary", {
		messages: [prior, assistant] as never,
		normalPrompt: { systemPrompt: "NORMAL PI SYSTEM PROMPT", tools: [normalTool] as never, sessionId: "pi-session" },
	});

	assert.equal(submitted?.systemPrompt, "NORMAL PI SYSTEM PROMPT");
	assert.equal(submitted?.messages[0], prior);
	assert.equal(submitted?.messages[1], assistant);
	assert.deepEqual(submitted?.tools, [normalTool]);
	const serialized = JSON.stringify(submitted);
	assert.equal(serialized.split(body).length - 1, 1);
	assert.match(serialized, /code_narration_request/);
	assert.equal(options?.sessionId, "pi-session");
	assert.equal(options?.cacheRetention, undefined);
});

test("does not forward the active system prompt or tools to a different pinned model", async () => {
	const current = { provider: "current", id: "main", contextWindow: 8_192, maxTokens: 1_024 };
	const pinned = { provider: "remote", id: "narrator", contextWindow: 8_192, maxTokens: 1_024 };
	let submitted: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] } | undefined;
	let options: { cacheRetention?: string; sessionId?: string } | undefined;
	const ctx = {
		model: current,
		modelRegistry: {
			find: () => pinned,
			complete: async (
				_model: unknown,
				context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
				requestOptions: { cacheRetention?: string; sessionId?: string },
			) => {
				submitted = context;
				options = requestOptions;
				return { role: "assistant", content: [{ type: "text", text: "A concise description." }], stopReason: "stop" };
			},
		},
	} as never;

	await describeCodeBlock(ctx, { language: "ts", code: "run();" }, "remote/narrator", "summary", {
		messages: [
			{ role: "user", content: [{ type: "text", text: "Prior discussion." }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "```ts\nrun();\n```" }] },
		] as never,
		normalPrompt: {
			systemPrompt: "PRIVATE ACTIVE SYSTEM PROMPT",
			tools: [{ name: "private_tool", description: "Private", parameters: { type: "object" } }] as never,
			sessionId: "normal-session",
		},
	});

	assert.notEqual(submitted?.systemPrompt, "PRIVATE ACTIVE SYSTEM PROMPT");
	assert.equal(submitted?.tools, undefined);
	assert.equal((submitted?.messages[0] as { role: string }).role, "user");
	assert.equal(options?.cacheRetention, "none");
	assert.notEqual(options?.sessionId, "normal-session");
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
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "A".repeat(200) }], timestamp: 1 },
				] as never,
			},
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

const GOOD = "It registers the keyboard shortcuts that toggle spoken output.";

function scriptedCtx(replies: Array<{ text?: string; fail?: Error }>): {
	ctx: never;
	calls: () => number;
} {
	let index = 0;
	const ctx = {
		model: { provider: "test", id: "model", contextWindow: 8192, maxTokens: 1024 },
		modelRegistry: {
			find: () => ({ provider: "test", id: "model", contextWindow: 8192, maxTokens: 1024 }),
			complete: async () => {
				const next = replies[Math.min(index, replies.length - 1)];
				index += 1;
				if (next.fail) throw next.fail;
				return { role: "assistant", content: [{ type: "text", text: next.text ?? "" }], stopReason: "stop" };
			},
		},
	};
	return { ctx: ctx as never, calls: () => index };
}

test("quality gate rejects filler but keeps semantic descriptions", () => {
	assert.match(assessCodeDescriptionQuality("A JSON file contains 4 lines.") ?? "", /line counts/);
	assert.ok(assessCodeDescriptionQuality("A TypeScript block."));
	assert.ok(assessCodeDescriptionQuality("This code block is present."));
	assert.equal(assessCodeDescriptionQuality(GOOD), undefined);
});

test("failure classification separates fatal, quality, and transient", () => {
	const overflow = new CodeDescriptionContextOverflowError(10, 5, 100);
	assert.equal(classifyCodeDescriptionFailure(overflow), "fatal");
	assert.equal(classifyCodeDescriptionFailure(new CodeDescriptionBudgetExhaustedError()), "fatal");
	assert.equal(classifyCodeDescriptionFailure(new Error("aborted")), "fatal");
	assert.equal(classifyCodeDescriptionFailure(new Error("insufficient credits for provider")), "fatal");
	assert.equal(classifyCodeDescriptionFailure(new Error("network_error while streaming")), "transient");
	assert.equal(classifyCodeDescriptionFailure(new CodeDescriptionQualityError("too short")), "quality");
});

test("non-semantic replies are retried up to three times with a corrective nudge", async () => {
	const { ctx, calls } = scriptedCtx([
		{ text: "A JSON file contains 4 lines." },
		{ text: "This code block is present." },
		{ text: GOOD },
	]);
	let attempts = 0;
	const plan = await describeCodeBlock(ctx, { language: "ts", code: "run();" }, "current", "summary", undefined, undefined, {
		onAttempt: () => {
			attempts += 1;
		},
	});
	assert.match(JSON.stringify(plan), /keyboard shortcuts/);
	assert.equal(calls(), 3);
	assert.equal(attempts, 3);
});

test("persistently non-semantic replies fail after three attempts", async () => {
	const { ctx, calls } = scriptedCtx([{ text: "A JSON file contains 4 lines." }]);
	await assert.rejects(
		describeCodeBlock(ctx, { language: "ts", code: "run();" }, "current", "summary"),
		CodeDescriptionQualityError,
	);
	assert.equal(calls(), 3);
});

test("transient failures retry once; quota failures never retry", async () => {
	const transient = scriptedCtx([{ fail: new Error("network_error") }, { text: GOOD }]);
	assert.match(JSON.stringify(await describeCodeBlock(transient.ctx, { language: "ts", code: "run();" }, "current", "summary")), /keyboard/);
	assert.equal(transient.calls(), 2);

	const exhausted = scriptedCtx([{ fail: new Error("network_error") }]);
	await assert.rejects(describeCodeBlock(exhausted.ctx, { language: "ts", code: "run();" }, "current", "summary"));
	assert.equal(exhausted.calls(), 2);

	const quota = scriptedCtx([{ fail: new Error("402 insufficient credits") }]);
	await assert.rejects(describeCodeBlock(quota.ctx, { language: "ts", code: "run();" }, "current", "summary"), /credits/);
	assert.equal(quota.calls(), 1);
});
