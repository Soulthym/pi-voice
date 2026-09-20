import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";
import { DeviceRouter, type ConnectionDevice } from "../src/device-router.js";
import { PhoneInputClient, type PhoneCapture } from "../src/phone-input.js";
import { CodeDescriptionCache } from "../src/code-description-cache.js";
import * as describer from "../src/code-describer.js";

let keys = 0;
mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
mock.module("../src/code-describer.js", { namedExports: { ...describer,
	codeDescriptionCacheKey: (...args: Parameters<typeof describer.codeDescriptionCacheKey>) => {
		keys++; return describer.codeDescriptionCacheKey(...args);
	},
} });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
async function setup(t: TestContext, output = "local") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-preview-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = names.map(name => process.env[name]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output,
		codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "preview");
	t.after(async () => {
		await host.shutdown();
		names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	return host;
}

test("failed previous-message acquisition keeps subsequent preview and audio on the same selected target", async t => {
	const host = await setup(t);
	for (const id of ["A", "B", "C"]) host.addMessage(id, null, assistant(`${id} sentence.`));
	await host.start();
	const acquire = mock.method(SessionCoordinator.prototype, "tryAcquireSpeech", () => false);
	const force = mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", async () => false);
	t.after(() => { acquire.mock.restore(); force.mock.restore(); });
	await host.shortcut("f6"); await settle();
	assert.ok(host.render("B sentence.").includes(NARRATION_ACTIVE_MARKER));
	assert.match(host.widgetLines()?.join(" ") ?? "", /message 2\/3/);
	acquire.mock.restore(); force.mock.restore();
	await host.shortcut("f6"); await settle();
	assert.ok(host.render("A sentence.").includes(NARRATION_ACTIVE_MARKER));
	assert.equal(host.render("B sentence.").includes(NARRATION_ACTIVE_MARKER), false);
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	assert.equal((worker.sent.at(-1) as { text: string }).text, "A sentence.");
});

test("rapid F6 presses select two previous messages before preparation yields", async t => {
	const host = await setup(t);
	for (const id of ["A", "B", "C"]) host.addMessage(id, null, assistant(`${id} sentence.`));
	await host.start();
	const first = host.shortcut("f6");
	assert.ok(host.render("B sentence.").includes(NARRATION_ACTIVE_MARKER));
	const second = host.shortcut("f6");
	assert.ok(host.render("A sentence.").includes(NARRATION_ACTIVE_MARKER));
	await Promise.all([first, second]); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	assert.equal((worker.sent.at(-1) as { text: string }).text, "A sentence.");
	assert.match(host.widgetLines()?.join(" ") ?? "", /message 1\/3/);
});

for (const manual of [false, true]) test(`initial marker retry respects manual scrolling (${manual})`, async t => {
	const host = await setup(t);
	host.addMessage("answer", null, assistant("First sentence. Second sentence."));
	await host.start();
	const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
	host.scrollView.setDocument(lines, 40);
	await host.command("bottom");
	await host.shortcut("f11"); await settle();
	assert.equal(host.scrollView.scrollTop, 260, "no marker has been rendered yet");
	if (manual) host.scrollView.manualScrollTo(50);
	lines[100] = `${NARRATION_ACTIVE_MARKER}First`;
	host.scrollView.setDocument(lines, 40);
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const segment = worker.sent.at(-1) as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", ...segment, start: 0, duration: 2 });
	worker.emit({ type: "playback", utterance: segment.utterance, position: 0.5 });
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(host.scrollView.scrollTop, manual ? 50 : 92);
	worker.emit({ type: "idle", utterance: segment.utterance }); await settle();
	assert.equal(host.scrollView.scrollTop, manual ? 50 : 260);
	assert.equal(host.scrollView.isFollowingEnd, !manual);
});

test("sentence preview precedes whole-history identity preparation", async t => {
	const host = await setup(t);
	for (let i = 0; i < 40; i++) host.addMessage(`answer-${i}`, null,
		assistant(`First sentence ${i}. Second sentence ${i}.\n\`\`\`js\nconst x = ${i};\n\`\`\``));
	await host.start(); await settle();
	keys = 0;
	const pending = host.shortcut("f9");
	assert.ok(host.render("First sentence 39. Second sentence 39.\n```js\nconst x = 39;\n```").includes(NARRATION_ACTIVE_MARKER));
	assert.ok(keys < 5, `preview must not prepare all 40 identities (got ${keys})`);
	await pending; await settle();
});

for (const key of ["f7", "f9"]) for (const changedCount of [false, true]) {
	test(`${key} ignores discarded branch cursors with ${changedCount ? "different" : "equal"} message counts`, async t => {
		const host = await setup(t);
		host.addMessage("discarded", null, assistant("Discarded first. Discarded second."));
		await host.start(); await host.shortcut("f11"); await settle();
		const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
		const before = worker.sent.length;
		host.entries.splice(host.entries.findIndex(entry => entry.id === "discarded"), 1);
		if (changedCount) host.addMessage("earlier", null, assistant("Earlier branch sentence."));
		host.addMessage("replacement", null, assistant("Replacement first. Replacement second."));
		await host.shortcut(key); await settle();
		const spoken = worker.sent.slice(before) as Array<{ text: string }>;
		assert.equal(spoken[0]?.text, key === "f7"
				? (changedCount ? "Earlier branch sentence." : "Replacement first.") : "Replacement second.");
		assert.ok(spoken.every(segment => !segment.text.includes("Discarded")));
		assert.equal(host.render("Discarded first. Discarded second.").includes(NARRATION_ACTIVE_MARKER), false);
	});
}

for (const resumeDuringPreparation of [false, true]) test(`F8 retains pending sentence navigation (early resume: ${resumeDuringPreparation})`, async t => {
	const host = await setup(t);
	const text = "First sentence. Second sentence. Third sentence.";
	host.addMessage("answer", null, assistant(text));
	await host.start(); await host.shortcut("f11"); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const before = worker.sent.length;
	const pending = host.shortcut("f9");
	await host.shortcut("f8");
	assert.equal(worker.pauses.at(-1), true);
	if (resumeDuringPreparation) await host.shortcut("f8");
	await pending; await settle();
	assert.equal(worker.pauses.at(-1), !resumeDuringPreparation);
	const segments = worker.sent.slice(before) as Array<{ text: string; utterance: number; segmentId: number }>;
	assert.deepEqual(segments.map(segment => segment.text), ["Second sentence.", "Third sentence."]);
	if (!resumeDuringPreparation) await host.shortcut("f8");
	await settle();
	const third = segments[1];
	worker.emit({ type: "segment-audio", utterance: third.utterance, segmentId: third.segmentId, start: 2, duration: 2 });
	worker.emit({ type: "playback", utterance: third.utterance, position: 2.5 });
	assert.ok(host.render(text).includes(`${NARRATION_ACTIVE_MARKER}Third`), "resumed replacement ticks still update highlights");
});

test("sentence navigation resolves known absolute timing after the branch grows", async t => {
	t.mock.method(MockedVoiceWorkerClient.prototype, "measureSegment", async () => 2);
	const host = await setup(t);
	host.addMessage("answer", null, assistant("First sentence. Second sentence. Third sentence."));
	await host.start(); await host.shortcut("f11"); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const full = worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
	full.forEach((segment, i) => worker.emit({ type: "segment-audio", utterance: segment.utterance, segmentId: segment.segmentId, start: i * 2, duration: 2 }));
	host.addMessage("later", "answer", assistant("Later message."));
	const before = full.length;
	await host.shortcut("f9"); await settle();
	const second = full[before];
	assert.equal(second.text, "Second sentence.");
	worker.emit({ type: "segment-audio", utterance: second.utterance, segmentId: second.segmentId, start: 0, duration: 2 });
	worker.emit({ type: "playback", utterance: second.utterance, position: 1 });
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.match(host.widgetLines()?.join(" ") ?? "", /\] 0:03 \/ /);
});

