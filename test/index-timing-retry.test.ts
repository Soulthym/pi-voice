import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { narrationRenderKey } from "../src/render-identity.js";
import { PlaybackHistory } from "../src/playback-history.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import type { TimingRetryResult } from "../src/worker-client.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, streamCompletedResponse } from "./helpers/fake-voice-host.js";

const calls: Array<{ text: string; signal?: AbortSignal; resolve: (result: TimingRetryResult) => void }> = [];
class RetryWorker extends MockedVoiceWorkerClient {
	static allowPlayback = false;
	retryTiming(text: string, signal?: AbortSignal): Promise<TimingRetryResult> {
		return new Promise(resolve => calls.push({ text, signal, resolve }));
	}
	measureSegment(): Promise<number> { assert.fail("retry must not measure/synthesize"); }
	sendSegment(utterance: number, segmentId: number, text: string): void {
		assert.ok(RetryWorker.allowPlayback, "retry must not play");
		super.sendSegment(utterance, segmentId, text);
	}
}
mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: RetryWorker } });
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 25)); };
const result: Extract<TimingRetryResult, { status: "timing" }> = { status: "timing", duration: 2, quality: "ctc-refined", words: [
	{ text: "Alpha", start: 0, end: 0.5, quality: "ctc-refined" },
	{ text: "beta", start: 1, end: 1.5, quality: "ctc-refined" },
] };

test("real timing retry handler snapshots scope, stays silent, persists coverage and fences cancellation", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-timing-retry-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const old = names.map(name => process.env[name]);
	for (const [i, name] of names.entries()) process.env[name] = path.join(root, String(i));
	const config = { ...DEFAULT_VOICE_CONFIG, enabled: false, mode: "assistant" as const, timingPreprocessConcurrency: 0 as const, codeDescriptionPreprocessBudget: 0, input: "disabled", output: "local" };
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify(config));
	const host = new FakeVoiceHost(root, "retry");
	t.after(async () => {
		await host.shutdown(); mock.restoreAll();
		for (const [i, name] of names.entries()) { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; }
		await fs.rm(root, { recursive: true, force: true });
	});
	const text = "Alpha beta.";
	const key = narrationRenderKey(text, config, []);
	for (const [i, quality] of ["estimated", "ctc-refined", undefined, "estimated"].entries()) {
		host.addMessage(`a${i}`, host.entries.at(-1)?.id ?? null, { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: i });
		host.api.appendEntry("pi-voice.playback-timing", { version: 3, messageId: `a${i}`, renderKey: key, duration: 2,
			checkpoints: [{ time: 0, duration: 2, sourceOffset: 0, quality }] });
	}
	host.addMessage("code", host.entries.at(-1)?.id, { role: "assistant", content: [{ type: "text", text: "```ts\nconst missing = 1;\n```" }], stopReason: "stop", timestamp: 5 });
	await host.start();
	const snapshots = () => host.entries.filter(entry => entry.customType === "pi-voice.playback-timing");
	const initial = snapshots().length;
	for (const scope of ["0-1", "01-2", "2-1", "1-99", "1-2 extra", "a", "a0 extra", "9007199254740993-9007199254740994"]) {
		await host.command(`timing retry ${scope}`);
		assert.equal(host.notices.at(-1)?.level, "error", scope);
	}
	assert.equal(calls.length, 0);
	const frames = host.widgetOperations.length;
	const draft = mock.method(host.ctx.ui, "setEditorText", () => assert.fail("draft mutation"));
	await host.command("timing retry 1-3");
	await tick();
	assert.equal(calls.length, 1);
	await host.command("timing");
	assert.match(host.notices.at(-1)!.message, /Timing retry: target 1\/3/);
	calls[0].resolve(result);
	await tick();
	assert.equal(calls.length, 1, "refined and unknown units are not retried");
	assert.equal(snapshots().length, initial + 1);
	const saved = snapshots().at(-1)!.data;
	assert.equal(saved.messageId, "a0");
	assert.deepEqual(saved.units[0].coverage, { estimated: 0, total: 2 });
	const restored = new PlaybackHistory();
	restored.sync([{ id: "a0", text, renderKey: key }]);
	restored.restore(JSON.parse(JSON.stringify([saved])));
	assert.deepEqual(restored.status()?.wordTimingCoverage, { estimated: 0, total: 2 });
	assert.equal(host.widgetOperations.length, frames, "retry does not touch playback widgets/viewport");
	assert.equal(draft.mock.callCount(), 0);
	assert.equal(host.modelRequests.length, 0);

	await host.command("timing retry current"); // selected code has no cached description
	await tick();
	assert.equal(calls.length, 1);
	assert.match(host.notices.at(-1)!.message, /1 skipped/);
	await host.command("timing retry a3");
	await tick();
	assert.equal(calls.length, 2);
	await host.command("timing retry a3");
	assert.equal(calls[1].signal?.aborted, true);
	await tick();
	assert.equal(calls.length, 3);
	calls[1].resolve(result);
	await tick();
	assert.equal(snapshots().length, initial + 1, "retired request cannot persist");
	await host.command("stop");
	assert.equal(calls[2].signal?.aborted, true);
	calls[2].resolve(result);
	await tick();
	assert.equal(snapshots().length, initial + 1);

	const owner = mock.method(SessionCoordinator.prototype, "speechOwner", () => ({ instanceId: "other" }) as any);
	await host.command("timing retry all");
	await tick();
	assert.equal(calls.length, 3, "foreground owns the next slot");
	owner.mock.restore();
	await new Promise(resolve => setTimeout(resolve, 75));
	assert.equal(calls.length, 4, "all uses eligible current-branch targets and skips missing plans");
	const preempt = mock.method(SessionCoordinator.prototype, "speechOwner", () => ({ instanceId: "other" }) as any);
	await new Promise(resolve => setTimeout(resolve, 75));
	assert.equal(calls.at(-1)!.signal?.aborted, true);
	calls.at(-1)!.resolve(result);
	await tick();
	assert.equal(snapshots().length, initial + 1);
	preempt.mock.restore();
	await new Promise(resolve => setTimeout(resolve, 75));
	assert.equal(calls.length, 5, "preempted units return to the single retry lane");
	calls.at(-1)!.resolve({ status: "cache-miss" });
	await tick();
	assert.match(host.notices.at(-1)!.message, /1 missing cached audio/);
	await host.command("timing retry a3");
	await tick();
	const branch = mock.method(host.sessionManager, "getBranch", () => host.entries.filter(entry => entry.id !== "a3"));
	const leaf = mock.method(host.sessionManager, "getLeafId", () => "other-branch");
	calls.at(-1)!.resolve(result);
	await tick();
	assert.equal(snapshots().length, initial + 1, "branch changes fence results");
	await host.command("timing retry a3");
	assert.equal(host.notices.at(-1)?.level, "error", "off-branch IDs rejected");
	branch.mock.restore(); leaf.mock.restore();
	await host.command("timing retry a3");
	await tick();
	await host.command("speed 1.5");
	calls.at(-1)!.resolve(result);
	await tick();
	assert.equal(snapshots().length, initial + 1, "changed render identity fences results");
	await host.command("speed 1");
	await host.command("timing retry a3");
	await tick();
	const retired = calls.at(-1)!;
	await host.emit("session_start", { type: "session_start" });
	assert.equal(retired.signal?.aborted, true);
	retired.resolve(result);
	await tick();
	assert.equal(snapshots().length, initial + 1, "session replacement fences old callbacks");
	await host.command("timing retry a3");
	await tick();
	await host.shutdown();
	assert.equal(calls.at(-1)!.signal?.aborted, true);
	calls.at(-1)!.resolve(result);
	await tick();
	assert.equal(snapshots().length, initial + 1);
});

