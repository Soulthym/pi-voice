import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { Vocalizer } from "../src/vocalizer.js";

function immediate(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

test("starts code description early while preserving spoken order", async () => {
	const events: string[] = [];
	const worker = {
		sendSegment(_utterance: number, _segmentId: number, text: string): void {
			events.push(`speech:${text}`);
		},
		endUtterance(): void {
			events.push("end");
		},
		cancel(): void {},
		async transcribe(): Promise<string[]> {
			return [];
		},
		async transcribePcm(): Promise<string> {
			return "";
		},
		async preload(): Promise<void> {},
		async terminate(): Promise<void> {},
	};
	const deferred = Promise.withResolvers<string>();
	let descriptionStarted = false;
	const vocalizer = new Vocalizer(
		() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }),
		() => {},
		async () => {
			descriptionStarted = true;
			return deferred.promise;
		},
		undefined,
		worker,
	);

	vocalizer.pushDelta("Before.\n```ts\nconst value = 1;\n```\nAfter.");
	vocalizer.flush();

	assert.equal(descriptionStarted, true);
	assert.deepEqual(events, ["speech:Before."]);

	deferred.resolve("The code defines a constant value.");
	await immediate();
	await immediate();
	assert.deepEqual(events, ["speech:Before.", "speech:The code defines a constant value.", "speech:After.", "end"]);
});
