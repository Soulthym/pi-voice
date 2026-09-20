import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { NARRATION_ACTIVE_MARKER, NarrationProgress } from "../src/narration-progress.js";
import { narrationLayoutCapture, narrationLayoutPlan, withNarrationLayout } from "../src/narration-render.js";

const native: typeof import("@earendil-works/pi-tui") = await import(process.env.PI_VOICE_TEST_TUI_MODULE ?? "@earendil-works/pi-tui");
const plain = (text: string) => text;
const theme: MarkdownTheme = {
	heading: plain, link: plain, linkUrl: plain, code: plain, codeBlock: plain,
	codeBlockBorder: plain, quote: plain, quoteBorder: plain, hr: plain,
	listBullet: plain, bold: plain, italic: plain, strikethrough: plain, underline: plain,
};

for (const width of [28, 100, 120]) test(`native source marker ignores copied history at width ${width}`, () => {
	const progress = new NarrationProgress();
	// Synthetic substitute for the saved four-line user message: one legacy token
	// in a quoted first line, unquoted continuation, blank line, then prose.
	const historicalMarker = new NarrationProgress().activeMarker;
	const quote = `> Earlier synthetic ${historicalMarker}${NARRATION_ACTIVE_MARKER}report is quoted here.\nContinuation of copied report.\n\nA separate follow-up request.`;
	// Raw markers inside the selected source also must not become its local anchor.
	const source = `${quote}\n\nLater active assistant has several words to narrate. Another sentence follows.`;
	const start = source.indexOf("Later active");
	const transform = () => progress.transform(source, "assistant", plain, plain, undefined, false, undefined, progress.activeMarker);
	const markdown = (text: string): string[] => new native.Markdown(text, 1, 0, theme).render(width);
	progress.setCompletedText(source);
	progress.previewSourceOffset(start);
	const copiedMarker = progress.activeMarker;
	const copiedAssistant = transform();
	const quotedUser = `> ${copiedAssistant.replace(/\n/g, "\n> ")}`;
	const history = ["Please rename the synthetic status label.", quote, quotedUser];

	for (let replay = 0; replay < 3; replay++) {
		const previousMarker = progress.activeMarker;
		progress.setCompletedText(source);
		progress.previewSourceOffset(start);
		assert.notEqual(progress.activeMarker, previousMarker, "repeated selection gets a fresh identity");
		assert.notEqual(progress.activeMarker, copiedMarker);
		assert.equal(progress.activeWordStart, start, "source offsets retain all raw marker bytes");
		assert.equal(progress.sourceTexts[0], source, "no private/exported source text is stripped");
		const oldLines = history.flatMap(markdown);
		const activeLines = withNarrationLayout(new native.Markdown(source, 1, 0, theme, undefined,
			{ transform })).render(width);
		assert.deepEqual(activeLines.map(line => line.replace(progress.activeMarker, "")), markdown(source),
			"the scoped token has zero rendered width, including narrow wrapping");
		const transcript = new native.ScrollView({ invalidate() {}, render: () => [
			...oldLines, ...activeLines, ...Array(80).fill("later tool output"),
		] }, { primary: true, follow: "end", scrollbar: "hidden" });
		const lines: string[] = transcript.render(width);
		const local = activeLines.findIndex(line => line.includes(progress.activeMarker));
		const actual = lines.findIndex(line => line.includes(progress.activeMarker));
		assert.ok(local >= 0);
		assert.equal(actual, oldLines.length + local, "only the newly rendered assistant anchors the viewport");
		assert.ok(lines.findIndex(line => line.includes(NARRATION_ACTIVE_MARKER)) < actual,
			"legacy global find-first demonstrably targets the older user quotation");
		assert.equal(lines.filter(line => line.includes(progress.activeMarker)).length, 1);
		history.push(`> ${transform().replace(/\n/g, "\n> ")}`);
	}
});