test("cached description sentence previews carry description offsets before acquisition", async t => {
	const host = await setup(t);
	const cached = mock.method(CodeDescriptionCache.prototype, "get", () => ({ guided: false,
		records: [{ speech: "First description. Second description.", operations: [] }] }));
	const acquire = mock.method(SessionCoordinator.prototype, "tryAcquireSpeech", () => false);
	const force = mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", async () => false);
	t.after(() => { cached.mock.restore(); acquire.mock.restore(); force.mock.restore(); });
	const text = "```js\nconst x = 1;\n```";
	host.addMessage("answer", null, assistant(text));
	await host.start(); await host.shortcut("f11"); await settle();
	assert.ok(host.render(text).includes(`${NARRATION_ACTIVE_MARKER}First`), "first description word, not raw fence");
	await host.shortcut("f9"); await settle();
	assert.ok(host.render(text).includes(`${NARRATION_ACTIVE_MARKER}Second`), "skipUnits maps to the second description sentence");
	assert.equal(MockedVoiceWorkerClient.instances.at(-1)?.sent.length ?? 0, 0, "failed acquisition never sends audio");
});


test("paused buffered idle records timing without advancing sentence selection", async t => {
	const host = await setup(t);
	host.addMessage("answer", null, assistant("First sentence. Second sentence. Third sentence."));
	await host.start(); await host.shortcut("f11"); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const segments = worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
	segments.forEach((segment, i) => worker.emit({ type: "segment-audio", utterance: segment.utterance,
		segmentId: segment.segmentId, start: i * 2, duration: 2 }));
	worker.emit({ type: "playback", utterance: segments[0].utterance, position: 0.5 });
	await host.shortcut("f8");
	worker.emit({ type: "idle", utterance: segments[0].utterance });
	await settle();
	const before = segments.length;
	await host.shortcut("f9"); await settle();
	assert.equal(segments[before]?.text, "Second sentence.");
	assert.equal(worker.pauses.at(-1), true);
});

