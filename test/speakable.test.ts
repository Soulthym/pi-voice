import assert from "node:assert/strict";
import test from "node:test";
import { NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";
import { findSentenceCut, SpeakableStream, type SpeakableItem } from "../src/speakable.js";

function speech(items: SpeakableItem[]): string[] {
	return items.filter((item): item is Extract<SpeakableItem, { kind: "speech" }> => item.kind === "speech").map(item => item.text);
}

test("raw sentence cuts preserve ordered prefixes without hiding numeric sentence endings", () => {
	for (const prefix of ["1. ", "  12.\t", "intro\n123. ", `${NARRATION_ACTIVE_MARKER}**1.** `]) {
		assert.equal(findSentenceCut(`${prefix}First option`), -1, prefix);
		assert.equal(findSentenceCut(`${prefix}First option. next`), `${prefix}First option. `.length);
	}
	for (const first of [
		"494 tests passed; native-TUI checks 10/10.",
		"10/10.", "Use 3.14 and version 1.2.3.", "🦊 Done.",
	]) {
		for (const formatted of [false, true]) {
			const head = formatted ? `${NARRATION_ACTIVE_MARKER}**${first}**${NARRATION_ACTIVE_MARKER} ` : `${first} `;
			assert.equal(findSentenceCut(`${head}next sentence.`), head.length);
			assert.equal(findSentenceCut(`${head}next sentence. tail`, head.length + 1), `${head}next sentence. `.length);
		}
	}
});

test("formatted test report retains its two sentences across every delta split", () => {
	const first = "494 tests passed; native-TUI checks 10/10.";
	const second = "Run /reload, then test paused navigation after manually scrolling away and watch the timing row for flicker.";
	const text = `${NARRATION_ACTIVE_MARKER}**${first}**${NARRATION_ACTIVE_MARKER} ${second}`;
	for (let split = 0; split <= text.length; split++) {
		const stream = new SpeakableStream();
		const items = [...stream.push(text.slice(0, split)), ...stream.push(text.slice(split)), ...stream.flush()];
		assert.deepEqual(speech(items), [`${NARRATION_ACTIVE_MARKER}${first}${NARRATION_ACTIVE_MARKER}`, second], `split ${split}`);
		assert.equal(items[0]!.source.end, text.indexOf("Run"));
		assert.equal(items[1]!.source.start, text.indexOf("Run"));
	}
});

test("formatted boundaries preserve list markers, abbreviations, numeric tokens and inline code", () => {
	for (const [text, expected] of [
		["1. First option. Second option.", ["1, First option.", "Second option."]],
		["**Dr.** Smith uses e.g. version 1.2.3 and 3.14 units. Next.", ["Dr. Smith uses e.g. version 1.2.3 and 3.14 units.", "Next."]],
		["Call path.to.module.submodule.function. Next.", ["Call path.to.module.submodule.function.", "Next."]],
		["Call path.to.module.submodule.function first. Next.", ["Call path.to.module.submodule.function first.", "Next."]],
		["Call `path.to.module.submodule.function`. Next.", ["Call path.to.module.submodule.function.", "Next."]],
		["🦊 **Done.** Next.", ["🦊 Done.", "Next."]],
		["Use `one. two.` Next.", ["Use one. two.", "Next."]],
		["Read *this.* Next.", ["Read this.", "Next."]],
		["Read __this.__ Next.", ["Read this.", "Next."]],
		["Read ~~this.~~ Next.", ["Read this.", "Next."]],
		["Read [the guide](https://example.com/v1.2). Next.", ["Read the guide.", "Next."]],
	] as const) {
		const stream = new SpeakableStream();
		const items = [...text.split("").flatMap(delta => stream.push(delta)), ...stream.flush()];
		assert.deepEqual(speech(items), expected, text);
		assert.equal(items[1]!.source.start, text.indexOf(text.includes("Second") ? "Second" : "Next"));
		assert.equal(items[1]!.source.end, text.length);
	}
});

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

test("literal prose newlines are generation boundaries", () => {
	const stream = new SpeakableStream();
	const items = [
		...stream.push("This explanation continues across a\nline wrap before the sentence ends."),
		...stream.flush(),
	];
	assert.deepEqual(speech(items), ["This explanation continues across a", "line wrap before the sentence ends."]);
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

test("speaks Markdown table rows as newline units and skips separator rows", () => {
	const stream = new SpeakableStream();
	const items = [
		...stream.push("| Name | Status |\n| :--- | ---: |\n| API | Ready |"),
		...stream.flush(),
	];
	assert.deepEqual(speech(items), [". Name. Status.", ". API. Ready."]);
});

test("speaks link labels and URL hosts instead of full URLs", () => {
	const stream = new SpeakableStream();
	const items = [...stream.push("Read [the guide](https://example.com/long/path). Visit https://pi.dev/docs next."), ...stream.flush()];
	assert.deepEqual(speech(items), ["Read the guide.", "Visit pi.dev next."]);
});

test("never fragments long sentences, even across stalled streaming deltas", () => {
	const stream = new SpeakableStream();
	const prefix = "word ".repeat(300);
	assert.deepEqual(stream.push(prefix), []);
	assert.deepEqual(stream.flushIdle(), []);
	assert.deepEqual(speech(stream.push("ends here. Next")), [prefix + "ends here."]);
	assert.deepEqual(speech(stream.flush()), ["Next"]);
});

test("short sentences stay separate and source offsets use UTF-16", () => {
	const stream = new SpeakableStream();
	const text = "Hi. 🦊 Done.\nNext line";
	const items = [...stream.push(text), ...stream.flush()];
	assert.deepEqual(speech(items), ["Hi.", "🦊 Done.", "Next line"]);
	assert.equal(text.slice(items[1]!.source.start, items[1]!.source.end).trim(), "🦊 Done.");
	assert.equal(text.slice(items[2]!.source.start, items[2]!.source.end), "Next line");
	const fenced = "🦊\n```ts\nrun();\n```";
	const parser = new SpeakableStream();
	const code = [...parser.push(fenced), ...parser.flush()].find(item => item.kind === "code")!;
	assert.equal(code.source.start, 3);
	assert.equal(fenced.slice(code.source.start, code.source.end), "```ts\nrun();\n```");
});
