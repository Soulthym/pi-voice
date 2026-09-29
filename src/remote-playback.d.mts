export function validStreamId(id: unknown): id is string;
export function validBootId(id: unknown): id is string;
export class RemotePlaybackUnconfirmedError extends Error {
	readonly code: "REMOTE_PLAYBACK_UNCONFIRMED";
	constructor(message: string, options?: ErrorOptions);
}
/** Set allowReboot only with persisted preparation identity matching the original registered deviceId. */
export function stopRemotePlayback(handle: { output: string; id: string; bootId?: string | null; deviceId?: string; allowReboot?: boolean }): Promise<void>;