for (const duringPreparation of [false, true]) for (const latest of ["f6", "stop"]) test(`overlapping cold F11 cannot supersede ${latest} (preparation started: ${duringPreparation})`, async t => {
	const host = await setup(t);
	await host.start();
	for (let i = 0; i < 40; i++) host.addMessage(`cold-${i}`, null, assistant(`Answer ${i}.\n\`\`\`js\nx(${i});\n\`\`\``));
	let clock = 0;
	t.mock.method(performance, "now", () => clock += 9);
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const replay = host.shortcut("f11");
	if (duringPreparation) await replay;
	const newer = latest === "stop" ? host.command("stop") : host.shortcut(latest);
	await Promise.all([replay, newer]);
	for (let i = 0; i < 6; i++) await settle();
	const sent = worker.sent as Array<{ text: string }>;
	if (latest === "stop") assert.equal(sent.length, 0);
	else {
		assert.ok(sent.some(segment => segment.text === "Answer 38."));
		assert.ok(sent.every(segment => segment.text !== "Answer 39."));
		assert.match(host.widgetLines()?.join(" ") ?? "", /message 39\/40/);
	}
});

for (const latest of ["f6", "stop"]) test(`F11 identity wait cannot overwrite newer ${latest}`, async t => {
	const host = await setup(t, "auto");
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	for (const id of ["A", "B", "C"]) host.addMessage(id, null, assistant(`${id} sentence.`));
	await host.start();
	const identity = Promise.withResolvers<ConnectionDevice>();
	const resolve = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => identity.promise);
	await host.shortcut("f11"); await settle();
	assert.equal(resolve.mock.callCount(), 1);
	if (latest === "stop") await host.command("stop");
	else await host.shortcut("f6");
	await settle();
	identity.resolve({ kind: "intentional_local" }); await settle();
	const sent = MockedVoiceWorkerClient.instances.slice(workerIndex).flatMap(worker => worker.sent) as Array<{ text: string }>;
	if (latest === "stop") assert.equal(sent.length, 0);
	else assert.deepEqual(sent.map(segment => segment.text).filter(text => !text.startsWith("Project ")), ["B sentence."], JSON.stringify(host.notices));
});

