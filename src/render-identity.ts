import { createHash } from "node:crypto";
import type { VoiceConfig } from "./config.js";

const RENDER_IDENTITY_VERSION = 1;

/** Identifies every input that can change rendered segment audio or boundaries. */
export function narrationRenderKey(text: string, config: VoiceConfig, codeDependencies: readonly string[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				RENDER_IDENTITY_VERSION,
				text,
				config.ttsModel,
				config.ttsDtype,
				config.voice,
				config.speed,
				config.codeNarration,
				config.audioCache ? ["opus", config.audioCacheBitrate] : ["pcm"],
				codeDependencies,
			]),
		)
		.digest("hex");
}
