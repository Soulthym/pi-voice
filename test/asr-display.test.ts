import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAsrDisplay } from "../src/asr-display.js";

// Independent tiny reader for inline display grammar: ensure actual hypotheses survive factoring.
function expand(display: string): string[] {
	let cursor = 0;
	const sequence = (): string[] => {
		let values = [""];
		while (cursor < display.length && !"|]".includes(display[cursor]!)) {
			let next: string[];
			const char = display[cursor++]!;
			if (char === "\\") next = [display[cursor++]!];
			else if (char === "[") {
				next = sequence();
				while (display[cursor] === "|") { cursor++; next.push(...sequence()); }
				assert.equal(display[cursor++], "]");
			} else next = [char === "∅" ? "" : char];
			values = values.flatMap(value => next.map(part => value + part));
		}
		return values;
	};
	const result = sequence();
	assert.equal(cursor, display.length);
	return result;
}

test("factors shared phrases throughout at whole-word boundaries, retaining punctuation", () => {
	assert.equal(formatAsrDisplay(["follow my advice", "follow the advice"]), "follow [my|the] advice");
	assert.equal(formatAsrDisplay(["forward your recommendation", "follow your recommended ion"]), "[forward|follow] your [recommendation|recommended ion]");
	assert.equal(formatAsrDisplay(["Clear the cash.", "Clear the cache."]), "Clear the [cash|cache].");
	assert.equal(formatAsrDisplay(["Don't re-open café!", "Don't re-open cafes!"]), "Don't re-open [café|cafes]!");
	assert.equal(formatAsrDisplay(["read src/one.ts", "read src/two.ts"]), "read [src/one|src/two].ts");
});

test("covered additions preserve layout exactly, including nested arbitrary subexpressions", () => {
	// a/b/c/d are phrases, not individual characters; this creates [a|b] c [b|d].
	const original = ["red route through town blue route", "blue route through town green route"];
	const display = formatAsrDisplay(original);
	assert.equal(display, "[red|blue] route through town [blue|green] route");
	assert.equal(formatAsrDisplay([...original, "red route through town green route"]), display);
	const nested = ["take red route left", "take blue route right", "skip tomorrow"];
	const nestedDisplay = formatAsrDisplay(nested);
	assert.equal(nestedDisplay, "[take [red|blue] route [left|right]|skip tomorrow]");
	assert.equal(formatAsrDisplay([...nested, "take red route right"]), nestedDisplay);
	assert.equal(formatAsrDisplay([...nested, "take blue route left", ...nested]), nestedDisplay);
	for (const candidate of nested) assert.ok(expand(nestedDisplay).includes(candidate));
	const phrases = ["take red route via town go west", "take blue route via town go west", "skip today via town stay east"];
	const phraseDisplay = formatAsrDisplay(phrases);
	assert.equal(phraseDisplay, "[take [red|blue] route|skip today] via town [go west|stay east]");
	assert.equal(formatAsrDisplay([...phrases, "take red route via town stay east"]), phraseDisplay);
	assert.equal(formatAsrDisplay([...phrases, "skip today via town go west"]), phraseDisplay);
});

test("retains every candidate, optional words, repeated anchors and literal syntax", () => {
	for (const candidates of [
		["go now", "go right now"],
		["a b a", "b a b", "a a b"],
		["use [x|y]", "use [x|z]"],
		["literal ∅", "literal \\ empty"],
		["take red route left", "take blue route right", "skip tomorrow", "take red route right", "take new road home"],
		["one  two", "one two"],
		["hello, friend!", "hello friend?"],
	]) {
		const copy = [...candidates];
		const output = formatAsrDisplay(candidates);
		const represented = expand(output);
		for (const candidate of candidates) assert.ok(represented.includes(candidate), `${candidate}: ${output}`);
		assert.deepEqual(candidates, copy);
		assert.equal(formatAsrDisplay(candidates), output);
	}
	assert.equal(formatAsrDisplay([]), "");
	assert.equal(formatAsrDisplay(["", "   ", "Only one.", "Only one."]), "Only one.");
});

test("unwieldy or divergent alternatives use separate lines without discarding text", () => {
	const candidates = ["Send a message to the team", "Cancel every scheduled appointment tomorrow"];
	assert.equal(formatAsrDisplay(candidates), `[\n  ${candidates[0]}\n| ${candidates[1]}\n]`);
	const long = ["alpha ".repeat(140).trim(), "beta ".repeat(140).trim()];
	const output = formatAsrDisplay(long);
	assert.ok(output.includes("\n"));
	for (const candidate of long) assert.ok(output.includes(candidate));
	assert.equal(formatAsrDisplay([...long, long[0]!]), output);
});
