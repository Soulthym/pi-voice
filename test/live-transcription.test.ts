import assert from "node:assert/strict";
import test from "node:test";
import { LiveTranscriptionSession } from "../src/live-transcription.js";

function samples(seconds: number, amplitude: number): Float32Array {
	const audio = new Float32Array(Math.round(seconds * 16_000));
	for (let index = 0; index < audio.length; index += 1) audio[index] = amplitude;
	return audio;
}

test("emits revisable partial text and commits speech at a pause", async () => {
	const partials: string[] = [];
	const segments: string[] = [];
	const session = new LiveTranscriptionSession(async () => "hello world", {
		onPartial: text => partials.push(text),
		onSegment: text => segments.push(text),
	});

	session.push(samples(0.7, 0.1));
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(partials, ["hello world"]);

	session.push(samples(0.7, 0));
	assert.equal(await session.finish(), "hello world");
	assert.deepEqual(segments, ["hello world"]);
});
