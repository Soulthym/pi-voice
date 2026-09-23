import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsSync from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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

test("attention requests the eligible waiting project with fresh origin identity; F5 stays own", async t => {
	const { host, waiting } = await setup(t);
	const resolve = mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "fresh-phone" }));
	t.after(() => resolve.mock.restore());
	await host.shortcut("f5"); await settle();
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

test("attention carries the manual origin pin without resolving ambiguous attachments", async t => {
	const { root, host, waiting } = await setup(t);
	await fs.mkdir(path.join(root, "devices"));
	const available = path.join(root, "available");
	await fs.writeFile(available, "");
	await fs.writeFile(path.join(root, "devices", "manual.json"), JSON.stringify({ version: 1, id: "manual", name: "Linux Mint PC",
		platform: "linux", audioEndpoint: `unix://${available}`, inputEndpoint: `unix://${available}`, connectedAt: 1, lastActive: 1 }));
	const resolve = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => { throw new Error("Multiple attached clients"); });
	await host.command('device "Linux Mint PC"');
	await host.command("attention");
	const request = waiting.takeAttentionRequest()!;
	assert.deepEqual(request.connection, { kind: "device", id: "manual" });
	assert.equal(waiting.attentionRequestIsCurrent(request), true);
	assert.equal(resolve.mock.callCount(), 0);
	await host.command("stop");
	assert.equal(waiting.attentionRequestIsCurrent(request), false);
});

test("attention fails closed when fresh origin attachment cannot be resolved", async t => {
	const { host, waiting } = await setup(t);
	const resolve = mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => { throw new Error("No attached tmux client"); });
	t.after(() => resolve.mock.restore());
	await host.command("attention");
	assert.equal(waiting.hasAttentionRequest(), false);
	assert.ok(host.notices.some(n => n.message.includes("No attached tmux client")));
});

for (const newer of ["f8", "stop", "f6", "failure"]) test(`attention retires pending replay before origin lookup: ${newer}`, async t => {
	const { host, waiting } = await setup(t);
	await host.command("output auto");
	const initial = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
	await host.shortcut("f5"); await settle();
	initial.mock.restore();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const replay = Promise.withResolvers<{ kind: "intentional_local" }>();
	const origin = Promise.withResolvers<{ kind: "intentional_local" }>();
	let calls = 0;
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => {
		calls++;
		return calls === 1 ? replay.promise : calls === 2 ? origin.promise : Promise.resolve({ kind: "intentional_local" as const });
	});
	await host.shortcut("f5"); await settle();
	const pending = host.command("attention"); await settle();
	// Attention waits for the old adoption, whose superseded replay must retire now.
	replay.resolve({ kind: "intentional_local" }); await settle();
	assert.equal(calls, 2);
	if (newer === "failure") {
		worker.emit({ type: "idle", utterance: (worker.sent.at(-1) as { utterance: number }).utterance });
		origin.reject(new Error("Lookup failed"));
	} else {
		if (newer === "stop") await host.command("stop");
		else await host.shortcut(newer);
		await settle();
		origin.resolve({ kind: "intentional_local" });
	}
	await pending; await settle();
	assert.equal(waiting.hasAttentionRequest(), false);
	if (newer === "failure") assert.equal(waiting.speechOwner(), undefined, "obsolete replay must not leave the owner waiting forever");
	if (newer === "f8") assert.equal(worker.pauses.at(-1), true, "F8 pauses the actual old transport");
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
	await host.shortcut("f5"); await settle();
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

for (const action of ["attention", "device local", "reconnect"]) test(`${action} finalizes capture into the editor without submission`, async t => {
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
	const pending = host.command(action); await settle();
	assert.equal(stop.mock.callCount(), 1);
	assert.equal(waiting.hasAttentionRequest(), false);
	capture.resolve({ type: "text", data: "Keep this draft." });
	await pending;
	assert.match(editor, /Keep this draft/);
	assert.equal(submitted.mock.callCount(), 0);
	assert.equal(waiting.hasAttentionRequest(), action === "attention");
});

test("external input cancellation during attention finalization cannot publish", async t => {
	const { host, waiting } = await setup(t);
	await host.command("input local");
	const capture = Promise.withResolvers<PhoneCapture>();
	t.mock.method(PhoneInputClient.prototype, "capture", () => capture.promise);
	t.mock.method(PhoneInputClient.prototype, "stop", async () => {});
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
	await host.command("talk"); await settle();
	const pending = host.command("attention"); await settle();
	await host.command("input disabled");
	capture.resolve({ type: "text", data: "Cancelled draft." });
	await pending;
	assert.equal(waiting.hasAttentionRequest(), false);
});

for (const key of ["f9", "f10"]) for (const published of [false, true]) test(`${key} tail cancels ${published ? "published" : "preparing"} attention`, async t => {
	const { host, waiting } = await setup(t);
	await host.shortcut("f5"); await settle();
	const gate = Promise.withResolvers<{ kind: "intentional_local" }>();
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => gate.promise);
	const pending = host.command("attention"); await settle();
	if (published) { gate.resolve({ kind: "intentional_local" }); await pending; }
	await host.shortcut(key);
	gate.resolve({ kind: "intentional_local" }); await pending;
	assert.equal(waiting.takeAttentionRequest(), undefined);
});

