import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant, streamCompletedResponse } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test("sticky pause queues new responses; settings preserve ownership and dirty assets require one explicit resume", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-ownership-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local", audioCache: false }));
	const host = new FakeVoiceHost(root, "owner");
	let status = "";
	host.ctx.ui.setStatus = (_key: string, text: string) => { status = text; };
	const observer = new SessionCoordinator(path.join(root, "other"), "other"); observer.start();
	t.after(async () => {
		await host.shutdown(); observer.shutdown();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("first", null, assistant("First sentence. Second sentence."));
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	await host.start(); await host.shortcut("f11"); await settle();
	const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
	const segments = worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
	const first = segments.find(segment => segment.text === "First sentence.")!;
	const ownerId = observer.speechOwner()!.instanceId;
	worker.emit({ type: "speaking" });
	for (const command of ["highlight off", "autoscroll off", "input local", "stt-model test/mic", "stt-dtype q8", "edit-model other/model"]) {
		const pauses = worker.pauses.length;
		await host.command(command);
		assert.match(status, /speaking/, command);
		assert.equal(worker.pauses.length, pauses, command);
		assert.equal(observer.speechOwner()?.instanceId, ownerId, command);
	}
	await host.shortcut("f8");
	assert.equal(worker.pauses.at(-1), true);
	const before = segments.length;
	observer.markWaiting();
	await streamCompletedResponse(host, "second", "first", "Queued response.");
	assert.equal(segments.length, before, "incoming response stays silent while paused");
	assert.equal(worker.pauses.at(-1), true);
	assert.match(host.widgetLines()?.join(" ") ?? "", /⏸.*message 1\/2/);
	assert.equal(observer.speechOwner()?.instanceId, ownerId);
	await host.shortcut("f8");
	assert.equal(worker.pauses.at(-1), false);
	worker.emit({ type: "idle", utterance: first.utterance }); await settle();
	assert.equal(segments.at(-1)?.text, "Queued response.", "resume drains queued project responses before announcements");
	assert.equal(segments.some(segment => segment.text.includes("requires attention next")), false);
	worker.emit({ type: "idle", utterance: segments.at(-1)!.utterance }); await settle();
	assert.ok(segments.at(-1)?.text.includes("requires attention next"));

	await host.shortcut("f11"); await settle();
	for (const command of ["voice af_bella", "speed 1.2", "tts-model test/tts", "tts-dtype fp32"]) {
		worker.emit({ type: "speaking" });
		const count = segments.length;
		const pending = host.command(command);
		assert.equal(worker.pauses.at(-1), true, `dirty pause must precede config persistence: ${command}`);
		await pending; await settle();
		assert.equal(segments.length, count, "new assets must not auto-restart playback");
		assert.equal(observer.speechOwner()?.instanceId, ownerId);
		await host.shortcut("f8"); await settle();
		assert.equal(worker.pauses.at(-1), false, "one resume recreates an unpaused sink");
		assert.ok(segments.length > count);
	}
	await host.shortcut("f8");
	await host.shortcut("f6"); await settle();
	assert.equal(worker.pauses.at(-1), true, "message navigation retains pause");
	await host.shortcut("f9"); await settle();
	assert.equal(worker.pauses.at(-1), true, "sentence navigation retains pause");
	await host.shortcut("f11"); await settle();
	assert.equal(worker.pauses.at(-1), false, "explicit replay exits tail/paused state");
	observer.clearWaiting();
	await host.shortcut("f10"); await settle();
	worker.emit({ type: "idle", utterance: segments.at(-1)!.utterance }); await settle();
	await host.shortcut("f10");
	const completed = segments.length;
	await host.shortcut("f8"); await settle();
	assert.ok(segments.length > completed, "resume from completed tail recreates playback in one action");
	assert.equal(worker.pauses.at(-1), false);
});
