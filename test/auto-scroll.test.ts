import assert from "node:assert/strict";
import test from "node:test";
import { anchorLineForMessage, computeAutoScrollTop, isManualScrollAway, narrationSourceLine } from "../src/auto-scroll.js";

test("starts always anchor at twenty percent, clamped to the real transcript end", () => {
	const view = { scrollTop: 100, viewportHeight: 40, contentHeight: 300 };
	assert.equal(computeAutoScrollTop(view, 120), null);
	assert.equal(computeAutoScrollTop(view, 120, true), 112);
	assert.equal(computeAutoScrollTop(view, 299, true), 260);
	assert.equal(computeAutoScrollTop(view, 2, true), 0);
});

const viewport = (scrollTop: number, viewportHeight = 40, contentHeight = 400) => ({
	scrollTop,
	viewportHeight,
	contentHeight,
});

test("keeps the anchor inside the 20-80 percent band without scrolling", () => {
	// 40-line viewport: band spans lines scrollTop+8 … scrollTop+32.
	assert.equal(computeAutoScrollTop(viewport(100), 100 + 8), null);
	assert.equal(computeAutoScrollTop(viewport(100), 100 + 20), null);
	assert.equal(computeAutoScrollTop(viewport(100), 100 + 32), null);
});

test("re-anchors out-of-band highlights at the 20 percent mark", () => {
	// Above the band: anchor lands on the top band edge.
	assert.equal(computeAutoScrollTop(viewport(200), 150), 142);
	// Below the band: scrolled just enough to sit at the 20% mark.
	assert.equal(computeAutoScrollTop(viewport(0), 60), 52);
	// Never scrolls past the end of the content.
	const nearEnd = computeAutoScrollTop(viewport(0, 40, 90), 80);
	assert.equal(nearEnd, Math.min(50, 80 - 8));
});

test("degenerate viewports never scroll", () => {
	assert.equal(computeAutoScrollTop(viewport(0, 0, 100), 10), null);
	assert.equal(computeAutoScrollTop(viewport(0, 40, 10), 5), null);
});

test("markerless fallback uses current mounted rows and declines missing or ambiguous sources", () => {
	const leaf = { text: "source", cachedLines: ["native first", "native second"] };
	const box = { component: { children: [leaf] }, rect: { width: 30 }, children: [], scrollContentLines: ["history", ...leaf.cachedLines, "tail"] };
	assert.equal(narrationSourceLine(box, "source"), 1);
	assert.equal(narrationSourceLine(box, "other source"), undefined);
	box.scrollContentLines = ["replacement native layout", "tail"];
	assert.equal(narrationSourceLine(box, "source"), undefined, "stale leaf rows cannot locate a source in the current frame");
	leaf.cachedLines = ["replacement native layout"];
	assert.equal(narrationSourceLine(box, "source"), 0);
	box.scrollContentLines.push(...leaf.cachedLines);
	assert.equal(narrationSourceLine(box, "source"), undefined, "repeated baseline glyphs are ambiguous");
});

test("detects manual reframing relative to the last automatic anchor", () => {
	assert.equal(isManualScrollAway(viewport(105), 100), true);
	assert.equal(isManualScrollAway(viewport(101), 100), true);
});

test("anchor tracks playback fraction inside the message", () => {
	// A 30-line message starting at line 500.
	assert.equal(anchorLineForMessage(500, 30, 0), 500);
	assert.equal(anchorLineForMessage(500, 30, 0.5), 515);
	assert.equal(anchorLineForMessage(500, 30, 1), 530);
	assert.equal(anchorLineForMessage(500, 30, 2), 530, "fractions clamp high");
	assert.equal(anchorLineForMessage(500, 30, -1), 500, "fractions clamp low");

	// End-to-end: speaking near the end of a tall message scrolls so the
	// anchor sits at the 20% mark of a 40-line viewport.
	const anchor = anchorLineForMessage(300, 120, 0.9);
	const target = computeAutoScrollTop(viewport(0, 40, 600), anchor);
	assert.equal(target, anchor - 8);
});
