import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { PhoneInputClient, type PhoneCapture } from "../src/phone-input.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant, streamBlockedResponse } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const tick = () => new Promise(resolve => setTimeout(resolve, 250));
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

async function lifecycleHost(t: import("node:test").TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-lifecycle-regression-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
	for (const name of names) process.env[name] = path.join(root, name);
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, input: "local", output: "local", audioCache: false, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "lifecycle");
	const observer = new SessionCoordinator(path.join(root, "observer"), "observer");
	observer.start();
	const index = MockedVoiceWorkerClient.instances.length;
	t.after(async () => {
		await host.shutdown(); observer.shutdown(); mock.restoreAll();
		for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("a", null, assistant("Replay this response."));
	await host.start();
	return { host, observer, worker: MockedVoiceWorkerClient.instances[index]! };
}

const delta = (host: FakeVoiceHost, text: string) => host.emit("message_update", {
	message: assistant(text, "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
});

test("Stop and session replacement fence pending test/replay and suppress attention until fresh work", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-lifecycle-"));
	const env = { ...process.env };
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(path.join(root, "project"), "project");
	const owner = new SessionCoordinator(path.join(root, "other"), "other");
	owner.start();
	t.after(async () => {
		await host.shutdown(); owner.shutdown(); mock.restoreAll();
		for (const key of ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"]) {
			if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("a", null, assistant("This project's response."));
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	await host.start();
	const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
	for (const action of ["test Obsolete test.", "attention"]) {
		for (const lifecycle of ["stop", "reload", "shutdown"]) {
			owner.tryAcquireSpeech();
			let release!: (value: boolean) => void;
			const delayed = mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", () => new Promise<boolean>(resolve => { release = resolve; }));
			const pending = host.command(action);
			await new Promise(resolve => setImmediate(resolve));
			assert.ok(release);
			if (lifecycle === "stop") await host.command("stop");
			else if (lifecycle === "reload") await host.emit("session_start", {});
			else await host.shutdown();
			release(true);
			await pending;
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(worker.sent.length, 0, `${action} survived ${lifecycle}`);
			delayed.mock.restore();
			if (lifecycle === "shutdown") await host.emit("session_start", {});
		}
	}
	owner.releaseSpeech();
	owner.markWaiting();
	await host.command("stop");
	await tick();
	assert.equal(worker.sent.length, 0, "Stop must suppress the announcement poll");
	await host.command("off"); await host.command("on"); await tick();
	assert.equal(worker.sent.length, 0, "enable must not revive Stop-cancelled work");
	await host.shortcut("f11");
	await tick();
	assert.match(JSON.stringify(worker.sent), /This project's response/);
	assert.equal(owner.hasAttentionRequest(), false, "replay must not route to the waiting project");
});

test("disabled waiting sessions leave the queue and re-enable only outstanding attention", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-enable-"));
	const env = { ...process.env };
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0 }));
	const owner = new SessionCoordinator(path.join(root, "owner"), "owner"); owner.start(); owner.tryAcquireSpeech();
	const host = new FakeVoiceHost(path.join(root, "project"), "project");
	t.after(async () => {
		await host.shutdown(); owner.shutdown();
		for (const key of ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"]) {
			if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	await streamBlockedResponse(host, "Waiting response.");
	assert.equal(owner.waitingSessions().length, 1);
	await host.command("off"); assert.equal(owner.waitingSessions().length, 0);
	await host.command("on"); assert.equal(owner.waitingSessions().length, 1);
	await host.command("off");
	await host.emit("input", { text: "Handled that response" });
	await host.command("on"); assert.equal(owner.waitingSessions().length, 0, "a new prompt handles the disabled session's old wait");
	await streamBlockedResponse(host, "A genuinely new waiting response.");
	assert.equal(owner.waitingSessions().length, 1);
	await host.command("stop"); await host.command("off"); await host.command("on");
	assert.equal(owner.waitingSessions().length, 0);
});


test("shutdown retains the lease until both microphone and player terminate", async t => {
	const { host, observer, worker } = await lifecycleHost(t);
	const mic = Promise.withResolvers<void>();
	const player = Promise.withResolvers<void>();
	mock.method(PhoneInputClient.prototype, "cancel", () => mic.promise);
	mock.method(worker, "terminate", () => player.promise);
	await host.shortcut("f11"); await settle();
	assert.ok(observer.speechOwner());
	const shutdown = host.shutdown(); await settle();
	try {
		assert.ok(observer.speechOwner(), "lease must outlive shutdown request");
		player.resolve(); await settle();
		assert.ok(observer.speechOwner(), "microphone must also acknowledge");
		mic.resolve(); await shutdown;
		assert.equal(observer.speechOwner(), undefined);
	} finally {
		player.resolve(); mic.resolve(); await shutdown;
	}
});

test("double microphone tap during replay releases only the cancelled lease after player ack", async t => {
	const { host, observer, worker } = await lifecycleHost(t);
	const capture = mock.method(PhoneInputClient.prototype, "capture", async (): Promise<PhoneCapture> => ({ type: "text", data: "" }));
	await host.shortcut("f11"); await settle();
	mock.method(worker, "cancel", () => 501 as never);
	await host.command("talk"); await settle();
	await host.command("talk"); await settle();
	assert.ok(observer.speechOwner());
	worker.emit({ type: "idle", cancelId: 501 }); await settle();
	assert.equal(observer.speechOwner(), undefined);
	assert.equal(capture.mock.callCount(), 0);
	await host.shortcut("f11"); await settle();
	await host.command("talk"); await settle();
	await host.command("stop");
	await host.shortcut("f11"); await settle();
	worker.emit({ type: "idle", cancelId: 501 }); await settle();
	assert.ok(observer.speechOwner(), "late acknowledgement must not release newer replay");
});

test("STT model and dtype changes drain capture and release its reservation", async t => {
	const { host, observer } = await lifecycleHost(t);
	for (const setting of ["stt-model test/model", "stt-dtype fp32"]) {
		const capture = Promise.withResolvers<PhoneCapture>();
		const stopped = Promise.withResolvers<void>();
		mock.method(PhoneInputClient.prototype, "capture", () => capture.promise);
		const cancel = mock.method(PhoneInputClient.prototype, "cancel", () => stopped.promise);
		await host.command("talk"); await settle();
		assert.ok(observer.speechOwner());
		const change = host.command(setting); await settle();
		assert.ok(observer.speechOwner(), "do not release before capture stop");
		stopped.resolve(); capture.resolve({ type: "text", data: "" }); await change; await settle();
		assert.equal(observer.speechOwner(), undefined);
		cancel.mock.restore();
	}
});

test("explicit dirty-stream resume preserves prefix and future deltas in order", async t => {
	const { host, worker } = await lifecycleHost(t);
	await host.emit("message_start", { message: assistant("", "pending") });
	await delta(host, "First sentence. "); await settle();
	await host.command("speed 1.2");
	await delta(host, "Second sentence. ");
	const before = worker.sent.length;
	const sent = mock.method(worker, "sendSegment");
	await host.shortcut("f8"); await settle();
	await delta(host, "Third sentence.");
	const complete = assistant("First sentence. Second sentence. Third sentence.");
	host.addMessage("b", "a", complete);
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete }); await settle();
	assert.ok(sent.mock.calls.length > 0);
	for (const call of sent.mock.calls) assert.equal((call.arguments as unknown as [number, number, string, { speed: number }])[3].speed, 1.2);
	const texts = worker.sent.slice(before).map(value => (value as { text: string }).text).join(" ");
	for (const sentence of ["First sentence.", "Second sentence.", "Third sentence."]) assert.equal(texts.split(sentence).length - 1, 1, texts);
	assert.ok(texts.indexOf("First") < texts.indexOf("Second") && texts.indexOf("Second") < texts.indexOf("Third"), texts);
});

test("TTS changes during microphone-only ownership do not sticky-pause the submitted response", async t => {
	const { host, worker } = await lifecycleHost(t);
	const capture = Promise.withResolvers<PhoneCapture>();
	mock.method(PhoneInputClient.prototype, "capture", () => capture.promise);
	await host.command("talk"); await settle();
	await host.command("speed 1.2");
	assert.notEqual(worker.pauses.at(-1), true);
	capture.resolve({ type: "text", data: "" }); await settle();
	await host.emit("input", { text: "Prompt" });
	await host.emit("before_agent_start", {});
	await streamBlockedResponse(host, "Audible submitted response."); await settle();
	assert.match(JSON.stringify(worker.sent), /Audible submitted response/);
	assert.notEqual(worker.pauses.at(-1), true);
});

for (const idleBeforeResume of [true, false]) test(`resuming paused attention drains queued response (idle before resume: ${idleBeforeResume})`, async t => {
	const { host, observer, worker } = await lifecycleHost(t);
	await host.shortcut("f11"); await settle();
	observer.markWaiting();
	worker.emit({ type: "idle", utterance: (worker.sent.at(-1) as { utterance: number }).utterance }); await settle();
	assert.match(JSON.stringify(worker.sent.at(-1)), /requires attention/);
	const notification = (worker.sent.at(-1) as { utterance: number }).utterance;
	await host.shortcut("f8");
	await streamBlockedResponse(host, "Queued unheard response.");
	if (idleBeforeResume) worker.emit({ type: "idle", utterance: notification });
	const before = worker.sent.length;
	await host.shortcut("f8"); await settle();
	if (!idleBeforeResume) worker.emit({ type: "idle", utterance: notification });
	await settle();
	assert.match(JSON.stringify(worker.sent.slice(before)), /Queued unheard response/);
});
