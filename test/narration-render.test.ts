import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { invalidateNarrationMarkdown } from "../src/narration-render.js";
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
