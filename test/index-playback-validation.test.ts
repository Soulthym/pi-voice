import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";
import type { Vocalizer as VocalizerType } from "../src/vocalizer.js";
import { NARRATION_ACTIVE_MARKER, NarrationProgress } from "../src/narration-progress.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const { Vocalizer } = await import("../src/vocalizer.js");
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve)); };

test("sample-count EOF reaches narration and retains a conservative history checkpoint", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-playback-pcm-"));
	for (const [key, value] of Object.entries({ PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") })) {
		const old = process.env[key]; process.env[key] = value;
		t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
	}
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode: "assistant", output: "local", input: "disabled", codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "pcm");
	t.after(async () => { await host.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
	let history: PlaybackHistory | undefined;
	const begin = PlaybackHistory.prototype.beginCapture;
	t.mock.method(PlaybackHistory.prototype, "beginCapture", function(this: PlaybackHistory, ...args: Parameters<typeof begin>) { history = this; return begin.apply(this, args); });
	const narration = t.mock.method(NarrationProgress.prototype, "setPlayback");
	await host.start(); const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const message = assistant("First sentence. Second sentence. ", "pending");
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	const segments = worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
	const first = segments.find(segment => segment.text === "First sentence.")!;
	const second = segments.find(segment => segment.text === "Second sentence.")!;
	assert.ok(first && second && first.utterance === second.utterance);
	worker.emit({ ...first, type: "segment-audio", start: 0, duration: 2400 / 24_000, audioIdentity: "pcm-1" });
	worker.emit({ ...second, type: "segment-audio", start: 2400 / 24_000, duration: 16800 / 24_000, audioIdentity: "pcm-2" });
	worker.emit({ type: "playback", utterance: second.utterance, position: 19200 / 24_000 });
	assert.deepEqual(narration.mock.calls.at(-1)?.arguments, [second.utterance, 0.8]);
	const eof = history!.resumeSnapshot();
	assert.equal(eof?.position, 2400 / 24_000 + 16800 / 24_000);
	assert.equal(eof?.sourceOffset, 16);
	assert.equal(eof?.audioOffset, undefined);
	const before = narration.mock.callCount();
	worker.emit({ type: "playback", utterance: second.utterance, position: 19201 / 24_000 });
	assert.equal(narration.mock.callCount(), before);
	assert.deepEqual(history!.resumeSnapshot(), eof);
	assert.equal(host.modelRequests.length, 0);
});

for (const estimated of [false, true]) test(`invalid queued playback cannot fence audible ticks or advance Tail (estimated=${estimated})`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-playback-validation-"));
	for (const [key, value] of Object.entries({ PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") })) {
		const old = process.env[key]; process.env[key] = value;
		t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
	}
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode: "assistant", output: "local", input: "disabled", codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "validation");
	t.after(async () => { await host.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
	let vocalizer: VocalizerType | undefined;
	const handle = Vocalizer.prototype.handleWorkerEvent;
	t.mock.method(Vocalizer.prototype, "handleWorkerEvent", function(this: VocalizerType, ...args: Parameters<typeof handle>) {
		vocalizer = this; return handle.apply(this, args);
	});
	let history: PlaybackHistory | undefined;
	const begin = PlaybackHistory.prototype.beginCapture;
	t.mock.method(PlaybackHistory.prototype, "beginCapture", function(this: PlaybackHistory, ...args: Parameters<typeof begin>) { history = this; return begin.apply(this, args); });
	const narration = t.mock.method(NarrationProgress.prototype, "setPlayback");
	await host.start(); const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const blocks = ["First audible answer.\n", "Last queued answer.\n"].map(text => ({ type: "text", text }));
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
	const segments = worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
	const a = segments.find(segment => segment.text === "First audible answer.")!;
	const b = segments.find(segment => segment.text === "Last queued answer.")!;
	assert.ok(a && b && b.utterance > a.utterance);
	for (const segment of [a, b]) worker.emit({ ...segment, type: "segment-audio", start: 0, duration: 3, audioIdentity: `pcm-${segment.segmentId}` });
	worker.emit({ type: "playback", utterance: a.utterance, position: 1, estimated });
	await settle();
	const before = narration.mock.callCount();
	worker.emit({ type: "playback", utterance: a.utterance, position: 30, estimated });
	assert.equal(vocalizer?.playbackUtterance, a.utterance, "invalid ticks cannot poison Vocalizer's foreground position");
	assert.equal(vocalizer?.playbackPhase, "playing");
	worker.emit({ type: "playback", utterance: b.utterance, position: 30, estimated });
	await settle();
	assert.equal(narration.mock.callCount(), before, "invalid queued tick must not reach narration");
	assert.doesNotMatch(host.widgetLines()!.join(" "), /\bTail\b/);
	worker.emit({ type: "playback", utterance: a.utterance, position: 1.5, estimated });
	await settle();
	assert.equal(history?.selected()?.id, "answer");
	assert.equal(history?.status()?.position, 1.5, "invalid newer tick must not fence continued audible playback");
	assert.ok(host.render(blocks[0].text.trim()).includes(NARRATION_ACTIVE_MARKER));
	assert.ok(!host.render(blocks[1].text.trim()).includes(NARRATION_ACTIVE_MARKER));
	assert.deepEqual(narration.mock.calls.at(-1)?.arguments, [a.utterance, 1.5]);
	worker.emit({ type: "playback", utterance: b.utterance, position: 1, estimated });
	await settle();
	assert.equal(history?.selected()?.id, "answer:1", "valid queued ticks still advance the source");
	worker.emit({ type: "idle", utterance: a.utterance });
	assert.equal(vocalizer?.playbackUtterance, b.utterance, "rejected queued position cannot hide later valid audio");
	assert.ok(host.render(blocks[1].text.trim()).includes(NARRATION_ACTIVE_MARKER));
	assert.equal(host.modelRequests.length, 0);
});
