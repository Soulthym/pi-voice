import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const native = await import(process.env.PI_VOICE_TEST_TUI_MODULE ?? "@earendil-works/pi-tui");
if (process.env.PI_VOICE_TEST_TUI_MODULE) mock.module("@earendil-works/pi-tui", { namedExports: { ...native } });
const { getMarkdownTheme, initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");
const settle = () => new Promise(resolve => setTimeout(resolve, 180));

for (const start of ["offscreen", "visible"] as const) for (const timing of ["none", "timed", "unmapped"] as const) {
	test(`native live follow: starts ${start}, ${timing}`, async t => {
		const timed = timing !== "none";
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "lf-"));
		const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
		const previous = names.map(name => process.env[name]);
		names.forEach((name, i) => { process.env[name] = path.join(root, ["voice.json", "coord", "devices"][i]); });
		await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, autoScroll: true,
			input: "disabled", output: "local", audioCache: false, mode: "assistant",
			codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
		const host = new FakeVoiceHost(root, "live-follow");
		const terminal = { columns: 60, rows: 24, write() {}, hideCursor() {} };
		const tui: any = new native.TuiAltScreen(terminal, false);
		tui.altScreenActive = true;
		Object.assign(host, { tui });
		host.ctx.ui.theme.fg = (_name: string, text: string) => text;
		let historyHeight = 80, tailHeight = 0, chromeHeight = 5;
		let text = "Audible **sentinel** begins the spoken sentence. ";
		let audible = "Audible";
		const growth = Array.from({ length: 65 }, (_, i) => `Generated paragraph ${i} has many words not yet spoken.\n\n`).join("");
		if (start === "offscreen") text += growth;
		const theme = getMarkdownTheme();
		// A native glyph replacement unsupported by the paint projection must keep its baseline.
		if (timing === "unmapped") theme.bold = text => text.includes("\x1b_voice-paint-") ? "UNMAPPABLE_PROBE" : "NATIVE_REPLACEMENT";
		const leaf = new native.Markdown(text.trim(), 1, 0, theme, undefined, { transform: (source: string) => host.render(source) });
		const transcript = new native.ScrollView({ children: [leaf], invalidate() { leaf.invalidate(); }, render(width: number) {
			return [...Array(historyHeight).fill("earlier context"), ...leaf.render(width), ...Array(tailHeight).fill("tool/model output")];
		} }, { primary: true, follow: "end" });
		tui.setLayoutRoot(new native.VStack([{ component: transcript, basis: 0, grow: 1 },
			{ component: { invalidate() {}, render: () => Array(chromeHeight).fill("editor/footer") }, shrink: 0 }]));
		tui.doRender();
		const frame = () => { tui.doRender(); return tui.previousScreen.map((line: string) => native.stripTerminalSequences(line)); };
		const audibleLine = () => transcript.render(terminal.columns).findIndex((line: string) => native.stripTerminalSequences(line).includes(audible));
		const visible = () => frame().some((line: string) => line.includes(audible));
		const assertVisible = (label: string) => {
			assert.equal(visible(), true, `${label}: audible glyphs must be in the effective native frame (top ${transcript.scrollTop}, line ${audibleLine()})`);
			assert.ok(audibleLine() >= transcript.scrollTop && audibleLine() < transcript.scrollTop + transcript.viewportHeight, label);
			assert.equal(transcript.viewportHeight, terminal.rows - chromeHeight);
		};
		assert.equal(visible(), start === "visible", "fixture proves the initial effective viewport");
		t.after(async () => {
			await host.shutdown();
			tui.stopSelectionAutoScroll();
			MockedVoiceWorkerClient.instances.length = 0;
			names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
			await fs.rm(root, { recursive: true, force: true });
		});
		await host.start();
		host.idle = false;
		await host.emit("before_agent_start", {});
		await host.emit("message_start", { message: assistant(text, "pending") });
		const delta = async (added: string) => {
			const partial = assistant(text, "pending");
			await host.emit("message_update", { message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: added, partial } });
			leaf.setText(text.trim());
		};
		await delta(text);
		await settle();
		const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
		assert.ok(worker, "real live autoplay path dispatches synthetic audio");
		const first = (worker.sent as Array<{ utterance: number; segmentId: number; text: string }>).find(segment => segment.text.includes("Audible"))!;
		assert.ok(first, "use content audio, not the project-name announcement");
		if (timed) worker.emit({ ...first, type: "segment-audio", start: 0, duration: 60 });
		worker.emit({ type: "playback", utterance: first.utterance, position: 0 });
		await settle();
		if (timed) {
			assert.match(host.render(text.trim()), /pi-voice-[a-f0-9]+/, "timed audible source has its current marker");
			if (timing === "timed") assert.match(leaf.render(terminal.columns).join("\n"), /pi-voice-[a-f0-9]+/, "mounted native glyph rows carry the marker");
			else {
				assert.doesNotMatch(leaf.render(terminal.columns).join("\n"), /pi-voice-[a-f0-9]+/, "fixture really has an unmappable projection");
				assert.deepEqual(leaf.render(terminal.columns), new native.Markdown(text.trim(), 1, 0, theme).render(terminal.columns), "unmapped paint preserves every native baseline byte");
			}
		}
		assertVisible("live playback start");
		if (start === "visible") { text += growth; await delta(growth); }
		await settle();
		assertVisible("streaming growth follows speech, not generated tail");
		// No new audio event: native layout itself must retain the audible position.
		historyHeight += 45;
		tailHeight += 25;
		await host.emit("tool_execution_update", { toolCallId: "synthetic", toolName: "read", partialResult: {} });
		assertVisible("tool/layout shift during playback");
		const height = transcript.contentHeight;
		historyHeight += 20; tailHeight -= 20;
		assertVisible("same-height layout redistribution");
		assert.equal(transcript.contentHeight, height, "total height alone cannot validate a cached message top");
		const redistributedTop = transcript.scrollTop;
		worker.emit({ type: "playback", utterance: first.utterance, position: 0 });
		await settle();
		assert.equal(transcript.scrollTop, redistributedTop, "a later tick cannot reuse the old absolute line anchor");
		terminal.rows = 14; terminal.columns = 32; chromeHeight = 7;
		assertVisible("resize and editor/footer pressure");
		if (timing === "timed") {
			const segments = (worker.sent as Array<{ utterance: number; segmentId: number; text: string }>).filter(segment => segment.utterance === first.utterance);
			segments.forEach((segment, i) => worker.emit({ ...segment, type: "segment-audio", start: i * 60, duration: 60 }));
			const index = segments.findIndex(segment => segment.text.includes("Generated paragraph 10"));
			assert.ok(index > 0, "long stream contains a later audible checkpoint");
			audible = "Generated paragraph 10";
			worker.emit({ type: "playback", utterance: first.utterance, position: index * 60 });
			await settle();
			assertVisible("audible cursor advances within a long stream, not to its newest text");
		}
		const beforeSave = transcript.scrollTop;
		const complete = assistant(text);
		host.addMessage("persisted", null, complete);
		await host.emit("message_end", { message: complete });
		await host.emit("turn_end", { message: complete, toolResults: [] });
		await settle();
		assertVisible("source canonicalization");
		assert.equal(transcript.scrollTop, beforeSave, "provisional-to-persisted identity does not jump the line anchor");
		await host.command("autoscroll off");
		frame();
		for (let i = 0; i < 20; i++) tui.handleTerminalInput("\x1b[<64;1;1M");
		const manualTop = transcript.scrollTop;
		assert.equal(visible(), false, "manual browse actually hides the audible glyphs");
		historyHeight += 20;
		worker.emit({ type: "playback", utterance: first.utterance, position: 0.1 });
		await settle(); frame();
		assert.equal(transcript.scrollTop, manualTop, "disabled follow never reclaims manual browsing");
		await host.command("autoscroll on");
		frame();
		assert.equal(transcript.scrollTop, manualTop, "enabling the setting does not cancel intentional manual framing");
		if (timing === "timed") {
			audible = "Audible";
			await host.shortcut("alt+v");
			assertVisible("explicit jump rearms Voice follow");
			await host.shortcut("f8");
			assert.equal(worker.pauses.at(-1), true);
			const pausedTop = transcript.scrollTop;
			tailHeight += 30; frame();
			assert.equal(transcript.scrollTop, pausedTop, "paused framing stays fixed across new layout");
			await host.shortcut("alt+t"); frame();
			assert.equal(transcript.isFollowingEnd, true, "Alt+T pins native tail independently of paused Voice");
			assert.equal(worker.pauses.at(-1), true);
			await host.shortcut("alt+v");
			assertVisible("paused jump back to the audible source");
			assert.equal(transcript.isFollowingEnd, false);
			await host.shortcut("f5"); await settle();
			assertVisible("historical replay starts");
			await host.emit("before_agent_start", {});
			const newer = assistant("Unrelated model output.", "pending");
			await host.emit("message_start", { message: newer });
			await host.emit("message_update", { message: newer, assistantMessageEvent: {
				type: "text_delta", contentIndex: 0, delta: "Unrelated model output.", partial: newer } });
			historyHeight += 30; tailHeight += 50;
			assertVisible("new model/tool context cannot displace an older audible replay");
		}
		assert.equal(host.modelRequests.length, 0);
	});
}
