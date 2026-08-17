import assert from "node:assert/strict";
import test from "node:test";
import { SpeakableStream } from "../src/speakable.js";

test("streams prose while omitting fenced code and markdown markers", () => {
	const stream = new SpeakableStream();
	const segments = [
		...stream.push("# Result\nThe build passed.\n```ts\nconst hidden = true;\n```\nDone."),
		...stream.flush(),
	];
	assert.deepEqual(segments, ["Result", "The build passed.", "Done."]);
});

test("speaks link labels and URL hosts instead of full URLs", () => {
	const stream = new SpeakableStream();
	const segments = [...stream.push("Read [the guide](https://example.com/long/path). Visit https://pi.dev/docs next."), ...stream.flush()];
	assert.deepEqual(segments, ["Read the guide.", "Visit pi.dev next."]);
});

test("keeps every emitted segment below Kokoro's input budget", () => {
	const stream = new SpeakableStream();
	const segments = [...stream.push("word ".repeat(300)), ...stream.flush()];
	assert.ok(segments.length > 1);
	assert.ok(segments.every(segment => segment.length <= 280));
});
