import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackController, type PlaybackSink } from "../src/playback-controller.mjs";

function deferred(): PromiseWithResolvers<void> {
	return Promise.withResolvers();
}

interface FakeSinkResult {
	sink: PlaybackSink;
	events: string[];
	resolveClose: () => void;
}

function fakeSink(): FakeSinkResult {
	const events: string[] = [];
	const closeGate = deferred();
	const sink = {
		ready: Promise.resolve(),
		stopped: false,
		samplesWritten: 0,
		writable: {
			write(): boolean {
				return true;
			},
			once(): void {},
		},
		noteAudio(samples: number): void {
			this.samplesWritten += samples;
			events.push(`audio:${samples}`);
		},
		setPaused(paused: boolean): void {
			events.push(paused ? "paused" : "resumed");
		},
		stop(): void {
			this.stopped = true;
			events.push("stopped");
		},
		async close(): Promise<void> {
			events.push("closing");
			await closeGate.promise;
			events.push("closed");
		},
	} as PlaybackSink & { samplesWritten: number };
	return { sink, events, resolveClose: () => closeGate.resolve() };
}

test("pause and resume reach the sink while it drains, and idle waits for closure", async () => {
	const sent: unknown[] = [];
	const playback = createPlaybackController({ send: (event: unknown) => sent.push(event) });
	const fake = fakeSink();

	const sink = playback.startPlayer(24_000, 7, "local", () => fake.sink);
	assert.equal(sink, fake.sink);
	assert.deepEqual(sent, [{ type: "speaking" }]);

	await playback.writeAudio(sink, new Float32Array(24_000));
	assert.equal((fake.sink as unknown as { samplesWritten: number }).samplesWritten, 24_000);

	// The utterance ends while the client player is still draining.
	const drained = playback.closePlayer(7);
	await new Promise(resolve => setImmediate(resolve));
	assert.ok(fake.events.includes("closing"), "close must have started");
	assert.equal(sent.some(event => (event as { type: string }).type === "idle"), false, "idle must wait for closure");

	playback.setPlayerPaused(true);
	playback.setPlayerPaused(false);
	assert.deepEqual(
		fake.events.filter(item => item === "paused" || item === "resumed"),
		["paused", "resumed"],
		"a draining sink must remain addressable",
	);
	assert.equal(playback.currentPlayer, sink);

	fake.resolveClose();
	await drained;
	assert.deepEqual(sent.at(-1), { type: "idle", utterance: 7 });
	assert.equal(playback.currentPlayer, null);
});

test("stop interrupts a draining sink without waiting for closure", () => {
	const sent: unknown[] = [];
	const playback = createPlaybackController({ send: (event: unknown) => sent.push(event) });
	const fake = fakeSink();

	playback.startPlayer(24_000, 3, "local", () => fake.sink);
	playback.stopPlayer();

	assert.ok(fake.sink.stopped);
	assert.equal(playback.currentPlayer, null);
	assert.equal(fake.events.includes("closing"), false);
});

test("a stale end for another utterance never closes the active player", async () => {
	const sent: unknown[] = [];
	const playback = createPlaybackController({ send: (event: unknown) => sent.push(event) });
	const active = fakeSink();
	const created: FakeSinkResult[] = [active];

	playback.startPlayer(24_000, 1, "local", () => created[0].sink);
	await playback.closePlayer(999);

	assert.equal(active.events.includes("closing"), false);
	assert.equal(sent.filter(event => (event as { type: string }).type === "idle").length, 0);
});

test("restarting the same utterance reuses the sink; different utterances replace it", () => {
	const playback = createPlaybackController({ send: () => {} });
	const firstFake = fakeSink();
	const secondFake = fakeSink();
	let next = 0;
	const factory = (): PlaybackSink => (next === 0 ? firstFake.sink : secondFake.sink);

	const first = playback.startPlayer(24_000, 5, "local", factory);
	assert.equal(playback.startPlayer(24_000, 5, "local", factory), first, "same utterance and output reuse the sink");
	assert.equal(first.stopped, false);

	next = 1;
	const second = playback.startPlayer(24_000, 6, "local", factory);
	assert.notEqual(second, first);
	assert.ok(first.stopped, "the replaced player must be stopped");
});
