import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextualTranscript, sessionContextTranscript } from "../src/code-context.js";

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

	const transcript = sessionContextTranscript(entries, "current-user");
	assert.match(transcript, /Earlier discussion summary/);
	assert.match(transcript, /Kept prompt/);
	assert.match(transcript, /Current prompt/);
	assert.doesNotMatch(transcript, /Old prompt that should be summarized/);
});

test("extends a stable conversation prefix only through the concerned block", () => {
	const before = "User:\nExplain the setting.";
	const first = contextualTranscript(before, "First explanation.\n```json\n{ \"enabled\": true }\n```");
	const same = contextualTranscript(before, "First explanation.\n```json\n{ \"enabled\": true }\n```");
	const later = contextualTranscript(`${before}\n\nAssistant:\nAn intervening answer.`, "```json\n{ \"enabled\": true }\n```");
	assert.equal(first, same);
	assert.notEqual(first, later);
});