for (const width of [10, 18, 24, 28, 40, 100, 120]) test(`guided code keeps ANSI and UTF-16 spans at width ${width}`, () => {
	const code = "const icon = '😀'; const face = icon;\nreturn icon;";
	const source = `\`\`\`ts\n${code}\n\`\`\``;
	const progress = new NarrationProgress();
	progress.setCompletedText(source);
	progress.registerSegment({ id: 1, utterance: 1, text: "Show the face.", source: { start: 0, end: 0 },
		code: { blockSource: { start: 0, end: source.length }, code, language: "ts", cues: [{ offset: 0, operations: [
			{ kind: "line-add", id: "line", range: { startLine: 1, endLine: 1 } },
			{ kind: "bold-add", id: "name", range: { startLine: 1, endLine: 1,
				startColumn: code.indexOf("face") + 1, endColumn: code.indexOf("face") + 4 } },
		] }] } });
	progress.setSegmentAudio(1, 0, 1);
	progress.setPlayback(1, 0);
	const syntax = (code: string, language?: string): string[] => code.split("\n").map(line =>
		language === "ts" ? `\x1b[32m${line}\x1b[39m` : line);
	const transformed = progress.transform(source, "assistant", plain, plain, undefined, true, syntax);
	assert.ok(transformed.includes("\x1b[1mface"), "bold range starts after the full non-BMP character");
	assert.ok(transformed.includes("\x1b[32m"), "syntax foreground is retained");
	const codeTheme = { ...theme, highlightCode: syntax };
	const baseline = new native.Markdown(source, 1, 0, codeTheme).render(width);
	const lines = withNarrationLayout(new native.Markdown(source, 1, 0, codeTheme, undefined, {
		transform: text => progress.transform(text, "assistant", plain, plain, undefined, true, syntax),
	})).render(width);
	assert.deepEqual(lines.map(native.stripTerminalSequences), baseline.map(native.stripTerminalSequences));
	assert.ok(lines.some(line => line.includes("\x1b[1m")));
	assert.ok(lines.some(line => line.includes("\x1b[32m")));
});

for (const width of [10, 28, 120]) test(`code description keeps its native callout and marker at width ${width}`, () => {
	const source = "```ts\nconst face = '😀';\n```";
	const description = "Alpha supercalifragilisticexpialidocious bravo charlie delta.";
	const progress = new NarrationProgress();
	progress.setCompletedText(source);
	progress.registerSegment({ id: 1, utterance: 1, text: description, source: { start: 0, end: source.length },
		codeDescription: { blockSource: { start: 0, end: source.length }, text: description, offset: 0 } });
	progress.setSegmentAudio(1, 0, 10);
	progress.setPlayback(1, 0);
	const baselineText = progress.transform(source, "assistant", plain, plain, undefined, false);
	const baseline = new native.Markdown(baselineText, 1, 0, theme).render(width);
	const lines = withNarrationLayout(new native.Markdown(source, 1, 0, theme, undefined, {
		transform: text => progress.transform(text, "assistant", text => `\x1b[38;5;244m${text}\x1b[39m`,
			text => `\x1b[48;5;236m${text}\x1b[49m`, undefined, true, undefined, progress.activeMarker),
	})).render(width);
	assert.deepEqual(lines.map(line => native.stripTerminalSequences(line.replaceAll(progress.activeMarker, ""))),
		baseline.map(native.stripTerminalSequences));
	assert.equal(lines.filter(line => line.includes(progress.activeMarker)).length, 1);
	for (const line of lines.filter(line => line.includes("\x1b[48;5;236m"))) {
		assert.match(native.stripTerminalSequences(line.slice(0, line.indexOf("\x1b[48;5;236m"))), /^ │ /);
		assert.ok(native.stripTerminalSequences(line.slice(line.lastIndexOf("\x1b[49m"))).endsWith(" "));
	}
});

