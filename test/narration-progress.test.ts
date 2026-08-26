import assert from "node:assert/strict";
import test from "node:test";
import { NARRATION_ACTIVE_MARKER, NarrationProgress } from "../src/narration-progress.js";

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

test("previews a regenerated source position before audio starts", () => {
	const progress = new NarrationProgress();
	progress.setCompletedText("Alpha beta gamma.");
	progress.previewSourceOffset(6);
	const transformed = progress.transform(
		"Alpha beta gamma.",
		"assistant",
		dim,
		background,
		undefined,
		true,
		undefined,
		NARRATION_ACTIVE_MARKER,
	);
	assert.ok(transformed.indexOf(NARRATION_ACTIVE_MARKER) < transformed.indexOf("beta"));
	assert.ok(transformed.indexOf(NARRATION_ACTIVE_MARKER) > transformed.indexOf("Alpha"));
});

test("marks the exact timed word for TUI auto-scroll", () => {
	const progress = new NarrationProgress();
	progress.setCompletedText("Alpha beta gamma.");
	progress.registerSegment({ id: 70, utterance: 30, text: "Alpha beta gamma.", source: { start: 0, end: 17 } });
	progress.setSegmentAudio(70, 0, 4);
	progress.setAlignment(70, [
		{ text: "Alpha", start: 0, end: 1 },
		{ text: "beta", start: 1.5, end: 2.5 },
		{ text: "gamma", start: 3, end: 4 },
	]);

	progress.setPlayback(30, 1.6);
	const transformed = progress.transform(
		"Alpha beta gamma.",
		"assistant",
		dim,
		background,
		undefined,
		true,
		undefined,
		NARRATION_ACTIVE_MARKER,
	);
	assert.match(transformed, new RegExp(`Alpha ${NARRATION_ACTIVE_MARKER}beta`));
	assert.equal(transformed.split(NARRATION_ACTIVE_MARKER).length - 1, 1);
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
		code: {
			blockSource: { start: 0, end: markdown.length },
			code: "for (const value of values) console.log(value);",
			language: "ts",
			cues: [],
		},
		codeDescription: {
			blockSource: { start: 0, end: markdown.length },
			text: description,
			offset: 0,
		},
	});
	progress.setSegmentAudio(14, 0, 2);

	const syntax = (code: string): string[] => code.split("\n").map(line => `\x1b[31m${line}\x1b[39m`);
	const pending = progress.transform(markdown, "assistant", dim, background, () => description, true, syntax);
	assert.match(pending, /```ts\u200c\n/);
	assert.match(pending, /\x1b\[2m\x1b\[31mfor/);
	assert.match(pending, /```\n\n> \*\*Code description\*\*/);
	assert.match(pending, /> <dim>The<\/dim> <dim>loop<\/dim>/);

	progress.setPlayback(6, 0);
	const active = progress.transform(
		markdown,
		"assistant",
		dim,
		background,
		() => description,
		true,
		undefined,
		NARRATION_ACTIVE_MARKER,
	);
	assert.match(active, new RegExp(`> <bg>${NARRATION_ACTIVE_MARKER}The <dim>loop<\\/dim>`));

	progress.finish();
	const finished = progress.transform(markdown, "assistant", dim, background, () => description);
	assert.match(finished, /> The loop prints each value\./);
	assert.doesNotMatch(finished, /\u200c/);
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

test("keeps checked task markers outside narration styling at every nesting level", () => {
	for (const box of ["[ ]", "[x]", "[X]"]) {
		const markdown = `Plan:\n- ${box} Top task\n    - ${box} Nested task\n      1. ${box} Ordered task inside`;
		const progress = new NarrationProgress();
		progress.setCompletedText(markdown);

		const transformed = progress.transform(markdown, "assistant", dim, background);
		const marker = box.replace(/[\[\]]/g, "\\$&");
		assert.match(transformed, new RegExp(`^- ${marker} <dim>Top</dim>`, "m"), box);
		assert.match(transformed, new RegExp(`^    - ${marker} <dim>Nested</dim>`, "m"), box);
		assert.match(transformed, new RegExp(`^      1\\. ${marker} <dim>Ordered</dim>`, "m"), box);
		// The structural checkbox itself must never be wrapped in narration styling.
		assert.doesNotMatch(transformed, /<(?:dim|bg)>(?:x|X| |)\[?<\/?(?:dim|bg)>/, box);
		assert.doesNotMatch(transformed, /<dim>\[[ xX]\]<\/dim>/, box);
	}
});

test("looks up repeated code blocks with their transcript prefix", () => {
	const markdown = "First use.\n```ts\nrun();\n```\nSecond use.\n```ts\nrun();\n```";
	const contexts: string[] = [];
	const transformed = new NarrationProgress().transform(
		markdown,
		"assistant",
		dim,
		background,
		(_block, transcript) => {
			contexts.push(transcript);
			return transcript.includes("Second use.") ? "The second use." : "The first use.";
		},
	);

	assert.equal(contexts.length, 2);
	assert.doesNotMatch(contexts[0], /Second use/);
	assert.match(contexts[1], /Second use/);
	assert.match(transformed, /The first use\.[\s\S]*The second use\./);
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
