import type { KokoroTTS } from "kokoro-js";
import type { RawAudio } from "@huggingface/transformers";

export function generateSentenceAudio(
	model: KokoroTTS,
	text: string,
	options: Parameters<KokoroTTS["generate"]>[1],
	cancelled?: () => boolean,
): Promise<RawAudio>;
