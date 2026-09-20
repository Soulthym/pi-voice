import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { DeviceRouter } from "../src/device-router.js";
import { PhoneInputClient, type PhoneCapture } from "../src/phone-input.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
async function setup(t: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-attention-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = names.map(name => process.env[name]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local",
		codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "origin");
	host.addMessage("answer", null, assistant("Origin answer."));
	const waiting = new SessionCoordinator(path.join(root, "other"), "waiting");
	await host.start();
	waiting.start(); waiting.markWaiting(); waiting.markAnnounced(waiting.instanceId);
	t.after(async () => {
		await host.shutdown(); waiting.shutdown();
		names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	return { root, host, waiting };
}

test("attention requests the eligible waiting project with fresh origin identity; F11 stays own", async t => {
	const { host, waiting } = await setup(t);
	const resolve = mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "fresh-phone" }));
	t.after(() => resolve.mock.restore());
	await host.shortcut("f11"); await settle();
	assert.equal(waiting.hasAttentionRequest(), false);
	await host.command("attention");
	const request = waiting.takeAttentionRequest();
	assert.deepEqual(request?.connection, { kind: "device", id: "fresh-phone" });
	assert.equal(waiting.attentionRequestIsCurrent(request!), true);
	await host.command("stop");
	assert.equal(waiting.attentionRequestIsCurrent(request!), false);
	await host.command("attention");
	const next = waiting.takeAttentionRequest()!;
	await host.shortcut("f8");
	assert.equal(waiting.attentionRequestIsCurrent(next), false);
});

test("attention fails closed when fresh origin attachment cannot be resolved", async t => {
	const { host, waiting } = await setup(t);
	const resolve = mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => { throw new Error("No attached tmux client"); });
	t.after(() => resolve.mock.restore());
	await host.command("attention");
	assert.equal(waiting.hasAttentionRequest(), false);
	assert.ok(host.notices.some(n => n.message.includes("No attached tmux client")));
});

test("coordinator rejects cancelled, disabled and stale attention requests", async t => {
	const { waiting, root } = await setup(t);
	const sender = new SessionCoordinator(root, "sender"); sender.start();
	t.after(() => sender.shutdown());
	sender.requestAttention(waiting.instanceId, { kind: "intentional_local" });
	sender.cancelSpeechAcquisition();
	assert.equal(waiting.takeAttentionRequest(), undefined);
	sender.requestAttention(waiting.instanceId, { kind: "intentional_local" });
	waiting.setAttentionEnabled(false);
	assert.equal(waiting.takeAttentionRequest(), undefined);
	waiting.setAttentionEnabled(true); waiting.markWaiting();
	sender.requestAttention(waiting.instanceId, { kind: "intentional_local" });
	const request = waiting.takeAttentionRequest()!;
	assert.equal(waiting.attentionRequestIsCurrent({ ...request, requestedAt: Date.now() - 9000 }), false);
	assert.equal(waiting.attentionRequestIsCurrent(request), true);
});

for (const newer of ["stop", "attention"]) test(`newer ${newer} supersedes origin identity wait`, async t => {
	const { host, waiting } = await setup(t);
	let finish!: (value: { kind: "intentional_local" }) => void;
	let calls = 0;
	const resolve = mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => ++calls === 1
		? new Promise<{ kind: "intentional_local" }>(r => { finish = r; }) : Promise.resolve({ kind: "intentional_local" as const }));
	t.after(() => resolve.mock.restore());
	const first = host.command("attention"); await settle();
	await host.command(newer);
	const latest = waiting.takeAttentionRequest();
	finish({ kind: "intentional_local" }); await first;
	assert.equal(waiting.hasAttentionRequest(), false);
	assert.equal(!!latest, newer === "attention");
});

