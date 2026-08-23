import type { VoiceMode } from "./config.js";
import { SpeakableStream } from "./speakable.js";

export function hasSpeakableAudio(text: string): boolean {
	const stream = new SpeakableStream();
	return [...stream.push(text), ...stream.flush()].some(item => item.kind === "code" || item.text.trim().length > 0);
}

/** Returns true only when a completed assistant message has content this mode would speak. */
export function requiresVoiceAttention(text: string, mode: VoiceMode, stopReason: string | undefined): boolean {
	if (stopReason === undefined || stopReason === "aborted" || stopReason === "error") return false;
	if (mode === "yield" && stopReason === "toolUse") return false;
	return hasSpeakableAudio(text);
}
