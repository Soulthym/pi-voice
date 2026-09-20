import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { NARRATION_ACTIVE_MARKER, NarrationProgress } from "../src/narration-progress.js";

const native = await import(process.env.PI_VOICE_TEST_TUI_MODULE ?? "@earendil-works/pi-tui");
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
	const quote = `> Earlier synthetic ${NARRATION_ACTIVE_MARKER}report is quoted here.\nContinuation of copied report.\n\nA separate follow-up request.`;
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
		const activeLines = markdown(transform());
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

for (const width of [18, 24, 28, 40]) test(`guided code keeps ANSI and UTF-16 spans at width ${width}`, () => {
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
	const render = (text: string): string[] => new native.Markdown(text, 1, 0, { ...theme, highlightCode: syntax }).render(width)
		.map((line: string) => native.stripTerminalSequences(line).replaceAll("\u200c", ""));
	assert.deepEqual(render(transformed), render(source));
});

test("each wrapped active row closes its zone before Markdown padding", {
	todo: "Pi carries background through wrap and appends padding before TUI's end-of-row reset",
}, () => {
	const source = "Alpha bravo charlie delta echo foxtrot golf hotel.";
	const progress = new NarrationProgress();
	progress.setCompletedText(source);
	progress.registerSegment({ id: 1, utterance: 1, text: source, source: { start: 0, end: source.length } });
	progress.setSegmentAudio(1, 0, 10);
	progress.setPlayback(1, 0);
	const transformed = progress.transform(source, "assistant", plain,
		text => `\x1b[48;5;236m${text}\x1b[49m`);
	const lines: string[] = new native.Markdown(transformed, 1, 0, theme).render(18);
	assert.ok(lines.length > 1);
	assert.equal(lines.filter(line => line.includes("\x1b[48;5;236m")).length, lines.length,
		"n wrapped rows have n active zones");
	for (const line of lines.slice(0, -1)) assert.match(line, /\x1b\[49m +$/,
		"zone must end before right padding, not merely at TUI's terminal-row reset");
});

test("upstream wrapping must ignore ANSI-only state before a long token", {
	todo: "Pi wrapSingleLine tests currentLine truthiness instead of visible content before breakLongWord",
}, () => {
	// No Voice transform, marker, Markdown parser, or source offsets involved.
	const text = "Alpha supercalifragilisticexpialidocious";
	const glyphs = (text: string) => native.wrapTextWithAnsi(text, 5).map(native.stripTerminalSequences);
	assert.deepEqual(glyphs(`\x1b[48;5;236m${text}\x1b[49m`), glyphs(text));
});

for (const width of [10, 18, 24, 28, 40]) test(`highlight never moves native glyphs at width ${width}`, async t => {
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
		"Alpha 😀 𐐀mega 界面 bravo charlie delta echo foxtrot golf hotel india.",
		"Alpha bravo charlie delta echo foxtrot golf hotel.\n\n```ts\nconst face = '😀';\n```",
	]) await t.test(source, {
		// Native wrapSingleLine pushes ANSI-only currentLine before an oversized
		// token. List indentation leaves five content columns here; even the
		// untransformed bold baseline can contain a spurious blank row.
		todo: width === 10 && source.startsWith("1.")
			? "upstream ANSI-only row before long token; needs renderer-level fix, not source rewriting"
			: false,
	}, () => {
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
			const transformed = progress.transform(source, "assistant",
				text => `\x1b[38;5;244m${text}\x1b[39m`,
				text => `\x1b[48;5;236m${text}\x1b[49m`,
				undefined, true, undefined, progress.activeMarker);
			const lines = render(transformed);
			const markerOnly = render(progress.transform(source, "assistant", plain, plain,
				undefined, false, undefined, progress.activeMarker));
			assert.deepEqual(glyphs(markerOnly), glyphs(baseline), `marker only: ${source}: position ${position}`);
			assert.deepEqual(glyphs(lines), glyphs(baseline), `${source}: position ${position}`);
			assert.equal(lines.filter(line => line.includes(progress.activeMarker)).length, 1);
			if (source.startsWith("Alpha bravo") && !source.includes("```")) {
				assert.ok(lines.length > 1);
				assert.equal(lines.filter(line => /\x1b\[[\d;]*48;5;236m/.test(line)).length, lines.length,
					"native wrap reapplies one active zone on every visible row; TUI resets each row");
			}
			if (source.includes("**")) assert.ok(lines.some(line => line.includes("\x1b[1m")), "native bold survives");
			if (source.startsWith("##")) assert.ok(lines.some(line => line.includes("\x1b[35m")), "native heading color survives");
			if (source.includes("```")) assert.ok(lines.some(line => line.includes("\x1b[32m")), "native code color survives");
		}
		if (source.includes("𐐀mega")) {
			progress.previewSourceOffset(source.indexOf("𐐀mega"));
			assert.equal(progress.activeWordStart, source.indexOf("𐐀mega"), "source offsets stay UTF-16, not terminal columns");
		}
	});
});
