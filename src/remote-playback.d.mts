export const REMOTE_STOP_DEADLINE_MS: number;
export function validStreamId(id: unknown): id is string;
export function validBootId(id: unknown): id is string;
export class RemotePlaybackUnconfirmedError extends Error {
	readonly code: "REMOTE_PLAYBACK_UNCONFIRMED";
	constructor(message: string, options?: ErrorOptions);
}
/** nativeWatchdog requires persisted v4 capability; allowReboot requires original registered device identity. */
export function stopRemotePlayback(handle: { output: string; id: string; bootId?: string | null; deviceId?: string; allowReboot?: boolean; nativeWatchdog?: boolean }): Promise<void>;