for (const latest of ["f6", "stop"]) test(`late F11 acquisition failure cannot retire newer ${latest}`, async t => {
	const host = await setup(t);
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	for (const id of ["A", "B", "C"]) host.addMessage(id, null, assistant(`${id} sentence.`));
	await host.start();
	const acquisition = Promise.withResolvers<boolean>();
	const acquire = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech", () => false);
	const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", () => acquisition.promise);
	await host.shortcut("f11"); await settle();
	assert.equal(force.mock.callCount(), 1);
	acquire.mock.restore();
	if (latest === "stop") await host.command("stop");
	else await host.shortcut("f6");
	await settle();
	acquisition.resolve(false); await settle();
	const workers = MockedVoiceWorkerClient.instances.slice(workerIndex);
	const sent = workers.flatMap(worker => worker.sent) as Array<{ text: string }>;
	if (latest === "stop") assert.equal(sent.length, 0);
	else {
		assert.deepEqual(sent.map(segment => segment.text).filter(text => !text.startsWith("Project ")), ["B sentence."]);
		assert.equal(workers.findLast(worker => worker.sent.length)?.pauses.at(-1), false);
	}
	assert.ok(!host.notices.some(notice => /replay remains paused/.test(notice.message)));
});

test("rapid F10 to Tail pauses the still-audible previous transport before retiring preparation", async t => {
	const host = await setup(t);
	for (const id of ["A", "B", "C"]) host.addMessage(id, null, assistant(`${id} sentence.`));
	await host.start(); await host.shortcut("f6"); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	assert.equal((worker.sent.at(-1) as { text: string }).text, "B sentence.");
	const before = worker.sent.length;
	const next = host.shortcut("f10");
	const tail = host.shortcut("f10");
	assert.equal(worker.pauses.at(-1), true);
	await Promise.all([next, tail]); await settle();
	assert.equal(worker.sent.length, before);
	assert.equal(host.scrollView.isFollowingEnd, true);
});

test("F8 acquisition retry retains replay-from-Tail intent", async t => {
	const host = await setup(t);
	host.addMessage("answer", null, assistant("First sentence."));
	await host.start();
	host.scrollView.setDocument(Array.from({ length: 300 }, (_, i) => i === 100 ? `${NARRATION_ACTIVE_MARKER}First` : `line ${i}`), 40);
	await host.command("bottom");
	const acquire = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech", () => false);
	const gate = Promise.withResolvers<boolean>();
	const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", () => gate.promise);
	await host.shortcut("f11"); await settle();
	assert.equal(force.mock.callCount(), 1);
	gate.resolve(false); await settle();
	acquire.mock.restore(); force.mock.restore();
	await host.shortcut("f8"); await settle();
	assert.equal(host.scrollView.scrollTop, 92);
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const segment = worker.sent.at(-1) as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", utterance: segment.utterance, segmentId: segment.segmentId, start: 0, duration: 2 });
	worker.emit({ type: "idle", utterance: segment.utterance }); await settle();
	assert.equal(host.scrollView.scrollTop, 260);
	assert.equal(host.scrollView.isFollowingEnd, true);
});

