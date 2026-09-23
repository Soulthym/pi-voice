import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlaybackStatus } from "./playback-history.js";

/** Pi supplies severity icons/colors; the text also stands alone in RPC/plain output. */
export function notifyVoice(ctx: ExtensionContext | null | undefined, message: string, level: "info" | "warning" | "error", episode?: { notified: boolean }): void {
	if (!ctx || episode?.notified) return;
	if (episode) episode.notified = true;
	ctx.ui.notify(`Voice · ${message.replace(/^Voice(?: · |: | )/, "")}`, level);
}

/** Word alignment provenance is independent of the device playback clock. */
export function playbackTimingStatus(coverage: PlaybackStatus["wordTimingCoverage"]): string {
	// Non-breaking padding keeps the count token's width stable under native Text wrapping.
	return coverage
		? `Word timing: ${String(coverage.estimated).padStart(String(coverage.total).length, "\u00a0")}/${coverage.total} estimated`
		: "Word timing: unknown/pending";
}

export function playbackStateLabel(paused: boolean, state: string, waiting = false): string {
	return paused ? "⏯ Paused" : waiting || state === "loading" || state === "downloading" ? "◷ Waiting"
		: state === "speaking" ? "▶ Playing" : "○ Idle";
}

export interface ReadyProgress {
	label: string;
	processed: number;
	total: number;
	unit?: "checked" | "processed" | "ready";
	detail?: string;
}

export interface VoiceProgressLine {
	kind: "input" | "playback" | "preprocessing" | "timing";
	text: string;
}

export function preprocessingStatus(progress: ReadyProgress): string {
	return `↺ ${progress.label} · ${progress.processed}/${progress.total} targets ${progress.unit ?? "ready"}${progress.detail ? ` · ${progress.detail}` : ""}`;
}

export function pendingPlaybackTiming(messageIndex: number, messageCount: number): string {
	const message = messageIndex >= 0 ? `message ${messageIndex + 1}/${messageCount}` : "current response";
	return `${message} · timing pending`;
}

export function deviceBadge(name: string, width: number): string {
	return `[${truncateToWidth(name, Math.max(0, Math.min(24, Math.floor(width / 2) - 2)))}]`;
}

/** Reserve the first physical row for the selected identity, without adding a row on narrow terminals. */
export function deviceProgressLines(lines: readonly string[], name: string, width: number, hint = ""): string[] {
	if (!lines.length || width < 1) return [];
	const badge = deviceBadge(name, width);
	const suffix = ` ${hint && width >= visibleWidth(badge) + visibleWidth(hint) + 8 ? `${hint} ` : ""}${badge}`;
	const first = truncateToWidth(lines[0], Math.max(0, width - visibleWidth(suffix))) + suffix;
	return [truncateToWidth(first, width), ...(lines.length > 1 ? wrapTextWithAnsi(lines.slice(1).join("\n"), width) : [])];
}

/** Keeps foreground activity nearest the editor and background work last. */
export function voiceProgressLines(
	input: string | undefined,
	playback: string | undefined,
	preprocessing: readonly ReadyProgress[],
	wordTiming?: string,
): VoiceProgressLine[] {
	return [
		...(input ? [{ kind: "input" as const, text: input }] : []),
		...(playback ? [{ kind: "playback" as const, text: playback }] : []),
		...preprocessing.map(progress => ({ kind: "preprocessing" as const, text: preprocessingStatus(progress) })),
		...(wordTiming ? [{ kind: "timing" as const, text: wordTiming }] : []),
	];
}
