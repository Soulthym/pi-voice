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

function providerMessagesForAssistant(conversationBefore: readonly Message[], assistant: unknown): Message[] {
	return [...conversationBefore, ...convertToLlm([structuredClone(assistant)] as never)];
}

/** Extends a resolved request prefix with an actual live or persisted assistant message. */
export function contextualAssistantMessages(conversationBefore: readonly Message[], assistant: unknown): Message[] {
	return providerMessagesForAssistant(conversationBefore, assistant);
}

/**
 * Truncates a persisted assistant message at an offset in its text-only joined
 * display, while retaining preceding thinking and tool-call content exactly.
 */
export function contextualAssistantMessagesThroughText(
	conversationBefore: readonly Message[],
	assistant: unknown,
	textOffset: number,
): Message[] {
	if (!assistant || typeof assistant !== "object" || !("content" in assistant) || !Array.isArray(assistant.content)) {
		return [...conversationBefore];
	}
	let joinedOffset = 0;
	let seenText = false;
	const content: unknown[] = [];
	for (const block of assistant.content) {
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text" || !("text" in block) || typeof block.text !== "string") {
			content.push(structuredClone(block));
			continue;
		}
		if (seenText) joinedOffset += 1; // assistantText() joins text blocks with one newline.
		seenText = true;
		const localEnd = Math.max(0, Math.min(block.text.length, textOffset - joinedOffset));
		content.push({ ...structuredClone(block), text: block.text.slice(0, localEnd) });
		if (localEnd < block.text.length || joinedOffset + block.text.length >= textOffset) break;
		joinedOffset += block.text.length;
	}
	return providerMessagesForAssistant(conversationBefore, { ...structuredClone(assistant), content });
}

function providerVisibleMessage(message: Message): unknown {
	if (message.role === "user") return { role: message.role, content: message.content };
	if (message.role === "assistant") return { role: message.role, content: message.content };
	return {
		role: message.role,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: message.content,
		isError: message.isError,
	};
}

/** Deterministic identity for the content providers actually receive. */
export function structuredContextIdentity(messages: readonly Message[]): string {
	return JSON.stringify(messages.map(providerVisibleMessage));
}
