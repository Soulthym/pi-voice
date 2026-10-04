import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve)); };
const segments = (worker: MockedVoiceWorkerClient) => worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;

async function fixture(t: TestContext, text = "First sentence. Old second sentence. ") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-life-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", output: "local", input: "disabled", codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "source-life");
	t.after(async () => {
		await host.shutdown();
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("older", null, assistant("Earlier history."));
	await host.start();
	const message = assistant(text, "pending");
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const clips = segments(worker).filter(s => !s.text.startsWith("Project "));
	for (const [i, clip] of clips.entries()) worker.emit({ ...clip, type: "segment-audio", start: i * 10, duration: 10, audioIdentity: `pcm-${clip.segmentId}` });
	worker.emit({ type: "playback", utterance: clips[0]!.utterance, position: 1 });
	return { host, worker, message };
}

for (const change of ["shortened", "replacement", "append"] as const) test(`F9 validates source after gated preparation: ${change}`, async t => {
	const { host, worker, message } = await fixture(t);
	const immediate = globalThis.setImmediate;
	let release: (() => void) | undefined;
	let clock = 0;
	const now = t.mock.method(performance, "now", () => clock += 9);
	const gate = t.mock.method(globalThis, "setImmediate", ((callback: () => void, ...args: unknown[]) => {
		if (new Error().stack?.includes("preparePlaybackMessages")) { release = callback; return immediate(() => {}); }
		return immediate(() => Reflect.apply(callback, undefined, args));
	}) as typeof setImmediate);
	try {
		const before = worker.sent.length;
		const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
		const send = t.mock.method(worker, "sendSegment");
		const navigation = host.shortcut("f9"); await settle();
		assert.ok(release, "gate preparation, not transport cancellation");
		assert.equal(captures.mock.calls.at(-1)!.arguments[4], 16, "F9 selected the old second sentence");
		assert.equal(worker.sent.length, before);
		const text = change === "shortened" ? "New first." : change === "replacement" ? "New first. New second." : message.content[0].text + "New third.";
		const final = assistant(text);
		host.addMessage("canonical", "older", final);
		await host.emit("message_end", { message: final });
		await host.emit("turn_end", { message: final });
		now.mock.restore(); gate.mock.restore(); release(); await navigation; await settle();
		assert.deepEqual(segments(worker).slice(before).map(s => s.text), change === "append" ? ["Old second sentence.", "New third."] : change === "replacement" ? ["New first.", "New second."] : ["New first."]);
		for (const call of send.mock.calls) assert.equal((call.arguments as unknown[])[4], undefined, "no stale cached-PCM offset after final-source validation");
		assert.equal(captures.mock.calls.at(-1)!.arguments[4], change === "append" ? 16 : 0);
		assert.equal(host.modelRequests.length, 0);
	} finally { now.mock.restore(); gate.mock.restore(); release?.(); }
});

for (const barrier of ["preparation", "cancellation"] as const) for (const change of ["replacement", "append"] as const) test(`Tail prefix validation after ${barrier}: ${change}`, async t => {
	const { host, worker, message } = await fixture(t, "First sentence. Old unfinished");
	const immediate = globalThis.setImmediate;
	let release: (() => void) | undefined;
	let clock = 0;
	const now = barrier === "preparation" ? t.mock.method(performance, "now", () => clock += 9) : undefined;
	const gate = barrier === "preparation" ? t.mock.method(globalThis, "setImmediate", ((callback: () => void, ...args: unknown[]) => {
		if (new Error().stack?.includes("preparePlaybackMessages")) { release = callback; return immediate(() => {}); }
		return immediate(() => Reflect.apply(callback, undefined, args));
	}) as typeof setImmediate) : undefined;
	const cancel = barrier === "cancellation" ? t.mock.method(worker, "cancel", () => 903 as never) : undefined;
	try {
		const before = worker.sent.length;
		await host.shortcut("f10"); await settle();
		if (barrier === "preparation") assert.ok(release);
		else assert.equal(cancel!.mock.callCount(), 1);
		assert.equal(worker.sent.length, before);
		const final = assistant(change === "replacement" ? "New first." : message.content[0].text + " becomes complete.");
		host.addMessage("canonical", "older", final);
		await host.emit("message_end", { message: final });
		await host.emit("turn_end", { message: final });
		now?.mock.restore(); gate?.mock.restore(); cancel?.mock.restore();
		if (barrier === "preparation") release!();
		else worker.emit({ type: "idle", cancelId: 903 });
		await settle();
		assert.deepEqual(segments(worker).slice(before).map(s => s.text), change === "replacement" ? ["New first."] : ["Old unfinished becomes complete."], "Tail cannot seed removed source or discard replacement text");
		assert.equal(host.modelRequests.length, 0);
	} finally { now?.mock.restore(); gate?.mock.restore(); cancel?.mock.restore(); release?.(); }
});

for (const continuation of ["allocated", "queued", "pause", "stop", "session"] as const) test(`ordinary F5 retires removed A but preserves B: ${continuation}`, async t => {
	const { host, worker, message } = await fixture(t);
	const observer = new SessionCoordinator(host.cwd, "observer");
	const b = "Remaining B block.";
	if (continuation !== "queued") {
		const updated = structuredClone(message);
		updated.content.push({ type: "text", text: b + " " });
		await host.emit("message_update", { message: updated, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: b + " " } });
		await settle();
		assert.ok(segments(worker).some(s => s.text === b), "B already has a worker block and live ID");
	}
	const a = segments(worker).find(s => s.text === "First sentence.")!;
	worker.emit({ type: "playback", utterance: a.utterance, position: 2 });
	const before = worker.sent.length;
	const cancel = t.mock.method(worker, "cancel", () => 902 as never);
	await host.shortcut("f5"); await settle();
	assert.equal(cancel.mock.callCount(), 1, "ordinary live F5 is waiting for cancellation without a paused notice");
	assert.equal(worker.sent.length, before);
	const final = { ...assistant(""), content: [
		{ type: "toolCall", id: "call", name: "read", arguments: {} }, { type: "text", text: b },
	] };
	await host.emit("message_end", { message: final });
	await host.emit("turn_end", { message: final }); await settle();
	assert.equal(worker.sent.length, before, "finalization cannot dispatch before stop proof");
	let replaced: Promise<void> | undefined;
	if (continuation === "pause") await host.shortcut("f8");
	if (continuation === "stop") await host.command("stop");
	if (continuation === "session") replaced = host.emit("session_start", {});
	cancel.mock.restore();
	worker.emit({ type: "idle", cancelId: 902 }); await replaced; await settle();
	if (continuation === "stop" || continuation === "session") {
		assert.equal(worker.sent.length, before, "newer user/session intent fences the old continuation");
	} else {
		if (continuation === "pause") {
			assert.equal(worker.sent.length, before);
			assert.match(host.widgetLines()!.join(" "), /Paused/);
			await host.shortcut("f8"); await settle();
		}
		assert.deepEqual(segments(worker).slice(before).map(s => s.text), [b], "remaining eligible audio plays exactly once, not removed A");
		assert.ok(observer.speechOwner(), "B retains ownership until its own completion");
		worker.emit({ type: "idle", utterance: a.utterance }); await settle();
		assert.ok(observer.speechOwner(), "old A completion cannot release B's lease");
		worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
		assert.deepEqual(segments(worker).slice(before).map(s => s.text), [b]);
	}
	assert.equal(observer.speechOwner(), undefined, "completion/supersession leaves no leaked speech lease");
	assert.equal(host.modelRequests.length, 0);
});
