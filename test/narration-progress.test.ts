import assert from "node:assert/strict";
import test from "node:test";
import { NarrationProgress } from "../src/narration-progress.js";

const dim = (text: string): string => `<dim>${text}</dim>`;
const background = (text: string): string => `<bg>${text}</bg>`;

test("dims unread prose and reveals words from playback progress", () => {
	const progress = new NarrationProgress();
	progress.begin();
	progress.pushDelta("assistant", 0, "First second.");
	progress.registerSegment({
		id: 1,
		utterance: 1,
		text: "First second.",
		source: { start: 0, end: 13 },
	});
	progress.setSegmentAudio(1, 0, 2);

	assert.equal(progress.transform("First second.", "assistant", dim), "<dim>First</dim> <dim>second</dim>.");
	progress.setPlayback(1, 0);
	assert.equal(
		progress.transform("First second.", "assistant", dim, background),
		"<bg>First <dim>second</dim></bg>.",
	);
	progress.setPlayback(1, 1.9);
	assert.equal(progress.transform("First second.", "assistant", dim), "First second.");
});

test("uses forced-alignment word timestamps when they arrive", () => {
	const progress = new NarrationProgress();
	progress.begin();
	progress.pushDelta("assistant", 0, "Alpha beta.");
	progress.registerSegment({ id: 7, utterance: 3, text: "Alpha beta.", source: { start: 0, end: 11 } });
	progress.setSegmentAudio(7, 0, 4);
	progress.setAlignment(7, [
		{ text: "Alpha", start: 0, end: 1 },
		{ text: "beta", start: 3, end: 4 },
	]);
	progress.setPlayback(3, 2.5);

	assert.equal(progress.transform("Alpha beta.", "assistant", dim), "Alpha <dim>beta</dim>.");
	progress.setPlayback(3, 3.1);
	assert.equal(progress.transform("Alpha beta.", "assistant", dim), "Alpha beta.");
});

test("ignores completion from an older utterance", () => {
	const progress = new NarrationProgress();
	progress.begin();
	progress.pushDelta("assistant", 0, "Still queued.");
	progress.registerSegment({ id: 9, utterance: 2, text: "Still queued.", source: { start: 0, end: 13 } });
	progress.finishUtterance(1);
	progress.finishUtterance(undefined);

	assert.equal(progress.transform("Still queued.", "assistant", dim), "<dim>Still</dim> <dim>queued</dim>.");
});

test("keeps highlighting an earlier message when a later assistant message appears", () => {
	const progress = new NarrationProgress();
	progress.begin();
	progress.pushDelta("assistant", 0, "First queued.");
	progress.registerSegment({ id: 10, utterance: 4, text: "First queued.", source: { start: 0, end: 13 } });
	progress.setSegmentAudio(10, 0, 2);
	progress.setPlayback(4, 0);

	const secondOffset = progress.startMessage();
	assert.equal(secondOffset, 13);
	progress.pushDelta("assistant", 0, "Second active.");
	progress.registerSegment({ id: 11, utterance: 5, text: "Second active.", source: { start: 13, end: 27 } });
	progress.setSegmentAudio(11, 0, 2);

	assert.match(progress.transform("First queued.", "assistant", dim, background), /<bg>First /);
	assert.equal(progress.transform("Second active.", "assistant", dim), "<dim>Second</dim> <dim>active</dim>.");

	progress.finishUtterance(4);
	progress.setPlayback(5, 0);
	assert.match(progress.transform("Second active.", "assistant", dim, background), /<bg>Second /);
});

test("styles spoken text fences while preserving their Markdown markers", () => {
	const markdown = "```text\nRead this sentence.\n```";
	const progress = new NarrationProgress();
	progress.begin();
	progress.pushDelta("assistant", 0, markdown);
	progress.registerSegment({
		id: 12,
		utterance: 4,
		text: "Read this sentence.",
		source: { start: 8, end: 27 },
	});
	progress.setSegmentAudio(12, 0, 2);

	assert.equal(
		progress.transform(markdown, "assistant", dim),
		"```text\n<dim>Read</dim> <dim>this</dim> <dim>sentence</dim>.\n```",
	);
	progress.setPlayback(4, 0);
	assert.match(progress.transform(markdown, "assistant", dim, background), /<bg>Read /);
});

