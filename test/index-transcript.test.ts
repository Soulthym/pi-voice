import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";
import { NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
async function setup(t: import("node:test").TestContext, mode = "all", context = "conversation") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-transcript-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const old = names.map(name => process.env[name]);
	for (const name of names) process.env[name] = path.join(root, name);
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode, input: "disabled", output: "local", audioCache: false,
		codeNarration: "summary", codeDescriptionContext: context, codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "transcript", async () => assistant("The code performs the requested operation."));
	const index = MockedVoiceWorkerClient.instances.length;
	t.after(async () => { await host.shutdown(); names.forEach((name, i) => { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; }); await fs.rm(root, { recursive: true, force: true }); });
	await host.start();
	const worker = MockedVoiceWorkerClient.instances[index]!;
	const spoken = () => (worker.sent as Array<{ text: string }>).map(item => item.text).filter(text => !text.startsWith("Project "));
	return { host, worker, spoken };
}

for (const mode of ["all", "assistant", "yield"]) test(`${mode}: live, replay and both navigation controls follow actual content order`, async t => {
	const { host, worker, spoken } = await setup(t, mode, "block-only");
	let history: PlaybackHistory | undefined;
	const begin = PlaybackHistory.prototype.beginCapture;
	t.mock.method(PlaybackHistory.prototype, "beginCapture", function (this: PlaybackHistory, ...args: Parameters<typeof begin>) { history = this; return begin.apply(this, args); });
	const blocks = [
		{ type: "text", text: "Answer first.\n" },
		{ type: "thinking", thinking: "Reason later.\nSecond thought.\n" },
		{ type: "text", text: "Answer again.\n" },
		{ type: "toolCall", id: "call", name: "read", arguments: {} },
		{ type: "text", text: "After tool.\n" },
	];
	const partial = { ...assistant("", "pending"), content: [] as any[] };
	await host.emit("message_start", { message: partial });
	for (const [contentIndex, block] of blocks.entries()) {
		partial.content.push(block);
		await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: {
			type: block.type === "thinking" ? "thinking_delta" : block.type === "text" ? "text_delta" : "toolcall_delta",
			contentIndex, delta: block.text ?? block.thinking ?? "",
		} });
	}
	const complete = { ...partial, stopReason: "stop" };
	host.addMessage("answer", null, complete);
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete }); await settle();
	assert.deepEqual(spoken(), mode === "all" ? ["Answer first.", "Reason later.", "Second thought.", "Answer again.", "After tool."] : ["Answer first.", "Answer again.", "After tool."]);
	const segments = worker.sent as Array<{ utterance: number; segmentId: number; text: string }>;
	for (const segment of segments) history!.setSegmentAudio(segment.segmentId, segment.text === "Second thought." ? 1 : 0, 1);
	const checked = new Set<number>();
	for (const segment of segments.filter(segment => !segment.text.startsWith("Project "))) {
		if (checked.has(segment.utterance)) continue;
		checked.add(segment.utterance);
		const snapshot = history!.snapshotForUtterance(segment.utterance);
		assert.ok(snapshot, `timing capture for ${segment.text}`);
		const block = blocks[Number(snapshot.messageId.split(":")[1] ?? 0)];
		assert.ok(snapshot.checkpoints.every(point => point.sourceOffset < (block.text ?? block.thinking!).length));
		if (segment.text === "Reason later." || segment.text === "Second thought.") assert.equal(snapshot.messageId, "answer:1");
		if (segment.text === "After tool.") assert.equal(snapshot.messageId, "answer:4");
	}
	worker.emit({ type: "playback", utterance: segments.at(-1)!.utterance, position: 0.5 });
	worker.sent.length = 0;
	await host.shortcut("f11"); await settle();
	assert.deepEqual(spoken(), ["After tool."]);
	await host.shortcut("f8");
	worker.sent.length = 0;
	await host.shortcut("f6"); await settle();
	assert.deepEqual(spoken(), ["Answer again."]);
	worker.sent.length = 0;
	await host.shortcut("f7"); await settle();
	assert.deepEqual(spoken(), mode === "all" ? ["Second thought."] : ["Answer first."]);
	assert.equal(worker.pauses.at(-1), true);
	if (mode === "all") {
		assert.ok(host.render(blocks[1].thinking!.trim(), "assistant-thinking").includes(NARRATION_ACTIVE_MARKER));
		worker.sent.length = 0;
		await host.shortcut("f7"); await settle();
		assert.deepEqual(spoken(), ["Reason later.", "Second thought."]);
		await host.shortcut("f9"); await settle();
	}
	worker.sent.length = 0;
	await host.shortcut("f9"); await settle();
	assert.deepEqual(spoken(), ["Answer again."]);
	worker.sent.length = 0;
	await host.shortcut("f10"); await settle();
	assert.deepEqual(spoken(), ["After tool."]);
});

