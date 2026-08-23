export interface PlaybackSink {
	ready: Promise<void>;
	stopped: boolean;
	samplesWritten?: number;
	writable: {
		write(bytes: Buffer): boolean;
		once(event: string, listener: () => void): unknown;
	};
	noteAudio?(samples: number): void;
	setPaused?(paused: boolean): void;
	stop(): void;
	close(): Promise<void>;
}

export interface PlaybackController {
	startPlayer(sampleRate: number, utterance: number, output: string, createSink: (output: string, sampleRate: number, utterance: number) => PlaybackSink): PlaybackSink;
	setPlayerPaused(paused: boolean): void;
	stopPlayer(): void;
	writeAudio(sink: PlaybackSink, pcm: Float32Array): Promise<void>;
	closePlayer(utterance: number): Promise<void>;
	clearCurrentPlayer(): void;
	readonly currentPlayer: PlaybackSink | null;
}

export function createPlaybackController(options: { send: (message: unknown) => void }): PlaybackController;
