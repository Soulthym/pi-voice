import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
// Optional installed Pi runtime exercises newer native mouse/banner code without changing dependencies.
const native = await import(process.env.PI_VOICE_TEST_TUI_MODULE ?? "@earendil-works/pi-tui");
const settle = () => new Promise(resolve => setTimeout(resolve, 120));
initTheme("dark");

for (const action of ["paused anchor", "End", "banner", "controls", "search", "search forced render", "drag", "PageDown bottom", "wheel bottom", "scrollbar bottom", "narrow cached", "wide cached"]) test(`native viewport: ${action}`, async t => {
	const cached = action.endsWith("cached");
	const width = action === "narrow cached" ? 28 : 100;
	const terminal = { columns: width, rows: 40, write() {}, hideCursor() {} };
	const tui: any = new native.TuiAltScreen(terminal, false, undefined,
		{ scrollToEndIndicator: () => "↓ Jump to latest message (End)" });
	if (action === "banner" && !tui.handleScrollToEndIndicatorMouseEvent) {
		t.skip("installed dependency predates the native banner; set PI_VOICE_TEST_TUI_MODULE to a newer Pi TUI");
		return;
	}
	// Render only into the inert terminal: never start a terminal or a live Pi session.
	// Keep native requestRender: force=true clears currentLayout synchronously.
	// The renderer stays stopped; doRender below paints into an inert terminal.
	tui.altScreenActive = true;
	let count = 300;
	let marker = 100;
	const text = Array.from({ length: 60 }, (_, i) => `Sentence ${i} contains several narrated words.`).join(" ");
	let renderText = () => text;
	let quotedHistory = () => "";
	let historyHeight = 1500;
	let tailHeight = 100;
	let editorHeight = 5;
	let progressHeight = 2;
	let footerHeight = 1;
	const transcript = new native.ScrollView({ invalidate() {}, render: (width: number) => cached
		? [...new native.Markdown(quotedHistory(), 1, 0, getMarkdownTheme()).render(width),
			...Array.from({ length: historyHeight }, (_, i) => `history ${i}`),
			...new native.Markdown(renderText(), 1, 0, getMarkdownTheme()).render(width), ...Array(tailHeight).fill("later")]
		: Array.from({ length: count }, (_, i) => i === marker ? renderText() : `line ${i}`)
	}, { primary: true, follow: "end", scrollbar: action === "scrollbar bottom" ? "always" : "hidden" });
	tui.setLayoutRoot(cached ? new native.VStack([
		{ component: transcript, basis: 0, grow: 1 },
		{ component: { invalidate() {}, render: () => Array(editorHeight).fill("editor") }, shrink: 0 },
		{ component: { invalidate() {}, render: () => Array(progressHeight).fill("Voice progress") }, shrink: 0 },
		{ component: { invalidate() {}, render: () => Array(footerHeight).fill("footer") }, shrink: 0 },
	]) : transcript);
	tui.doRender();
	const view = tui.getPrimaryScrollView();
	view.piVoiceCacheNarrationLayout = cached;
	const originalBottom = tui.scrollToBottom;
	const originalGestures = [tui.handleViewportInput, tui.refreshSearch, tui.autoScrollSelection];
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-native-scroll-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local",
		audioCache: false, codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, `native-${action}`);
	Object.assign(host, { tui });
	// Native viewport assertions do not inspect fake theme call history.
	host.ctx.ui.theme.fg = (_name: string, text: string) => text;
	t.after(async () => {
		await host.shutdown();
		MockedVoiceWorkerClient.instances.length = 0; // Release callbacks retaining previous hosts/layouts.
		assert.equal(tui.scrollToBottom, originalBottom, "dispose restores the native adapter");
		assert.deepEqual([tui.handleViewportInput, tui.refreshSearch, tui.autoScrollSelection], originalGestures);
		tui.stopSelectionAutoScroll();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	if (action === "controls") host.addMessage("previous", null, assistant("Older sentence. Another sentence."));
	host.addMessage("answer", null, assistant(cached ? text : "First sentence. Second sentence."));
	await host.start();
	renderText = () => cached ? host.render(text)
		: ["First sentence. Second sentence.", "Older sentence. Another sentence."].map(source => host.render(source)).join(" ");
	await host.shortcut("f11");
	await settle();
	if (cached) {
		const activeMarker = () => {
			const marker = renderText().match(/[\u200b\u200c]*\u2063\u200b\u2063\u200c\u2063/)?.[0];
			assert.ok(marker, "the actual host render must contain its active marker");
			return marker;
		};
		const oldMarker = activeMarker();
		quotedHistory = () => ["user", "toolResult"].map(role => host.render(
			`> Quoted ${NARRATION_ACTIVE_MARKER}legacy marker and ${oldMarker}old narration marker.`, role)).join("\n\n");
		await host.shortcut("f11");
		await settle();
		assert.notEqual(activeMarker(), oldMarker, "replay must retire the copied marker");
		assert.ok(transcript.render(width).filter((line: string) => line.includes(oldMarker)).length >= 2, "user and tool history retain old dynamic markers");
		const currentMarker = activeMarker();
		assert.equal(transcript.render(width).filter((line: string) => line.includes(currentMarker)).length, 1, "only the actual target has the current marker");
		const markerLine = () => {
			// Render once per lookup, not once per history line; replay can replace the marker.
			const marker = activeMarker();
			return transcript.render(width).findIndex((line: string) => line.includes(marker));
		};
		const assertFramed = (label: string) => {
			const target = markerLine();
			assert.ok(target >= 0, `${label}: actual narration target exists`);
			assert.equal(view.scrollTop, Math.max(0, Math.min(view.contentHeight - view.viewportHeight,
				target - Math.floor(view.viewportHeight * 0.2))), label);
			assert.ok(target >= view.scrollTop && target < view.scrollTop + view.viewportHeight, `${label}: target visible`);
		};
		assertFramed("offscreen start at 20%, ignoring quoted markers");
		const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
		const sent = worker.sent as Array<{ utterance: number; segmentId: number }>;
		const segments = sent.filter(segment => segment.utterance === sent.at(-1)!.utterance);
		segments.forEach((segment, i) => worker.emit({ type: "segment-audio", utterance: segment.utterance, segmentId: segment.segmentId, start: i * 2, duration: 2 }));
		for (let i = 0; i < 45; i++) {
			if (i === 12) { terminal.rows = 24; progressHeight = 4; editorHeight = 3; footerHeight = 2; }
			if (i === 24) { terminal.rows = 52; progressHeight = 1; editorHeight = 10; footerHeight = 3; }
			if (i === 36) { terminal.rows = 32; progressHeight = 3; editorHeight = 6; footerHeight = 1; }
			tui.doRender();
			worker.emit({ type: "playback", utterance: segments.at(-1)!.utterance, position: i * 2 });
			await settle();
			assert.equal(view.viewportHeight, terminal.rows - editorHeight - progressHeight - footerHeight, "native layout uses screen height minus chrome");
			if (i % 12 === 0) {
				await host.command("scroll-to");
				assertFramed(`height ${terminal.rows}, editor ${editorHeight}, progress ${progressHeight}, footer ${footerHeight}`);
			}
			const target = markerLine();
			const relative = target - view.scrollTop;
			assert.ok(relative >= Math.floor(view.viewportHeight * 0.2) && relative <= Math.ceil(view.viewportHeight * 0.8),
				`word ${i}: marker ${target}, top ${view.scrollTop}, height ${view.viewportHeight}`);
		}
		tui.handleTerminalInput("\x1b[<64;1;1M");
		const manualTop = view.scrollTop;
		footerHeight++;
		tui.doRender();
		worker.emit({ type: "playback", utterance: segments.at(-1)!.utterance, position: 92 });
		await settle();
		assert.equal(view.scrollTop, manualTop, "layout changes cannot reclaim manual framing");
		await host.shortcut("f8");
		const navigation = host.shortcut("f9");
		assertFramed("paused navigation frames synchronously");
		await navigation;
		assert.equal(worker.pauses.at(-1), true, "paused navigation stays silent");
		historyHeight = tailHeight = 0;
		quotedHistory = () => "";
		const previousUtterance = (worker.sent.at(-1) as { utterance: number }).utterance;
		await host.shortcut("f11");
		await settle();
		tui.doRender();
		await host.command("scroll-to");
		assertFramed("start-of-document clamps to zero");
		assert.equal(view.scrollTop, 0);
		// F11 starts an unpaused replay, even after paused navigation; F8 would pause it.
		assert.equal(worker.pauses.at(-1), false, "replay is playing");
		const replay = (worker.sent as Array<{ utterance: number; segmentId: number; text: string }>);
		const latest = replay.filter(segment => segment.utterance === replay.at(-1)!.utterance);
		assert.notEqual(latest.at(-1)!.utterance, previousUtterance, "drive the regenerated replay, not retired audio");
		assert.ok(latest.at(-1)!.text.includes("Sentence 59"), "replay includes the final spoken sentence");
		latest.forEach((segment, i) => worker.emit({ type: "segment-audio", utterance: segment.utterance, segmentId: segment.segmentId, start: i * 2, duration: 2 }));
		worker.emit({ type: "playback", utterance: latest.at(-1)!.utterance, position: latest.length * 2 - 0.01 });
		await settle();
		tui.doRender();
		await host.command("scroll-to");
		assertFramed("end-of-document clamps to maximum scroll");
		assert.equal(view.scrollTop, Math.max(0, view.contentHeight - view.viewportHeight));
		return;
	}
	assert.equal(view.scrollTop, 92);
	assert.equal(tui.getPrimaryScrollView(), transcript, "explicit preview must not reset native primary layout");
	if (action === "controls") {
		await host.shortcut("f8");
		for (const key of ["f6", "f7", "f9", "f10", "f8", "f11"]) {
			tui.handleTerminalInput("\x1b[<64;1;1M");
			assert.notEqual(view.scrollTop, 92);
			const action = host.shortcut(key);
			assert.equal(view.scrollTop, 92, `${key} frames synchronously after manual unfollow`);
			await action;
			await settle();
			if (["f6", "f7", "f9", "f10"].includes(key)) {
				assert.equal(MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!.pauses.at(-1), true, "paused navigation remains silent");
			}
		}
		return;
	}
	// Genuine input cancels follow; programmatic layout/framing does not.
	tui.handleTerminalInput("\x1b[<64;1;1M");
	await host.shortcut("f11");
	assert.equal(view.scrollTop, 92, "replay immediately rearms after manual browsing");
	view.scrollTo(30);
	tui.requestRender(true);
	tui.doRender();
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const last = worker.sent.at(-1) as { utterance: number };
	(worker.sent as Array<{ utterance: number; segmentId: number }>).filter(segment => segment.utterance === last.utterance)
		.forEach((segment, i) => worker.emit({ type: "segment-audio", utterance: segment.utterance, segmentId: segment.segmentId, start: i * 2, duration: 2 }));
	const tick = async () => { worker.emit({ type: "playback", utterance: last.utterance, position: 0 }); await settle(); };
	await tick();
	assert.equal(view.scrollTop, 92, "programmatic motion does not cancel the ongoing 20–80% follow band");

	if (["search", "search forced render", "drag", "PageDown bottom", "wheel bottom", "scrollbar bottom"].includes(action)) {
		tui.doRender();
		if (action.startsWith("search")) {
			tui.handleTerminalInput("\x1b[102;6u"); // Ctrl+Shift+F
			tui.handleTerminalInput("line 220");
			assert.equal(view.scrollTop, 92, "search reveal is deferred until render");
			if (action === "search forced render") tui.requestRender(true);
			tui.doRender();
			assert.ok(view.scrollTop > 180, "native search reveals the offscreen match");
			tui.handleTerminalInput("\x1b");
		} else if (action === "drag") {
			tui.handleTerminalInput("\x1b[<0;5;20M");
			tui.handleTerminalInput("\x1b[<32;5;1M");
			assert.equal(view.scrollTop, 92, "selection scroll waits for its native timer");
			tui.requestRender(true);
			await settle();
			assert.ok(view.scrollTop < 92, "native selection timer scrolls upward despite cleared layout");
			tui.doRender();
			tui.handleTerminalInput("\x1b[<0;5;1m");
		} else {
			view.scrollTo(259, { disableFollow: true });
			tui.doRender();
			if (action === "PageDown bottom") tui.handleTerminalInput("\x1b[6~");
			else if (action === "wheel bottom") tui.handleTerminalInput("\x1b[<65;1;1M");
			else {
				tui.handleTerminalInput("\x1b[<0;100;38M");
				tui.handleTerminalInput("\x1b[<32;100;40M");
				tui.handleTerminalInput("\x1b[<0;100;40m");
			}
			assert.equal(view.scrollTop, 260, "manual gesture lands exactly at bottom");
			assert.equal(view.isFollowingEnd, true, "native follow-end is not explicit tail intent");
		}
		const manualTop = view.scrollTop;
		marker = 150;
		await tick();
		assert.equal(view.scrollTop, manualTop, "playback cannot reclaim manual framing");
		worker.emit({ type: "idle", utterance: last.utterance });
		await settle();
		assert.equal(view.scrollTop, manualTop, "completion cannot reclaim manual framing");
		await host.shortcut("f11");
		assert.equal(view.scrollTop, 142, "explicit Voice control immediately rearms follow");
		return;
	}

	if (action === "paused anchor") {
		await host.shortcut("f11"); // Restore the preview after the synthetic tick (no worker segments).
		await settle();
		marker = 299;
		await host.command("scroll-to");
		assert.equal(view.isFollowingEnd, true, "ordinary playing tail framing retains native banner suppression");
		tui.doRender();
		assert.equal(tui.scrollToEndIndicatorRect, undefined);
		await host.shortcut("f8");
		await host.command("scroll-to");
		assert.equal(view.scrollTop, 260);
		assert.equal(view.isFollowingEnd, false, "paused Alt+V must not pin the tail");
		count = 320;
		tui.doRender();
		assert.equal(view.scrollTop, 260, "incoming output cannot move a paused narration anchor");
		tui.handleTerminalInput("\x1b[F");
		count = 330;
		tui.doRender();
		assert.equal(view.scrollTop, 290, "explicit native End still pins while paused");
		return;
	}

	const jump = () => {
		if (action === "End") tui.handleTerminalInput("\x1b[F");
		else {
			tui.doRender();
			const rect = tui.scrollToEndIndicatorRect;
			assert.ok(rect, "click the real rendered native banner hitbox");
			tui.handleTerminalInput(`\x1b[<0;${rect.column + 1};${rect.row + 1}M`);
			tui.handleTerminalInput(`\x1b[<0;${rect.column + 1};${rect.row + 1}m`);
		}
	};
	// A native wheel is manual browsing; the subsequent explicit end action supersedes it.
	tui.handleTerminalInput("\x1b[<64;1;1M");
	await tick();
	if (action === "End") {
		const before = view.scrollTop;
		const overlay = tui.showOverlay({ render: () => ["dialog"], invalidate() {}, handleInput() {} });
		tui.handleTerminalInput("\x1b[F");
		assert.equal(view.scrollTop, before, "End owned by an overlay is not a transcript pin");
		overlay.hide();
		tui.handleTerminalInput("\x1b[4;1:3~");
		assert.equal(view.scrollTop, before, "End key release is not a transcript pin");
	}
	jump();
	await tick();
	assert.equal(view.scrollTop, 260, "explicit native end remains pinned until output grows");
	count = 320;
	tui.doRender();
	await tick();
	assert.equal(view.scrollTop, 92, "new output restores the narration window, not manual browsing");
	worker.emit({ type: "idle", utterance: last.utterance });
	await settle();
	assert.equal(view.scrollTop, 280, "completion honors the native end intent");

	await host.shortcut("f11");
	await settle();
	const replay = worker.sent.at(-1) as { utterance: number };
	jump();
	tui.handleTerminalInput("\x1b[<64;1;1M");
	const manualTop = view.scrollTop;
	worker.emit({ type: "playback", utterance: replay.utterance, position: 0 });
	await settle();
	worker.emit({ type: "idle", utterance: replay.utterance });
	await settle();
	assert.equal(view.scrollTop, manualTop, "later wheel browsing overrides native end intent");
	assert.equal(view.isFollowingEnd, false);
});
