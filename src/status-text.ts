export interface ReadyProgress {
	label: string;
	processed: number;
	total: number;
}

export function preprocessingStatus(progress: ReadyProgress): string {
	return `Preprocessing · ${progress.label.toLowerCase()}: ${progress.processed}/${progress.total} ready`;
}

export function pendingPlaybackTiming(messageIndex: number, messageCount: number): string {
	const message = messageIndex >= 0 ? `${messageIndex + 1}/${messageCount}` : "unknown";
	return `Playback · message ${message}: speech timing pending`;
}
