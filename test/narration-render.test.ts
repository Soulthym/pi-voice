import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { invalidateNarrationMarkdown, withNarrationLayout } from "../src/narration-render.js";
import { NARRATION_ACTIVE_MARKER, NarrationProgress } from "../src/narration-progress.js";

test("joined thinking Markdown refreshes cached markers and clears old highlights", () => {
	const progress = new NarrationProgress();
	const first = "Alpha beta.";
	const second = "Gamma delta.";
	const joined = `${first}\n\n${second}`;
	progress.begin();
	progress.pushDelta("assistant-thinking", 0, first);
	progress.pushDelta("assistant-thinking", 1, second, first.length + 2);
	let transforms = 0;
	const thinking = new Markdown(joined, 0, 0, theme, undefined, {
		transform: text => {
			transforms++;
			return progress.transform(text, "assistant-thinking", plain, plain, undefined, true, undefined, NARRATION_ACTIVE_MARKER);
		},
	});
	const tui = { children: [{ child: thinking }] };
	const render = () => thinking.render(100).join("\n");
	progress.previewSourceOffset(0);
	const initial = render();
	assert.ok(initial.includes(`${NARRATION_ACTIVE_MARKER}Alpha`));
	const previousSources = new Set(progress.sourceTexts);
	assert.deepEqual([...previousSources], [first, second]);
	progress.previewSourceOffset(first.length);
	assert.equal(render(), initial, "Pi Markdown retains its cached transform until invalidated");
	invalidateNarrationMarkdown(tui, previousSources);
	const moved = render();
	assert.ok(moved.includes(`${NARRATION_ACTIVE_MARKER}Gamma`));
	assert.ok(!moved.includes(`${NARRATION_ACTIVE_MARKER}Alpha`));
	assert.equal(transforms, 2);

	// Replay can track only the second block while Pi still displays the whole run.
	progress.setCompletedText(second, "assistant-thinking", 1, first.length + 2);
	progress.previewSourceOffset(6);
	invalidateNarrationMarkdown(tui, new Set(progress.sourceTexts));
	assert.ok(render().includes(`${NARRATION_ACTIVE_MARKER}delta`));
	progress.begin();
	invalidateNarrationMarkdown(tui, previousSources);
	assert.ok(!render().includes(NARRATION_ACTIVE_MARKER), "previous sources clear cached markers after reset");
	assert.equal(transforms, 4);
});

const plain = (text: string) => text;
const theme: MarkdownTheme = {
	heading: plain, link: plain, linkUrl: plain, code: plain, codeBlock: plain,
	codeBlockBorder: plain, quote: plain, quoteBorder: plain, hr: plain,
	listBullet: plain, bold: plain, italic: plain, strikethrough: plain, underline: plain,
};

test("narration invalidates only affected Markdown, retaining historical parse caches", () => {
	const transcript = new Container();
	let transforms = 0;
	const sources = Array.from({ length: 1000 }, (_, i) => `Message ${i}.\n\n\`\`\`js\nconst value = ${i};\n\`\`\``);
	for (const source of sources) transcript.addChild(new Markdown(source, 0, 0, theme, undefined, {
		transform: text => { transforms++; return text; },
	}));
	transcript.render(100);
	transforms = 0;
	let start = performance.now();
	transcript.invalidate();
	transcript.render(100);
	const fullMs = performance.now() - start;
	assert.equal(transforms, 1000);
	transforms = 0;
	start = performance.now();
	assert.equal(invalidateNarrationMarkdown({ getMountedRoots: () => [transcript] }, new Set([sources[999]!])), true);
	transcript.render(100);
	console.log(`1000-message render: full=${fullMs.toFixed(1)}ms, targeted=${(performance.now() - start).toFixed(1)}ms`);
	assert.equal(transforms, 1, "do not reparse 999 unaffected historical messages on a word tick");
	transforms = 0;
	invalidateNarrationMarkdown({ children: [transcript] }, new Set(), new Set(["const value = 500;"]));
	transcript.render(100);
	assert.equal(transforms, 1, "description arrival invalidates only Markdown containing its code");
	assert.equal(invalidateNarrationMarkdown({}, new Set()), false, "unknown TUI shapes need compatibility fallback");
	const thinking = new Markdown("Private thinking", 0, 0, theme, undefined, {
		transform: text => { transforms++; return text; },
	});
	thinking.render(100);
	transforms = 0;
	// MouseRegion wraps thinking in a single `child`, not a Container.children array.
	invalidateNarrationMarkdown({ children: [{ child: thinking }] }, new Set(["Private thinking"]));
	thinking.render(100);
	assert.equal(transforms, 1, "thinking wrapped in MouseRegion must also refresh");
});

test("current-message paint reuses one native baseline without reparsing history", () => {
	const progress = new NarrationProgress();
	const source = `${"1. Alpha **bravo** charlie delta echo foxtrot golf hotel.\n".repeat(40)}\n\`\`\`ts\nconst face = '😀';\n\`\`\``;
	progress.setCompletedText(source);
	progress.registerSegment({ id: 1, utterance: 1, text: "Alpha bravo charlie delta echo foxtrot golf hotel.",
		source: { start: 3, end: source.indexOf("\n") } });
	progress.setSegmentAudio(1, 0, 10);
	let baselineSyntaxCalls = 0;
	let nativeListRenders = 0;
	let historyTransforms = 0;
	const root = new Container();
	for (let i = 0; i < 1000; i++) root.addChild(new Markdown(`Historical message ${i}`, 1, 0, theme, undefined, {
		transform: text => { historyTransforms++; return text; },
	}));
	const target = withNarrationLayout(new Markdown(source, 1, 0, { ...theme,
		listBullet: text => { nativeListRenders++; return text; }, highlightCode: code => {
		baselineSyntaxCalls++;
		return code.split("\n").map(line => `\x1b[32m${line}\x1b[39m`);
	} }, undefined, { transform: text => progress.transform(text, "assistant",
		text => `\x1b[38;5;244m${text}\x1b[39m`, text => `\x1b[48;5;236m${text}\x1b[49m`,
		undefined, true, undefined, progress.activeMarker) }));
	root.addChild(target);
	progress.setPlayback(1, 0);
	root.render(100);
	assert.equal(baselineSyntaxCalls, 1);
	assert.equal(nativeListRenders, 80, "one baseline plus one source-map probe");
	historyTransforms = 0;
	const times: number[] = [];
	for (let tick = 1; tick <= 20; tick++) {
		progress.setPlayback(1, tick / 3);
		const start = performance.now();
		invalidateNarrationMarkdown({ children: [root] }, new Set([source]));
		root.render(100);
		times.push(performance.now() - start);
	}
	assert.equal(historyTransforms, 0, "ticks never transform/render a second copy of history");
	assert.equal(baselineSyntaxCalls, 1, "native baseline is immutable across word ticks");
	assert.equal(nativeListRenders, 80, "stable source-map probe is also reused across word ticks");
	console.log(`current-message post-wrap paint: ${source.length} UTF-16 units, median=${times.sort((a, b) => a - b)[10].toFixed(1)}ms`);
	root.render(28);
	assert.equal(baselineSyntaxCalls, 2, "resize replaces, rather than accumulates, the baseline");
	target.invalidate();
	root.render(28);
	assert.equal(baselineSyntaxCalls, 3, "ordinary theme/source invalidation rebuilds native styles");
});