test("shows a code description below its block and reveals it with playback", () => {
	const markdown = "```ts\nfor (const value of values) console.log(value);\n```";
	const description = "The loop prints each value.";
	const progress = new NarrationProgress();
	progress.setCompletedText(markdown);
	progress.registerSegment({
		id: 14,
		utterance: 6,
		text: description,
		source: { start: 0, end: 0 },
		revealAtEnd: true,
		codeDescription: {
			blockSource: { start: 0, end: markdown.length },
			text: description,
			offset: 0,
		},
	});
	progress.setSegmentAudio(14, 0, 2);

	const pending = progress.transform(markdown, "assistant", dim, background, () => description);
	assert.match(pending, /```\n\n> \*\*Code description\*\*/);
	assert.match(pending, /> <dim>The<\/dim> <dim>loop<\/dim>/);

	progress.setPlayback(6, 0);
	const active = progress.transform(markdown, "assistant", dim, background, () => description);
	assert.match(active, /> <bg>The <dim>loop<\/dim>/);

	progress.finish();
	assert.match(progress.transform(markdown, "assistant", dim, background, () => description), /> The loop prints each value\./);
});

test("shows cached descriptions for every fenced code block", () => {
	const markdown = "```ts\nconst one = 1;\n```\nBetween.\n```py\ntwo = 2\n```";
	const descriptions = new Map([
		["const one = 1;", "TypeScript defines one."],
		["two = 2", "Python defines two."],
	]);
	const transformed = new NarrationProgress().transform(
		markdown,
		"assistant",
		dim,
		background,
		block => descriptions.get(block.code),
	);

	assert.equal(transformed.match(/\*\*Code description\*\*/g)?.length, 2);
	assert.match(transformed, /TypeScript defines one\.[\s\S]*Between\.[\s\S]*Python defines two\./);
});

test("keeps nested ordered-list markers outside narration styling", () => {
	const markdown = "Changes:\n- Ordered work:\n    1. First nested item\n    2. Second nested item\n- Finished.";
	const progress = new NarrationProgress();
	progress.setCompletedText(markdown);

	const transformed = progress.transform(markdown, "assistant", dim, background);
	assert.match(transformed, /\n    1\. <dim>First<\/dim>/);
	assert.match(transformed, /\n    2\. <dim>Second<\/dim>/);
	assert.doesNotMatch(transformed, /<dim>[12]<\/dim>\./);
});

test("tracks table cells as independent active sentences", () => {
	const markdown = "| Name | Status |";
	const progress = new NarrationProgress();
	progress.begin();
	progress.pushDelta("assistant", 0, markdown);
	progress.registerSegment({ id: 13, utterance: 5, text: "Name.", source: { start: 1, end: 8 } });
	progress.setSegmentAudio(13, 0, 1);
	progress.setPlayback(5, 0);

	const transformed = progress.transform(markdown, "assistant", dim, background);
	assert.match(transformed, /\| <bg>Name<\/bg> \| <dim>Status<\/dim> \|/);
});

test("does not inject styling into fenced code or link destinations", () => {
	const markdown = "Read [the guide](https://example.test).\n```ts\nconst value = 1;\n```";
	const progress = new NarrationProgress();
	progress.begin();
	progress.pushDelta("assistant", 0, markdown);

	const transformed = progress.transform(markdown, "assistant", dim);
	assert.match(transformed, /<dim>Read<\/dim> \[<dim>the<\/dim> <dim>guide<\/dim>\]\(https:\/\/example\.test\)/);
	assert.match(transformed, /```ts\nconst value = 1;\n```$/);
	assert.doesNotMatch(transformed, /https:\/\/<dim>/);
});
