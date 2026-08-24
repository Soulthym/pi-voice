import assert from "node:assert/strict";
import test from "node:test";
import { computeAutoScrollTop, isManualScrollAway } from "../src/auto-scroll.js";

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

test("manual scrolling away suspends auto-scroll until re-anchor", () => {
	assert.equal(isManualScrollAway(viewport(105), 100), true);
	assert.equal(isManualScrollAway(viewport(101), 100), false);
});
