import type { TimingQuality } from "./narration-progress.js";

/** Word alignment provenance is independent of the device playback clock. */
export function playbackTimingStatus(quality: TimingQuality | undefined, clockEstimated: boolean): string {
	const words = quality === "ctc-refined" ? "CTC-refined"
		: quality === "mixed" ? "mixed (includes estimates)"
		: quality === "estimated" ? "estimated" : "quality unknown";
	return ` · word timing: ${words}${clockEstimated ? " · playback clock: estimated" : ""}`;
}

export interface ReadyProgress {
	label: string;
	processed: number;
	total: number;
}

export interface VoiceProgressLine {
	kind: "input" | "playback" | "preprocessing";
	text: string;
}

export function preprocessingStatus(progress: ReadyProgress): string {
	return `Preprocessing · ${progress.label.toLowerCase()}: ${progress.processed}/${progress.total} ready`;
}

export function pendingPlaybackTiming(messageIndex: number, messageCount: number): string {
	const message = messageIndex >= 0 ? `message ${messageIndex + 1}/${messageCount}` : "current response";
	return `Playback · ${message}: speech timing pending`;
}

/** Keeps foreground activity nearest the editor and background work last. */
export function voiceProgressLines(
	input: string | undefined,
	playback: string | undefined,
	preprocessing: readonly ReadyProgress[],
): VoiceProgressLine[] {
	return [
		...(input ? [{ kind: "input" as const, text: input }] : []),
		...(playback ? [{ kind: "playback" as const, text: playback }] : []),
		...preprocessing.map(progress => ({ kind: "preprocessing" as const, text: preprocessingStatus(progress) })),
	];
}
