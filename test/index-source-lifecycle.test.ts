import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve)); };
const segments = (worker: MockedVoiceWorkerClient) => worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;

async function fixture(t: TestContext) {
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
	const message = assistant("First sentence. Old second sentence. ", "pending");
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
