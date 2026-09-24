import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { PlaybackHistory } from "../src/playback-history.js";
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
	const observer = new SessionCoordinator(path.join(root, "observer"), "observer");
	observer.start();
	// Actual Pi replacement + container + fullscreen layout, on an inert terminal.
	const { InteractiveMode, FooterComponent, initTheme } = await import(process.env.PI_VOICE_TEST_AGENT_MODULE ?? "@earendil-works/pi-coding-agent");
	initTheme("dark");
	const terminal = { columns: 160, rows: 24, write() {}, hideCursor() {} };
	const tui: any = new native.TuiAltScreen(terminal, false);
	tui.altScreenActive = true; // Never start a terminal or live session.
	const mountedRows: string[][] = [];
	const frames: string[][] = [];
	const nativeUI = Object.assign(Object.create(InteractiveMode.prototype), {
		extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
		widgetContainerAbove: new native.Container(), widgetContainerBelow: new native.Container(), ui: tui,
	});
	const statuses = new Map([["other", "Other extension status"]]);
	host.ctx.ui.setStatus = (key: string, value?: string) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); };
	const footer = new FooterComponent({ state: {}, sessionManager: { getEntries: () => [], getCwd: () => root, getSessionName: () => undefined }, getContextUsage: () => undefined } as any,
		{ getGitBranch: () => undefined, getExtensionStatuses: () => statuses, getAvailableProviderCount: () => 0 } as any);
	const originalFooterRender = footer.render;
	const transcript = new native.ScrollView(new native.Text("history\n".repeat(100), 0, 0), { primary: true, follow: "end" });
	// Match InteractiveMode's dock ordering and shrink/minSize policy.
	const dock = new native.VStack([
		{ component: new native.Container(), shrink: 1, minSize: 0 }, // pending messages
		{ component: new native.Container(), shrink: 1, minSize: 0 }, // working status
		{ component: nativeUI.widgetContainerAbove, shrink: 1, minSize: 0 },
		{ component: new native.Text("editor\n\n", 0, 0), shrink: 1, minSize: 3 },
		{ component: nativeUI.widgetContainerBelow, shrink: 1, minSize: 0 },
		{ component: footer, shrink: 1, minSize: 1 },
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
		assert.match(frames.at(-1)!.join("\n"), /(?:Paused|Queued|Synthesizing|Loading|Connecting|Playing|Idle).*\[[●━]/, label);
		assert.doesNotMatch(frames.at(-1)!.join("\n"), /Waiting|livewaiting/i);
	};
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	t.after(async () => {
		await host.shutdown();
		observer.shutdown();
		for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("old", null, assistant("Historical response."));
	await host.start();
	assert.equal(footer.render, originalFooterRender, "extension never patches native footer rendering or hitboxes");
	tui.requestRender();
	assert.match(frames.at(-1)!.join("\n"), /Other extension status/);
	const retired: any = nativeUI.extensionWidgetsBelow.get("pi-voice-progress");
	retired.render(100);
	await host.shortcut("f5"); await settle();
	await host.shortcut("f8"); await settle();
	assert.match(host.widgetLines()![0]!, /Paused/);
	assert.equal(nativeUI.extensionWidgetsBelow.get("pi-voice-progress"), retired, "progress refresh retains native mouse identity");
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
	const pausedMissing = t.mock.method(PlaybackHistory.prototype, "status", () => undefined);
	for (const phase of ["loading", "synthesizing", "connecting", "queued"] as const) {
		worker.emit({ type: "playback-phase", utterance: segment.utterance, segmentId: segment.segmentId, phase });
		await settle();
		assert.match(host.widgetLines()![0]!, /Paused.*\[[●━]/, "paused intent wins even without a history status");
		assert.doesNotMatch(host.widgetLines()![0]!, /● live/);
		assertFrame(`paused ${phase} without history`);
	}
	pausedMissing.mock.restore();
	worker.emit({ type: "ready" }); await settle();
	const firstOperation = host.widgetOperations.length;
	const firstMount = mountedRows.length;
	const firstFrame = frames.length;
	for (const type of ["loading", "ready", "idle"] as const) {
		worker.emit({ type }); await settle();
		assert.match(host.widgetLines()![0]!, /Paused.*message 2\/2.*timing pending/);
	}
	await host.shortcut("f8"); await settle();
	assert.match(host.widgetLines()![0]!, /Queued.*message 2\/2.*timing pending/);
	for (const phase of ["loading", "synthesizing", "connecting", "queued"] as const) {
		worker.emit({ type: "playback-phase", utterance: segment.utterance, segmentId: segment.segmentId, phase });
		await settle();
		assert.match(host.widgetLines()![0]!, new RegExp(phase, "i"));
		worker.emit({ type: "playback-phase", utterance: segment.utterance + 999, segmentId: 999, phase: "playing" });
		worker.emit({ type: "ready" }); await settle();
		assert.match(host.widgetLines()![0]!, new RegExp(phase, "i"), "unowned/background events cannot claim foreground playback");
		assertFrame(`foreground ${phase}`);
	}
	worker.emit({ type: "segment-audio", segmentId: segment.segmentId, utterance: segment.utterance, start: 0, duration: 4, timingQuality: "estimated" });
	worker.emit({ type: "speaking" });
	worker.emit({ type: "playback", utterance: segment.utterance, position: 1 });
	await settle();
	assert.match(host.widgetLines()![0]!, /Playing.*0:01 \/ 0:04.*message 2\/2/);
	assert.doesNotMatch(host.widgetLines()![0]!, /● live/);
	await host.shortcut("alt+t"); await settle();
	assert.doesNotMatch(host.widgetLines()![0]!, /● live/, "following the viewport is not chronological live playback");
	partial.content[0].text += "Second sentence continues growing. ";
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Second sentence continues growing. " } });
	await host.emit("agent_settled", {}); await settle();
	assert.match(host.widgetLines()![0]!, /0:01 \/ 0:04.*message 2\/2/);
	worker.emit({ type: "playback", utterance: segment.utterance, position: 4 }); await settle();
	assert.doesNotMatch(host.widgetLines()![0]!, /● live/, "exhausted first clip is not live while second prose awaits audio");
	assert.doesNotMatch(frames.at(-1)!.join("\n"), /● live/);
	const pendingProse = worker.sent.at(-1) as { utterance: number; segmentId: number };
	assert.notEqual(pendingProse.segmentId, segment.segmentId);
	worker.emit({ type: "segment-audio", segmentId: pendingProse.segmentId, utterance: pendingProse.utterance, start: 4, duration: 6 }); await settle();
	await host.shortcut("f8"); await settle();
	const complete = { ...partial, stopReason: "stop" };
	host.addMessage("new", "old", complete);
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete });
	await host.emit("agent_settled", {}); await settle();
	assert.match(host.widgetLines()![0]!, /Paused.*0:04 \/ 0:10.*message 2\/2/);
	assert.ok(host.widgetOperations.slice(firstOperation).filter(operation => operation.name === "pi-voice-progress")
		.every(operation => operation.value?.lines?.length), "mounted UI never removes the live playback row");
	assert.ok(mountedRows.slice(firstMount).every(rows => rows.some(line => /message 2\/2/.test(line))),
		"Pi's mounted component keeps the selected live target through replacements");
	assert.ok(frames.slice(firstFrame).length > 0);
	assert.ok(frames.slice(firstFrame).every(rows => !/Waiting|livewaiting/i.test(rows.join("\n"))), "no obsolete playback state in native frames");
	assert.ok(frames.slice(firstFrame).every(rows => rows.some(line => /message 2\/2/.test(line))),
		"actual native screens retain the playbar, not merely the widget map");
	assert.match(host.widgetLines()![0]!, /0:04 \/ 0:10/, "real retained history exists before Tail");
	await host.shortcut("f10"); await settle();
	assert.match(host.widgetLines()![0]!, /Paused.*--:-- \/ --:--/, "paused Tail discards abandoned history time");
	await host.shortcut("f8"); await settle();
	await host.shortcut("f10"); await settle();
	assert.match(host.widgetLines()![0]!, /● live/);
	assert.doesNotMatch(host.widgetLines()![0]!, /0:04 \/ 0:10/, "Tail abandons the retained history timestamp");
	assert.match(frames.at(-1)!.join("\n"), /● live/);
	await host.command("stop");
	assert.doesNotMatch(host.widgetLines()![0]!, /Paused|Queued|Playing|● live/);
	await settle();
	// A finished source block is not completion of the still-streaming response.
	await host.emit("before_agent_start", {}); await settle();
	const streaming = assistant(""); delete streaming.stopReason;
	streaming.content = [{ type: "text", text: "" }];
	await host.emit("message_start", { message: streaming });
	const streamingFrames = frames.length;
	assert.match(host.widgetLines()![0]!, /Playing.*\] ● live ·/);
	assert.ok(host.styleCalls.some(call => call.style === "error" && call.text === "● live"));
	const missing = t.mock.method(PlaybackHistory.prototype, "status", () => undefined);
	worker.emit({ type: "ready" }); await settle();
	assert.match(host.widgetLines()![0]!, /\[[●━].*● live/, "streaming intent keeps a real bar without a history record");
	assertFrame("history record temporarily unavailable");
	missing.mock.restore();
	for (const type of ["loading", "ready", "idle"] as const) {
		worker.emit({ type }); await settle();
		assert.match(host.widgetLines()![0]!, /Playing.*\] ● live ·/);
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
	assert.match(host.widgetLines()![0]!, /Queued.*0:03 \/ 0:03/);
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
	assert.match(host.widgetLines()![0]!, /Playing.*● live/);
	assertFrame("canonicalized completion");
	assert.equal(observer.speechOwner(), undefined, "completed live follow releases the audio lease");
	const finishedGapStart = frames.length;
	const finishedMissing = t.mock.method(PlaybackHistory.prototype, "status", () => undefined);
	worker.emit({ type: "ready" }); await settle();
	assert.match(host.widgetLines()?.join("\n") ?? "", /Playing.*● live/, "completed live intent survives release and missing history status");
	finishedMissing.mock.restore();
	worker.emit({ type: "ready" }); await settle();
	const finishedGapEnd = frames.length;
	await host.shortcut("f8"); await settle();
	assert.match(host.widgetLines()![0]!, /Paused.*0:02 \/ 0:02/);
	assert.equal(observer.speechOwner(), undefined, "pausing live intent needs no transport");
	const sentBeforePause = worker.sent.length;
	const queuedResponse = assistant("Queued while caught-up playback is paused. ");
	await host.emit("before_agent_start", {});
	await host.emit("message_start", { message: queuedResponse });
	await host.emit("message_update", { message: queuedResponse, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: queuedResponse.content[0].text } });
	await host.emit("message_end", { message: queuedResponse });
	host.addMessage("queued-response", "last", queuedResponse);
	await host.emit("turn_end", { message: queuedResponse }); await settle();
	assert.equal(worker.sent.length, sentBeforePause, "paused live edge queues the next complete response");
	await host.shortcut("f8"); await settle();
	assert.ok(worker.sent.length > sentBeforePause, "one F8 resumes the queued response");
	const resumed = worker.sent.at(-1) as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", utterance: resumed.utterance, segmentId: resumed.segmentId, start: 0, duration: 1 });
	worker.emit({ type: "idle", utterance: resumed.utterance }); await settle();
	assert.match(host.widgetLines()![0]!, /Playing.*● live/);
	assert.equal(observer.speechOwner(), undefined);
	await host.shortcut("f6"); await settle();
	assert.equal((worker.sent.at(-1) as { text: string }).text, queuedResponse.content[0].text.trim(), "F6 from completed live selects the last message, not the penultimate");
	await host.shortcut("f6"); await settle();
	const historical = worker.sent.at(-1) as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", utterance: historical.utterance, segmentId: historical.segmentId, start: 0, duration: 2 });
	worker.emit({ type: "idle", utterance: historical.utterance }); await settle();
	assert.match(host.widgetLines()![0]!, /Idle.*0:02 \/ 0:02/);
	assert.doesNotMatch(host.widgetLines()![0]!, /● live/, "completed history behind latest does not establish live intent");
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
	assert.ok(frames.filter((_rows, index) => index >= streamingFrames && (index < finishedGapStart || index >= finishedGapEnd))
		.every(rows => rows.some(line => /(?:Queued|Playing|Idle|Paused|Loading|Synthesizing|Connecting).*\[[●━]/.test(line))),
		"native frames keep the bar across chunks, preparation gaps and tools; only finished idle can retire it");
	for (const columns of [40, 100]) {
		terminal.columns = columns;
		tui.requestRender(true);
		if (columns === 40) assert.match(frames.at(-1)!.join("\n"), /🎧/, "narrow dock retains device identity even with a long hostname");
		else assertFrame(`resized ${columns}-column dock`);
	}
	await host.shortcut("f10"); await settle();
	await host.shortcut("f10"); await settle();
	const tailMissing = t.mock.method(PlaybackHistory.prototype, "status", () => undefined);
	worker.emit({ type: "ready" }); await settle();
	assert.match(host.widgetLines()![0]!, /Playing.*\[[●━].*● live/, "Tail keeps playing intent while awaiting future output without a history status");
	assertFrame("chronological Tail without history");
	tailMissing.mock.restore();
	await host.shortcut("f7"); await settle();
	assert.doesNotMatch(host.widgetLines()![0]!, /● live/, "previous sentence leaves the chronological live edge");
	terminal.columns = 160;
	for (const suffix of ["Unfinished prose", "```ts\nconst pending ="]) {
		await host.command("stop"); await settle();
		await host.emit("before_agent_start", {}); await settle();
		const message = assistant("Plain prose.\n---\n"); delete message.stopReason;
		await host.emit("message_start", { message });
		await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
		await settle();
		const clip = worker.sent.at(-1) as { utterance: number; segmentId: number };
		worker.emit({ type: "segment-audio", utterance: clip.utterance, segmentId: clip.segmentId, start: 0, duration: 1 });
		worker.emit({ type: "playback", utterance: clip.utterance, position: 1 });
		worker.emit({ type: "idle", utterance: clip.utterance });
		await settle();
		assert.match(frames.at(-1)!.join("\n"), /Playing.*● live/, "silent markdown tail is consumed with its prose");
		const sent = worker.sent.length;
		message.content[0].text += suffix;
		await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: suffix } });
		await settle(); // No worker event (or idle flush) can refresh this buffered delta.
		assert.equal(worker.sent.length, sent);
		assert.doesNotMatch(frames.at(-1)!.join("\n"), /● live/, "buffered source immediately retires the mounted live badge");
		assertFrame("buffered source retains the mounted playbar");
	}
	await host.command("stop"); await settle();
	await host.emit("before_agent_start", {}); await settle();
	const silentTail = assistant("Plain prose.\n---\n", "toolUse");
	await host.emit("message_start", { message: silentTail });
	await host.emit("message_update", { message: silentTail, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: silentTail.content[0].text } });
	host.addMessage("silent-tail", "last", silentTail);
	await host.emit("message_end", { message: silentTail });
	await settle();
	const tailClip = worker.sent.at(-1) as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", utterance: tailClip.utterance, segmentId: tailClip.segmentId, start: 0, duration: 1 });
	worker.emit({ type: "playback", utterance: tailClip.utterance, position: 1 });
	worker.emit({ type: "idle", utterance: tailClip.utterance });
	await settle();
	assert.match(frames.at(-1)!.join("\n"), /Playing.*● live/, "tool wait remains live after consumed prose plus silent markdown");
	const cancel = t.mock.method(worker, "cancel", () => 901);
	const terminate = t.mock.method(worker, "terminate", async () => { throw new Error("stop unconfirmed"); });
	await host.command("stop"); await settle();
	assert.match(host.widgetLines()!.join("\n"), /Idle.*\[[●━]/, "history remains visible during stop");
	assert.match(frames.at(-1)!.join("\n"), /stopping.*waiting for device confirmation/, "mounted status retains delayed-stop warning beside history");
	await new Promise(resolve => setTimeout(resolve, 1100)); await settle();
	assert.match(frames.at(-1)!.join("\n"), /stopping|blocked|error/, "failed stop remains visible beside retained progress");
	assert.ok(host.notices.some(notice => /stop unconfirmed/.test(notice.message)));
	cancel.mock.restore(); terminate.mock.restore();
	worker.emit({ type: "idle", cancelId: 901 });
	const stoppedMissing = t.mock.method(PlaybackHistory.prototype, "status", () => undefined);
	worker.emit({ type: "ready" }); await settle();
	assert.doesNotMatch(host.widgetLines()?.join("\n") ?? "", /\[[●━]|● live/, "stop has no phantom transport without history");
	await host.command("off");
	for (let i = 0; i < 30 && host.widgetLines(); i++) await settle();
	assert.equal(host.widgetLines(), undefined);
	stoppedMissing.mock.restore();
	await host.shutdown();
	assert.equal(host.widgetLines(), undefined);
	assert.deepEqual(mountedRows.at(-1), []);
	assert.equal(footer.render, originalFooterRender);
	assert.equal(statuses.get("other"), "Other extension status");
	assert.equal(host.modelRequests.length, 0);
});
