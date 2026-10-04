import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { Vocalizer } from "../src/vocalizer.js";
import type { VoiceWorkerClient } from "../src/worker-client.js";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("resume offset belongs only to the first retained unit, including deferred guided code", async () => {
	const calls: Parameters<VoiceWorkerClient["sendSegment"]>[] = [], narration: any[] = [];
	const worker = {
		sendSegment(...args: Parameters<VoiceWorkerClient["sendSegment"]>) { calls.push(args); },
		endUtterance() {}, cancel() {}, async measureSegment() { return 1; }, async transcribe() { return []; },
		async transcribePcm() { return ""; }, async preload() {}, async preloadAlignment() {}, async terminate() {},
	};
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), () => {}, async () => ({
		guided: true, records: [
			{ speech: "First sentence.", operations: [{ kind: "line-add", id: "one", range: { startLine: 1, endLine: 1 } }] },
			{ speech: "Second sentence.", operations: [] },
		],
	}), segment => narration.push(segment), worker);
	const resume = { seconds: 0.25, audioIdentity: "cached-pcm" };
	const source = "```ts\nconst value = 1;\n```\nAfter code.";
	vocalizer.speakFrom(source, 50, 1, resume);
	vocalizer.speak("Ordinary next utterance."); // Queued while the description resolves.
	await tick(); await tick();
	assert.deepEqual(calls.map(call => [call[2], call[4]]), [
		["Second sentence.", resume], ["After code.", undefined], ["Ordinary next utterance.", undefined],
	]);
	assert.equal(narration[0].text, "Second sentence.", "resume never slices canonical speech text");
	assert.equal(narration[0].codeDescription.offset, "First sentence. ".length);
	assert.equal(narration[0].code.cues[0].operations[0].id, "one", "earlier focus cues survive");
	assert.equal(narration[0].source.start, 50);
	calls.length = 0;
	vocalizer.clear();
	vocalizer.setNarrationSourceOffset(50, 1, resume);
	vocalizer.pushDelta(source); vocalizer.flush();
	await tick(); await tick();
	assert.deepEqual(calls.map(call => call[4]), [resume, undefined]);
	calls.length = 0;
	vocalizer.setNarrationSourceOffset(50, 0, resume);
	vocalizer.clear(); vocalizer.speak("After cancel.");
	assert.equal(calls[0]![4], undefined);
	calls.length = 0;
	vocalizer.speakFrom("", 0, 0, resume); vocalizer.speak("After empty.");
	assert.equal(calls[0]![4], undefined);
});
