import type { Message } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	if ("summary" in message && typeof message.summary === "string") return message.summary;
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

/** Converts Pi's resolved, compaction-aware context messages into stable text. */
export function contextTranscript(messages: readonly unknown[]): string {
	const transcript: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object" || !("role" in message) || typeof message.role !== "string") continue;
		const text = messageText(message).trim();
		if (!text) continue;
		const label = message.role.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, character => character.toUpperCase());
		transcript.push(`${label}:\n${text}`);
	}
	return transcript.join("\n\n");
}

export interface ResolvedCodeContext {
	/** Deterministic text used only for persistent cache identity. */
	transcript: string;
	/** Pi's provider-compatible messages, retaining normal role boundaries. */
	messages: Message[];
}

/** Resolves context at a historical leaf so later entries cannot change its identity. */
export function resolvedSessionContext(entries: readonly SessionEntry[], leafId?: string | null): ResolvedCodeContext {
	const resolved = buildSessionContext([...entries], leafId).messages;
	return {
		transcript: contextTranscript(resolved),
		messages: convertToLlm(resolved),
	};
}

/** Backward-compatible transcript-only projection. */
export function sessionContextTranscript(entries: readonly SessionEntry[], leafId?: string | null): string {
	return resolvedSessionContext(entries, leafId).transcript;
}

export function contextualTranscript(conversationBefore: string, messageThroughBlock: string): string {
	return [conversationBefore, `Assistant:\n${messageThroughBlock}`].filter(Boolean).join("\n\n");
}

/** Extends the exact resolved request prefix with the assistant output available through a block. */
export function contextualMessages(conversationBefore: readonly Message[], messageThroughBlock: string): Message[] {
	if (!messageThroughBlock) return [...conversationBefore];
	return [
		...conversationBefore,
		{
			role: "assistant",
			content: [{ type: "text", text: messageThroughBlock }],
			api: "pi-voice-context",
			provider: "pi-voice",
			model: "context",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	];
}
