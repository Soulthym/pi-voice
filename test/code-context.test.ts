import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	assistantCodeContext,
	eligibleAssistantBlocks,
	contextualAssistantMessages,
	contextualAssistantMessagesThroughText,
	contextualTranscript,
	resolvedSessionContext,
	sessionContextTranscript,
	structuredContextIdentity,
} from "../src/code-context.js";

const message = (id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionEntry =>
	({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content: [{ type: "text", text }], timestamp: 0, ...(role === "assistant" ? { stopReason: "stop" } : {}) },
	}) as SessionEntry;

test("reconstructs an older block context through its preceding compaction", () => {
	const entries: SessionEntry[] = [
		message("old-user", null, "user", "Old prompt that should be summarized"),
		message("old-assistant", "old-user", "assistant", "Old answer"),
		message("kept-user", "old-assistant", "user", "Kept prompt"),
		{
			type: "compaction",
			id: "compaction",
			parentId: "kept-user",
			timestamp: "2026-01-01T00:00:01.000Z",
			summary: "Earlier discussion summary",
			firstKeptEntryId: "kept-user",
			tokensBefore: 100,
		},
		message("current-user", "compaction", "user", "Current prompt"),
	];

	const resolved = resolvedSessionContext(entries, "current-user");
	const transcript = sessionContextTranscript(entries, "current-user");
	assert.equal(transcript, resolved.transcript);
	assert.match(transcript, /Earlier discussion summary/);
	assert.match(transcript, /Kept prompt/);
	assert.match(transcript, /Current prompt/);
	assert.doesNotMatch(transcript, /Old prompt that should be summarized/);
	assert.deepEqual(resolved.messages.map(item => item.role), ["user", "user", "user"]);
	assert.match(JSON.stringify(resolved.messages[0]), /Earlier discussion summary/);
});

test("gives live and historical blocks the same structured identity", () => {
	const before = [{ role: "user", content: [{ type: "text", text: "Explain it." }], timestamp: 1 }] as never;
	const throughBlock = "Answer.\n```ts\nrun();\n```\n";
	const complete = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Consider the request." },
			{ type: "text", text: `${throughBlock}Later text.` },
		],
	};
	const partial = {
		...complete,
		content: [complete.content[0], { type: "text", text: throughBlock }],
	};
	const live = contextualAssistantMessages(before, partial);
	const historical = contextualAssistantMessagesThroughText(before, complete, throughBlock.length);
	partial.content[1] = { type: "text", text: `${throughBlock}Mutated later.` };

	assert.deepEqual(live.map(message => message.role), ["user", "assistant"]);
	assert.equal(structuredContextIdentity(live), structuredContextIdentity(historical));
	assert.match(JSON.stringify(historical), /Consider the request/);
	assert.doesNotMatch(JSON.stringify(historical), /Later text/);
	assert.doesNotMatch(JSON.stringify(live), /Mutated later/);
});

test("context boundary includes thinking, tools and following prose but not the next opening", () => {
	const before = [{ role: "user", content: "Question", timestamp: 1 }] as never;
	const code = "😀\n```ts\nrun();\n```\n";
	const partial = { role: "assistant", content: [
		{ type: "thinking", thinking: code + "Reason after code.\n" },
		{ type: "toolCall", id: "call", name: "read", arguments: { path: "file" } },
		{ type: "text", text: "Following answer.\n``" },
	] };
	assert.deepEqual(eligibleAssistantBlocks(partial, "all").map(block => block.contentIndex), [0, 2]);
	assert.deepEqual(eligibleAssistantBlocks(partial, "assistant").map(block => block.contentIndex), [2]);
	assert.equal(assistantCodeContext(before, partial, 0, code.length, false), undefined);
	partial.content[2].text += "`python\nexcluded()\n```\nExcluded prose.";
	const live = assistantCodeContext(before, partial, 0, code.length, false)!;
	const persisted = assistantCodeContext(before, partial, 0, code.length)!;
	assert.deepEqual(live, persisted);
	assert.match(JSON.stringify(live), /Reason after code/);
	assert.match(JSON.stringify(live), /toolCall/);
	assert.match(JSON.stringify(live), /Following answer/);
	assert.doesNotMatch(JSON.stringify(live), /python|excluded|Excluded/);
	assert.match(structuredContextIdentity(live), /^[a-f0-9]{64}$/);
	assert.equal(structuredContextIdentity(live), structuredContextIdentity(persisted));
	const signed = structuredClone(partial) as any;
	signed.content[0].thinkingSignature = "late provider signature";
	signed.content[2].textSignature = "late text signature";
	const signedContext = assistantCodeContext(before, signed, 0, code.length)!;
	assert.equal(structuredContextIdentity(live), structuredContextIdentity(signedContext));
	assert.doesNotMatch(JSON.stringify(signedContext), /late text signature/, "truncated blocks cannot retain whole-block signatures");
});

test("extends a stable conversation prefix only through the concerned block", () => {
	const before = "User:\nExplain the setting.";
	const first = contextualTranscript(before, "First explanation.\n```json\n{ \"enabled\": true }\n```");
	const same = contextualTranscript(before, "First explanation.\n```json\n{ \"enabled\": true }\n```");
	const later = contextualTranscript(`${before}\n\nAssistant:\nAn intervening answer.`, "```json\n{ \"enabled\": true }\n```");
	assert.equal(first, same);
	assert.notEqual(first, later);
});
