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
