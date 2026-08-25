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
	let playerGeneration = 0;
	let desiredPaused = false;

	function clearCurrentPlayer() {
		player = null;
		playerUtterance = null;
		playerOutput = null;
	}

	function startPlayer(sampleRate, utterance, output, createSink) {
		if (player && playerUtterance === utterance && playerOutput === output) return player;
		stopPlayer();
		const sink = createSink(output, sampleRate, utterance);
		playerGeneration += 1;
		player = sink;
		playerUtterance = utterance;
		playerOutput = output;
		if (desiredPaused) {
			try {
				sink.setPaused?.(true);
			} catch {
				// Best-effort transport control.
			}
		}
		send({ type: "speaking" });
		return sink;
	}

	function setPlayerPaused(paused) {
		desiredPaused = paused === true;
		try {
			player?.setPaused?.(desiredPaused);
		} catch {
			// Best-effort transport control.
		}
	}

	function resetPlayerPaused() {
		desiredPaused = false;
	}

	function stopPlayer() {
		const sink = player;
		if (sink) playerGeneration += 1;
		clearCurrentPlayer();
		if (!sink) return Promise.resolve();
		try {
			return Promise.resolve(sink.stop()).catch(() => {});
		} catch {
			// Best-effort interruption.
			return Promise.resolve();
		}
	}

	function waitForWritable(sink) {
		return new Promise(resolve => {
			const writable = sink.writable;
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				writable.removeListener?.("drain", finish);
				writable.removeListener?.("close", finish);
				writable.removeListener?.("error", finish);
				resolve();
			};
			writable.once("drain", finish);
			writable.once("close", finish);
			writable.once("error", finish);
			if (sink.stopped || writable.destroyed) finish();
		});
	}

	async function writeAudio(sink, pcm) {
		if (!(pcm instanceof Float32Array) || pcm.length === 0 || sink.stopped) return;
		await sink.ready;
		if (sink.stopped) return;
		sink.noteAudio(pcm.length);
		const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		if (!sink.writable.write(bytes)) await waitForWritable(sink);
	}

	async function closePlayer(utterance) {
		const sink = player;
		if (!sink || playerUtterance !== utterance) return false;
		const generation = playerGeneration;
		// Keep the draining sink addressable until the client player actually exits.
		// PCM is usually written much faster than it is heard; clearing here made F8
		// unable to pause the remaining buffered playback.
		await sink.close();
		if (sink.stopped || generation !== playerGeneration) return false;
		if (player === sink) clearCurrentPlayer();
		desiredPaused = false;
		send({ type: "idle", utterance });
		return true;
	}

	return {
		startPlayer,
		setPlayerPaused,
		resetPlayerPaused,
		stopPlayer,
		writeAudio,
		closePlayer,
		clearCurrentPlayer,
		get currentPlayer() {
			return player;
		},
	};
}
