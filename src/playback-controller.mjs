/**
 * Player lifecycle shared by the voice worker. Extracted so tests can drive the
 * real draining/pause semantics with an injected sink instead of audio hardware.
 *
 * The regression this protects: `closePlayer` must keep the draining sink
 * addressable (pause/resume still reach it) until `sink.close()` resolves, and
 * `idle` may only be emitted afterwards.
 */
export function createPlaybackController({ send }) {
	let player = null;
	let playerUtterance = null;
	let playerOutput = null;

	function clearCurrentPlayer() {
		player = null;
		playerUtterance = null;
		playerOutput = null;
	}

	function startPlayer(sampleRate, utterance, output, createSink) {
		if (player && playerUtterance === utterance && playerOutput === output) return player;
		stopPlayer();
		const sink = createSink(output, sampleRate, utterance);
		player = sink;
		playerUtterance = utterance;
		playerOutput = output;
		send({ type: "speaking" });
		return sink;
	}

	function setPlayerPaused(paused) {
		try {
			player?.setPaused?.(paused);
		} catch {
			// Best-effort transport control.
		}
	}

	function stopPlayer() {
		const sink = player;
		clearCurrentPlayer();
		if (!sink) return;
		try {
			sink.stop();
		} catch {
			// Best-effort interruption.
		}
	}

	async function writeAudio(sink, pcm) {
		if (!(pcm instanceof Float32Array) || pcm.length === 0 || sink.stopped) return;
		await sink.ready;
		if (sink.stopped) return;
		sink.noteAudio(pcm.length);
		const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		if (!sink.writable.write(bytes)) await new Promise(resolve => sink.writable.once("drain", resolve));
	}

	async function closePlayer(utterance) {
		const sink = player;
		if (!sink || playerUtterance !== utterance) return;
		// Keep the draining sink addressable until the client player actually exits.
		// PCM is usually written much faster than it is heard; clearing here made F8
		// unable to pause the remaining buffered playback.
		await sink.close();
		if (player === sink) clearCurrentPlayer();
		send({ type: "idle", utterance });
	}

	return {
		startPlayer,
		setPlayerPaused,
		stopPlayer,
		writeAudio,
		closePlayer,
		clearCurrentPlayer,
		get currentPlayer() {
			return player;
		},
	};
}
