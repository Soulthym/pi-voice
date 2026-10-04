import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { DeviceRouter } from "../src/device-router.js";
import { PhoneInputClient, type PhoneCapture } from "../src/phone-input.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve)); };
const segments = (worker: MockedVoiceWorkerClient) => worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
const notices = (worker: MockedVoiceWorkerClient) => segments(worker).filter(segment => segment.text.includes("requires attention next"));

async function fixture(t: test.TestContext, input = false) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-loan-"));
	for (const [key, value] of Object.entries({ PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") })) {
		const old = process.env[key]; process.env[key] = value;
		t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
	}
	await fs.mkdir(process.env.PI_VOICE_DEVICE_DIR!, { recursive: true });
	const endpoint = `unix://${root}/output`;
	await fs.writeFile(path.join(root, "output"), "");
	await fs.writeFile(path.join(process.env.PI_VOICE_DEVICE_DIR!, "shared.json"), JSON.stringify({ version: 1, id: "shared", name: "Shared output", platform: "termux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 1, lastActive: 1 }));
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "shared" }));
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode: "assistant", output: "auto", input: input ? "auto" : "disabled", timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(path.join(root, "idle"), "idle");
	let owner: SessionCoordinator | undefined;
	const start = SessionCoordinator.prototype.start;
	t.mock.method(SessionCoordinator.prototype, "start", function(this: SessionCoordinator) { start.call(this); if (this.sessionId === "idle") owner = this; });
	await host.start(); const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const waiting = new SessionCoordinator(path.join(root, "waiting"), "waiting");
	waiting.start(); waiting.markWaiting({ kind: "device", id: "shared" });
	t.after(async () => { await host.shutdown(); waiting.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
	await new Promise(resolve => setTimeout(resolve, 300)); await settle();
	assert.equal(notices(worker).length, 1);
	assert.equal(waiting.speechOwner()?.instanceId, owner!.instanceId);
	return { host, worker, waiting, owner: owner!, endpoint, notice: notices(worker)[0]! };
}

for (const receipt of [false, true]) test(`manual selection returns notification-only loan after stop proof (retained receipt=${receipt})`, async t => {
	const stopped = Promise.withResolvers<void>();
	t.after(() => stopped.resolve());
	const { host, worker, waiting, owner, endpoint, notice } = await fixture(t);
	const lease = waiting.speechOwner()!;
	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	if (receipt) worker.emit({ type: "remote-handle", output: endpoint, id, utterance: notice.utterance });
	const terminate = t.mock.method(worker, "terminate", () => stopped.promise);
	const selection = host.command("device local"); await settle();
	assert.ok(terminate.mock.callCount() > 0, "selection must stop the original worker");
	assert.equal(waiting.tryAcquireSpeech(), false, "foreign project cannot acquire while shutdown is pending");
	assert.equal(waiting.speechOwner()?.speechGeneration, lease.speechGeneration);
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, false, "cancelled EOF cannot acknowledge the request");
	stopped.resolve(); await selection; await settle();
	if (receipt) {
		assert.equal(waiting.tryAcquireSpeech(), false, "worker termination is not the retained scope's receipt");
		worker.emit({ type: "remote-released", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }); await settle();
		assert.equal(waiting.speechOwner()?.instanceId, owner.instanceId);
		worker.emit({ type: "remote-released", id }); await settle();
	}
	assert.equal(waiting.tryAcquireSpeech(), true, "a legitimate foreign acquisition succeeds after all stop proof");
	assert.equal(waiting.speechOwner()?.instanceId, waiting.instanceId);
	assert.equal(segments(worker).length, 1, "selection never starts user audio");
	assert.equal(waiting.waitingSessions()[0]!.announced, false);
	assert.ok(!host.widgetLines()?.join(" ").includes("Paused"), "notification cancellation cannot restore an old pause state");
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	assert.equal(waiting.speechOwner()?.instanceId, waiting.instanceId, "late notification completion cannot release the foreign owner");
});

for (const action of ["off", "reconnect", "speed 1.2"] as const) test(`${action} also returns a cancelled idle notification loan`, async t => {
	const { host, worker, waiting, notice } = await fixture(t);
	const stopped = Promise.withResolvers<void>();
	const terminate = t.mock.method(worker, "terminate", () => stopped.promise);
	const cancelling = host.command(action); await settle();
	try {
		for (let i = 0; i < 100 && !terminate.mock.callCount(); i++) await new Promise(resolve => setTimeout(resolve, 10));
		assert.ok(terminate.mock.callCount() > 0);
		assert.equal(waiting.tryAcquireSpeech(), false);
	} finally { stopped.resolve(); }
	await cancelling; await settle();
	assert.equal(waiting.tryAcquireSpeech(), true, "shared cancellation releases only after shutdown");
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, false);
	assert.equal(waiting.speechOwner()?.instanceId, waiting.instanceId);
});

for (const action of ["device local", "reconnect"] as const) test(`${action}: cancelled loan cannot release a newer durable generation of the same coordinator`, async t => {
	const stopped = Promise.withResolvers<void>();
	t.after(() => stopped.resolve());
	let terminate: ReturnType<typeof t.mock.method>;
	t.after(() => terminate?.mock.restore());
	const { host, worker, waiting, owner } = await fixture(t);
	const original = owner.speechOwner()!;
	let replacement: string | undefined;
	terminate = t.mock.method(worker, "terminate", async () => {
		await stopped.promise;
		// The inert worker has stopped; use real coordinator APIs, never rewrite a lease file.
		owner.releaseSpeech();
		assert.equal(owner.tryAcquireSpeech(), true);
		replacement = owner.speechOwner()!.speechGeneration;
	});
	const selection = host.command(action); await settle();
	assert.ok(terminate.mock.callCount() > 0);
	assert.equal(waiting.tryAcquireSpeech(), false, "replacement happens only after the original fixture stops");
	stopped.resolve(); await selection; await settle();
	assert.notEqual(replacement, original.speechGeneration);
	assert.equal(owner.speechOwner()?.speechGeneration, replacement);
	assert.equal(waiting.tryAcquireSpeech(), false, "old cancellation cannot release a replacement with the same instance ID");
	terminate.mock.restore();
});

for (const action of ["device local", "reconnect"] as const) test(`${action}: rejected loan shutdown retains ownership through wrong receipt until correct recovery`, async t => {
	const stopped = Promise.withResolvers<void>();
	const recovered = Promise.withResolvers<void>();
	t.after(() => { stopped.resolve(); recovered.resolve(); });
	const { host, worker, waiting, owner, endpoint, notice } = await fixture(t);
	const lease = owner.speechOwner()!;
	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	worker.emit({ type: "remote-handle", output: endpoint, id, utterance: notice.utterance });
	const terminate = t.mock.method(worker, "terminate", () => stopped.promise);
	const cancelling = host.command(action); await settle();
	assert.ok(terminate.mock.callCount() > 0);
	stopped.reject(new Error("Synthetic notification stop failure"));
	await cancelling; await settle();
	assert.equal(waiting.tryAcquireSpeech(), false, "rejected shutdown is not stop proof");
	assert.equal(owner.speechOwner()?.speechGeneration, lease.speechGeneration);
	worker.emit({ type: "idle", utterance: notice.utterance });
	worker.emit({ type: "remote-released", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }); await settle();
	assert.equal(owner.recovery.episode("output")?.handles[0]?.id, id, "wrong receipt cannot retire the original scope");
	assert.equal(waiting.tryAcquireSpeech(), false);
	assert.equal(waiting.waitingSessions()[0]!.announced, false, "cancelled completion cannot acknowledge the notice");
	terminate.mock.mockImplementation(() => recovered.promise);
	const attempts = terminate.mock.callCount();
	const reconnecting = host.command("reconnect"); await settle();
	assert.ok(terminate.mock.callCount() > attempts, "recovery retries the stopped worker");
	worker.emit({ type: "remote-released", id }); await settle();
	assert.equal(waiting.tryAcquireSpeech(), false, "matching receipt still needs successful worker termination");
	recovered.resolve(); await reconnecting; await settle();
	assert.equal(waiting.tryAcquireSpeech(), true, "correct receipt and recovered termination return the loan");
	assert.equal(segments(worker).length, 1, "recovery never starts user audio");
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, false);
	assert.equal(waiting.speechOwner()?.instanceId, waiting.instanceId);
	terminate.mock.restore();
});

