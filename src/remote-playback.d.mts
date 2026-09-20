export function validStreamId(id: unknown): id is string;
export class RemotePlaybackUnconfirmedError extends Error {
	readonly code: "REMOTE_PLAYBACK_UNCONFIRMED";
	constructor(message: string, options?: ErrorOptions);
}
export function stopRemotePlayback(handle: { output: string; id: string }): Promise<void>;
