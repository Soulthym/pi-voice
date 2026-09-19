import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
// Optional installed Pi runtime exercises newer native mouse/banner code without changing dependencies.
const native = await import(process.env.PI_VOICE_TEST_TUI_MODULE ?? "@earendil-works/pi-tui");
const settle = () => new Promise(resolve => setTimeout(resolve, 120));

for (const action of ["paused anchor", "End", "banner"]) test(`native viewport: ${action}`, async t => {
	const tui: any = new native.TuiAltScreen({ columns: 100, rows: 40, write() {}, hideCursor() {} }, false, undefined,
		{ scrollToEndIndicator: () => "↓ Jump to latest message (End)" });
	if (action === "banner" && !tui.handleScrollToEndIndicatorMouseEvent) {
		t.skip("installed dependency predates the native banner; set PI_VOICE_TEST_TUI_MODULE to a newer Pi TUI");
		return;
	}
	// Render only into the inert terminal: never start a terminal or a live Pi session.
	tui.requestRender = () => {};
	tui.altScreenActive = true;
	let count = 300;
	let marker = 100;
	tui.addChild({ invalidate() {}, render: () => Array.from({ length: count }, (_, i) =>
		i === marker ? `${NARRATION_ACTIVE_MARKER}First` : `line ${i}`) });
	tui.doRender();
	const view = tui.getPrimaryScrollView();
	view.piVoiceCacheNarrationLayout = false;
	const originalBottom = tui.scrollToBottom;
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
	t.after(async () => {
		await host.shutdown();
		assert.equal(tui.scrollToBottom, originalBottom, "dispose restores the native adapter");
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("answer", null, assistant("First sentence. Second sentence."));
	await host.start();
	await host.shortcut("f11");
	await settle();
	assert.equal(view.scrollTop, 92);
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const last = worker.sent.at(-1) as { utterance: number };
	const tick = async () => { worker.emit({ type: "playback", utterance: last.utterance, position: 0 }); await settle(); };

	if (action === "paused anchor") {
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
