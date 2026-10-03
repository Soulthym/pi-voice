import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { DeviceRouter, type VoiceDeviceRegistration } from "../src/device-router.js";
import { DevicePriorityStore } from "../src/device-priorities.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };
const device = (id: string): VoiceDeviceRegistration => ({ version: 1, id, name: id, platform: "linux", connectedAt: 1, lastActive: 1, audioEndpoint: `unix:///fixture/${id}`, inputEndpoint: `unix:///fixture/${id}-input` });

for (const pauseBeforeHandoff of [false, true]) for (const pauseDuringProof of [false, true])
test(`priority handoff of playing A retains independently streaming B until A finishes (pause before: ${pauseBeforeHandoff}, F8 during proof: ${pauseDuringProof})`, async t => {
	const root = await fs.mkdtemp(join(tmpdir(), "priority-streaming-queue-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_DEVICE_DIR", "PI_VOICE_COORDINATOR_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = join(root, "config.json");
	process.env.PI_VOICE_DEVICE_DIR = join(root, "devices");
	process.env.PI_VOICE_COORDINATOR_DIR = join(root, "coordinator");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, output: "auto", input: "disabled", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	new DevicePriorityStore(join(root, "device-priorities.json")).discover([{ id: "d2", date: 1 }, { id: "d3", date: 2 }]);
	let devices = [device("d3")];
	t.mock.method(DeviceRouter.prototype, "connected", () => devices);
	t.mock.method(DeviceRouter.prototype, "resolve", (id: string) => devices.find(d => d.id === id));
	t.mock.method(DeviceRouter.prototype, "claim", () => undefined);
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "d3" }));
	let poll = () => {};
	const interval = globalThis.setInterval;
	t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number, ...args: unknown[]) => {
		if (ms === 1_000) { poll = callback; return interval(() => {}, 100_000); }
		return interval(callback, ms, ...args);
	});
	const host = new FakeVoiceHost(root, "priority-streaming-queue");
	host.addMessage("a", null, assistant("Older answer."));
	const index = MockedVoiceWorkerClient.instances.length;
	const proof = Promise.withResolvers<void>();
	t.after(async () => {
		proof.resolve();
		await host.shutdown();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start(); await settle();
	const worker = MockedVoiceWorkerClient.instances[index];
	await host.shortcut("f5"); await settle();
	assert.equal((worker.sent.at(-1) as any).text, "Older answer.");
	if (pauseBeforeHandoff) {
		await host.shortcut("f8"); await settle();
		assert.equal(worker.pauses.at(-1), true);
	}
	await host.emit("message_start", { message: assistant("", "pending") });
	await host.emit("message_update", { message: assistant("New answer. ", "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "New answer. " } });
	const before = worker.sent.length;
	const termination = t.mock.method(worker, "terminate", () => proof.promise);
	devices = [device("d3"), device("d2")];
	poll(); await settle();
	assert.ok(termination.mock.callCount() > 0, "handoff must await original stop proof");
	assert.equal(worker.sent.length, before, "no admission before original stop proof");
	if (pauseDuringProof) {
		await host.shortcut("f8"); await settle();
		assert.equal(worker.sent.length, before, "F8 must not admit speech during proof");
	}
	proof.resolve(); await settle(); termination.mock.restore();
	assert.equal(host.entries.filter(e => e.customType === "pi-voice.device-selection").at(-1)?.data.selected, "d2");
	if (pauseDuringProof) {
		assert.equal(worker.sent.length, before, "F8 during proof must prevent automatic resume");
	} else if (pauseBeforeHandoff) {
		assert.equal(worker.pauses.at(-1), true, "replacement A must retain paused intent");
	}
	if (pauseBeforeHandoff || pauseDuringProof) {
		await host.shortcut("f8"); await settle();
		assert.equal(worker.pauses.at(-1), false, "explicit F8 resumes A");
	}
	assert.deepEqual((worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text), ["Older answer."]);
	const resumed = worker.sent.at(-1) as { utterance: number };
	const message = assistant("New answer. Later sentence.");
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Later sentence." } });
	host.addMessage("b", "a", message);
	await host.emit("message_end", { message });
	await host.emit("turn_end", { message, toolResults: [] });
	await settle();
	const queued = worker.sent.length;
	assert.equal(queued, before + 1, "B must not interrupt A");
	worker.emit({ type: "idle", utterance: resumed.utterance }); await settle();
	assert.deepEqual((worker.sent.slice(queued) as Array<{ text: string }>).map(s => s.text), ["New answer.", "Later sentence."], "B must drain intact after A reaches EOF");
	const b = worker.sent.at(-1) as { utterance: number };
	worker.emit({ type: "idle", utterance: b.utterance }); await settle();
	assert.deepEqual((worker.sent.slice(before - 1) as Array<{ text: string }>).map(s => s.text), ["Older answer.", "Older answer.", "New answer.", "Later sentence."], "independent B must be spoken exactly once");
});