for (const mode of ["all", "yield"]) for (const action of ["navigation", "dirty resume"]) test(`${mode}: ${action} uses the audible earlier block despite capture-ahead`, async t => {
	const { host, worker, spoken } = await setup(t, mode);
	const blocks = ["First answer.\n", "Middle answer.\n", "Latest answer.\n"].map(text => ({ type: "text", text }));
	const partial = { ...assistant("", "pending"), content: [] as typeof blocks };
	await host.emit("message_start", { message: partial });
	for (const [contentIndex, block] of blocks.entries()) {
		partial.content.push(block);
		await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex, delta: block.text } });
	}
	const complete = { ...partial, stopReason: "stop" };
	host.addMessage("answer", null, complete);
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete }); await settle();
	assert.deepEqual(spoken(), blocks.map(block => block.text.trim()));
	const first = (worker.sent as Array<{ utterance: number; segmentId: number; text: string }>).find(segment => segment.text === "First answer.")!;
	worker.emit({ type: "segment-audio", utterance: first.utterance, segmentId: first.segmentId, start: 0, duration: 1 });
	worker.emit({ type: "playback", utterance: first.utterance, position: 0.5 });
	if (action === "dirty resume") await host.command("speed 1.2");
	worker.sent.length = 0;
	await host.shortcut(action === "navigation" ? "f10" : "f8"); await settle();
	assert.deepEqual(spoken(), [action === "navigation" ? "Middle answer." : "First answer."]);
});

test("streaming waits through following prose and tool-separated blocks; replay/backfill use identical context keys", async t => {
	const { host, worker, spoken } = await setup(t);
	let history: PlaybackHistory | undefined;
	const begin = PlaybackHistory.prototype.beginCapture;
	t.mock.method(PlaybackHistory.prototype, "beginCapture", function (this: PlaybackHistory, ...args: Parameters<typeof begin>) { history = this; return begin.apply(this, args); });
	host.addMessage("user", null, { role: "user", content: "Original request", timestamp: 1 });
	const partial = { ...assistant("", "pending"), content: [{ type: "text", text: "" }] as any[] };
	await host.emit("message_start", { message: partial });
	const delta = async (index: number, text: string) => {
		partial.content[index].text += text;
		await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: text } }); await settle();
	};
	await delta(0, "Preceding prose.\n```ts\nfirst();\n```\n");
	assert.deepEqual(spoken(), ["Preceding prose."]);
	assert.equal(host.modelRequests.length, 0);
	await delta(0, "Following explanation.\n");
	assert.equal(host.modelRequests.length, 0);
	partial.content.push({ type: "toolCall", id: "call", name: "read", arguments: { path: "source.ts" } }, { type: "text", text: "" });
	await delta(2, "More relevant prose.\n``");
	assert.equal(host.modelRequests.length, 0);
	await delta(2, "`ts\nsecond();\n```\nLast explanation.");
	assert.equal(host.modelRequests.length, 1);
	const first = host.modelRequests[0].context;
	assert.match(JSON.stringify(first), /Following explanation/);
	assert.match(JSON.stringify(first), /More relevant prose/);
	assert.match(JSON.stringify(first), /source.ts/);
	assert.doesNotMatch(JSON.stringify(first.messages.slice(0, -1)), /second\(\)|Last explanation/);
	assert.match(JSON.stringify(first.messages.at(-1)), /Complement rather than repeat/);
	const complete = { ...partial, stopReason: "stop" };
	host.addMessage("answer", "user", complete);
	await host.emit("message_end", { message: complete }); await settle();
	assert.equal(host.modelRequests.length, 2);
	assert.match(JSON.stringify(host.modelRequests[1].context), /Last explanation/);
	assert.deepEqual(spoken(), ["Preceding prose.", "The code performs the requested operation.", "Following explanation.", "More relevant prose.", "The code performs the requested operation.", "Last explanation."]);
	const sent = worker.sent as Array<{ utterance: number; segmentId: number; text: string }>;
	const times = new Map<number, number>();
	for (const segment of sent) {
		const time = times.get(segment.utterance) ?? 0;
		history!.setSegmentAudio(segment.segmentId, time, 1);
		times.set(segment.utterance, time + 1);
	}
	const descriptions = sent.filter(segment => segment.text === "The code performs the requested operation.");
	assert.equal(history!.snapshotForUtterance(descriptions[0].utterance)?.messageId, "answer");
	assert.equal(history!.snapshotForUtterance(descriptions[1].utterance)?.messageId, "answer:2");
	await host.emit("turn_end", { message: complete });
	await host.emit("agent_settled", {}); await settle();
	worker.sent.length = 0;
	await host.shortcut("f11"); await settle();
	await host.shortcut("f6"); await settle();
	host.model.id = "another-model";
	await host.command("edit-model test/another-model");
	await host.command("code-preprocess 1");
	await host.emit("agent_settled", {}); await settle();
	assert.equal(host.modelRequests.length, 2, "replay and historical work must reuse both boundary identities");
	assert.match(host.render(partial.content[0].text.trim()), /The code performs/);
});