for (const [key, live] of [["f11", false], ["f6", false], ["f9", false], ["f11", true]] as const) test(`${key} handles microphone stop rejection without abandoning the ownership fence (live: ${live})`, async t => {
	const host = await setup(t);
	host.addMessage("answer", null, assistant("First sentence. Second sentence."));
	await host.start(); await host.command("input local");
	if (live) {
		await host.emit("before_agent_start", {});
		const partial = assistant("Live unfinished", "pending");
		await host.emit("message_start", { message: partial });
		await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Live unfinished" } });
	}
	const capture = Promise.withResolvers<PhoneCapture>();
	const stopped = Promise.withResolvers<void>();
	t.mock.method(PhoneInputClient.prototype, "capture", () => capture.promise);
	const stop = t.mock.method(PhoneInputClient.prototype, "stop", () => stopped.promise);
	t.mock.method(PhoneInputClient.prototype, "cancel", async () => {});
	t.after(() => { capture.resolve({ type: "text", data: "" }); });
	await host.command("talk"); await settle();
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const before = worker.sent.length;
	const playback = host.shortcut(key); await settle();
	assert.equal(stop.mock.callCount(), 1);
	stopped.reject(new Error("Recorder stop unconfirmed"));
	await playback; await settle();
	assert.ok(host.notices.some(notice => /Voice replay failed.*Recorder stop unconfirmed/.test(notice.message)));
	assert.equal(worker.sent.length, before);
	await host.shortcut("f8"); await settle();
	assert.equal(worker.sent.length, before, "failed recorder stop still fences playback");
	await fs.stat(path.join(process.env.PI_VOICE_COORDINATOR_DIR!, "speech.lock", "lease.json"));
});

test("streaming F11 replays the prefix, continues future deltas, ticks and canonical ordinal", async t => {
	const host = await setup(t);
	host.addMessage("old", null, assistant("Earlier answer."));
	await host.start();
	await host.emit("before_agent_start", {});
	const partial = assistant("First sentence. Second sentence. ", "pending");
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: {
		type: "text_delta", contentIndex: 0, delta: "First sentence. Second sentence. ", partial,
	} }); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const segments = worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
	const before = segments.length;
	await host.shortcut("f11"); await settle();
	assert.deepEqual(segments.slice(before).map(segment => segment.text), ["First sentence.", "Second sentence."]);
	const second = segments.findLast(segment => segment.text === "Second sentence.")!;
	segments.forEach((segment, i) => worker.emit({ type: "segment-audio", utterance: segment.utterance, segmentId: segment.segmentId, start: i * 2, duration: 2 }));
	worker.emit({ type: "playback", utterance: second.utterance, position: segments.indexOf(second) * 2 + 0.1 });
	assert.ok(host.render("First sentence. Second sentence.").includes(`${NARRATION_ACTIVE_MARKER}Second`));
	const complete = assistant("First sentence. Second sentence. Third sentence. ");
	await host.emit("message_update", { message: complete, assistantMessageEvent: {
		type: "text_delta", contentIndex: 0, delta: "Third sentence. ", partial: complete,
	} });
	await host.emit("message_end", { message: complete });
	host.addMessage("canonical", "old", complete);
	await host.emit("turn_end", { message: complete });
	await host.emit("agent_settled", {}); await settle();
	assert.deepEqual(segments.map(segment => segment.text).filter(text => !text.startsWith("Project ")),
		["First sentence.", "Second sentence.", "First sentence.", "Second sentence.", "Third sentence."]);
	assert.match(host.widgetLines()?.join(" ") ?? "", /message 2\/2/);
	await host.shortcut("f11"); await settle();
	assert.equal(segments.filter(segment => segment.text === "First sentence.").length, 3);
});

for (const beforeDelta of [true, false]) test(`live replay retains unfinished sentences (before first delta: ${beforeDelta})`, async t => {
	const host = await setup(t);
	await host.start();
	await host.emit("before_agent_start", {});
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const partial = { ...assistant("", "pending"), content: [{ type: "text", text: "" }] };
	await host.emit("message_start", { message: partial });
	const delta = async (text: string) => {
		partial.content[0].text += text;
		await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
		await settle();
	};
	if (!beforeDelta) await delta("An unfinished");
	await host.shortcut("f11"); await settle();
	assert.equal((worker.sent as Array<{ text: string }>).filter(segment => !segment.text.startsWith("Project ")).length, 0, "replay must not flush an unfinished prefix");
	await delta(beforeDelta ? "An unfinished sentence. " : " sentence. ");
	assert.deepEqual((worker.sent as Array<{ text: string }>).map(segment => segment.text).filter(text => !text.startsWith("Project ")), ["An unfinished sentence."]);
	const complete = { ...partial, stopReason: "stop" };
	host.addMessage("answer", null, complete);
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete });
	await host.emit("agent_settled", {}); await settle();
	assert.match(host.widgetLines()?.join(" ") ?? "", /message 1\/1/);
});