test("superseded notification completion returns its loan even when selection failed before cancellation", async t => {
	const stopped = Promise.withResolvers<void>();
	t.after(() => stopped.resolve());
	const { host, worker, waiting, notice } = await fixture(t);
	const metadata = DeviceRouter.prototype.routeMetadata;
	t.mock.method(DeviceRouter.prototype, "routeMetadata", function(this: DeviceRouter, ...args: Parameters<DeviceRouter["routeMetadata"]>) {
		if (args[0] === "local") throw new Error("Synthetic route failure");
		return metadata.apply(this, args);
	});
	await host.command("device local"); await settle();
	const terminate = t.mock.method(worker, "terminate", () => stopped.promise);
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	assert.ok(terminate.mock.callCount() > 0);
	assert.equal(waiting.tryAcquireSpeech(), false);
	stopped.resolve(); await settle();
	assert.equal(waiting.tryAcquireSpeech(), true);
	assert.equal(waiting.waitingSessions()[0]!.announced, false, "superseded delivery cannot acknowledge waiting");
});

for (const takeover of ["playback", "input"] as const) test(`late notification cancellation never releases active user ${takeover}`, async t => {
	const capture = Promise.withResolvers<PhoneCapture>();
	const stopped = Promise.withResolvers<void>();
	t.after(() => { stopped.resolve(); capture.resolve({ type: "text", data: "" }); });
	const record = t.mock.method(PhoneInputClient.prototype, "capture", () => capture.promise);
	t.mock.method(PhoneInputClient.prototype, "cancel", async () => {});
	t.mock.method(DeviceRouter.prototype, "route", async function(this: DeviceRouter, ...args: Parameters<DeviceRouter["route"]>) { return this.routeMetadata(...args); });
	const { host, worker, waiting, owner, notice } = await fixture(t, takeover === "input");
	if (takeover === "playback") {
		await host.shortcut("f8");
		assert.equal(worker.pauses.at(-1), true, "the old notification was explicitly paused");
	}
	waiting.clearWaiting();
	host.addMessage("user-target", null, assistant("Explicit user playback."));
	t.mock.method(worker, "terminate", () => stopped.promise);
	const selection = host.command("device shared"); await settle();
	const action = host.shortcut(takeover === "input" ? "f4" : "f5"); await settle();
	assert.equal(waiting.tryAcquireSpeech(), false, "takeover must still wait for original stop proof");
	stopped.resolve(); await selection; await action; await settle();
	if (takeover === "input") assert.equal(record.mock.callCount(), 1);
	else assert.ok(segments(worker).some(segment => segment.text === "Explicit user playback."));
	const lease = owner.speechOwner()!;
	assert.equal(lease.instanceId, owner.instanceId);
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	assert.equal(owner.speechOwner()?.speechGeneration, lease.speechGeneration);
	assert.equal(waiting.tryAcquireSpeech(), false, "active user transport still owns its lease");
	if (takeover === "playback") assert.equal(worker.pauses.at(-1), false, "late cancellation cannot restore the old notification's pause");
	capture.resolve({ type: "text", data: "" }); await settle();
});
