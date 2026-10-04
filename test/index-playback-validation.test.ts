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

for (const samples of [[2400, 16800], [4800, 2400], [3000, 4200]]) for (const estimated of [false, true])
test(`sample-count EOF shares one normalized clock (${samples.join("+")}, estimated=${estimated})`, async t => {
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
	let vocalizer: VocalizerType | undefined;
	const handle = Vocalizer.prototype.handleWorkerEvent;
	const handled = t.mock.method(Vocalizer.prototype, "handleWorkerEvent", function(this: VocalizerType, ...args: Parameters<typeof handle>) {
		vocalizer = this; return handle.apply(this, args);
	});
	await host.start(); const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const message = assistant("First sentence. Second sentence. ", "pending");
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	const segments = worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
	const first = segments.find(segment => segment.text === "First sentence.")!;
	const second = segments.find(segment => segment.text === "Second sentence.")!;
	assert.ok(first && second && first.utterance === second.utterance);
	const [firstSamples, secondSamples] = samples;
	const start = firstSamples / 24_000, duration = secondSamples / 24_000;
	// The last case has canonical EOF 0.3 and an upstream tick rounded to 0.1 + 0.2.
	const position = firstSamples === 3000 ? 0.1 + 0.2 : (firstSamples + secondSamples) / 24_000, normalized = start + duration;
	assert.notEqual(position, normalized, "real sample-count arithmetic must exercise roundoff");
	worker.emit({ ...first, type: "segment-audio", start: 0, duration: start, audioIdentity: "pcm-1" });
	worker.emit({ ...second, type: "segment-audio", start, duration, audioIdentity: "pcm-2" });
	for (const segment of segments.filter(segment => segment.utterance !== second.utterance)) worker.emit({ type: "idle", utterance: segment.utterance });
	worker.emit({ type: "playback", utterance: second.utterance, position: 0, estimated });
	assert.deepEqual(narration.mock.calls.at(-1)?.arguments, [second.utterance, 0], "zero is accepted");
	assert.equal(vocalizer?.playbackPhase, "playing");
	assert.equal(history!.resumeSnapshot()?.confirmedPosition, estimated ? undefined : 0);
	const event = { type: "playback" as const, utterance: second.utterance, position, estimated };
	worker.emit(event);
	assert.deepEqual(narration.mock.calls.at(-1)?.arguments, [second.utterance, normalized]);
	assert.deepEqual(handled.mock.calls.at(-1)?.arguments, [{ ...event, position: normalized }]);
	assert.equal(event.position, position, "the worker event is not mutated");
	assert.equal(vocalizer?.playbackPhase, "idle", "normalized EOF cannot retain phantom playing audio");
	assert.notEqual(vocalizer?.playbackUtterance, second.utterance);
	const eof = history!.resumeSnapshot();
	assert.equal(eof?.position, normalized);
	assert.equal(eof?.confirmedPosition, undefined, "EOF has no reusable audio offset");
	assert.equal(eof?.sourceOffset, 16);
	assert.equal(eof?.audioOffset, undefined);
	const eofCalls = narration.mock.callCount();
	worker.emit(event);
	assert.equal(narration.mock.callCount(), eofCalls + 1, "repeated raw EOF normalizes before ordering");
	assert.deepEqual(narration.mock.calls.at(-1)?.arguments, [second.utterance, normalized]);
	const before = narration.mock.callCount(), handledBefore = handled.mock.callCount();
	for (const invalid of [-1, NaN, Infinity, position + 1 / 24_000, start / 2]) {
		worker.emit({ ...event, position: invalid });
		assert.equal(narration.mock.callCount(), before);
		assert.equal(handled.mock.callCount(), handledBefore, "rejected ticks cannot mutate foreground state");
		assert.deepEqual(history!.resumeSnapshot(), eof);
	}
	if (!estimated) {
		const cancel = t.mock.method(worker, "cancel");
		const sent = worker.sent.length;
		await host.shortcut("f9"); await host.shortcut("f10"); await settle();
		assert.equal(cancel.mock.callCount(), 0, "rounded confirmed OPEN-stream EOF makes forward navigation inert");
		assert.equal(worker.sent.length, sent);
		assert.deepEqual(history!.resumeSnapshot(), eof);
	}
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
	const snapshot = history?.resumeSnapshot();
	for (const position of [-1, NaN, Infinity, 30, 0.5]) {
		worker.emit({ type: "playback", utterance: a.utterance, position, estimated });
		assert.deepEqual(history?.resumeSnapshot(), snapshot);
		assert.equal(narration.mock.callCount(), before);
		assert.equal(vocalizer?.playbackUtterance, a.utterance, "invalid ticks cannot poison Vocalizer's foreground position");
		assert.equal(vocalizer?.playbackPhase, "playing");
	}
	// A sample-sized hole before queued audio must not change selection or the utterance fence.
	worker.emit({ ...b, type: "segment-audio", start: 2 / 24_000, duration: 3, audioIdentity: `pcm-${b.segmentId}` });
	for (const position of [-1, NaN, Infinity, 30, 1 / 24_000]) {
		worker.emit({ type: "playback", utterance: b.utterance, position, estimated });
		assert.deepEqual(history?.resumeSnapshot(), snapshot);
		assert.equal(narration.mock.callCount(), before);
	}
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
