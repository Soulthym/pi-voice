import assert from "node:assert/strict";
import test from "node:test";
import { SpeakableStream, type SpeakableItem } from "../src/speakable.js";

function speech(items: SpeakableItem[]): string[] {
	return items.filter((item): item is Extract<SpeakableItem, { kind: "speech" }> => item.kind === "speech").map(item => item.text);
}

test("emits fenced code for description while preserving its spoken position", () => {
	const stream = new SpeakableStream();
	const items = [
		...stream.push("# Result\nThe build passed.\n```ts\nconst hidden = true;\n```\nDone."),
		...stream.flush(),
	];
	assert.deepEqual(items, [
		{ kind: "speech", text: "Result", source: { start: 2, end: 8 } },
		{ kind: "speech", text: "The build passed.", source: { start: 9, end: 26 } },
		{
			kind: "code",
			block: { language: "ts", code: "const hidden = true;" },
			source: { start: 27, end: 58 },
		},
		{ kind: "speech", text: "Done.", source: { start: 58, end: 63 } },
	]);
});

test("joins model-inserted prose line wraps without splitting intonation", () => {
	const stream = new SpeakableStream();
	const items = [
		...stream.push("This explanation continues across a\nline wrap before the sentence ends."),
		...stream.flush(),
	];
	assert.deepEqual(speech(items), ["This explanation continues across a line wrap before the sentence ends."]);
});

test("retains real Markdown block boundaries", () => {
	const stream = new SpeakableStream();
	const items = [...stream.push("First fragment\n\nSecond fragment\n- List item"), ...stream.flush()];
	assert.deepEqual(speech(items), ["First fragment", "Second fragment", "List item"]);
});

test("speaks text-like fenced blocks instead of describing them", () => {
	const stream = new SpeakableStream();
	const items = [
		...stream.push("Before.\n```text\nRead this exactly.\nSecond line.\n```\nAfter."),
		...stream.flush(),
	];
	assert.deepEqual(speech(items), ["Before.", "Read this exactly.", "Second line.", "After."]);
	assert.equal(items.some(item => item.kind === "code"), false);
});

test("recognizes fenced blocks split across streaming deltas", () => {
	const stream = new SpeakableStream();
	const items = [
		...stream.push("``"),
		...stream.push("`diff\n-old\n"),
		...stream.push("+new\n```"),
		...stream.push("\n"),
		...stream.flush(),
	];
	assert.deepEqual(items, [
		{ kind: "code", block: { language: "diff", code: "-old\n+new" }, source: { start: 0, end: 22 } },
	]);
});

test("speaks Markdown table cells as separate sentences and skips separator cells", () => {
	const stream = new SpeakableStream();
	const items = [
		...stream.push("| Name | Status |\n| :--- | ---: |\n| API | Ready |"),
		...stream.flush(),
	];
	assert.deepEqual(speech(items), ["Name.", "Status.", "API.", "Ready."]);
});

test("speaks link labels and URL hosts instead of full URLs", () => {
	const stream = new SpeakableStream();
	const items = [...stream.push("Read [the guide](https://example.com/long/path). Visit https://pi.dev/docs next."), ...stream.flush()];
	assert.deepEqual(speech(items), ["Read the guide.", "Visit pi.dev next."]);
});

test("keeps every emitted speech segment below Kokoro's input budget", () => {
	const stream = new SpeakableStream();
	const items = [...stream.push("word ".repeat(300)), ...stream.flush()];
	const segments = speech(items);
	assert.ok(segments.length > 1);
	assert.ok(segments.every(segment => segment.length <= 280));
});
