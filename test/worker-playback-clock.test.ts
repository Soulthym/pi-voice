import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";

// Import the real clock without worker input, model loading, or subprocesses.
mock.module("node:readline", { namedExports: { createInterface: () => new EventEmitter() } });
mock.module("node:fs", { namedExports: { mkdirSync: () => {} } });
mock.module("@huggingface/transformers", { namedExports: {
	env: {}, RawAudio: class {}, Tensor: class {}, pipeline: () => { throw Error("No inference"); },
} });
mock.module("kokoro-js", { namedExports: { KokoroTTS: {} } });
const { attachPlaybackClock } = await import(new URL("../src/worker.mjs", import.meta.url).href);

test("estimated clock excludes starvation, including feedback fallback, and preserves pause", t => {
	let now = 0;
	let tick = () => {};
	let cleared = false;
	const events: any[] = [];
	t.mock.method(performance, "now", () => now);
	t.mock.method(globalThis, "setInterval", ((callback: () => void) => {
		tick = callback;
		return { unref() {} };
	}) as any);
	t.mock.method(globalThis, "clearInterval", (() => { cleared = true; }) as any);
	t.mock.method(process.stdout, "write", ((chunk: any) => {
		events.push(JSON.parse(String(chunk)));
		return true;
	}) as any);
	const latest = () => events.at(-1);

	for (const feedback of [false, true]) {
		now = 0;
		events.length = 0;
		const sink = attachPlaybackClock({}, 24000, 7, feedback);
		sink.noteAudio(24000);
		now = 1000;
		if (feedback) sink.reportPlayback(1);
		else tick();
		assert.equal(latest().position, 1);
		// No timer ticks during the gap: append itself must discard starvation.
		now = 10000;
		sink.noteAudio(48000);
		now += 125;
		tick();
		assert.deepEqual(latest(), { type: "playback", utterance: 7, position: 1.125, estimated: true });

		sink.setPlaybackClockPaused(true);
		now += 9000;
		tick();
		assert.equal(latest().position, 1.125);
		sink.setPlaybackClockPaused(false);
		now += 125;
		tick();
		assert.equal(latest().position, 1.25);

		// Real feedback corrects an estimate in either direction, and is not estimated.
		sink.reportPlayback(0.5);
		assert.deepEqual(latest(), { type: "playback", utterance: 7, position: 0.5 });
		now += 125;
		tick();
		assert.equal(latest().position, 0.5, "recent feedback suppresses estimates");
		now += 625;
		tick();
		assert.equal(latest().position, 1.25, "fallback is anchored to real feedback");
		now += 10000;
		tick();
		assert.equal(latest().position, 3);
		assert.equal(latest().estimated, true, "buffer exhaustion is not stop proof");
		assert.ok(events.every(event => event.type === "playback"), "clock never declares idle");
		sink.stopPlaybackClock();
		assert.equal(cleared, true);
		cleared = false;
	}

	const pausedSink = attachPlaybackClock({}, 24000, 8);
	pausedSink.setPlaybackClockPaused(true);
	const count = events.length;
	now += 1000;
	tick();
	assert.equal(events.length, count, "startup pause does not start the clock");
	pausedSink.noteAudio(24000);
	now += 1000;
	tick();
	assert.equal(latest().position, 0);
	pausedSink.setPlaybackClockPaused(false);
	now += 125;
	tick();
	assert.equal(latest().position, 0.125, "new sink starts at zero after seek/replacement");
	pausedSink.stopPlaybackClock();
});