test("attention does not publish before confirmed player stop", async t => {
	const { host, waiting } = await setup(t);
	await host.shortcut("f11"); await settle();
	let stopped!: () => void;
	const terminate = mock.method(MockedVoiceWorkerClient.prototype, "terminate", () => new Promise<void>(r => { stopped = r; }));
	const resolve = mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
	t.after(() => { terminate.mock.restore(); resolve.mock.restore(); });
	const pending = host.command("attention"); await settle();
	assert.equal(waiting.hasAttentionRequest(), false);
	assert.notEqual(waiting.speechOwner(), undefined);
	stopped(); await pending;
	terminate.mock.restore();
	assert.equal(waiting.hasAttentionRequest(), true);
});

test("attention finalizes capture into the editor before requesting, without submission", async t => {
	const { host, waiting } = await setup(t);
	await host.command("input local");
	await host.command("submit auto");
	let editor = "";
	host.ctx.ui.getEditorText = () => editor;
	host.ctx.ui.setEditorText = (text: string) => { editor = text; };
	const submitted = mock.method(host.api, "sendUserMessage", () => {});
	const capture = Promise.withResolvers<PhoneCapture>();
	const recording = mock.method(PhoneInputClient.prototype, "capture", () => capture.promise);
	const stop = mock.method(PhoneInputClient.prototype, "stop", async () => {});
	const resolve = mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
	t.after(() => { recording.mock.restore(); stop.mock.restore(); resolve.mock.restore(); });
	await host.command("talk"); await settle();
	const pending = host.command("attention"); await settle();
	assert.equal(stop.mock.callCount(), 1);
	assert.equal(waiting.hasAttentionRequest(), false);
	capture.resolve({ type: "text", data: "Keep this draft." });
	await pending;
	assert.match(editor, /Keep this draft/);
	assert.equal(submitted.mock.callCount(), 0);
	assert.equal(waiting.hasAttentionRequest(), true);
});

test("disabled attention does not request another project", async t => {
	const { host, waiting } = await setup(t);
	await host.command("off"); await host.command("attention");
	assert.equal(waiting.hasAttentionRequest(), false);
	assert.ok(host.notices.some(n => n.message === "Voice mode is disabled"));
});

for (const cancelled of [false, true]) test(`waiting receiver adopts only current origin pin without resolving detached attachment (cancelled: ${cancelled})`, async t => {
	const { root, host, waiting } = await setup(t);
	waiting.clearWaiting();
	const receiver = new FakeVoiceHost(path.join(root, "receiver"), "receiver");
	receiver.addMessage("remote-answer", null, assistant("Waiting answer."));
	await receiver.start();
	t.after(() => receiver.shutdown());
	const sessions = waiting.activeSessions();
	const target = sessions.find(session => session.sessionId === "receiver")!;
	await fs.mkdir(path.join(waiting.root, "waiting"), { recursive: true });
	await fs.writeFile(path.join(waiting.root, "waiting", `${target.instanceId}.json`), JSON.stringify({ ...target, waitingSince: Date.now(), announced: true }));
	let calls = 0;
	const resolve = mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => {
		if (++calls > 1) throw new Error("Detached receiver must not resolve attachment");
		return { kind: "device" as const, id: "origin-phone" };
	});
	t.after(() => resolve.mock.restore());
	const acquisition = Promise.withResolvers<void>();
	const original = SessionCoordinator.prototype.forceAcquireSpeech;
	const force = mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", async function (this: SessionCoordinator) {
		if (cancelled) await acquisition.promise;
		return original.call(this);
	});
	t.after(() => force.mock.restore());
	await host.command("attention");
	await new Promise(r => setTimeout(r, 350)); await settle();
	if (cancelled) { await host.command("stop"); acquisition.resolve(); await settle(); }
	assert.equal(calls, 1);
	assert.equal(receiver.entries.some(entry => entry.data?.pin === "origin-phone"), !cancelled);
	if (!cancelled) assert.ok(MockedVoiceWorkerClient.instances.some(worker => worker.sent.some((segment: any) => segment.text === "Waiting answer.")));
	else assert.equal(waiting.speechOwner(), undefined);
	await receiver.shutdown();
});