test("unread attention cannot supersede receiver F6 cold preparation", async t => {
	const { host, waiting } = await setup(t);
	host.addMessage("latest", "answer", assistant("Latest answer."));
	const target = waiting.activeSessions().find(session => session.sessionId === "origin")!;
	await fs.writeFile(path.join(waiting.root, "waiting", `${target.instanceId}.json`), JSON.stringify({ ...target, waitingSince: Date.now(), announced: true }));
	waiting.requestAttention(target.instanceId, { kind: "intentional_local" });
	const gate = Promise.withResolvers<void>();
	let entered = false, clock = 0;
	t.mock.method(performance, "now", () => clock += 9);
	const immediate = globalThis.setImmediate;
	t.mock.method(globalThis, "setImmediate", ((callback: () => void) => {
		if (entered) return immediate(callback);
		entered = true;
		void gate.promise.then(callback);
		return undefined;
	}) as typeof setImmediate);
	await host.shortcut("f6"); await settle();
	assert.ok(entered);
	await new Promise(resolve => setTimeout(resolve, 350));
	gate.resolve(); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	assert.equal((worker.sent.at(-1) as { text: string }).text, "Origin answer.");
});

for (const direction of ["outgoing", "incoming", "incoming cancelled", "incoming superseded"]) test(`${direction} attention reserves intent against automatic queued response drain`, async t => {
	const { host, waiting } = await setup(t);
	await host.command("output auto");
	await host.emit("before_agent_start", {});
	const partial = assistant("Old prefix", "pending");
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Old prefix" } }); await settle();
	const replayGate = Promise.withResolvers<{ kind: "intentional_local" }>();
	const originGate = Promise.withResolvers<{ kind: "intentional_local" }>();
	let calls = 0;
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => ++calls === 1 ? replayGate.promise : originGate.promise);
	await host.shortcut("f5"); await settle();
	const old = { ...partial, stopReason: "toolUse" };
	host.addMessage("old", "answer", old);
	await host.emit("message_end", { message: old });
	await host.emit("turn_end", { message: old });
	const next = assistant("Queued response.");
	await host.emit("message_start", { message: next });
	await host.emit("message_update", { message: next, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Queued response." } });
	host.addMessage("next", "old", next);
	await host.emit("message_end", { message: next });
	await host.emit("turn_end", { message: next });
	replayGate.resolve({ kind: "intentional_local" }); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const before = worker.sent.length;
	if (direction === "outgoing") {
		const pending = host.command("attention"); await settle();
		assert.equal(calls, 2);
		worker.emit({ type: "idle", utterance: (worker.sent.at(-1) as { utterance: number }).utterance }); await settle();
		assert.equal(worker.sent.length, before, "queued B must not replace explicit attention");
		originGate.resolve({ kind: "intentional_local" }); await pending;
		assert.ok(waiting.takeAttentionRequest());
	} else {
		host.addMessage("attention", "next", assistant("Completed waiting C."));
		const target = waiting.activeSessions().find(session => session.sessionId === "origin")!;
		await fs.writeFile(path.join(waiting.root, "waiting", `${target.instanceId}.json`), JSON.stringify({ ...target, waitingSince: Date.now(), announced: true }));
		const gate = Promise.withResolvers<void>();
		let entered = false, clock = 0;
		t.mock.method(performance, "now", () => clock += 9);
		const immediate = globalThis.setImmediate;
		t.mock.method(globalThis, "setImmediate", ((callback: () => void) => {
			if (entered) return immediate(callback);
			entered = true;
			void gate.promise.then(callback);
			return undefined;
		}) as typeof setImmediate);
		waiting.requestAttention(target.instanceId, { kind: "intentional_local" });
		await new Promise(resolve => setTimeout(resolve, 350));
		assert.ok(entered, "incoming attention must be preparing history");
		worker.emit({ type: "idle", utterance: (worker.sent.at(-1) as { utterance: number }).utterance }); await settle();
		assert.equal(worker.sent.length, before, "queued B must not cancel consumed C");
		if (direction === "incoming cancelled") waiting.cancelSpeechAcquisition();
		const replacement = direction === "incoming superseded" ? host.command("attention") : undefined;
		await settle();
		gate.resolve(); await settle();
		if (replacement) {
			assert.equal(worker.sent.length, before, "stale incoming cleanup must not clear the newer outgoing guard");
			originGate.resolve({ kind: "intentional_local" }); await replacement;
			assert.ok(waiting.takeAttentionRequest());
		} else {
			assert.equal((worker.sent.at(-1) as { text: string }).text,
				direction === "incoming" ? "Completed waiting C." : "Queued response.");
		}
	}
});

test("receiver action fences an unread request published before it", async t => {
	const { waiting, root } = await setup(t);
	const sender = new SessionCoordinator(root, "sender"); sender.start();
	t.after(() => sender.shutdown());
	sender.requestAttention(waiting.instanceId);
	waiting.cancelSpeechAcquisition();
	assert.equal(waiting.takeAttentionRequest(), undefined);
	sender.requestAttention(waiting.instanceId);
	assert.ok(waiting.takeAttentionRequest(), "requests published after the receiver action remain eligible");
});

test("taking attention cannot unlink a replacement published during the read", async t => {
	const { waiting, root } = await setup(t);
	const sender = new SessionCoordinator(root, "sender"); sender.start();
	t.after(() => sender.shutdown());
	sender.requestAttention(waiting.instanceId);
	const read = fsSync.readFileSync;
	let replaced = false;
	const hooked = t.mock.method(fsSync, "readFileSync", ((file: any, ...args: any[]) => {
		const value = (read as any)(file, ...args);
		if (!replaced && String(file).includes(`${waiting.instanceId}.json`) && String(file).includes("/attention/")) {
			replaced = true;
			sender.requestAttention(waiting.instanceId, { kind: "device", id: "newer" });
		}
		return value;
	}) as typeof read);
	syncBuiltinESMExports();
	try { waiting.takeAttentionRequest(); }
	finally { hooked.mock.restore(); syncBuiltinESMExports(); }
	assert.ok(replaced);
	assert.equal(waiting.takeAttentionRequest()?.connection?.kind, "device");
});

test("published attention does not reacquire an announcement and cancel itself", async t => {
	const { host, waiting } = await setup(t);
	waiting.clearWaiting(); waiting.markWaiting();
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
	await host.command("attention");
	await new Promise(resolve => setTimeout(resolve, 350)); await settle();
	assert.equal(waiting.speechOwner(), undefined, "origin must not announce while handoff is pending");
	const request = waiting.takeAttentionRequest()!;
	assert.ok(request);
	assert.equal(await waiting.forceAcquireSpeech(), true);
	await new Promise(resolve => setTimeout(resolve, 350)); await settle();
	assert.equal(waiting.attentionRequestIsCurrent(request), true);
});

test("failed attention lookup completes an origin that became idle behind the guard", async t => {
	const { host, waiting } = await setup(t);
	await host.shortcut("f5"); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const gate = Promise.withResolvers<never>();
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => gate.promise);
	const pending = host.command("attention"); await settle();
	worker.emit({ type: "idle", utterance: (worker.sent.at(-1) as { utterance: number }).utterance }); await settle();
	assert.ok(waiting.speechOwner(), "guard retains the lease until lookup finishes");
	gate.reject(new Error("Attachment disappeared")); await pending; await settle();
	assert.equal(waiting.speechOwner(), undefined);
	assert.equal(waiting.hasAttentionRequest(), false);
});

test("handing off a streaming origin preserves its subsequent waiting response", async t => {
	const { host, waiting } = await setup(t);
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
	await host.emit("before_agent_start", {});
	const partial = assistant("Heard prefix. ", "pending");
	await host.emit("message_start", { message: partial });
	await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Heard prefix. " } }); await settle();
	await host.command("attention");
	assert.ok(waiting.takeAttentionRequest());
	const complete = assistant("Heard prefix. Unheard continuation.");
	await host.emit("message_update", { message: complete, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Unheard continuation." } });
	host.addMessage("streamed", "answer", complete);
	await host.emit("message_end", { message: complete });
	await host.emit("turn_end", { message: complete });
	assert.ok(waiting.waitingSessions().some(session => session.sessionId === "origin"));
});

test("disabled attention does not request another project", async t => {
	const { host, waiting } = await setup(t);
	await host.command("off"); await host.command("attention");
	assert.equal(waiting.hasAttentionRequest(), false);
	assert.ok(host.notices.some(n => n.message === "Voice · Mode off · /voice on to enable"));
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
