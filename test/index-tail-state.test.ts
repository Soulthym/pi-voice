import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { assistant, FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 120)); };

async function startHost(t: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "tail-state-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "voice.json"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false, codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "tail-state");
	t.after(async () => {
		await host.shutdown();
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("older", null, assistant("Older response."));
	await host.start();
	return host;
}

for (const completion of ["finalizing", "unpersisted", "persisted"] as const) for (const check of ["counter", "f9", "f10"] as const) test(`caught-up autoplay ${completion}: ${check}`, async t => {
	const host = await startHost(t);
	const ended = t.mock.method(MockedVoiceWorkerClient.prototype, "endUtterance");
	host.idle = false;
	const message = assistant("Latest sentence. Another sentence. "); delete message.stopReason;
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	const final = { ...message, stopReason: "stop" };
	if (completion === "persisted") host.addMessage("latest", "older", final);
	await host.emit("message_end", { message: final });
	if (completion !== "finalizing") await host.emit("turn_end", { message: final });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	assert.ok(worker, "autoplay, not a fabricated Tail fixture");
	for (const segment of worker.sent as Array<{ utterance: number; segmentId: number }>) worker.emit({ ...segment, type: "segment-audio", start: 0, duration: 2 });
	await settle();
	assert.match(host.widgetLines()![0], / · 2\/2(?: ·|\s)/, "playing latest is an existing entry");
	for (const utterance of new Set(worker.sent.map(segment => (segment as { utterance: number }).utterance))) {
		assert.ok(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === utterance), "only a flushed utterance can report EOF");
		worker.emit({ type: "idle", utterance });
	}
	await settle();
	if (check === "counter") {
		assert.match(host.widgetLines()![0], /● live · 3\/2(?: ·|\s)/, "drained autoplay waits beyond the last eligible entry, even while the model works");
	} else {
		const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
		const cancels = t.mock.method(MockedVoiceWorkerClient.prototype, "cancel");
		const releases = t.mock.method(SessionCoordinator.prototype, "releaseSpeech");
		const acquisitions = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech");
		const sent = worker.sent.length;
		const pauses = [...worker.pauses];
		const lines = host.widgetLines();
		await host.shortcut(check); await settle();
		assert.equal(captures.mock.callCount(), 0, "no cursor replacement/backward replay");
		assert.equal(cancels.mock.callCount(), 0, "no transport cancellation at caught-up Tail");
		assert.equal(releases.mock.callCount(), 0, "no lease release");
		assert.equal(acquisitions.mock.callCount(), 0, "no lease acquisition");
		assert.equal(worker.sent.length, sent, "no synthesis");
		assert.deepEqual(worker.pauses, pauses, "play/pause intent unchanged");
		assert.deepEqual(host.widgetLines(), lines);
	}
	if (completion !== "persisted") {
		host.addMessage("latest", "older", final);
		await host.emit("turn_end", { message: final });
		await host.emit("agent_settled", {}); await settle();
		assert.match(host.widgetLines()![0], /● live · 3\/2(?: ·|\s)/, "canonical adoption must retain the waiting boundary");
	}
	assert.equal(host.modelRequests.length, 0);
});

for (const key of ["f9", "f10"]) test(`${key} into Tail, paused/resumed Tail and a later real entry`, async t => {
	const host = await startHost(t);
	await host.shortcut("f5"); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	await host.command("bottom"); // Viewport arrival alone is not Voice Tail.
	assert.match(host.widgetLines()![0], / · 1\/1(?: ·|\s)/);
	await host.shortcut(key); await settle();
	assert.match(host.widgetLines()![0], /● live · 2\/1(?: ·|\s)/);
	const cancels = t.mock.method(MockedVoiceWorkerClient.prototype, "cancel");
	const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
	const sent = worker.sent.length;
	for (const paused of [true, false]) {
		await host.shortcut("f8"); await settle();
		assert.match(host.widgetLines()![0], paused ? /Paused/ : /● live · 2\/1(?: ·|\s)/);
		const lines = host.widgetLines();
		await host.shortcut("f9"); await host.shortcut("f10"); await settle();
		assert.equal(cancels.mock.callCount(), 0);
		assert.equal(captures.mock.callCount(), 0);
		assert.equal(worker.sent.length, sent);
		assert.deepEqual(host.widgetLines(), lines);
	}
	host.addMessage("later", "older", assistant("Later first sentence. Later second sentence."));
	await host.shortcut(key); await settle();
	assert.ok(worker.sent.length > sent, "new real entries must still be navigable after a Tail boundary");
	assert.equal((worker.sent[sent] as { text: string }).text, "Later first sentence.");
	assert.match(host.widgetLines()![0], / · 2\/2(?: ·|\s)/);
	const beforeSentence = worker.sent.length;
	await host.shortcut("f9"); await settle();
	assert.equal((worker.sent[beforeSentence] as { text: string }).text, "Later second sentence.");
});

test("explicit streaming Tail is inert and retains future deltas through canonicalization", async t => {
	const host = await startHost(t);
	const message = assistant("Streamed first. Streamed last. "); delete message.stopReason;
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	await host.shortcut("f10"); await settle(); // Explicitly skip the prefix, rather than fabricate streaming EOF.
	assert.match(host.widgetLines()![0], /● live · 3\/2(?: ·|\s)/);
	const cancels = t.mock.method(MockedVoiceWorkerClient.prototype, "cancel");
	const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
	const sent = worker.sent.length;
	await host.shortcut("f9"); await host.shortcut("f10"); await settle();
	assert.equal(cancels.mock.callCount(), 0);
	assert.equal(captures.mock.callCount(), 0);
	assert.equal(worker.sent.length, sent);
	const delta = "Future sentence. ";
	const updated = assistant(message.content[0].text + delta); delete updated.stopReason;
	await host.emit("message_update", { message: updated, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } }); await settle();
	assert.deepEqual((worker.sent.slice(sent) as Array<{ text: string }>).map(segment => segment.text), ["Future sentence."]);
	assert.match(host.widgetLines()![0], / · 2\/2(?: ·|\s)/);
	const ended = t.mock.method(MockedVoiceWorkerClient.prototype, "endUtterance");
	const final = { ...updated, stopReason: "stop" };
	host.addMessage("latest", "older", final);
	await host.emit("message_end", { message: final });
	await host.emit("turn_end", { message: final }); await settle();
	const clip = worker.sent.at(-1) as { utterance: number; segmentId: number };
	assert.ok(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === clip.utterance));
	worker.emit({ ...clip, type: "segment-audio", start: 0, duration: 2 });
	worker.emit({ type: "idle", utterance: clip.utterance }); await settle();
	assert.match(host.widgetLines()![0], /● live · 3\/2(?: ·|\s)/);
});

test("empty streaming header reserves identity, not an eligible counter entry", async t => {
	const host = await startHost(t);
	await host.shortcut("f10"); await settle();
	assert.match(host.widgetLines()![0], /● live · 2\/1(?: ·|\s)/);
	const empty = assistant(""); delete empty.stopReason;
	await host.emit("message_start", { message: empty }); await settle();
	assert.match(host.widgetLines()![0], /● live · 2\/1(?: ·|\s)/, "empty source reservation does not increment total");
	const message = assistant("Eligible streaming sentence. "); delete message.stopReason;
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	assert.match(host.widgetLines()![0], / · 2\/2(?: ·|\s)/, "first eligible content creates exactly one real entry");
});
