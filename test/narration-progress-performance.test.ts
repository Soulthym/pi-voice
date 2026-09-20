import assert from "node:assert/strict";
import test from "node:test";
import { NarrationProgress } from "../src/narration-progress.js";
import { withNarrationLayout } from "../src/narration-render.js";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

const dim = (text: string): string => `<dim>${text}</dim>`;
const link = "[label](https://example.test/destination)";

test("Markdown tokens walk each occurrence once and current source is cached", t => {
	const progress = new NarrationProgress();
	const original = String.prototype.indexOf;
	let source = "";
	let scans = 0;
	t.mock.method(String.prototype, "indexOf", function (this: string, search: string, position?: number) {
		if (this === source && search === link) scans++;
		return original.call(this, search, position);
	});
	for (const count of [16, 128]) {
		source = Array(count).fill(`before ${link} after`).join("\n");
		progress.setCompletedText(source);
		scans = 0;
		const expected = Array(count).fill("<dim>before</dim> [<dim>label</dim>](https://example.test/destination) <dim>after</dim>").join("\n");
		assert.equal(progress.transform(source, "assistant", dim), expected);
		assert.equal(scans, count, "each actual link occurrence is located once");
		scans = 0;
		assert.equal(progress.transform(source, "assistant", dim), expected);
		assert.equal(scans, 0, "unchanged Markdown does not rescan tokens");
		progress.previewSourceOffset(source.indexOf("after"));
		progress.transform(source, "assistant", dim);
		assert.equal(scans, 0, "cursor changes reuse source analysis");

		// Replacing the source evicts the previous entry, rather than retaining history.
		progress.setCompletedText("Replacement source");
		progress.transform("Replacement source", "assistant", dim);
		progress.setCompletedText(source);
		progress.transform(source, "assistant", dim);
		assert.equal(scans, count);
	}
});

test("merged exclusions preserve adjacent prose, overlapping syntax and active markers", () => {
	const progress = new NarrationProgress();
	const source = "1. before [label](https://example.test/<hidden>) after\n\n[ref]: https://example.test\n\nend";
	progress.setCompletedText(source);
	assert.equal(progress.transform(source, "assistant", dim),
		"1. <dim>before</dim> [<dim>label</dim>](https://example.test/<hidden>) <dim>after</dim>\n\n[ref]: https://example.test\n\n<dim>end</dim>");
	progress.registerSegment({ id: 1, utterance: 1, text: "1 before label after", source: { start: 0, end: source.indexOf("\n") } });
	progress.setSegmentAudio(1, 0, 4);
	progress.setPlayback(1, 0);
	const marked = progress.transform(source, "assistant", dim, text => text, undefined, true, undefined, "MARK");
	assert.ok(marked.startsWith("1. MARK<dim>before</dim>"));
});

test("benchmark repeated-link Markdown cold analysis and cached progress ticks", () => {
	const progress = new NarrationProgress();
	const times: number[] = [];
	const cold: number[] = [];
	for (let sample = 0; sample < 7; sample++) {
		const source = `${Array(400).fill(`before ${link} after`).join("\n")}\nSample ${sample}`;
		progress.setCompletedText(source);
		let start = performance.now();
		progress.transform(source, "assistant", dim);
		cold.push(performance.now() - start);
		for (let tick = 0; tick < 10; tick++) {
			progress.previewSourceOffset(tick * 60);
			start = performance.now();
			progress.transform(source, "assistant", dim);
			times.push(performance.now() - start);
		}
	}
	const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2);
	console.log(`400 repeated links: cold median=${median(cold)}ms, cached tick median=${median(times)}ms (transform only; no inference)`);
});

test("benchmark 200 repeated links through native layout", () => {
	const plain = (text: string) => text;
	const theme: MarkdownTheme = {
		heading: plain, link: plain, linkUrl: plain, code: plain, codeBlock: plain,
		codeBlockBorder: plain, quote: plain, quoteBorder: plain, hr: plain,
		listBullet: plain, bold: plain, italic: plain, strikethrough: plain, underline: plain,
	};
	const source = Array(200).fill(`word ${link}`).join(" ");
	const progress = new NarrationProgress();
	progress.setCompletedText(source);
	const times: number[] = [];
	for (let sample = 0; sample < 12; sample++) {
		progress.previewSourceOffset(sample * (link.length + 6));
		const start = performance.now();
		const lines = withNarrationLayout(new Markdown(source, 1, 0, theme, undefined, {
			transform: text => progress.transform(text, "assistant", plain, plain, undefined, false, undefined, progress.activeMarker),
		})).render(100);
		if (sample >= 2) times.push(performance.now() - start);
		assert.ok(lines.some(line => line.includes(progress.activeMarker)));
	}
	times.sort((a, b) => a - b);
	console.log(`200 repeated links (${source.length} UTF-16 units): warmed fresh native render median=${times[Math.floor(times.length / 2)].toFixed(2)}ms; no inference`);
});
