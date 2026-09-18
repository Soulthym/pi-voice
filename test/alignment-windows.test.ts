import assert from "node:assert/strict";
import { test } from "node:test";
import { alignmentWindows, estimatedWords, mergeWindow } from "../src/alignment-windows.mjs";

test("overlapping windows stay bounded and cover the tail without a duplicate window", () => {
	assert.deepEqual([...alignmentWindows(30)], [{ start: 0, end: 30 }]);
	assert.deepEqual([...alignmentWindows(65)], [{ start: 0, end: 30 }, { start: 24, end: 54 }, { start: 48, end: 65 }]);
	for (const window of alignmentWindows(10_000)) assert.ok(window.end - window.start <= 30);
});

test("unique interior matches refine once; uncertain/repeated/seam words remain source-ordered estimates", () => {
	const words = estimatedWords("AAA BBB CCC DDD EEE FFF", 60);
	const recognized = [
		{ text: "AAA", start: 0, end: 9 }, { text: "BBB", start: 11, end: 19 },
		{ text: "CCC", start: 21, end: 29 }, { text: "DDD", start: 30, end: 39 },
	];
	mergeWindow(words, recognized, { start: 0, end: 30 }, 60);
	assert.equal(words[1].quality, "ctc-refined");
	assert.equal(words[2].quality, "estimated", "uncertain seam is not promoted");
	const once = structuredClone(words);
	mergeWindow(words, recognized, { start: 0, end: 30 }, 60);
	assert.deepEqual(words, once);
	mergeWindow(words, [{ text: "BBB", start: 0, end: 1 }, { text: "CCC", start: 0, end: 50 }, { text: "DDD", start: 50, end: 51 }], { start: 0, end: 60 }, 60);
	assert.deepEqual(words, once, "incompatible source-order refinement is rejected");
	assert.equal(words.length, 6);
	assert.ok(words.every((word: any, i: number) => !i || word.start >= words[i - 1].end));
	const repeated = estimatedWords("AAA BBB CCC AAA BBB CCC", 60);
	mergeWindow(repeated, recognized, { start: 0, end: 60 }, 60);
	assert.ok(repeated.every((word: any) => word.quality === "estimated"));
});