test("consecutive thinking blocks retain distinct targets inside Pi's joined Markdown", async t => {
	const { host, worker, spoken } = await setup(t);
	const text = "Same thought.\n```ts\nrun();\n```\nFollowing reason.";
	const complete = { ...assistant(""), content: [{ type: "thinking", thinking: text }, { type: "thinking", thinking: text }] };
	host.addMessage("answer", null, complete);
	await host.shortcut("f11"); await settle();
	assert.deepEqual(spoken(), ["Same thought.", "The code performs the requested operation.", "Following reason."]);
	const joined = `${text}\n\n${text}`;
	let rendered = host.render(joined, "assistant-thinking");
	assert.ok(rendered.indexOf(NARRATION_ACTIVE_MARKER) > rendered.indexOf("Following reason."), "second identical thinking block is the selected source");
	await host.shortcut("f8");
	worker.sent.length = 0;
	await host.shortcut("f6"); await settle();
	assert.equal(host.modelRequests.length, 2);
	rendered = host.render(joined, "assistant-thinking");
	assert.equal(rendered.split("The code performs the requested operation.").length - 1, 2);
	assert.ok(rendered.indexOf(NARRATION_ACTIVE_MARKER) < rendered.indexOf("Following reason."));
	assert.equal(worker.pauses.at(-1), true);
});

test("dirty thinking-block resume retains its ordinal and block-local contextual boundary", async t => {
	const { host, worker, spoken } = await setup(t);
	t.mock.method(host, "completeModel", async () => assistant("First description sentence. Second description sentence."));
	const prefix = "Thinking aloud.\n";
	const code = `${prefix}\`\`\`ts\nreason();\n\`\`\`\n`;
	const partial = { ...assistant("", "pending"), content: [{ type: "text", text: "Earlier answer.\n" }, { type: "thinking", thinking: code }] };
	await host.emit("message_start", { message: assistant("", "pending") });
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: partial.content[0].text } });
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: code } });
	await settle();
	assert.equal(host.modelRequests.length, 0);
	const thinking = (worker.sent as Array<{ utterance: number; segmentId: number; text: string }>).find(segment => segment.text === "Thinking aloud.")!;
	assert.ok(thinking);
	worker.emit({ type: "segment-audio", utterance: thinking.utterance, segmentId: thinking.segmentId, start: 0, duration: 1 });
	worker.emit({ type: "playback", utterance: thinking.utterance, position: 0.5 });
	await host.command("speed 1.2");
	const resume = PlaybackHistory.prototype.resumeTarget;
	t.mock.method(PlaybackHistory.prototype, "resumeTarget", function (this: PlaybackHistory) {
		const target = resume.call(this);
		return target && { ...target, sourceOffset: prefix.length, skipUnits: 1 };
	});
	worker.sent.length = 0;
	await host.shortcut("f8"); await settle();
	assert.equal(host.modelRequests.length, 0);
	partial.content[1].thinking += "Reason following the code.";
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Reason following the code." } });
	const complete = { ...partial, stopReason: "stop" };
	host.addMessage("answer", null, complete);
	await host.emit("message_end", { message: complete }); await settle();
	assert.equal(host.modelRequests.length, 1);
	assert.match(JSON.stringify(host.modelRequests[0].context), /Earlier answer/);
	assert.match(JSON.stringify(host.modelRequests[0].context), /Reason following the code/);
	assert.deepEqual(spoken(), ["Second description sentence.", "Reason following the code."]);
});

