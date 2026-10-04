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
const settle = () => new Promise(resolve => setTimeout(resolve, 160));

for (const offscreen of [false, true]) for (const manual of [false, true]) test(`native Tail → speaking → Tail: offscreen=${offscreen}, manual=${manual}`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "tc-"));
	for (const [key, value] of Object.entries({ PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coord"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") })) {
		const old = process.env[key]; process.env[key] = value;
		t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
	}
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, autoScroll: true, input: "disabled", output: "local", codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "cycle");
	const terminal = { columns: 60, rows: 24, write() {}, hideCursor() {} };
	const tui: any = new native.TuiAltScreen(terminal, false); tui.altScreenActive = true;
	Object.assign(host, { tui });
	const leaf = new native.Markdown("", 1, 0, getMarkdownTheme(), undefined, { transform: (text: string) => host.render(text) });
	let tail = 0;
	const view = new native.ScrollView({ children: [leaf], invalidate() { leaf.invalidate(); }, render(width: number) {
		return [...Array(80).fill("earlier context"), ...leaf.render(width), ...Array(tail).fill("newest generated output")];
	} }, { primary: true, follow: "end" });
	tui.setLayoutRoot(new native.VStack([{ component: view, basis: 0, grow: 1 }]));
	const frame = () => { tui.doRender(); return tui.previousScreen.map((line: string) => native.stripTerminalSequences(line)); };
	frame(); await host.start(); await host.shortcut("f10"); frame();
	assert.equal(view.isFollowingEnd, true);
	t.after(async () => { await host.shutdown(); tui.stopSelectionAutoScroll(); await fs.rm(root, { recursive: true, force: true }); });
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const text = "Audible sentinel sentence. ";
	const partial = assistant(text, "pending");
	if (offscreen) tail = 70;
	leaf.setText(text); frame();
	await host.emit("before_agent_start", {});
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
	await settle();
	const segment = (worker.sent as Array<{ utterance: number; segmentId: number; text: string }>).find(s => s.text === text.trim())!;
	assert.ok(segment);
	for (const earlier of worker.sent as Array<{ utterance: number }>) if (earlier.utterance < segment.utterance) worker.emit({ type: "idle", utterance: earlier.utterance });
	worker.emit({ ...segment, type: "segment-audio", start: 0, duration: 5 });
	worker.emit({ type: "playback", utterance: segment.utterance, position: 0.2 }); await settle();
	assert.ok(frame().some((line: string) => line.includes("Audible sentinel")));
	tail = 90; frame();
	assert.ok(frame().some((line: string) => line.includes("Audible sentinel")), "layout pushes cannot follow newest generated text");
	assert.equal(view.isFollowingEnd, false);
	if (manual) for (let i = 0; i < 18; i++) tui.handleTerminalInput("\x1b[<64;1;1M");
	const manualTop = view.scrollTop;
	const pauses = worker.pauses.length;
	const complete = assistant(text);
	host.addMessage("one", null, complete);
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete }); await settle(); frame();
	assert.equal(view.isFollowingEnd, false, "model finalization is not physical audio completion");
	worker.emit({ type: "idle", utterance: segment.utterance }); await settle(); frame();
	assert.equal(view.isFollowingEnd, !manual, "whole-message completion restores only still-enabled viewport follow");
	if (manual) {
		assert.equal(view.scrollTop, manualTop);
		assert.equal(worker.pauses.length, pauses, "manual scrolling and EOF do not stop audio");
	}
	assert.match(host.widgetLines()!.join(" "), /2\/1/);
	const next = assistant("Next audible sentence. ", "pending"); leaf.setText(next.content[0]!.text); tail += 20; frame();
	await host.emit("before_agent_start", {});
	await host.emit("message_start", { message: next });
	await host.emit("message_update", { message: next, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: next.content[0]!.text } }); await settle(); frame();
	assert.ok(worker.sent.some((s: any) => s.text === "Next audible sentence."), "viewport override does not disable live playback");
	if (manual) assert.equal(view.scrollTop, manualTop, "later audible messages cannot silently re-enable follow");
	else assert.ok(frame().some((line: string) => line.includes("Next audible")));
});