for (const finalize of [false, true]) test(`live replay refreshes after device wait across source blocks (finalized: ${finalize})`, async t => {
	const host = await setup(t, "auto");
	await host.start();
	await host.command("mode all");
	await host.emit("before_agent_start", {});
	const partial = { ...assistant("", "pending"), content: [{ type: "thinking", thinking: "First thought. " }] as any[] };
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "First thought. " } }); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const before = worker.sent.length;
	const gate = Promise.withResolvers<ConnectionDevice>();
	const resolve = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => gate.promise);
	await host.shortcut("f11"); await settle();
	assert.equal(resolve.mock.callCount(), 1, `explicit live replay repins the connection: ${JSON.stringify(host.notices)} ${host.widgetLines()?.join(" ")}`);
	partial.content[0].thinking += "More thought. ";
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "More thought. " } });
	partial.content.push({ type: "toolCall", id: "tool", name: "read", arguments: {} }, { type: "text", text: "Answer prefix" });
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "Answer prefix" } });
	const complete = { ...partial, stopReason: "stop" };
	if (finalize) {
		await host.emit("message_end", { message: complete });
		host.addMessage("answer", null, complete);
		await host.emit("turn_end", { message: complete });
		await host.emit("agent_settled", {}); await settle();
	}
	gate.resolve({ kind: "intentional_local" }); await settle();
	const segments = worker.sent.slice(before) as Array<{ text: string; utterance: number; segmentId: number }>;
	assert.deepEqual(segments.map(segment => segment.text), finalize ? ["First thought.", "More thought.", "Answer prefix"] : ["First thought.", "More thought."]);
	if (!finalize) {
		partial.content[2].text += " continued. ";
		await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: " continued. " } });
		const done = { ...partial, stopReason: "stop" };
		host.addMessage("answer", null, done);
		await host.emit("message_end", { message: done });
		await host.emit("turn_end", { message: done });
		await host.emit("agent_settled", {}); await settle();
		assert.deepEqual((worker.sent.slice(before) as Array<{ text: string }>).map(segment => segment.text), ["First thought.", "More thought.", "Answer prefix continued."]);
	}
	const last = worker.sent.at(-1) as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", utterance: last.utterance, segmentId: last.segmentId, start: 0, duration: 2 });
	worker.emit({ type: "playback", utterance: last.utterance, position: 0.1 });
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.ok(host.render(partial.content[2].text.trim()).includes(`${NARRATION_ACTIVE_MARKER}Answer`), host.render(partial.content[2].text.trim()));
	assert.match(host.widgetLines()?.join(" ") ?? "", /message 2\/2/);
});

for (const latest of ["stop", "f6"]) test(`pending live replay yields to ${latest}`, async t => {
	const host = await setup(t, "auto");
	host.addMessage("old", null, assistant("Earlier answer."));
	await host.start();
	await host.emit("before_agent_start", {});
	const partial = assistant("Live prefix. ", "pending");
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Live prefix. " } }); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const before = worker.sent.length;
	const gate = Promise.withResolvers<ConnectionDevice>();
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => gate.promise);
	await host.shortcut("f11"); await settle();
	if (latest === "stop") await host.command("stop"); else await host.shortcut("f6");
	gate.resolve({ kind: "intentional_local" }); await settle();
	const complete = { ...partial, stopReason: "stop", content: [...partial.content, { type: "text", text: "Future sentence. " }] };
	await host.emit("message_update", { message: complete, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Future sentence. " } });
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete });
	const last = worker.sent.at(-1) as { utterance: number };
	worker.emit({ type: "idle", utterance: last.utterance }); await settle();
	assert.deepEqual((worker.sent.slice(before) as Array<{ text: string }>).map(segment => segment.text), latest === "stop" ? [] : ["Earlier answer."]);
});

