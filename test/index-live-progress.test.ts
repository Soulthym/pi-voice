import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const native = await import(process.env.PI_VOICE_TEST_TUI_MODULE ?? "@earendil-works/pi-tui");
if (process.env.PI_VOICE_TEST_TUI_MODULE) mock.module("@earendil-works/pi-tui", { namedExports: { ...native } });
const settle = async () => {
	for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setTimeout(resolve, 100));
};

test("mounted playbar keeps a queued live target through background preparation and streaming", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-live-progress-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", output: "local", audioCache: false }));
	const host = new FakeVoiceHost(root, "live-progress");
	// Actual Pi replacement + container + fullscreen layout, on an inert terminal.
	const { InteractiveMode, initTheme } = await import(process.env.PI_VOICE_TEST_AGENT_MODULE ?? "@earendil-works/pi-coding-agent");
	initTheme("dark");
	const terminal = { columns: 100, rows: 24, write() {}, hideCursor() {} };
	const tui: any = new native.TuiAltScreen(terminal, false);
	tui.altScreenActive = true; // Never start a terminal or live session.
	const mountedRows: string[][] = [];
	const frames: string[][] = [];
	const nativeUI = Object.assign(Object.create(InteractiveMode.prototype), {
		extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
		widgetContainerAbove: new native.Container(), widgetContainerBelow: new native.Container(), ui: tui,
	});
	const transcript = new native.ScrollView(new native.Text("history\n".repeat(100), 0, 0), { primary: true, follow: "end" });
	// Match InteractiveMode's dock ordering and shrink/minSize policy.
	const dock = new native.VStack([
		{ component: new native.Container(), shrink: 1, minSize: 0 }, // pending messages
		{ component: new native.Container(), shrink: 1, minSize: 0 }, // working status
		{ component: nativeUI.widgetContainerAbove, shrink: 1, minSize: 0 },
		{ component: new native.Text("editor\n\n", 0, 0), shrink: 1, minSize: 3 },
		{ component: nativeUI.widgetContainerBelow, shrink: 1, minSize: 0 },
		{ component: new native.Text("footer", 0, 0), shrink: 1, minSize: 1 },
	]);
	tui.setLayoutRoot(new native.VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]));
	const requestRender = tui.requestRender.bind(tui);
	let painting = false;
	tui.requestRender = (force?: boolean) => {
		requestRender(force);
		if (painting) return;
		painting = true;
		try {
			tui.doRender();
			frames.push(tui.previousScreen.map(native.stripTerminalSequences));
		} finally { painting = false; }
	};
	host.ctx.ui.setWidget = (name: string, value: any, options: any) => {
		nativeUI.setExtensionWidget(name, value, options);
		const component = nativeUI.extensionWidgetsBelow.get(name) ?? nativeUI.extensionWidgetsAbove.get(name);
		const normalized = component ? { lines: component.render(160).map((line: string) => line.trimStart()), placement: options?.placement } : undefined;
		host.widgets.set(name, normalized);
		host.widgetOperations.push({ name, value: normalized });
		mountedRows.push(nativeUI.widgetContainerBelow.render(160));
	};
	const assertFrame = (label: string) => {
		tui.requestRender();
		assert.match(frames.at(-1)!.join("\n"), /(?:Paused|Waiting|Playing|Idle).*message /, label);
	};
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	t.after(async () => {
		await host.shutdown();
		for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("old", null, assistant("Historical response."));
	await host.start();
	await host.shortcut("f5"); await settle();
	await host.shortcut("f8"); await settle();
	assert.match(host.widgetLines()![0]!, /Paused/);
	const partial = assistant("New response first sentence. ");
	delete partial.stopReason;
	host.idle = false;
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: partial.content[0].text } });
	await host.shortcut("f10"); await settle();
	assert.match(host.widgetLines()![0]!, /Paused.*message 2\/2.*timing pending/);
	const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
	const segment = worker.sent.find((event: any) => event.text.includes("New response")) as { utterance: number; segmentId: number };
	assert.ok(segment, JSON.stringify(worker.sent));
	const firstOperation = host.widgetOperations.length;
	const firstMount = mountedRows.length;
	const firstFrame = frames.length;
	for (const type of ["loading", "ready", "idle"] as const) {
		worker.emit({ type }); await settle();
		assert.match(host.widgetLines()![0]!, /Paused.*message 2\/2.*timing pending/);
	}
	await host.shortcut("f8"); await settle();
	assert.match(host.widgetLines()![0]!, /Waiting.*message 2\/2.*timing pending/);
	worker.emit({ type: "segment-audio", segmentId: segment.segmentId, utterance: segment.utterance, start: 0, duration: 4, timingQuality: "estimated" });
	worker.emit({ type: "speaking" });
	worker.emit({ type: "playback", utterance: segment.utterance, position: 1 });
	await settle();
	assert.match(host.widgetLines()![0]!, /Playing.*0:01 \/ 0:04.*message 2\/2/);
	partial.content[0].text += "Second sentence continues growing. ";
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Second sentence continues growing. " } });
	await host.emit("agent_settled", {}); await settle();
	assert.match(host.widgetLines()![0]!, /0:01 \/ 0:04.*message 2\/2/);
	await host.shortcut("f8"); await settle();
	const complete = { ...partial, stopReason: "stop" };
	host.addMessage("new", "old", complete);
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete });
	await host.emit("agent_settled", {}); await settle();
	assert.match(host.widgetLines()![0]!, /Paused.*0:01 \/ 0:0[45].*message 2\/2/);
	assert.ok(host.widgetOperations.slice(firstOperation).filter(operation => operation.name === "pi-voice-progress")
		.every(operation => operation.value?.lines?.length), "mounted UI never removes the live playback row");
	assert.ok(mountedRows.slice(firstMount).every(rows => rows.some(line => /message 2\/2/.test(line))),
		"Pi's mounted component keeps the selected live target through replacements");
	assert.ok(frames.slice(firstFrame).length > 0);
	assert.ok(frames.slice(firstFrame).every(rows => rows.some(line => /message 2\/2/.test(line))),
		"actual native screens retain the playbar, not merely the widget map");
	await host.command("stop");
	assert.doesNotMatch(host.widgetLines()![0]!, /Paused|Waiting|Playing/);
	await settle();
	// A finished source block is not completion of the still-streaming response.
	await host.emit("before_agent_start", {}); await settle();
	const streaming = assistant(""); delete streaming.stopReason;
	streaming.content = [{ type: "text", text: "" }];
	await host.emit("message_start", { message: streaming });
	const streamingFrames = frames.length;
	assert.match(host.widgetLines()![0]!, /Waiting.*timing pending/);
	for (const type of ["loading", "ready", "idle"] as const) {
		worker.emit({ type }); await settle();
		assert.match(host.widgetLines()![0]!, /Waiting.*timing pending/);
		assertFrame(`initial ${type} preparation gap`);
	}
	streaming.content[0].text = "First block sentence. ";
	await host.emit("message_update", { message: streaming, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: streaming.content[0].text } });
	await settle();
	const first = worker.sent.at(-1) as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", segmentId: first.segmentId, utterance: first.utterance, start: 0, duration: 3 });
	worker.emit({ type: "speaking" });
	worker.emit({ type: "playback", utterance: first.utterance, position: 1 });
	await settle();
	streaming.content.push({ type: "text", text: "Second block sentence. " });
	await host.emit("message_update", { message: streaming, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: streaming.content[1].text } });
	await settle();
	worker.emit({ type: "idle", utterance: first.utterance }); await settle();
	assert.match(host.widgetLines()![0]!, /Waiting.*0:03 \/ 0:03/);
	assertFrame("source-block handoff");
	const second = worker.sent.at(-1) as { utterance: number; segmentId: number };
	assert.notEqual(second.utterance, first.utterance);
	worker.emit({ type: "segment-audio", segmentId: second.segmentId, utterance: second.utterance, start: 0, duration: 2 });
	worker.emit({ type: "speaking" });
	worker.emit({ type: "playback", utterance: second.utterance, position: 1 }); await settle();
	assert.match(host.widgetLines()![0]!, /Playing.*0:01 \/ 0:02/);
	const finished = { ...streaming, stopReason: "stop" };
	host.addMessage("last", "new", finished);
	await host.emit("message_end", { message: finished });
	await host.emit("turn_end", { message: finished });
	worker.emit({ type: "idle", utterance: second.utterance }); await settle();
	assert.match(host.widgetLines()![0]!, /Idle.*0:02 \/ 0:02/);
	assertFrame("canonicalized completion");
	// A tool boundary and delayed session insertion must not unmount the row.
	const toolMessage = assistant("Before reading a file. ", "toolUse");
	toolMessage.content.push({ type: "toolCall", id: "call", name: "read", arguments: {} });
	await host.emit("message_start", { message: toolMessage });
	await host.emit("message_update", { message: toolMessage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: toolMessage.content[0].text } });
	await host.emit("message_end", { message: toolMessage });
	assertFrame("message_end before session insertion");
	host.addMessage("tool-call", "last", toolMessage);
	await host.emit("tool_execution_start", { toolCallId: "call", toolName: "read", args: {} });
	await host.emit("tool_execution_end", { toolCallId: "call", toolName: "read", result: { content: [{ type: "text", text: "file contents" }] }, isError: false });
	await host.emit("turn_end", { message: toolMessage, toolResults: [] });
	await settle();
	assertFrame("tool boundary / delayed canonicalization");
	const afterTool = assistant("After reading the file. "); delete afterTool.stopReason;
	await host.emit("message_start", { message: afterTool });
	await host.emit("message_update", { message: afterTool, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: afterTool.content[0].text } });
	await settle();
	assertFrame("next assistant after tool");
	assert.ok(frames.slice(streamingFrames).every(rows => rows.some(line => /(?:Waiting|Playing|Idle).*message /.test(line))),
		"no native frame loses the playback row across chunks, preparation gaps, completion and tools");
	for (const columns of [40, 100]) {
		terminal.columns = columns;
		tui.requestRender(true);
		assertFrame(`resized ${columns}-column dock`);
	}
	await host.shutdown();
	assert.equal(host.widgetLines(), undefined);
	assert.deepEqual(mountedRows.at(-1), []);
	assert.equal(host.modelRequests.length, 0);
});