test("each wrapped active row closes its zone before Markdown padding", () => {
	const source = "Alpha bravo charlie delta echo foxtrot golf hotel.";
	const progress = new NarrationProgress();
	progress.setCompletedText(source);
	progress.registerSegment({ id: 1, utterance: 1, text: source, source: { start: 0, end: source.length } });
	progress.setSegmentAudio(1, 0, 10);
	progress.setPlayback(1, 0);
	const lines: string[] = withNarrationLayout(new native.Markdown(source, 1, 0, theme, undefined, {
		transform: text => progress.transform(text, "assistant", plain, text => `\x1b[48;5;236m${text}\x1b[49m`),
	})).render(18);
	assert.ok(lines.length > 1);
	assert.equal(lines.filter(line => line.includes("\x1b[48;5;236m")).length, lines.length,
		"n wrapped rows have n active zones");
	for (const line of lines.slice(0, -1)) assert.match(line, /\x1b\[49m +$/,
		"zone must end before right padding, not merely at TUI's terminal-row reset");
	for (const line of lines) assert.equal([...line.matchAll(/\x1b\[48;5;236m/g)].length, 1);
});

for (const source of ["Alpha supercalifragilisticexpialidocious", "Alpha abcdefghij."]) test(`post-wrap paint adds no ANSI-only row: ${source}`, () => {
	const progress = new NarrationProgress();
	progress.setCompletedText(source);
	progress.registerSegment({ id: 1, utterance: 1, text: source, source: { start: 0, end: source.length } });
	progress.setSegmentAudio(1, 0, 10);
	progress.setPlayback(1, 0);
	const baseline = new native.Markdown(source, 0, 0, theme).render(5);
	const lines = withNarrationLayout(new native.Markdown(source, 0, 0, theme, undefined, {
		transform: text => progress.transform(text, "assistant", plain, text => `\x1b[48;5;236m${text}\x1b[49m`),
	})).render(5);
	assert.deepEqual(lines.map(native.stripTerminalSequences), baseline);
	assert.ok(lines.every(line => native.stripTerminalSequences(line).trim()));
	assert.equal(lines.filter(line => line.includes("\x1b[48;5;236m")).length, baseline.length);
});

for (const width of [10, 18, 24, 28, 40, 100, 120]) test(`highlight never moves native glyphs at width ${width}`, async t => {
	const styledTheme: MarkdownTheme = {
		...theme,
		heading: text => `\x1b[35m${text}\x1b[39m`,
		bold: text => `\x1b[1m${text}\x1b[22m`,
		codeBlock: text => `\x1b[32m${text}\x1b[39m`,
	};
	for (const source of [
		"Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima.",
		"Alpha supercalifragilisticexpialidocious omega.",
		"1. Alpha **supercalifragilisticexpialidocious** omega.",
		"1. Alpha **😀 𐐀mega 界面** bravo charlie.",
		"## Alpha **bravo** charlie delta echo foxtrot golf hotel india juliet kilo lima.",
		"1. Alpha **bravo** charlie delta echo foxtrot golf hotel india juliet kilo lima.",
		"> Alpha **supercalifragilisticexpialidocious** bravo charlie delta.",
		"> Alpha supercalifragilisticexpialidocious bravo charlie delta.",
		"1. Alpha bravo.\n   1. charlie **supercalifragilisticexpialidocious** delta.",
		"Alpha 👨‍👩‍👧‍👦 é 😀‍↔️ bravo charlie.",
		"Alpha [bravo](https://example.com) _charlie_ delta.",
		"Alpha $\\frac{a}{b}$ bravo.",
		"Alpha 😀 𐐀mega 界面 bravo charlie delta echo foxtrot golf hotel india.",
		"Alpha bravo charlie delta echo foxtrot golf hotel.\n\n```ts\nconst face = '😀';\n```",
	]) await t.test(source, () => {
		const progress = new NarrationProgress();
		progress.setCompletedText(source);
		const end = source.indexOf("\n\n") < 0 ? source.length : source.indexOf("\n\n");
		const start = source.indexOf("Alpha");
		progress.registerSegment({ id: 1, utterance: 1, text: source.slice(start, end), source: { start, end } });
		progress.setSegmentAudio(1, 0, 10);
		const render = (text: string): string[] => new native.Markdown(text, 1, 0, styledTheme).render(width);
		const glyphs = (lines: string[]) => lines.map(line => native.stripTerminalSequences(line.replaceAll(progress.activeMarker, "")));
		const baseline = render(source);
		for (let position = 0; position < 10; position++) {
			progress.setPlayback(1, position);
			const lines = withNarrationLayout(new native.Markdown(source, 1, 0, styledTheme, undefined, {
				transform: text => progress.transform(text, "assistant",
					text => `\x1b[38;5;244m${text}\x1b[39m`,
					text => `\x1b[48;5;236m${text}\x1b[49m`,
					undefined, true, undefined, progress.activeMarker),
			})).render(width);
			const markerOnly = withNarrationLayout(new native.Markdown(source, 1, 0, styledTheme, undefined, {
				transform: text => progress.transform(text, "assistant", plain, plain,
					undefined, false, undefined, progress.activeMarker),
			})).render(width);
			assert.deepEqual(glyphs(markerOnly), glyphs(baseline), `marker only: ${source}: position ${position}`);
			assert.deepEqual(glyphs(lines), glyphs(baseline), `${source}: position ${position}`);
			assert.equal(lines.filter(line => line.includes(progress.activeMarker)).length, 1);
			for (let row = 0; row < lines.length; row++) {
				const line = lines[row];
				const open = line.indexOf("\x1b[48;5;236m");
				if (open < 0) continue;
				const plainRow = glyphs([baseline[row]])[0];
				const left = native.visibleWidth(line.slice(0, open));
				const close = line.lastIndexOf("\x1b[49m");
				const right = native.visibleWidth(line.slice(0, close));
				const prefix = plainRow.match(/^\s*(?:(?:\d+\. |│ )\s*)*/u)?.[0] ?? "";
				assert.ok(left >= native.visibleWidth(prefix), "background never paints list/quote continuation indentation");
				assert.ok(right <= native.visibleWidth(plainRow.trimEnd()), "background closes before all right padding");
				if (!source.includes("https://")) assert.equal([...line.matchAll(/\x1b\[48;5;236m/g)].length, 1,
					"one contiguous zone on each active row (link destinations remain excluded)");
			}
			if (source.startsWith("Alpha bravo") && !source.includes("```")) {
				if (width < 100) assert.ok(lines.length > 1);
				assert.equal(lines.reduce((count, line) => count + [...line.matchAll(/\x1b\[48;5;236m/g)].length, 0), lines.length,
					"exactly one clipped background zone per active native row");
			}
			if (source.includes("**")) assert.ok(lines.some(line => /\x1b\[(?:\d+;)*1(?:;\d+)*m/.test(line)), "native bold survives");
			if (source.startsWith("##")) assert.ok(lines.some(line => /\x1b\[(?:\d+;)*35(?:;\d+)*m/.test(line)), "native heading color survives");
			if (source.includes("```")) assert.ok(lines.some(line => /\x1b\[(?:\d+;)*32(?:;\d+)*m/.test(line)), "native code color survives");
		}
		if (source.includes("𐐀mega")) {
			progress.previewSourceOffset(source.indexOf("𐐀mega"));
			assert.equal(progress.activeWordStart, source.indexOf("𐐀mega"), "source offsets stay UTF-16, not terminal columns");
		}
	});
});

for (const width of [10, 28, 100]) for (const source of [
	"Alpha [ref][label].\n\n[label]: https://example.com",
	"Alpha [ref].\n\n[ref]: https://example.com",
	"Alpha [ref][].\n\n[ref]: https://example.com",
	"Alpha [ref][a b].\n\n[a b]: <https://example.com> \"Title\"",
	"Alpha \\*ref\\* and <https://example.com> bravo.",
	"Alpha क्‍ष bravo.",
	"Alpha e\u0301 👩🏽‍💻 🇮🇳 1️⃣ bravo.",
]) test(`reference/grapheme projection at ${width}: ${JSON.stringify(source)}`, () => {
	const progress = new NarrationProgress();
	progress.setCompletedText(source);
	progress.registerSegment({ id: 1, utterance: 1, text: source.includes("[ref]") ? "Alpha ref." : source.split("\n")[0],
		source: { start: 0, end: source.split("\n")[0].length } });
	progress.setSegmentAudio(1, 0, 10);
	const baseline = new native.Markdown(source, 1, 0, theme).render(width);
	for (const highlight of [true, false]) for (const position of [0, 4, 8]) {
		progress.setPlayback(1, position);
		const lines = withNarrationLayout(new native.Markdown(source, 1, 0, theme, undefined, {
			transform: text => progress.transform(text, "assistant",
				text => highlight ? `\x1b[2m${text}\x1b[22m` : text,
				text => highlight ? `\x1b[48;5;236m${text}\x1b[49m` : text,
				undefined, highlight, undefined, progress.activeMarker),
		})).render(width);
		assert.deepEqual(lines.map(line => native.stripTerminalSequences(line.replaceAll(progress.activeMarker, ""))),
			baseline.map(native.stripTerminalSequences));
		assert.equal(lines.join("").split(progress.activeMarker).length - 1, 1, "projection did not silently fall back");
		if (highlight) assert.ok(lines.some(line => line.includes("\x1b[48;5;236m")));
		if (highlight && source.includes("[ref]")) {
			assert.ok(lines.some(line => /\x1b\[48;5;236m[^\n]*ref/.test(line)), "reference label remains paintable");
		}
	}
});

test("unmappable native probe keeps exact styled/padded baseline and does not crash", () => {
	const source = "## Alpha **bravo**\n\n1. charlie delta";
	const styledTheme = { ...theme, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
	for (const width of [10, 28]) {
		const baseline = new native.Markdown(source, 2, 1, styledTheme).render(width);
		const leaf = withNarrationLayout(new native.Markdown(source, 2, 1, styledTheme, undefined, {
			transform: text => {
				narrationLayoutCapture()?.(narrationLayoutPlan("", tag => tag(plain, "synthetic replacement")));
				return text;
			},
		}));
		assert.deepEqual(leaf.render(width), baseline);
		leaf.invalidate();
		assert.deepEqual(leaf.render(width), baseline);
	}
});

for (const width of [14, 28, 100]) for (const emoji of ["**1**️⃣", "\x1b[1m👨\x1b[22m‍👩‍👧‍👦"]) {
	test(`ANSI-split grapheme keeps exact following paint and native clipping: ${emoji}/${width}`, () => {
		const source = `Alpha ${emoji} bravo.`;
		const progress = new NarrationProgress();
		progress.setCompletedText(source);
		const start = source.indexOf("bravo");
		progress.registerSegment({ id: 1, utterance: 1, text: "bravo.", source: { start, end: source.length } });
		progress.setSegmentAudio(1, 0, 10);
		progress.setPlayback(1, 0);
		const styled = { ...theme, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
		const painted: string[] = [];
		const lines = withNarrationLayout(new native.Markdown(source, 1, 0, styled, undefined, {
			transform: text => progress.transform(text, "assistant", plain, text => {
				painted.push(native.stripTerminalSequences(text.replaceAll(progress.activeMarker, "")));
				return `\x1b[48;5;236m${text}\x1b[49m`;
			}, undefined, false, undefined, progress.activeMarker),
		})).render(width);
		assert.equal(painted.join(""), "bravo.");
		const baseline = new native.Markdown(source, 1, 0, styled).render(width);
		assert.deepEqual(lines.map(line => native.stripTerminalSequences(line.replaceAll(progress.activeMarker, ""))), baseline.map(native.stripTerminalSequences));
		assert.equal(lines.filter(line => line.includes(progress.activeMarker)).length, 1);
	});
}

for (const atom of ["![Diagram](diagram.svg)", "![Diagram][figure]", "![Diagram][]", "![Diagram]",
	"https://example.com", "<https://example.com>", "[Diagram][figure]", "[Diagram][]", "[Diagram]"]) {
	for (const width of [18, 100]) test(`native repeated atom retains caption paint and anchor: ${atom}/${width}`, () => {
		const source = `${atom}${width === 18 && atom.startsWith("![") ? "" : " then "}${atom} after.\n\n[figure]: diagram.svg\n[Diagram]: diagram.svg`;
		const progress = new NarrationProgress();
		progress.setCompletedText(source);
		const start = source.indexOf(atom, atom.length);
		const word = atom.includes("Diagram") ? "Diagram" : "https://example.com";
		const wordStart = source.indexOf(word, start);
		progress.registerSegment({ id: 1, utterance: 1, text: word,
			source: { start: wordStart, end: wordStart + word.length } });
		progress.setSegmentAudio(1, 0, 10);
		progress.setPlayback(1, 0);
		const painted: string[] = [];
		const lines = withNarrationLayout(new native.Markdown(source, 1, 0, theme, undefined, {
			transform: text => progress.transform(text, "assistant", plain, text => {
				painted.push(native.stripTerminalSequences(text.replaceAll(progress.activeMarker, "")));
				return `\x1b[48;5;236m${text}\x1b[49m`;
			}, undefined, false, undefined, progress.activeMarker),
		})).render(width);
		const baseline = new native.Markdown(source, 1, 0, theme).render(width);
		assert.deepEqual(lines.map(line => native.stripTerminalSequences(line.replaceAll(progress.activeMarker, ""))), baseline.map(native.stripTerminalSequences));
		assert.equal(painted.join(""), word, "only the selected repeated atom's visible caption/URL is painted");
		assert.equal(lines.filter(line => line.includes(progress.activeMarker)).length, 1);
		assert.equal(progress.sourceTexts[0], source);
	});
}

for (const [head, tail] of [["1", "️⃣"], ["👨", "‍👩‍👧‍👦"]]) for (const width of [14, 100]) {
	test(`paint inside ANSI-split grapheme projects the whole glyph: ${head}/${width}`, () => {
		const source = `Alpha \x1b[1m${head}\x1b[22m${tail} bravo.`;
		const styled = { ...theme, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
		const painted: string[] = [];
		const leaf = withNarrationLayout(new native.Markdown(source, 1, 0, styled, undefined, {
			transform: text => {
				narrationLayoutCapture()?.(narrationLayoutPlan("", tag =>
					`Alpha \x1b[1m${head}\x1b[22m${tag(text => { painted.push(native.stripTerminalSequences(text)); return text; }, tail)} bravo.`));
				return text;
			},
		}));
		const lines = leaf.render(width);
		assert.equal(painted.join(""), head + tail);
		assert.deepEqual(lines.map(native.stripTerminalSequences),
			new native.Markdown(source, 1, 0, styled).render(width).map(native.stripTerminalSequences));
	});
}

for (const body of [
	"Alpha https://example.com https://example.com/path bravo",
	"Alpha <https://example.com> https://example.com bravo",
	"Alpha https://example.com <https://example.com> bravo",
	"Alpha ![Diagram] ![Diagram][figure] ![Diagram][] bravo",
	"Alpha ![Diagram][figure] ![Diagram] bravo",
	"Alpha `https://example.com ![Diagram]` https://example.com ![Diagram] bravo",
	"Alpha [label](https://example.com) https://example.com bravo",
	String.raw`Alpha \![Diagram] ![Diagram] bravo`,
	"> Alpha https://example.com\n> https://example.com/path bravo",
	"- Alpha https://example.com\n  https://example.com/path bravo",
	"Alpha\r\n![Diagram](x) bravo",
	"😀 Alpha\r\n![Diagram](x) bravo",
	"Alpha\r![Diagram](x) bravo",
	"- Alpha\n\tAlpha ![Diagram](x) bravo",
	"> - Alpha\r\n> \tAlpha ![Diagram](x) bravo",
	"- Alpha\n\t- Alpha\n\t\tAlpha ![Diagram](x) bravo",
	"| A | B |\n| - | - |\n| x\\|y ![Diagram](x) | bravo |",
	"| A | B |\n| - | - |\n| - | ![Diagram](x) bravo |",
	"<div>Alpha bravo</div>",
	'<div title="bravo > Diagram">Alpha bravo</div>',
]) for (const width of [18, 100]) {
	for (const target of ["bravo", ...(body.includes("![Diagram]") ? ["Diagram"] : body.includes("https://") ? ["https://example.com"] : [])]) {
		test(`nonoverlapping source atoms paint ${target}: ${JSON.stringify(body)}/${width}`, () => {
			const source = `${body}\n\n[figure]: diagram.svg\n[Diagram]: diagram.svg`;
			const start = body.lastIndexOf(target);
			const progress = new NarrationProgress();
			progress.setCompletedText(source);
			progress.registerSegment({ id: 1, utterance: 1, text: target,
				source: { start, end: start + target.length } });
			progress.setSegmentAudio(1, 0, 10);
			progress.setPlayback(1, 0);
			assert.equal(progress.activeWordStart, start);
			assert.equal(progress.sourceWordTimings(1)[0].sourceOffset, start);
			const painted: string[] = [];
			const leaf = withNarrationLayout(new native.Markdown(source, 1, 0, theme, undefined, {
				transform: text => progress.transform(text, "assistant", plain, text => {
					painted.push(native.stripTerminalSequences(text.replaceAll(progress.activeMarker, "")));
					return `\x1b[48;5;236m${text}\x1b[49m`;
				}, undefined, false, undefined, progress.activeMarker),
			}));
			const lines = leaf.render(width);
			const baseline = new native.Markdown(source, 1, 0, theme).render(width);
			assert.deepEqual(lines.map(line => native.stripTerminalSequences(line.replaceAll(progress.activeMarker, ""))),
				baseline.map(native.stripTerminalSequences));
			const expected = target.startsWith("https") && body.slice(start).startsWith(`${target}/path`) ? `${target}/path` : target;
			assert.equal(painted.join(""), expected);
			assert.equal(lines.join("\n").split(progress.activeMarker).length - 1, 1);
			const anchored = lines.map(line => native.stripTerminalSequences(line.replace(progress.activeMarker, "ANCHOR")).trim().replace(/^│ /, "")).join("");
			// Narrow tables interleave columns between fragments of a wrapped word.
			const anchorText = body.startsWith("|") && width === 18 ? expected.slice(0, 1) : expected;
			assert.equal(anchored.indexOf("ANCHOR"), anchored.replace("ANCHOR", "").lastIndexOf(anchorText),
				"marker anchors the selected final occurrence, not an earlier lookalike");
			assert.deepEqual(leaf.render(width), lines, "cached projection retains paint and scoped anchor");
			assert.equal(progress.sourceTexts[0], source);
		});
	}
}
