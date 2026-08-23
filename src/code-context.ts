import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

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

/** Resolves context at a historical leaf so later entries cannot change its cache identity. */
export function sessionContextTranscript(entries: readonly SessionEntry[], leafId?: string | null): string {
	return contextTranscript(buildSessionContext([...entries], leafId).messages);
}

export function contextualTranscript(conversationBefore: string, messageThroughBlock: string): string {
	return [conversationBefore, `Assistant:\n${messageThroughBlock}`].filter(Boolean).join("\n\n");
}