test("live replay survives finalization during cold preparation without automatic queue advancement", async t => {
	const host = await setup(t);
	await host.start();
	for (let i = 0; i < 20; i++) host.addMessage(`cold-${i}`, null, assistant(`History ${i}.`));
	await host.emit("before_agent_start", {});
	const partial = { ...assistant("Unfinished prefix", "pending") };
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Unfinished prefix" } }); await settle();
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const before = worker.sent.length;
	// Every historical entry yields, leaving replay preparation pending through turn_end.
	let clock = 0;
	t.mock.method(performance, "now", () => clock += 9);
	await host.shortcut("f11");
	const complete = { ...partial, stopReason: "stop", content: [...partial.content, { type: "text", text: "Later block." }] };
	await host.emit("message_update", { message: complete, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Later block." } });
	await host.emit("message_end", { message: complete });
	host.addMessage("answer", "cold-19", complete);
	await host.emit("turn_end", { message: complete });
	for (let i = 0; i < 6; i++) await settle();
	assert.deepEqual((worker.sent.slice(before) as Array<{ text: string }>).map(segment => segment.text), ["Unfinished prefix", "Later block."]);
	assert.match(host.widgetLines()?.join(" ") ?? "", /message 21\/22/);
});

test("failed live acquisition retry retains continuation after canonical finalization", async t => {
	const host = await setup(t);
	await host.start(); await host.emit("before_agent_start", {});
	const partial = assistant("First unfinished", "pending");
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First unfinished" } }); await settle();
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const before = worker.sent.length;
	const owns = t.mock.method(SessionCoordinator.prototype, "ownsSpeech", () => false);
	const acquire = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech", () => false);
	const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", async () => false);
	await host.shortcut("f11"); await settle();
	assert.match(host.notices.at(-1)?.message ?? "", /replay remains paused/);
	const complete = { ...partial, stopReason: "stop", content: [...partial.content, { type: "text", text: "Final block." }] };
	await host.emit("message_update", { message: complete, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Final block." } });
	await host.emit("message_end", { message: complete });
	host.addMessage("answer", null, complete);
	await host.emit("turn_end", { message: complete });
	await host.emit("agent_settled", {}); await settle();
	owns.mock.restore(); acquire.mock.restore(); force.mock.restore();
	await host.shortcut("f8"); await settle();
	assert.deepEqual((worker.sent.slice(before) as Array<{ text: string }>).map(segment => segment.text), ["First unfinished", "Final block."]);
	const last = worker.sent.at(-1) as { utterance: number };
	worker.emit({ type: "idle", utterance: last.utterance }); await settle();
	assert.equal(worker.sent.length, before + 2, "drained queued blocks cannot play twice");
});

test("replaying an already completed live part discards later blocks finalized during preparation", async t => {
	const host = await setup(t, "auto");
	await host.start(); await host.emit("before_agent_start", {});
	const partial = assistant("First part. ", "pending");
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First part. " } });
	partial.content.push({ type: "text", text: "Second unfinished" });
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Second unfinished" } }); await settle();
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const before = worker.sent.length;
	const gate = Promise.withResolvers<ConnectionDevice>();
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => gate.promise);
	await host.shortcut("f11"); await settle();
	partial.content[1].text += " sentence. ";
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " sentence. " } });
	partial.content.push({ type: "text", text: "Third part." });
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "Third part." } });
	const complete = { ...partial, stopReason: "stop" };
	host.addMessage("answer", null, complete);
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete });
	await host.emit("agent_settled", {}); await settle();
	gate.resolve({ kind: "intentional_local" }); await settle();
	const last = worker.sent.at(-1) as { utterance: number };
	worker.emit({ type: "idle", utterance: last.utterance }); await settle();
	assert.deepEqual((worker.sent.slice(before) as Array<{ text: string }>).map(segment => segment.text), ["First part."]);
	assert.match(host.widgetLines()?.join(" ") ?? "", /message 1\/3/);
});

