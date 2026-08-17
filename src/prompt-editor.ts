import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `You are a voice-dictation prompt editor. Return only the complete revised prompt, with no preamble, explanation, quotation marks, or Markdown fence.

You receive an existing draft and one newly dictated utterance.

Rules:
- If the utterance continues the draft, append it naturally without changing unrelated text.
- If it corrects, retracts, replaces, deletes, restructures, or reformats earlier text, apply that instruction to the draft instead of appending the instruction literally.
- Understand natural corrections such as "actually", "I meant", "scratch that", "replace X with Y", "delete the last sentence", and "make the second paragraph shorter".
- Preserve technical spelling, paths, code, punctuation, and formatting unless the utterance asks to change them.
- Never answer or execute the draft. Your entire response must be the revised draft only.`;

export function buildSpokenEditRequest(draft: string, utterance: string): string {
	return `<existing_draft>\n${draft}\n</existing_draft>\n\n<new_dictation>\n${utterance}\n</new_dictation>`;
}

export function parseEditModelSelector(selector: string): { provider: string; modelId: string } | undefined {
	if (selector === "current") return undefined;
	const separator = selector.indexOf("/");
	if (separator <= 0 || separator === selector.length - 1) throw new Error(`Invalid editing model: ${selector}`);
	return { provider: selector.slice(0, separator), modelId: selector.slice(separator + 1) };
}

export function cleanRevisedPrompt(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```$/);
	return (fenced?.[1] ?? trimmed).trim();
}

/** Uses Pi's currently selected model in an isolated, non-conversation request. */
export async function applySpokenEdit(
	ctx: ExtensionContext,
	draft: string,
	utterance: string,
	modelSelector = "current",
): Promise<string> {
	const selected = parseEditModelSelector(modelSelector);
	const model = selected ? ctx.modelRegistry.find(selected.provider, selected.modelId) : ctx.model;
	if (!model) throw new Error(`Voice editing model is unavailable: ${modelSelector}`);
	const message: Message = {
		role: "user",
		content: [{ type: "text", text: buildSpokenEditRequest(draft, utterance) }],
		timestamp: Date.now(),
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Smart voice edit timed out")), 60_000);
	timer.unref?.();
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{ systemPrompt: SYSTEM_PROMPT, messages: [message] },
			{
				signal: controller.signal,
				reasoningEffort: "minimal",
				maxTokens: 4_096,
				cacheRetention: "none",
				sessionId: randomUUID(),
			},
		);
		if (response.stopReason === "aborted" || response.stopReason === "error") {
			throw new Error(`Smart voice edit ${response.stopReason}`);
		}
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text)
			.join("\n");
		const revised = cleanRevisedPrompt(text);
		if (!revised) throw new Error("The current model returned an empty voice edit");
		return revised;
	} finally {
		clearTimeout(timer);
	}
}