for (const pauseBeforeCapture of [true, false]) test(`live dirty resume retains later thinking prefixes (pause before capture: ${pauseBeforeCapture})`, async t => {
	const { host, worker, spoken } = await setup(t);
	const partial = { ...assistant("", "pending"), content: [{ type: "text", text: "First answer.\n" }] as any[] };
	await host.emit("message_start", { message: assistant("", "pending") });
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: partial.content[0].text } });
	await settle();
	const first = (worker.sent as Array<{ utterance: number; segmentId: number; text: string }>).find(segment => segment.text === "First answer.")!;
	assert.ok(first);
	worker.emit({ type: "segment-audio", utterance: first.utterance, segmentId: first.segmentId, start: 0, duration: 1 });
	worker.emit({ type: "playback", utterance: first.utterance, position: 0.5 });
	if (pauseBeforeCapture) await host.command("speed 1.2");
	partial.content.push({ type: "thinking", thinking: "Queued thought.\n" });
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: partial.content[1].thinking } });
	await settle();
	if (!pauseBeforeCapture) await host.command("speed 1.2");
	worker.sent.length = 0;
	await host.shortcut("f8"); await settle();
	partial.content[1].thinking += "Future thought.";
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Future thought." } });
	const complete = { ...partial, stopReason: "stop" };
	host.addMessage("answer", null, complete);
	await host.emit("message_end", { message: complete }); await settle();
	assert.deepEqual(spoken(), ["First answer.", "Queued thought.", "Future thought."]);
});

for (const persistedBeforeEnd of [true, false]) test(`canonical batch preserves paused middle target; persisted before end=${persistedBeforeEnd}`, async t => {
	const { host, worker } = await setup(t);
	let history: PlaybackHistory | undefined;
	const begin = PlaybackHistory.prototype.beginCapture;
	t.mock.method(PlaybackHistory.prototype, "beginCapture", function(this: PlaybackHistory, ...args: Parameters<typeof begin>) { history = this; return begin.apply(this, args); });
	const content = [
		{ type: "text", text: "Identical first.\n" },
		{ type: "thinking", thinking: "Identical middle.\n" },
		{ type: "text", text: "Identical last.\n" },
	];
	const complete = { ...assistant(""), content };
	host.addMessage("earlier", null, structuredClone(complete));
	const partial = { ...complete, stopReason: "pending", content: [] as any[] };
	await host.emit("message_start", { message: partial });
	for (const [contentIndex, block] of content.entries()) {
		partial.content.push(block);
		await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: {
			type: block.type === "thinking" ? "thinking_delta" : "text_delta", contentIndex, delta: block.text ?? block.thinking,
		} });
	}
	const middle = (worker.sent as Array<{ text: string; utterance: number }>).find(segment => segment.text === "Identical middle.")!;
	worker.emit({ type: "playback", utterance: middle.utterance, position: 0 });
	await host.shortcut("f8");
	const selected = history!.selected()!.id;
	assert.match(selected, /^live:/);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	if (persistedBeforeEnd) host.addMessage("current", "earlier", structuredClone(complete));
	await host.emit("message_end", { message: complete });
	if (!persistedBeforeEnd) {
		await host.emit("agent_settled", {});
		await settle();
		assert.equal(history!.selected()!.id, selected, "history sync must wait rather than select earlier identical text/index");
		host.addMessage("current", "earlier", structuredClone(complete));
	}
	await host.emit("turn_end", { message: complete });
	await host.emit("agent_settled", {});
	await settle();
	assert.equal(history!.selected()!.id, "current:1", "settled history sync must canonicalize before the retry timer");
	t.mock.timers.tick(0);
	await settle();
	assert.equal(history!.selected()!.id, "current:1", "late retry must preserve the canonical middle target");
	assert.equal(worker.pauses.at(-1), true);
	t.mock.timers.reset();
});

test("a message with no live targets cannot block later history sync", async t => {
	const { host } = await setup(t, "yield", "block-only");
	await host.emit("message_end", { message: assistant("Uncaptured tool response.", "toolUse") });
	const sync = t.mock.method(PlaybackHistory.prototype, "sync");
	host.addMessage("later", null, assistant("Later response."));
	await host.emit("agent_settled", {}); await settle();
	assert.ok(sync.mock.callCount() > 0);
	assert.ok(sync.mock.calls.at(-1)!.arguments[0].some(message => message.id === "later"));
});

test("Stop cancels boundary waits without starting a late narrator request", async t => {
	const { host, spoken } = await setup(t);
	const text = "Earlier prose.\n```ts\nrun();\n```\n";
	await host.emit("message_start", { message: assistant("", "pending") });
	await host.emit("message_update", { message: assistant(text, "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
	await settle();
	assert.deepEqual(spoken(), ["Earlier prose."]);
	assert.equal(host.modelRequests.length, 0);
	await host.command("stop");
	const complete = assistant(text + "Final prose.");
	await host.emit("message_end", { message: complete }); await settle();
	assert.equal(host.modelRequests.length, 0);
});
