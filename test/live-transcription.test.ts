import assert from "node:assert/strict";
import test from "node:test";
import { LiveTranscriptionSession } from "../src/live-transcription.js";

function samples(seconds: number, amplitude: number): Float32Array {
	const audio = new Float32Array(Math.round(seconds * 16_000));
	for (let index = 0; index < audio.length; index += 1) audio[index] = amplitude;
	return audio;
}

test("a preview failure stays awaitable until recording finishes", async () => {
	const session = new LiveTranscriptionSession(async () => { throw new Error("synthetic preview failure"); }, {});
	session.push(samples(0.7, 0.1));
	await new Promise(resolve => setImmediate(resolve));
	await assert.rejects(session.finish(), /synthetic preview failure/);
});

test("candidate callbacks retain original evidence while the committed transcript stays ordinary text", async () => {
	const candidates = ["follow my advice", "follow the advice", "follow their advice"];
	const partials: string[][] = [];
	const segments: string[][] = [];
	const session = new LiveTranscriptionSession(async () => candidates, {
		onPartialCandidates: values => partials.push(values),
		onSegmentCandidates: values => segments.push(values),
	});
	session.push(samples(0.7, 0.1));
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(partials, [candidates]);
	session.push(samples(0.7, 0));
	assert.equal(await session.finish(), candidates[0]);
	assert.deepEqual(segments, [candidates]);
	assert.deepEqual(candidates, ["follow my advice", "follow the advice", "follow their advice"]);
});

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
