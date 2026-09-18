import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { invalidateNarrationMarkdown } from "../src/narration-render.js";

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
});
