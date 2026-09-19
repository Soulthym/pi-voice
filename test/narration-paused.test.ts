import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView } from "@earendil-works/pi-tui";
import { type ScrollViewportLike, computeAutoScrollTop } from "../src/auto-scroll.js";
import { frameNarrationViewport } from "../src/narration-render.js";
import { NarrationProgress, NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";

test("late alignment and audio retain a frozen marker, explicit preview/resume applies refinements", () => {
	const progress = new NarrationProgress();
	const text = "Alpha beta gamma.";
	progress.setCompletedText(text);
	progress.registerSegment({ id: 1, utterance: 1, text, source: { start: 0, end: text.length } });
	progress.setSegmentAudio(1, 0, 3);
	progress.setPlayback(1, 1.5);
	const render = () => progress.transform(text, "assistant", s => s, s => `<active>${s}</active>`,
		undefined, true, undefined, NARRATION_ACTIVE_MARKER);
	assert.ok(progress.transform(text, "assistant", s => s, s => s, undefined, false, undefined,
		NARRATION_ACTIVE_MARKER).includes(NARRATION_ACTIVE_MARKER), "manual marker lookup needs no progress styling");
	const frozen = render();
	progress.setPaused(true);
	progress.setSegmentAudio(1, 0, 4);
	assert.equal(render(), frozen);
	progress.setAlignment(1, [
		{ text: "Alpha", start: 0, end: 2 },
		{ text: "beta", start: 2, end: 2.5 },
		{ text: "gamma", start: 2.5, end: 3 },
	]);
	assert.equal(render(), frozen);
	assert.equal(progress.sourceWordTimings(1)[1].time, 2);
	progress.setPlayback(1, 0);
	assert.equal(render(), frozen);
	progress.setPlayback(1, 2.6, true);
	assert.ok(render().includes(`${NARRATION_ACTIVE_MARKER}gamma`));
	progress.setPlayback(1, 0);
	progress.setPaused(false);
	assert.ok(render().includes(`${NARRATION_ACTIVE_MARKER}Alpha`));
});

test("native ScrollView framing clamps at tail without suppressing native follow, manual scroll remains free", () => {
	const view = new ScrollView({ render: () => Array(300).fill("line"), invalidate() {} }, { follow: "end" });
	view.updateLayout(300, 40, () => {});
	// Pi exposes these layout fields at runtime, but marks contentHeight private in its declaration.
	const adapter = view as unknown as ScrollViewportLike & Pick<ScrollView, "scrollTo">;
	frameNarrationViewport(adapter, computeAutoScrollTop(adapter, 299, true)!);
	assert.equal(view.scrollTop, 260);
	assert.equal(view.isFollowingEnd, true, "native jump-to-end state must not be suppressed at the end");
	view.updateLayout(301, 40, () => {});
	assert.equal(view.scrollTop, 261);
	frameNarrationViewport(adapter, computeAutoScrollTop(adapter, 300, true)!, false);
	assert.equal(view.isFollowingEnd, false, "paused navigation to the last word is not a bottom pin");
	view.updateLayout(320, 40, () => {});
	assert.equal(view.scrollTop, 261, "incoming output must not move the paused anchor");
	view.scrollToEnd();
	view.updateLayout(321, 40, () => {});
	assert.equal(view.scrollTop, 281, "explicit bottom pin still follows output while paused");
	frameNarrationViewport(adapter, computeAutoScrollTop(adapter, 120, true)!);
	assert.equal(view.scrollTop, 112);
	assert.equal(view.isFollowingEnd, false);
	view.scrollBy(-1);
	assert.equal(view.scrollTop, 111);
	view.updateLayout(200, 30, () => {});
	assert.equal(view.scrollTop, 111, "resize/collapse alone must not re-anchor a paused view");
});
