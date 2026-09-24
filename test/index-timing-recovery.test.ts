import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, streamCompletedResponse } from "./helpers/fake-voice-host.js";
import { PlaybackHistory } from "../src/playback-history.js";
import type { TimingRetryResult } from "../src/worker-client.js";

const measured: string[] = [];
let duration = 0;
class MeasuringWorker extends MockedVoiceWorkerClient {
	retryTiming(): Promise<TimingRetryResult> {
		return Promise.resolve({ status: "timing", duration: 2, quality: "ctc-refined", words: [
			{ text: "Alpha", start: 0, end: 0.5, quality: "ctc-refined" },
			{ text: "beta", start: 1, end: 1.5, quality: "ctc-refined" },
		] });
	}
	override measureSegment(...args: unknown[]): Promise<number> {
		measured.push(String(args[0]));
		return Promise.resolve(duration);
	}
}

for (const paused of [false, true]) test(`missing-unit recovery preserves the target (paused lease-owner poll: ${paused})`, async t => {
	measured.length = 0;
	duration = 0;
	const workerStart = MockedVoiceWorkerClient.instances.length;
	mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MeasuringWorker } });
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-recovery-"));
	const previous = { ...process.env };
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({
		enabled: true, mode: "assistant", input: "disabled", audioCache: false, timingPreprocessConcurrency: 1,
	}));
	const host = new FakeVoiceHost(path.join(root, "project"), "timing-recovery");
	t.after(async () => {
		await host.shutdown().catch(() => {});
		mock.reset();
		for (const key of ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"]) {
			if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("user", null, { role: "user", content: [{ type: "text", text: "Read." }], timestamp: 1 });
	await host.start();
	await streamCompletedResponse(host, "assistant", "user", "First sentence has enough words. Second sentence has enough words. Third sentence has enough words.");
	const worker = MockedVoiceWorkerClient.instances.slice(workerStart).find(instance => instance.sent.length > 0)!;
	const beforeReplay = worker.sent.length;
	await host.shortcut("f5");
	const first = worker.sent[beforeReplay] as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", segmentId: first.segmentId, start: 0, duration: 2 } as never);
	worker.emit({ type: "playback", utterance: first.utterance, position: 0 } as never);
	const beforeSeek = worker.sent.length;
	await host.shortcut("f9");
	const suffix = worker.sent.slice(beforeSeek) as Array<{ utterance: number; segmentId: number; text: string }>;
	assert.equal(suffix.length, 2);
	worker.emit({ type: "segment-audio", segmentId: suffix[1].segmentId, start: 4, duration: 3 } as never);
	const sent = worker.sent.length;
	if (paused) await host.shortcut("f8");
	else worker.emit({ type: "idle", utterance: suffix[1].utterance } as never);
	const frozen = host.render("First sentence has enough words. Second sentence has enough words. Third sentence has enough words.");
	if (paused) await fs.stat(path.join(root, "coordinator", "speech.lock", "lease.json"));
	// Paused case has no idle/settled event: the ordinary poll must admit its owner.
	for (let i = 0; i < 100 && measured.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(measured, [suffix[0].text]);
	assert.equal(host.entries.some(entry => entry.data?.version === 3), false, "invalid duration cannot make a partial target complete");
	duration = 4;
	worker.emit({ type: "idle", utterance: suffix[1].utterance } as never);
	for (let i = 0; i < 100 && !host.entries.some(entry => entry.data?.version === 3); i++) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.deepEqual(measured, [suffix[0].text, suffix[0].text]);
	const snapshot = host.entries.find(entry => entry.data?.version === 3)?.data;
	assert.ok(snapshot);
	assert.equal(snapshot.duration, 9);
	assert.equal(snapshot.checkpoints.filter((point: { duration: number }) => point.duration > 0).length, 3);
	assert.equal(worker.sent.length, sent, "timing recovery must not speak");
	if (paused) {
		assert.equal(worker.pauses.at(-1), true);
		assert.equal(host.render("First sentence has enough words. Second sentence has enough words. Third sentence has enough words."), frozen);
		await fs.stat(path.join(root, "coordinator", "speech.lock", "lease.json"));
	}
});

test("same-transport resume cancels paused background timing before unpausing", async t => {
	mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MeasuringWorker } });
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-resume-timing-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local",
		codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 1 }));
	const host = new FakeVoiceHost(root, "resume-timing");
	let finish: ((duration: number) => void) | undefined;
	let measuring: MockedVoiceWorkerClient | undefined;
	const measure = mock.method(MeasuringWorker.prototype, "measureSegment", function (this: MeasuringWorker) {
		measuring = this;
		return new Promise<number>(resolve => { finish = resolve; });
	});
	t.after(async () => {
		finish?.(1); measure.mock.restore(); await host.shutdown(); mock.reset();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	const firstWorker = MockedVoiceWorkerClient.instances.length;
	await host.start();
	await streamCompletedResponse(host, "answer", "user", "First sentence. Second sentence.");
	const worker = MockedVoiceWorkerClient.instances[firstWorker]!;
	await host.shortcut("f8");
	for (let i = 0; i < 100 && !measuring; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.ok(measuring, "paused-owner poll starts incomplete timing work");
	const cancel = mock.method(measuring, "cancel", () => undefined);
	const sent = worker.sent.length;
	await host.shortcut("f8");
	assert.ok(cancel.mock.callCount() > 0, "foreground resume cancels paused recovery");
	assert.equal(worker.sent.length, sent, "resume reuses the same transport");
	assert.equal(worker.pauses.at(-1), false);
	finish?.(9);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(host.entries.some(entry => entry.data?.version === 3), false, "cancelled recovery cannot persist a late result");
});

test("background completion merges a concurrent paused retry and persists all unit coverage", async t => {
	mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MeasuringWorker } });
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-recovery-retry-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = keys.map(key => process.env[key]);
	keys.forEach((key, i) => { process.env[key] = path.join(root, String(i)); });
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local",
		codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 1 }));
	const host = new FakeVoiceHost(root, "recovery-retry");
	let finish: ((duration: number) => void) | undefined;
	const measurements: string[] = [];
	mock.method(MeasuringWorker.prototype, "measureSegment", (text: string) => {
		measurements.push(text);
		return new Promise<number>(resolve => { finish = resolve; });
	});
	t.after(async () => {
		finish?.(2); await host.shutdown(); mock.reset();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	const workerStart = MockedVoiceWorkerClient.instances.length;
	const text = "Alpha beta. Gamma delta.";
	await host.start();
	await streamCompletedResponse(host, "answer", "user", text);
	const worker = MockedVoiceWorkerClient.instances.slice(workerStart).find(worker => worker.sent.length)!;
	const beforeReplay = worker.sent.length;
	await host.shortcut("f5");
	const first = worker.sent[beforeReplay] as { segmentId: number; utterance: number };
	worker.emit({ type: "segment-audio", segmentId: first.segmentId, utterance: first.utterance, start: 0, duration: 2, timingQuality: "estimated" });
	worker.emit({ type: "playback", utterance: first.utterance, position: 0.5 });
	await host.shortcut("f8");
	for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(measurements, ["Gamma delta."]);
	const frozen = host.render(text);
	const top = host.scrollView.scrollTop;
	const sent = worker.sent.length;
	const snapshots = () => host.entries.filter(entry => entry.customType === "pi-voice.playback-timing");
	await host.command("timing retry current");
	for (let i = 0; i < 100 && !snapshots().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(snapshots().at(-1)?.data.units[0].checkpoints[0].quality, "ctc-refined");
	assert.equal(snapshots().at(-1)?.data.complete, false);
	finish!(2);
	for (let i = 0; i < 100 && snapshots().at(-1)?.data.complete === false; i++) await new Promise(resolve => setTimeout(resolve, 10));
	const saved = snapshots().at(-1)!.data;
	assert.notEqual(saved.complete, false);
	const restored = new PlaybackHistory();
	restored.sync([{ id: saved.messageId, text, renderKey: saved.renderKey }]);
	restored.restore(JSON.parse(JSON.stringify([saved])));
	assert.equal(restored.timingForUnit(saved.messageId, saved.renderKey, { sourceOffset: 0, skipUnits: 0 })?.[0].quality, "ctc-refined");
	assert.equal(saved.checkpoints[0].quality, "ctc-refined");
	assert.deepEqual(restored.status()?.wordTimingCoverage, { estimated: 2, total: 4 });
	assert.equal(restored.status()?.timingsComplete, true);
	assert.equal(host.render(text), frozen);
	assert.equal(host.scrollView.scrollTop, top);
	assert.equal(worker.sent.length, sent);
	assert.equal(worker.pauses.at(-1), true);
	assert.equal(host.modelRequests.length, 0);
});