for (const improved of [true, false]) test(`paused retry preserves playback and accepts pending CTC after an unimproved retry (${improved})`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-retry-paused-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") };
	const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local", timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "paused-retry");
	t.after(async () => {
		await host.shutdown(); mock.restoreAll(); RetryWorker.allowPlayback = false;
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("u", null, { role: "user", content: "Speak", timestamp: 1 });
	await host.start();
	RetryWorker.allowPlayback = true;
	await streamCompletedResponse(host, "a", "u", "Alpha beta.");
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const segment = worker.sent.at(-1) as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", utterance: segment.utterance, segmentId: segment.segmentId, start: 0, duration: 2, timingQuality: "estimated" });
	worker.emit({ type: "playback", utterance: segment.utterance, position: 0.5 });
	await host.shortcut("f8");
	RetryWorker.allowPlayback = false;
	await new Promise(resolve => setTimeout(resolve, 100));
	const frozen = host.render("Alpha beta.");
	const line = host.widgetLines()![0];
	const top = host.scrollView.scrollTop;
	assert.match(line, /Paused/);
	mock.method(host.ctx.ui, "setEditorText", () => assert.fail("retry changed draft"));
	const count = calls.length;
	await host.command("timing retry current");
	await tick();
	assert.equal(calls.length, count + 1);
	calls.at(-1)!.resolve(improved ? result : { ...result, quality: "estimated",
		words: result.words.map(word => ({ ...word, quality: "estimated" })) });
	await tick();
	assert.equal(host.render("Alpha beta."), frozen);
	assert.equal(host.widgetLines()![0], line);
	assert.equal(host.scrollView.scrollTop, top);
	const snapshot = host.entries.filter(entry => entry.customType === "pi-voice.playback-timing").at(-1)!.data;
	assert.deepEqual(snapshot.units[0].coverage, { estimated: improved ? 0 : 2, total: 2 });
	if (!improved) {
		worker.emit({ type: "alignment", segmentId: segment.segmentId, quality: "ctc-refined", words: result.words });
		worker.emit({ type: "idle", utterance: segment.utterance });
		const accepted = host.entries.filter(entry => entry.customType === "pi-voice.playback-timing").at(-1)!.data;
		assert.equal(accepted.units[0].checkpoints[0].quality, "ctc-refined");
		assert.deepEqual(accepted.units[0].coverage, { estimated: 0, total: 2 });
		assert.equal(host.render("Alpha beta."), frozen);
		assert.equal(host.scrollView.scrollTop, top);
		assert.match(host.widgetLines()![0], /Paused/);
		return;
	}
	worker.emit({ type: "alignment", segmentId: segment.segmentId, quality: "estimated", words: [
		{ text: "Alpha", start: 0, end: 1, quality: "estimated" },
		{ text: "beta", start: 1.5, end: 2, quality: "estimated" },
	] });
	worker.emit({ type: "alignment-error", segmentId: segment.segmentId, quality: "estimated", message: "late original failure" });
	worker.emit({ type: "idle", utterance: segment.utterance });
	const idle = host.entries.filter(entry => entry.customType === "pi-voice.playback-timing").at(-1)!.data;
	assert.deepEqual(idle.checkpoints, snapshot.checkpoints, "late original alignment cannot downgrade retry timing");
	assert.deepEqual(idle.units, snapshot.units, "idle persists refined words and their measured coverage");
	const restored = new PlaybackHistory();
	restored.sync([{ id: idle.messageId, text: "Alpha beta.", renderKey: idle.renderKey }]);
	restored.restore(JSON.parse(JSON.stringify([idle])));
	assert.deepEqual(restored.status()?.wordTimingCoverage, { estimated: 0, total: 2 });
	assert.equal(host.modelRequests.length, 0);
});
