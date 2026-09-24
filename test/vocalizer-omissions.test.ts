import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { NarrationProgress } from "../src/narration-progress.js";
import { Vocalizer } from "../src/vocalizer.js";

test("terminal omissions consume silently while paused but never after cancellation or for untracked prompts", async () => {
	const narration = new NarrationProgress();
	let ready = Promise.withResolvers<void>();
	const worker = {
		sendSegment() { assert.fail("omissions must not synthesize"); }, endUtterance() {}, cancel() {},
		async measureSegment() { return 1; }, async transcribe() { return []; },
		async transcribePcm() { return ""; }, async preload() {}, async preloadAlignment() {}, async terminate() {},
	};
	const ends: number[] = [];
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), () => {},
		async () => { await ready.promise; return { records: [], guided: false, omitted: true }; },
		() => assert.fail("omissions must not add highlight or history segments"), worker, undefined, undefined, undefined,
		source => { ends.push(source.end); narration.consumeOmittedSource(source.end); });
	const text = "```ts\nrun();\n```\n";
	vocalizer.speakFrom(text, 7);
	vocalizer.setPlaybackPaused(true);
	ready.resolve(); await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(ends, [7 + text.length]);
	assert.equal(narration.consumedSourceEnd, 7 + text.length);
	assert.equal(narration.cursor, 0, "silent consumption leaves highlights alone");
	assert.equal(vocalizer.playbackPhase, "paused");
	ready = Promise.withResolvers<void>();
	vocalizer.speak(text);
	vocalizer.clear();
	ready.resolve(); await new Promise(resolve => setImmediate(resolve));
	assert.equal(ends.length, 1, "stale resolution cannot consume a new narration source");
	vocalizer.speakUntracked(text);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(ends.length, 1);
	await vocalizer.shutdown();
});
