export interface PlaybackSink {
	ready: Promise<void>;
	stopped: boolean;
	samplesWritten?: number;
	writable: {
		write(bytes: Buffer): boolean;
		once(event: string, listener: () => void): unknown;
		removeListener?(event: string, listener: () => void): unknown;
		destroyed?: boolean;
	};
	noteAudio?(samples: number): void;
	setPaused?(paused: boolean): void;
	stop(): void | Promise<void>;
	close(): Promise<void>;
}

export interface PlaybackController {
	startPlayer(sampleRate: number, utterance: number, output: string, createSink: (output: string, sampleRate: number, utterance: number) => PlaybackSink): PlaybackSink;
	setPlayerPaused(paused: boolean): void;
	resetPlayerPaused(): void;
	stopPlayer(): Promise<void>;
	writeAudio(sink: PlaybackSink, pcm: Float32Array): Promise<void>;
	closePlayer(utterance: number): Promise<boolean>;
	clearCurrentPlayer(): void;
	readonly currentPlayer: PlaybackSink | null;
}

export function createPlaybackController(options: { send: (message: unknown) => void }): PlaybackController;