test("live replay refreshes deltas received while the old sink cancellation is unacknowledged", async t => {
	const host = await setup(t);
	await host.start(); await host.emit("before_agent_start", {});
	const partial = assistant("First sentence. ", "pending");
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First sentence. " } }); await settle();
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const before = worker.sent.length;
	const cancel = t.mock.method(worker, "cancel", () => 501 as never);
	await host.shortcut("f11"); await settle();
	assert.equal(cancel.mock.callCount(), 1);
	partial.content[0].text += "Middle sentence. ";
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Middle sentence. " } });
	assert.equal(worker.sent.length, before, "replacement cannot start before old sink stop proof");
	worker.emit({ type: "idle", cancelId: 501 }); await settle();
	partial.content[0].text += "Last sentence. ";
	await host.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Last sentence. " } }); await settle();
	assert.deepEqual((worker.sent.slice(before) as Array<{ text: string }>).map(segment => segment.text), ["First sentence.", "Middle sentence.", "Last sentence."]);
	cancel.mock.restore();
});

test("pending live replay keeps its source IDs across the next tool turn", async t => {
	const host = await setup(t, "auto");
	await host.start(); await host.emit("before_agent_start", {});
	const partial = assistant("Old prefix", "pending");
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Old prefix" } }); await settle();
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const before = worker.sent.length;
	const gate = Promise.withResolvers<ConnectionDevice>();
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => gate.promise);
	await host.shortcut("f11"); await settle();
	const complete = { ...partial, stopReason: "toolUse", content: [...partial.content, { type: "text", text: "Old final." }] };
	await host.emit("message_update", { message: complete, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Old final." } });
	await host.emit("message_end", { message: complete });
	host.addMessage("old", null, complete);
	await host.emit("turn_end", { message: complete });
	const next = assistant("New prefix", "pending");
	await host.emit("message_start", { message: next });
	await host.emit("message_update", { message: next, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "New prefix" } });
	gate.resolve({ kind: "intentional_local" }); await settle();
	const done = assistant("New prefix completed.");
	await host.emit("message_update", { message: done, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " completed." } });
	host.addMessage("new", "old", done);
	await host.emit("message_end", { message: done });
	await host.emit("turn_end", { message: done });
	await host.emit("agent_settled", {}); await settle();
	assert.deepEqual((worker.sent.slice(before) as Array<{ text: string }>).map(segment => segment.text), ["Old prefix", "Old final."]);
	const last = worker.sent.at(-1) as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", utterance: last.utterance, segmentId: last.segmentId, start: 0, duration: 2 });
	worker.emit({ type: "playback", utterance: last.utterance, position: 0.1 });
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.match(host.widgetLines()?.join(" ") ?? "", /message 2\/3/);
	assert.ok(host.render("Old final.").includes(`${NARRATION_ACTIVE_MARKER}Old`));
	assert.equal(host.render("New prefix completed.").includes(NARRATION_ACTIVE_MARKER), false, "new finalization must not inherit the old replay capture");
});

for (const stopReason of ["aborted", "error"]) test(`pending live replay is retired by terminal ${stopReason}`, async t => {
	const host = await setup(t, "auto");
	await host.start(); await host.emit("before_agent_start", {});
	const partial = assistant("Unfinished prefix", "pending");
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Unfinished prefix" } }); await settle();
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const before = worker.sent.length;
	const gate = Promise.withResolvers<ConnectionDevice>();
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => gate.promise);
	await host.shortcut("f11"); await settle();
	const complete = { ...partial, stopReason };
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete });
	gate.resolve({ kind: "intentional_local" }); await settle();
	assert.equal(worker.sent.length, before);
	assert.equal(host.render("Unfinished prefix").includes(NARRATION_ACTIVE_MARKER), false);
});
