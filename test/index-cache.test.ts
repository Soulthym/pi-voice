import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

async function setup(t: TestContext, timing: number, respond?: () => Promise<any>) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-cache-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local",
		audioCache: false, codeNarration: "summary", codeDescriptionContext: "block-only",
		codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: timing }));
	MockedVoiceWorkerClient.instances.length = 0;
	const host = new FakeVoiceHost(path.join(root, "project"), "cache", respond);
	t.after(async () => {
		await host.shutdown().catch(() => {});
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	return host;
}

test("cold replay adopts the resolved plan without pausing on later settings or sweeps", async t => {
	let resolve!: (value: any) => void;
	const response = new Promise<any>(done => { resolve = done; });
	const host = await setup(t, 0, () => response);
	host.addMessage("answer", null, assistant("Before.\n```ts\nrun();\n```\nAfter."));
	await host.start(); await host.shortcut("f11"); await settle();
	assert.equal(host.modelRequests.length, 1);
	resolve(assistant("A contextual description.")); await settle();
	const worker = MockedVoiceWorkerClient.instances.find(worker => worker.sent.length)!;
	const sent = (worker.sent as Array<{ utterance: number; segmentId: number; text: string }>).filter(segment => segment.text !== "Project project.");
	assert.ok(sent.some(segment => segment.text.includes("A contextual description")), JSON.stringify({ sent, notices: host.notices, entries: host.entries }));
	const pauses = worker.pauses.length;
	await host.command("autoscroll off"); await host.emit("agent_settled", {}); await settle();
	assert.ok(!worker.pauses.slice(pauses).includes(true), "first plan resolution is not dirty playback");
	const utterance = sent[0].utterance;
	sent.forEach((segment, i) => worker.emit({ type: "segment-audio", utterance, segmentId: segment.segmentId, start: i, duration: 1 }));
	worker.emit({ type: "idle", utterance }); await settle();
	assert.ok(host.entries.some(entry => entry.customType === "pi-voice.playback-timing"), "resolved capture remains persistable");
	await host.shortcut("f11"); await settle();
	const beforeDirty = worker.pauses.length;
	await host.command("speed 1.2"); await settle();
	assert.ok(worker.pauses.slice(beforeDirty).includes(true), "changing an already-used render still pauses");
	assert.equal(host.modelRequests.length, 1);
});

test("local context-overflow fallback has a stable identity and retains prose timings without retry", async t => {
	const measured: string[] = [];
	const original = MockedVoiceWorkerClient.prototype.measureSegment;
	MockedVoiceWorkerClient.prototype.measureSegment = async function (this: MockedVoiceWorkerClient, ...args: any[]) {
		measured.push(args[0]); return 1;
	};
	t.after(() => { MockedVoiceWorkerClient.prototype.measureSegment = original; });
	const host = await setup(t, 1);
	host.model.contextWindow = 1;
	host.addMessage("answer", null, assistant("Before.\n```ts\nrun();\n```\nAfter."));
	await host.start(); await new Promise(resolve => setTimeout(resolve, 100)); await settle();
	assert.ok(measured.includes("Before.") && measured.includes("After."), JSON.stringify(measured));
	assert.ok(measured.length >= 3, "local code fallback is measured too");
	const snapshots = () => host.entries.filter(entry => entry.customType === "pi-voice.playback-timing");
	assert.equal(snapshots().length, 1);
	const count = measured.length;
	await host.emit("agent_settled", {}); await host.command("autoscroll off"); await settle();
	await host.shortcut("f11"); await settle();
	assert.equal(measured.length, count);
	assert.equal(host.modelRequests.length, 0);
	assert.equal(host.notices.filter(notice => notice.message.includes("insufficient context")).length, 1);
	assert.equal(snapshots().length, 1);
});
