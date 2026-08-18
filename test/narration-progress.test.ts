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
		"<bg>First</bg><bg> </bg><bg><dim>second</dim></bg>.",
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

	assert.equal(progress.transform("Still queued.", "assistant", dim), "<dim>Still</dim> <dim>queued</dim>.");
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
	assert.match(progress.transform(markdown, "assistant", dim, background), /<bg>Read<\/bg>/);
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
