import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { StopRecovery } from "../src/stop-recovery.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test, type TestContext } from "node:test";
import { DeviceRouter, type VoiceDeviceRegistration } from "../src/device-router.js";
import { DevicePriorityStore } from "../src/device-priorities.js";
import { PhoneInputClient, type PhoneCapture } from "../src/phone-input.js";
import type { VoiceConfig } from "../src/config.js";
import { deviceProgressComponent } from "../src/device-picker-ui.js";
import type { DevicePickerOptions } from "../src/device-picker-ui.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

class Worker extends MockedVoiceWorkerClient {
	outputs: string[] = [];
	cleanupPending = false;
	cleanupDispatches = 0;
	override sendSegment(utterance: number, segmentId: number, text: string, config?: VoiceConfig) {
		if (this.cleanupPending) {
			this.cleanupDispatches++;
			throw new Error("Voice worker transport cleanup is in progress");
		}
		this.outputs.push(config!.output);
		super.sendSegment(utterance, segmentId, text);
	}
}
mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: Worker } });
let picker = async (_options: DevicePickerOptions): Promise<string | undefined> => undefined;
mock.module("../src/device-picker-ui.js", { namedExports: { deviceProgressComponent,
	selectPriorityDeviceOverlay: (_ctx: unknown, options: DevicePickerOptions) => picker(options) } });
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };
const device = (id: string, connectedAt = 1): VoiceDeviceRegistration => ({ version: 1, id, name: id, platform: "linux", connectedAt, lastActive: 1, audioEndpoint: `unix:///fixture/${id}`, inputEndpoint: `unix:///fixture/${id}-input` });

async function fixture(t: TestContext, output = "auto", input = "disabled", config: Partial<VoiceConfig> = {}) {
	picker = async () => undefined;
	const root = await fs.mkdtemp(join(tmpdir(), "priority-integration-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_DEVICE_DIR", "PI_VOICE_COORDINATOR_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = join(root, "config.json");
	process.env.PI_VOICE_DEVICE_DIR = join(root, "devices");
	process.env.PI_VOICE_COORDINATOR_DIR = join(root, "coordinator");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, output, input, audioCache: false, timingPreprocessConcurrency: 0, ...config }));
	const store = new DevicePriorityStore(join(root, "device-priorities.json"));
	store.discover([1, 2, 3, 4].map(n => ({ id: `d${n}`, date: n })));
	let devices = [device("d3")];
	t.mock.method(DeviceRouter.prototype, "connected", () => devices);
	t.mock.method(DeviceRouter.prototype, "resolve", (id: string) => id === "local" ? undefined : devices.find(d => d.id === id) ?? device(id));
	t.mock.method(DeviceRouter.prototype, "claim", () => undefined);
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "d3" }));
	let poll = () => {};
	let attentionPoll = () => {};
	const interval = globalThis.setInterval;
	t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number, ...args: unknown[]) => {
		if (ms === 1_000) { poll = callback; return interval(() => {}, 100_000); }
		if (ms === 200) { attentionPoll = callback; return interval(() => {}, 100_000); }
		return interval(callback, ms, ...args);
	});
	const host = new FakeVoiceHost(root, "priority-integration");
	host.addMessage("message", null, assistant("First sentence. Second sentence. Third sentence."));
	const index = Worker.instances.length;
	t.after(async () => {
		await host.shutdown();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start(); await settle();
	const worker = Worker.instances[index] as Worker;
	const routePoll = poll;
	const selected = () => host.entries.filter(e => e.customType === "pi-voice.device-selection").at(-1)?.data;
	const event = async (...ids: (string | VoiceDeviceRegistration)[]) => { devices = ids.map(id => typeof id === "string" ? device(id) : id); routePoll(); await settle(); };
	const progress = (position: number) => {
		const segments = worker.sent as Array<{ utterance: number; segmentId: number; text: string }>;
		const current = segments.at(-1)!.utterance;
		segments.filter(s => s.utterance === current).forEach((s, i) => worker.emit({ type: "segment-audio", utterance: current, segmentId: s.segmentId, start: i * 2, duration: 2 }));
		worker.emit({ type: "playback", utterance: current, position });
	};
	return { host, worker, store, selected, event, progress, poll: routePoll, attentionPoll, root };
}

test("lease-free paused Tail changes route without acquiring or preempting another project", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	f.worker.emit({ type: "idle", utterance: (f.worker.sent.at(-1) as any).utterance }); await settle();
	await assert.rejects(fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json")), { code: "ENOENT" });
	await f.host.shortcut("f8"); await settle();
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	try {
		assert.equal(other.tryAcquireSpeech(), true);
		const acquire = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech");
		const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech");
		const before = f.worker.sent.length;
		await f.event("d2", "d3");
		assert.equal(f.selected().selected, "d2");
		assert.equal(acquire.mock.callCount(), 0, "device event must not attempt speech acquisition");
		assert.equal(force.mock.callCount(), 0, "device event must never request foreign preemption");
		assert.equal(other.ownsSpeech(), true);
		assert.equal(f.worker.sent.length, before);
		assert.deepEqual(await fs.readdir(join(f.root, "coordinator", "preemption")), []);
	} finally { other.shutdown(); }
});

for (const cancel of ["none", "stop", "pause", "session", "source"]) test(`F5 takeover survives automatic arrival (cancel: ${cancel})`, async t => {
	const f = await fixture(t);
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	try {
		assert.equal(other.tryAcquireSpeech(), true);
		const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech");
		await f.host.shortcut("f5"); await settle();
		assert.equal(force.mock.callCount(), 1);
		const preemption = join(f.root, "coordinator", "preemption");
		const files = await fs.readdir(preemption);
		assert.equal(files.length, 1);
		const request = await fs.readFile(join(preemption, files[0]), "utf8");
		await f.event("d2", "d3");
		assert.equal(f.selected().selected, "d2");
		assert.equal(f.worker.sent.length, 0, "foreign owner proof still gates playback");
		assert.equal(await fs.readFile(join(preemption, files[0]), "utf8"), request, "retain the one authorized preemption request");
		if (cancel === "stop") await f.host.command("stop");
		if (cancel === "pause") await f.host.shortcut("f8");
		if (cancel === "session") await f.host.emit("session_start", {});
		if (cancel === "source") {
			f.host.addMessage("new", "message", assistant("Replacement source."));
			await f.host.shortcut("f10"); await settle();
		}
		other.releaseSpeech();
		await new Promise(resolve => setTimeout(resolve, 75)); await settle();
		assert.equal(force.mock.callCount(), cancel === "source" ? 2 : 1, "only another user selection can issue another takeover");
		const replay = (f.worker.sent as Array<{ utterance: number; text: string }>).filter(s => s.text.includes("sentence."));
		assert.equal(new Set(replay.map(s => s.utterance)).size, cancel === "none" ? 1 : 0);
		if (cancel === "source") assert.ok((f.worker.sent as Array<{ text: string }>).some(s => s.text === "Replacement source."));
		if (cancel === "none") {
			assert.ok(f.worker.outputs.every(output => output === "unix:///fixture/d2"));
			assert.equal(f.worker.pauses.at(-1), false, "authorized replay must not remain paused");
		}
	} finally { other.shutdown(); }
});

test("pending takeover waits for a disconnected route to return without another takeover", async t => {
	const f = await fixture(t);
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	try {
		assert.equal(other.tryAcquireSpeech(), true);
		const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech");
		await f.host.shortcut("f5"); await settle();
		await f.event();
		other.releaseSpeech();
		await new Promise(resolve => setTimeout(resolve, 75)); await settle();
		assert.equal(f.worker.sent.length, 0, "no playback on a disconnected route");
		await f.event("d3");
		assert.equal(force.mock.callCount(), 1);
		assert.ok((f.worker.sent as Array<{ text: string }>).some(s => s.text === "First sentence."));
		assert.equal(f.worker.pauses.at(-1), false);
	} finally { other.shutdown(); }
});

test("dormant disconnected F5 waits for the arrival after a manual handoff before dispatch", async t => {
	const f = await fixture(t);
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	const proof = Promise.withResolvers<void>();
	try {
		assert.equal(other.tryAcquireSpeech(), true);
		await f.host.shortcut("f5"); await settle();
		await f.event();
		other.releaseSpeech();
		await new Promise(resolve => setTimeout(resolve, 75)); await settle();
		assert.equal(f.worker.sent.length, 0, "F5 has retired without admitting the disconnected route");
		await f.event("d4");
		const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
		const manual = f.host.command("device d4"); await settle();
		assert.equal(termination.mock.callCount(), 1);
		await f.event("d2", "d4");
		assert.equal(f.worker.sent.length, 0, "manual adoption still awaits original stop proof");
		proof.resolve(); await manual; await settle(); termination.mock.restore();
		assert.equal(f.selected().selected, "d2");
		assert.deepEqual((f.worker.sent as Array<{ text: string }>).filter(s => !s.text.startsWith("Project ")).map(s => s.text),
			["First sentence.", "Second sentence.", "Third sentence."]);
		assert.ok(f.worker.outputs.every(output => output === "unix:///fixture/d2"), "obsolete manual destination must never receive replay");
	} finally { proof.resolve(); other.shutdown(); }
});

for (const disconnect of [false, true]) test(`dormant disconnected F5 reranks a manual retry after foreign acquisition (disconnect: ${disconnect})`, async t => {
	const f = await fixture(t);
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	try {
		assert.equal(other.tryAcquireSpeech(), true);
		await f.host.shortcut("f5"); await settle();
		await f.event();
		other.releaseSpeech();
		await new Promise(resolve => setTimeout(resolve, 75)); await settle();
		assert.equal(f.worker.sent.length, 0);
		await f.event("d4");
		assert.equal(other.tryAcquireSpeech(), true);
		const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech");
		const manual = f.host.command("device d4"); await settle();
		assert.equal(f.selected().selected, "d4", "manual route has already been adopted");
		assert.equal(force.mock.callCount(), 1, "manual retry is blocked in acquisition, not termination");
		await f.event(...(disconnect ? [] : ["d2", "d4"]));
		assert.equal(other.ownsSpeech(), true);
		assert.equal(f.worker.sent.length, 0);
		other.releaseSpeech();
		await manual; await settle();
		if (disconnect) {
			assert.equal(f.selected().selected, "d4");
			assert.match(f.host.widgetLines()?.join(" ") ?? "", /WAIT/i);
			assert.equal(f.worker.sent.length, 0, "unused acquisition must not dispatch I/O");
			assert.equal(f.worker.outputs.length, 0);
			await assert.rejects(fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json")), { code: "ENOENT" });
			await f.event("d4");
			assert.equal(force.mock.callCount(), 1, "retained intent resumes without another takeover");
			assert.deepEqual((f.worker.sent as Array<{ text: string }>).filter(s => !s.text.startsWith("Project ")).map(s => s.text),
				["First sentence.", "Second sentence.", "Third sentence."]);
			assert.ok(f.worker.outputs.every(output => output === "unix:///fixture/d4"));
			return;
		}
		assert.equal(f.selected().selected, "d2");
		assert.deepEqual((f.worker.sent as Array<{ text: string }>).filter(s => !s.text.startsWith("Project ")).map(s => s.text),
			["First sentence.", "Second sentence.", "Third sentence."]);
		assert.ok(f.worker.outputs.every(output => output === "unix:///fixture/d2"), "obsolete manual destination must never receive replay");
	} finally { other.shutdown(); }
});

for (const pause of [false, true]) test(`pending takeover retains an independent streaming source across arrival (pause: ${pause})`, async t => {
	const f = await fixture(t);
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	try {
		assert.equal(other.tryAcquireSpeech(), true);
		await f.host.shortcut("f5"); await settle();
		await f.host.emit("message_start", { message: assistant("", "pending") });
		await f.host.emit("message_update", { message: assistant("New answer. ", "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "New answer. " } });
		await f.event("d2", "d3");
		if (pause) await f.host.shortcut("f8");
		other.releaseSpeech();
		await new Promise(resolve => setTimeout(resolve, 75)); await settle();
		const message = assistant("New answer. Later sentence.");
		await f.host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Later sentence." } });
		f.host.addMessage("new", "message", message);
		await f.host.emit("message_end", { message });
		await f.host.emit("turn_end", { message, toolResults: [] }); await settle();
		if (pause) {
			assert.equal(f.worker.sent.length, 0, "Pause cancels pending admission");
			await f.host.shortcut("f8"); await settle();
		}
		const replay = (f.worker.sent.at(-1) as { utterance: number }).utterance;
		assert.equal(new Set((f.worker.sent as Array<{ text: string; utterance: number }>).filter(s => s.text === "First sentence.").map(s => s.utterance)).size, 1);
		const before = f.worker.sent.length;
		f.worker.emit({ type: "idle", utterance: replay }); await settle();
		assert.deepEqual((f.worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text), ["New answer.", "Later sentence."]);
		f.worker.emit({ type: "idle", utterance: (f.worker.sent.at(-1) as { utterance: number }).utterance }); await settle();
		assert.equal(f.worker.sent.length, before + 2, "B drains exactly once");
	} finally { other.shutdown(); }
});

for (const cancel of ["none", "stop", "pause"]) test(`cold F5 retains explicit intent through arrival (cancel: ${cancel})`, async t => {
	const f = await fixture(t);
	f.host.addMessage("cold", "message", assistant("Cold history sentence."));
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	const immediate = globalThis.setImmediate;
	let release: (() => void) | undefined;
	let clock = 0;
	const now = t.mock.method(performance, "now", () => clock += 9);
	const gate = t.mock.method(globalThis, "setImmediate", ((callback: () => void, ...args: unknown[]) => {
		if (new Error().stack?.includes("preparePlaybackMessages")) {
			release = callback;
			return immediate(() => {});
		}
		return immediate(() => Reflect.apply(callback, undefined, args));
	}) as typeof setImmediate);
	try {
		assert.equal(other.tryAcquireSpeech(), true);
		const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech");
		await f.host.shortcut("f5"); await settle();
		assert.ok(release, "cold history preparation is actually gated");
		assert.equal(force.mock.callCount(), 0, "arrival precedes acquisition");
		await f.event("d2", "d3");
		assert.equal(f.selected().selected, "d2");
		if (cancel === "stop") await f.host.command("stop");
		if (cancel === "pause") await f.host.shortcut("f8");
		now.mock.restore(); gate.mock.restore(); release(); await settle();
		assert.equal(force.mock.callCount(), cancel === "none" ? 1 : 0, "only current explicit intent may request takeover");
		assert.equal(f.worker.sent.length, 0, "foreign proof still gates IO");
		other.releaseSpeech();
		await new Promise(resolve => setTimeout(resolve, 75)); await settle();
		const replay = (f.worker.sent as Array<{ text: string; utterance: number }>).filter(s => s.text === "First sentence.");
		assert.equal(new Set(replay.map(s => s.utterance)).size, cancel === "none" ? 1 : 0, JSON.stringify(f.worker.sent));
		assert.ok(f.worker.outputs.every(output => output === "unix:///fixture/d2"));
	} finally { gate.mock.restore(); now.mock.restore(); release?.(); other.shutdown(); }
});

for (const foreign of [false, true, "during WAIT"]) test(`cold live F5 retains activated ownership through disconnect and cancel ACK (foreign takeover: ${foreign})`, async t => {
	const f = await fixture(t);
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	let cancellation: ReturnType<typeof t.mock.method> | undefined;
	try {
		const message = assistant("Cold live first sentence. Cold live second sentence. ", "pending");
		await f.host.emit("message_start", { message });
		await f.host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
		await settle();
		await f.host.command("stop"); await settle();
		// Keep the selected live source, but retire its original lease before F5.
		await assert.rejects(fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json")), { code: "ENOENT" });
		f.worker.sent.length = 0; f.worker.outputs.length = 0;
		if (foreign === true) assert.equal(other.tryAcquireSpeech(), true);
		cancellation = t.mock.method(f.worker, "cancel", (() => 1) as unknown as typeof f.worker.cancel);
		const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech");
		await f.host.shortcut("f5"); await settle();
		if (foreign === true) {
			assert.equal(force.mock.callCount(), 1);
			other.releaseSpeech();
			await new Promise(resolve => setTimeout(resolve, 75)); await settle();
		}
		assert.equal(cancellation.mock.callCount(), 1, "activated live replay awaits its own cancellation ACK");
		assert.equal(f.worker.sent.length, 0, "new ownership has not yet admitted the live replay");
		const leasePath = join(f.root, "coordinator", "speech.lock", "lease.json");
		const owner = JSON.parse(await fs.readFile(leasePath, "utf8"));
		assert.notEqual(owner.instanceId, other.instanceId);
		await f.event();
		f.worker.emit({ type: "idle", cancelId: 1 }); await settle();
		for (let i = 0; i < 10; i++) { f.attentionPoll(); f.poll(); await settle(); }
		assert.equal(f.worker.sent.length, 0, "attention polling cannot admit disconnected playback");
		assert.match(f.host.widgetLines()?.join(" ") ?? "", /WAIT/i);
		const waitingOwner = JSON.parse(await fs.readFile(leasePath, "utf8"));
		assert.equal(waitingOwner.instanceId, owner.instanceId);
		assert.equal(waitingOwner.speechGeneration, owner.speechGeneration, "activated ownership survives dormant WAIT");
		cancellation.mock.restore();
		if (foreign === "during WAIT") {
			const takeover = other.forceAcquireSpeech();
			for (let i = 0; i < 10; i++) {
				f.attentionPoll(); await settle();
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			assert.equal(await takeover, true, "real preemption must release dormant ownership");
			assert.equal(other.ownsSpeech(), true);
			await f.event("d3");
			for (let i = 0; i < 10; i++) { f.attentionPoll(); f.poll(); await settle(); }
			assert.equal(force.mock.callCount(), 1, "only the foreign coordinator may request takeover");
			assert.equal(other.ownsSpeech(), true, "device return cannot steal ownership back");
			assert.equal(f.worker.sent.length, 0, "preempted replay cannot auto resume");
			other.releaseSpeech();
			for (let i = 0; i < 10; i++) { f.attentionPoll(); f.poll(); await settle(); }
			assert.equal(f.worker.sent.length, 0, "foreign release does not restore superseded intent");
			assert.equal(force.mock.callCount(), 1);
			return;
		}
		await f.event("d3");
		assert.deepEqual((f.worker.sent as Array<{ text: string }>).filter(s => !s.text.startsWith("Project ")).map(s => s.text),
			["Cold live first sentence.", "Cold live second sentence."]);
		assert.ok(f.worker.outputs.every(output => output === "unix:///fixture/d3"));
		assert.equal(f.worker.pauses.at(-1), false);
		assert.equal(force.mock.callCount(), foreign ? 1 : 0, "return must not request a new takeover");
	} finally { cancellation?.mock.restore(); other.shutdown(); }
});

for (const change of ["arrival", "disconnect", "source growth"]) test(`dormant automatic live retry rechecks route after its own cancel ACK (${change})`, async t => {
	const f = await fixture(t);
	const message = assistant("Dormant live first sentence. Dormant live second sentence. ", "pending");
	await f.host.emit("message_start", { message });
	await f.host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	await f.host.command("stop"); await settle();
	await assert.rejects(fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json")), { code: "ENOENT" });
	f.worker.sent.length = 0; f.worker.outputs.length = 0;
	let cancelId = 0;
	const cancellation = t.mock.method(f.worker, "cancel", (() => ++cancelId <= 3 ? cancelId : undefined) as unknown as typeof f.worker.cancel);
	const proof = Promise.withResolvers<void>();
	let termination: ReturnType<typeof t.mock.method> | undefined;
	try {
		await f.host.shortcut("f5"); await settle();
		assert.equal(cancelId, 1);
		await f.event();
		f.worker.emit({ type: "idle", cancelId: 1 }); await settle();
		assert.equal(f.worker.sent.length, 0, "disconnected admission leaves a dormant retained live request");
		await f.event("d2");
		assert.equal(f.selected().selected, "d2");
		assert.equal(cancelId, 3, "adoption shutdown and automatic B retry each cancel the old transport");
		if (change === "source growth") {
			const chunk = "During B wait sentence. ";
			const grown = assistant(message.content[0].text + chunk, "pending");
			await f.host.emit("message_update", { message: grown, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
		} else {
			termination = t.mock.method(f.worker, "terminate", async () => {
				f.worker.cleanupPending = true;
				await proof.promise;
				f.worker.cleanupPending = false;
			});
			await f.event(...(change === "disconnect" ? [] : ["d1", "d2"]));
		}
		assert.equal(f.worker.sent.length, 0);
		f.worker.emit({ type: "idle", cancelId: 3 }); await settle();
		if (change === "arrival") {
			assert.equal(termination!.mock.callCount(), 1);
			assert.equal(f.worker.cleanupPending, true, "B cancel ACK is not handoff shutdown proof");
			assert.equal(f.worker.cleanupDispatches, 0, "ACK alone must not even attempt dispatch");
			assert.equal(f.worker.sent.length, 0);
			assert.equal(f.selected().selected, "d2", "C adoption awaits shutdown proof");
		}
		proof.resolve(); await settle();
		cancellation.mock.restore();
		if (change !== "source growth") assert.ok(!f.worker.outputs.includes("unix:///fixture/d2"), "obsolete B must never receive WorkerClient.sendSegment");
		if (change === "disconnect") {
			assert.equal(f.worker.sent.length, 0);
			assert.match(f.host.widgetLines()?.join(" ") ?? "", /WAIT/i);
		} else {
			const destination = change === "source growth" ? "d2" : "d1";
			assert.equal(f.selected().selected, destination);
			const expected = ["Dormant live first sentence.", "Dormant live second sentence."];
			if (change === "source growth") expected.push("During B wait sentence.");
			assert.deepEqual((f.worker.sent as Array<{ text: string }>).filter(s => !s.text.startsWith("Project ")).map(s => s.text), expected);
			assert.ok(f.worker.outputs.every(output => output === `unix:///fixture/${destination}`));
		}
	} finally {
		proof.resolve(); cancellation.mock.restore(); await settle(); termination?.mock.restore();
	}
});

test("live F5 cancel ACK cannot bypass pending handoff termination or newest routing", async t => {
	const f = await fixture(t);
	let text = "Live first sentence. Live second sentence. ";
	await f.host.emit("message_start", { message: assistant("", "pending") });
	const delta = async (chunk: string) => f.host.emit("message_update", { message: assistant(text, "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
	await delta(text); await settle();
	assert.ok(f.worker.sent.length, "live playback owns an actual sink before F5");
	const before = f.worker.sent.length;
	let cancelId = 0;
	const cancellation = t.mock.method(f.worker, "cancel", (() => ++cancelId) as unknown as typeof f.worker.cancel);
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", async () => {
		f.worker.cleanupPending = true;
		await proof.promise;
		f.worker.cleanupPending = false;
	});
	try {
		await f.host.shortcut("f5"); await settle();
		assert.equal(cancelId, 1, "F5 is waiting for its own cancel ACK");
		await f.event("d2", "d3");
		assert.equal(termination.mock.callCount(), 1, "automatic handoff independently awaits termination");
		await f.event("d1", "d2", "d3");
		text += "During cleanup sentence. ";
		await delta("During cleanup sentence. ");
		f.worker.emit({ type: "idle", cancelId: 1 }); await settle();
		assert.equal(f.worker.cleanupPending, true, "cancel ACK is not shutdown proof");
		assert.equal(f.worker.cleanupDispatches, 0, "F5 must not even attempt dispatch during cleanup");
		assert.equal(f.worker.sent.length, before);
		assert.equal(f.selected().selected, "d3", "no route adoption before termination proof");
		proof.resolve(); await settle();
		assert.equal(f.selected().selected, "d1");
		assert.deepEqual((f.worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text),
			["Live first sentence.", "Live second sentence.", "During cleanup sentence."]);
		assert.ok(f.worker.outputs.slice(before).every(output => output === "unix:///fixture/d1"));
		for (let i = 0; i < 10; i++) f.poll();
		await settle();
		assert.equal(f.worker.sent.length, before + 3, "one replay after the newest route settles");
	} finally {
		proof.resolve(); cancellation.mock.restore(); await settle(); termination.mock.restore();
	}
});

test("recovered explicit live replay drains a later block finalized during failed cleanup only once", async t => {
	const f = await fixture(t);
	const message = assistant("Live first sentence. ", "pending");
	await f.host.emit("message_start", { message });
	await f.host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	const before = f.worker.sent.length;
	assert.ok(before);
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	try {
		await f.event("d2", "d3");
		await f.host.shortcut("f5"); await settle();
		proof.reject(new Error("original stop unconfirmed")); await settle();
		message.content.push({ type: "text", text: "Later block sentence. " });
		await f.host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: message.content[1].text } });
		const final = { ...message, stopReason: "stop" };
		f.host.addMessage("live-complete", "message", final);
		await f.host.emit("message_end", { message: final });
		await f.host.emit("turn_end", { message: final, toolResults: [] }); await settle();
		assert.equal(f.worker.sent.length, before);
		termination.mock.restore();
		await f.event("d2", "d3", "d4");
		assert.equal(f.selected().selected, "d2");
		assert.deepEqual((f.worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text),
			["Live first sentence.", "Later block sentence."]);
		for (let i = 0; i < 2; i++) {
			f.worker.emit({ type: "idle", utterance: (f.worker.sent.at(-1) as { utterance: number }).utterance }); await settle();
		}
		assert.equal(f.worker.sent.length, before + 2, "EOF must not replay the later block left in the paused queue");
	} finally { proof.resolve(); termination.mock.restore(); }
});

test("recovered nonexplicit live continuation drains finalized source once after failed admission", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	f.worker.emit({ type: "idle", utterance: (f.worker.sent.at(-1) as { utterance: number }).utterance }); await settle();
	await f.host.shortcut("f10"); await settle();
	await f.host.shortcut("f8"); await settle();
	await assert.rejects(fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json")), { code: "ENOENT" });
	const message = assistant("Live first sentence. ", "pending");
	await f.host.emit("message_start", { message });
	await f.host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	const before = f.worker.sent.length;
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	try {
		await f.event("d2", "d3");
		assert.equal(termination.mock.callCount(), 1);
		await f.host.shortcut("f8"); await settle(); // Lease-free Tail resumes with queued=true, not explicit F5.
		proof.reject(new Error("original stop unconfirmed")); await settle();
		message.content.push({ type: "text", text: "Later block sentence. " });
		await f.host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: message.content[1].text } });
		const final = { ...message, stopReason: "stop" };
		f.host.addMessage("live-complete", "message", final);
		await f.host.emit("message_end", { message: final });
		await f.host.emit("turn_end", { message: final, toolResults: [] }); await settle();
		assert.equal(f.worker.sent.length, before);
		termination.mock.restore();
		await f.event("d2", "d3", "d4");
		assert.equal(f.selected().selected, "d2");
		assert.deepEqual((f.worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text),
			["Live first sentence.", "Later block sentence."]);
		for (let i = 0; i < 2; i++) {
			f.worker.emit({ type: "idle", utterance: (f.worker.sent.at(-1) as { utterance: number }).utterance }); await settle();
		}
		assert.equal(f.worker.sent.length, before + 2, "EOF must not drain a duplicate queued source block");
	} finally { proof.resolve(); termination.mock.restore(); }
});

test("F8 cancelling rerouted live Tail retains the paused suffix after the old coroutine retires", async t => {
	const f = await fixture(t);
	let text = "Already heard sentence. ";
	await f.host.emit("message_start", { message: assistant("", "pending") });
	const delta = async (chunk: string) => f.host.emit("message_update", { message: assistant(text, "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
	await delta(text); await settle();
	const before = f.worker.sent.length;
	const cancellation = t.mock.method(f.worker, "cancel", (() => 1) as unknown as typeof f.worker.cancel);
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	try {
		await f.host.shortcut("f10"); await settle();
		assert.ok(cancellation.mock.callCount(), "Tail is pending cancellation of the live sink");
		await f.event("d2", "d3");
		await f.host.shortcut("f8"); await settle();
		text += "Only retained suffix. ";
		await delta("Only retained suffix. ");
		proof.resolve(); await settle();
		cancellation.mock.restore(); termination.mock.restore();
		assert.equal(f.worker.sent.length, before);
		assert.equal(f.worker.pauses.at(-1), true);
		assert.match(f.host.widgetLines()?.join(" ") ?? "", /Paused/);
		await f.host.shortcut("f8"); await settle();
		assert.deepEqual((f.worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text), ["Only retained suffix."]);
		assert.equal(f.worker.pauses.at(-1), false);
	} finally { proof.resolve(); cancellation.mock.restore(); termination.mock.restore(); }
});

test("Pause after failed Tail rebind retires resumes only the retained suffix", async t => {
	const f = await fixture(t);
	let text = "Already heard sentence. ";
	await f.host.emit("message_start", { message: assistant("", "pending") });
	const delta = async (chunk: string) => f.host.emit("message_update", { message: assistant(text, "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
	await delta(text); await settle();
	const before = f.worker.sent.length;
	assert.ok(before, "the Tail prefix was already dispatched");
	const cancellation = t.mock.method(f.worker, "cancel", (() => 1) as unknown as typeof f.worker.cancel);
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	try {
		await f.host.shortcut("f10"); await settle();
		assert.ok(cancellation.mock.callCount());
		await f.event("d2", "d3");
		assert.equal(termination.mock.callCount(), 1);
		proof.reject(new Error("original stop unconfirmed")); await settle();
		assert.equal(f.selected().selected, "d3");
		assert.equal(f.worker.sent.length, before);
		// Unlike cancellation before proof, Pause now sees a dormant retained request.
		await f.host.shortcut("f8"); await settle();
		text += "Only retained suffix. ";
		await delta("Only retained suffix. ");
		cancellation.mock.restore(); termination.mock.restore();
		await f.event("d2", "d3", "d4");
		assert.equal(f.selected().selected, "d2");
		assert.equal(f.worker.pauses.at(-1), true, "recovery must respect Pause even if it prepares paused segments");
		await f.host.shortcut("f8"); await settle();
		assert.deepEqual((f.worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text), ["Only retained suffix."]);
		assert.ok(f.worker.outputs.slice(before).every(output => output === "unix:///fixture/d2"));
	} finally { proof.resolve(); cancellation.mock.restore(); termination.mock.restore(); }
});

test("F8 cancellation at the post-acquisition handoff barrier releases an unused lease", async t => {
	const f = await fixture(t);
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	const acquired = Promise.withResolvers<void>();
	const admit = Promise.withResolvers<void>();
	const proof = Promise.withResolvers<void>();
	const originalForce = SessionCoordinator.prototype.forceAcquireSpeech;
	const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", async function (this: SessionCoordinator) {
		const result = await originalForce.call(this);
		if (result) acquired.resolve();
		await admit.promise;
		return result;
	});
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	try {
		assert.equal(other.tryAcquireSpeech(), true);
		await f.host.shortcut("f5"); await settle();
		assert.equal(force.mock.callCount(), 1);
		other.releaseSpeech();
		await acquired.promise;
		const leasePath = join(f.root, "coordinator", "speech.lock", "lease.json");
		const owner = JSON.parse(await fs.readFile(leasePath, "utf8"));
		assert.notEqual(owner.instanceId, other.instanceId, "F5 really acquired the lease before the handoff");
		await f.host.shortcut("f8"); await settle(); // Paused replay forces old-transport shutdown during adoption.
		await f.event("d2", "d3");
		assert.equal(termination.mock.callCount(), 1);
		assert.equal(f.worker.pauses.at(-1), true);
		admit.resolve(); await settle();
		assert.equal(f.worker.sent.length, 0, "acquired replay is blocked at the post-acquisition barrier");
		await f.host.shortcut("f8"); await settle(); // Resume remains behind the same barrier.
		await f.host.shortcut("f8"); await settle(); // Pause now cancels the rerouted request.
		proof.resolve(); await settle();
		assert.equal(f.worker.sent.length, 0, "stale replay must not use its acquired lease");
		await assert.rejects(fs.stat(leasePath), { code: "ENOENT" }, "cancelled admission must not strand an unused lease");
		assert.equal(other.tryAcquireSpeech(), true, "another project can acquire after stale admission retires");
	} finally { admit.resolve(); proof.resolve(); force.mock.restore(); termination.mock.restore(); other.shutdown(); }
});

test("fresh F5 promotes a queued Tail resume on the same target to explicit takeover across arrival", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	f.worker.emit({ type: "idle", utterance: (f.worker.sent.at(-1) as any).utterance }); await settle();
	await f.host.shortcut("f8"); await settle();
	const message = assistant("Queued Tail sentence.");
	await f.host.emit("message_start", { message: assistant("", "pending") });
	await f.host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	f.host.addMessage("queued-tail", "message", message);
	await f.host.emit("message_end", { message });
	await f.host.emit("turn_end", { message, toolResults: [] }); await settle();
	const before = f.worker.sent.length;
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	try {
		assert.equal(other.tryAcquireSpeech(), true);
		const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech");
		await f.host.shortcut("f8"); await settle();
		assert.equal(force.mock.callCount(), 1, "queued Tail resume is waiting behind the foreign owner");
		await f.host.shortcut("f5"); await settle();
		assert.equal(force.mock.callCount(), 2, "fresh F5 authorizes the same selected target");
		await f.event("d2", "d3");
		assert.equal(f.worker.sent.length, before);
		other.releaseSpeech();
		await new Promise(resolve => setTimeout(resolve, 75)); await settle();
		assert.equal(force.mock.callCount(), 2, "arrival retains rather than replaces explicit takeover");
		assert.deepEqual((f.worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text), ["Queued Tail sentence."]);
		assert.ok(f.worker.outputs.slice(before).every(output => output === "unix:///fixture/d2"));
		assert.equal(f.worker.pauses.at(-1), false);
	} finally { other.shutdown(); }
});

for (const missing of [false, true]) test(`owning cold F5 preserves WAIT across selected disconnect (missing row: ${missing})`, async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	const leasePath = join(f.root, "coordinator", "speech.lock", "lease.json");
	const owner = JSON.parse(await fs.readFile(leasePath, "utf8"));
	const before = f.worker.sent.length;
	f.host.addMessage("cold", "message", assistant("Unselected cold history sentence."));
	const immediate = globalThis.setImmediate;
	let release: (() => void) | undefined;
	let clock = 0;
	const now = t.mock.method(performance, "now", () => clock += 9);
	const gate = t.mock.method(globalThis, "setImmediate", ((callback: () => void, ...args: unknown[]) => {
		if (new Error().stack?.includes("preparePlaybackMessages")) {
			release = callback;
			return immediate(() => {});
		}
		return immediate(() => Reflect.apply(callback, undefined, args));
	}) as typeof setImmediate);
	try {
		await f.host.shortcut("f5"); await settle();
		assert.ok(release, "owning F5 preparation is actually gated");
		assert.equal(f.worker.pauses.at(-1), false);
		await f.event();
		assert.equal(f.worker.pauses.at(-1), true, "disconnect physically pauses the retained sink even during cold preparation");
		const disconnectedOwner = JSON.parse(await fs.readFile(leasePath, "utf8"));
		assert.equal(disconnectedOwner.instanceId, owner.instanceId);
		assert.equal(disconnectedOwner.speechGeneration, owner.speechGeneration, "disconnect retains the original acquisition");
		const resolution = missing ? t.mock.method(DeviceRouter.prototype, "resolve", () => undefined) : undefined;
		if (missing) { f.store.forget("d3"); await settle(); f.poll(); await settle(); }
		now.mock.restore(); gate.mock.restore(); release(); await settle();
		assert.equal(f.worker.sent.length, before, "existing ownership cannot admit disconnected IO");
		assert.match(f.host.widgetLines()?.join(" ") ?? "", /WAIT/i);
		const waitingOwner = JSON.parse(await fs.readFile(leasePath, "utf8"));
		assert.equal(waitingOwner.instanceId, owner.instanceId);
		assert.equal(waitingOwner.speechGeneration, owner.speechGeneration, "retired cold preparation must retain the same lease throughout WAIT");
		resolution?.mock.restore();
		await f.event("d3");
		assert.deepEqual((f.worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text),
			["First sentence.", "Second sentence.", "Third sentence."], "return resumes the selected source, not newly appended history");
		assert.ok(f.worker.outputs.slice(before).every(output => output === "unix:///fixture/d3"));
		assert.equal(f.worker.pauses.at(-1), false);
		for (let i = 0; i < 10; i++) f.poll();
		await settle();
		assert.equal(f.worker.sent.length, before + 3);
	} finally { gate.mock.restore(); now.mock.restore(); release?.(); }
});

for (const resume of ["return", "selection"]) test(`forgotten disconnected pending route retains WAIT (${resume})`, async t => {
	const f = await fixture(t);
	const other = new SessionCoordinator(join(f.root, "other"), "other");
	other.start();
	try {
		assert.equal(other.tryAcquireSpeech(), true);
		const force = t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech");
		await f.host.shortcut("f5"); await settle();
		await f.event();
		const missing = t.mock.method(DeviceRouter.prototype, "resolve", () => undefined);
		f.store.forget("d3"); await settle(); f.poll(); await settle();
		other.releaseSpeech();
		await new Promise(resolve => setTimeout(resolve, 75)); await settle();
		assert.equal(f.worker.sent.length, 0, "missing row must not dispatch to its dead cached endpoint");
		assert.match(f.host.widgetLines()?.join(" ") ?? "", /WAIT/i);
		missing.mock.restore();
		if (resume === "return") await f.event("d3");
		else {
			await f.event("d4");
			await f.host.command("device d4"); await settle();
		}
		assert.equal(force.mock.callCount(), 1);
		assert.equal((f.worker.sent as Array<{ text: string }>).filter(s => s.text === "First sentence.").length, 1);
		assert.ok(f.worker.outputs.every(output => output === `unix:///fixture/${resume === "return" ? "d3" : "d4"}`));
	} finally { other.shutdown(); }
});

for (const afterManual of [false, true]) test(`queued priority arrival is fenced by manual selection (new arrival after manual: ${afterManual})`, async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	await f.event("d2", "d3");
	await f.event("d1", "d2", "d3");
	const before = f.worker.outputs.length;
	const manual = f.host.command("device d3"); await settle();
	if (afterManual) await f.event("d1", "d2", "d3", "d4");
	proof.resolve(); await manual; await settle(); termination.mock.restore();
	assert.equal(f.selected().selected, afterManual ? "d1" : "d3");
	assert.ok(f.worker.outputs.length > before);
	assert.ok(f.worker.outputs.slice(before).every(output => output === `unix:///fixture/${afterManual ? "d1" : "d3"}`));
	for (let i = 0; i < 10; i++) f.poll();
	await settle();
	assert.equal(f.selected().selected, afterManual ? "d1" : "d3", "unchanged polls cannot retire manual choice");
	if (!afterManual) {
		await f.event("d1", "d2", "d3", "d4");
		assert.equal(f.selected().selected, "d1", "a later genuine event reranks");
	}
});

test("event during idle manual adoption reranks even when the old selection is still the winner", async t => {
	const f = await fixture(t);
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	const manual = f.host.command("device local"); await settle();
	await f.event("d3", "d4");
	proof.resolve(); await manual; await settle(); termination.mock.restore();
	assert.equal(f.selected().selected, "d3", "postmanual arrival must be evaluated against the adopted selection");
});

test("exact 3→2 connect/disconnect/return/manual3/2 return sequence uses current cursor and proof", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	f.progress(2.5);
	assert.equal(f.worker.outputs.at(-1), "unix:///fixture/d3");
	await f.event("d3", "d2");
	assert.equal(f.selected().selected, "d2");
	assert.equal(f.selected().pin, undefined, "ordinary adoption never pins");
	assert.equal((f.worker.sent.at(-2) as any).text, "Second sentence.");
	await f.event("d3");
	const waiting = f.worker.sent.length;
	await f.event("d3", "d4");
	assert.equal(f.worker.sent.length, waiting, "lower arrival cannot bypass wait");
	await f.event("d3", "d2");
	assert.ok(f.worker.sent.length > waiting);
	assert.equal(f.worker.outputs.at(-1), "unix:///fixture/d2");
	await f.event("d3");
	await f.host.command("device d3"); await settle();
	assert.equal(f.selected().selected, "d3");
	assert.equal(f.worker.outputs.at(-1), "unix:///fixture/d3");
	f.progress(2.5); // Now in the third sentence of the resumed suffix.
	const beforeReturn = f.worker.sent.length;
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	await f.event("d3", "d2");
	assert.equal(f.worker.sent.length, beforeReturn, "no admission before original stop proof");
	assert.equal(f.selected().selected, "d3");
	proof.resolve(); await settle(); termination.mock.restore();
	assert.equal(f.selected().selected, "d2");
	assert.equal((f.worker.sent[beforeReturn] as any).text, "Third sentence.", "old return is a NEW handoff, not the obsolete checkpoint");
	await f.event("d3");
	assert.equal(f.worker.pauses.at(-1), true);
	const final = f.worker.sent.length;
	f.poll(); await settle();
	assert.equal(f.worker.sent.length, final);
});

for (const supersede of ["pause", "stop", "new source", "session"]) test(`${supersede} fences a resume waiting for original stop proof`, async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	await f.event();
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	await f.event("d3");
	const before = f.worker.sent.length;
	let replacement: Promise<void> | undefined;
	if (supersede === "pause") await f.host.shortcut("f8");
	if (supersede === "stop") await f.host.command("stop");
	if (supersede === "new source") {
		f.host.addMessage("new", "message", assistant("Replacement source."));
		await f.host.shortcut("f10");
	}
	if (supersede === "session") replacement = f.host.emit("session_start", {});
	proof.resolve(); await replacement; await settle(); termination.mock.restore();
	const added = (f.worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text);
	if (supersede === "new source") {
		assert.ok(added.length, "the superseding selection remains usable after proof");
		assert.ok(added.every(text => text === "Replacement source."));
	}
	else assert.deepEqual(added, []);
	if (supersede === "stop") await assert.rejects(fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json")), { code: "ENOENT" });
});

for (const finished of [false, true]) test(`disconnect retains a growing live source (finalized before return: ${finished})`, async t => {
	const f = await fixture(t);
	let text = "First sentence. Second sentence. ";
	await f.host.emit("message_start", { message: assistant("", "pending") });
	const delta = async (chunk: string) => f.host.emit("message_update", { message: assistant(text, "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
	await delta(text); await settle();
	f.progress(2.5);
	await f.event();
	const count = f.worker.sent.length;
	text += "Future sentence. ";
	await delta("Future sentence. ");
	if (finished) {
		const message = assistant(text);
		f.host.addMessage("live-complete", "message", message);
		await f.host.emit("message_end", { message });
		await f.host.emit("turn_end", { message, toolResults: [] });
	}
	await f.event("d3");
	assert.deepEqual((f.worker.sent.slice(count) as Array<{ text: string }>).map(s => s.text), ["Second sentence.", "Future sentence."]);
});

test("failed original stop proof retains owner and blocks automatic and manual admission", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	await f.event();
	const count = f.worker.sent.length;
	const failure = t.mock.method(f.worker, "terminate", async () => { throw new Error("original stop unconfirmed"); });
	await f.event("d2", "d3");
	assert.equal(f.selected().selected, "d3");
	assert.equal(f.worker.sent.length, count);
	await f.host.command("device d2"); await settle();
	assert.equal(f.worker.sent.length, count);
	await fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json"));
	failure.mock.restore();
	await f.host.command("device d2"); await settle();
	assert.equal(f.selected().selected, "d2");
	assert.ok(f.worker.sent.length > count);
});

test("paused intent survives return; manual lower choice holds until a genuine event", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	await f.host.shortcut("f8");
	await f.event();
	await f.event("d3");
	assert.equal(f.worker.pauses.at(-1), true);
	await f.event("d2", "d3");
	await f.host.command("device d3");
	assert.equal(f.selected().selected, "d3");
	const count = f.worker.sent.length;
	for (let i = 0; i < 20; i++) f.poll();
	await settle();
	assert.equal(f.selected().selected, "d3");
	assert.equal(f.worker.sent.length, count);
	await f.event("d2", "d3", "d4");
	assert.equal(f.selected().selected, "d2", "real connection event ends the temporary choice");
});

for (const output of ["local", "unix:///fixture/custom-output"]) test(`explicit output override ${output} never hands off`, async t => {
	const f = await fixture(t, output);
	await f.host.shortcut("f5"); await settle();
	const count = f.worker.sent.length;
	await f.event("d1", "d2");
	assert.equal(f.worker.sent.length, count);
	assert.equal(f.worker.outputs.at(-1), output);
	assert.notEqual(f.worker.pauses.at(-1), true);
});

test("picker pin/reorder races fence stale adoption and remain independent from selection", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	await f.event("d2", "d3");
	const order = [...f.store.snapshot.user_order];
	picker = async options => {
		await options.onAction!({ kind: "pin", id: "d3" }, options.snapshot());
		return undefined;
	};
	await f.host.command("devices"); await settle();
	assert.equal(f.selected().pin, "d3");
	assert.equal(f.selected().selected, "d3");
	f.store.refresh();
	assert.deepEqual(f.store.snapshot.user_order, order);
	await f.host.command("device d2"); await settle();
	assert.equal(f.selected().selected, "d3", "connected pin0 outranks temporary selection");
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	picker = async options => {
		const stale = options.snapshot();
		await options.onAction!({ kind: "pin", id: undefined }, stale);
		await options.onAction!({ kind: "pin", id: "d4" }, stale);
		return undefined;
	};
	await f.host.command("devices"); await settle();
	f.store.place("d3", 0); // Shared-session reorder supersedes the pending d2 handoff.
	await settle();
	proof.resolve(); await settle(); termination.mock.restore();
	assert.equal(f.selected().selected, "d3");
	assert.equal(f.selected().pin, undefined, "stale picker action cannot pin a replacement row");
	assert.equal(f.worker.outputs.at(-1), "unix:///fixture/d3");
	const before = f.worker.sent.length;
	const refresh = t.mock.method(DevicePriorityStore.prototype, "refresh");
	const discover = t.mock.method(DevicePriorityStore.prototype, "discover");
	for (let i = 0; i < 100; i++) f.poll();
	await settle();
	assert.equal(f.worker.sent.length, before);
	assert.equal(refresh.mock.callCount(), 0);
	assert.equal(discover.mock.callCount(), 0);
});

for (const manual of [false, true]) test(`automatic routing awaits ASR for review without submitting or replacing manual editor tickets (${manual})`, async t => {
	const f = await fixture(t, "auto", "local", { submitMode: "auto", editMode: "append" });
	let draft = "Existing draft";
	let submissions = 0;
	f.host.ctx.ui.getEditorText = () => draft;
	f.host.ctx.ui.setEditorText = (text: string) => { draft = text; };
	f.host.api.sendUserMessage = () => { submissions++; };
	const capture = Promise.withResolvers<PhoneCapture>();
	const record = t.mock.method(PhoneInputClient.prototype, "capture", () => capture.promise);
	const transcript = Promise.withResolvers<string[]>();
	t.mock.method(f.worker, "transcribe", () => transcript.promise);
	t.mock.method(PhoneInputClient.prototype, "stop", async () => { capture.resolve({ type: "audio", data: Buffer.from("mock audio") }); });
	t.mock.method(PhoneInputClient.prototype, "cancel", async () => {});
	await f.host.command("talk"); await settle();
	assert.equal(record.mock.callCount(), 1);
	await f.event("d2", "d3");
	assert.equal(f.selected().selected, "d3", "routing waits for delayed ASR");
	assert.equal(submissions, 0);
	if (manual) draft = "Manual editor ticket";
	transcript.resolve(["Nonempty dictation."]); await settle();
	assert.equal(f.selected().selected, "d2");
	await f.event("d3"); await f.event("d2", "d3");
	assert.equal(record.mock.callCount(), 1);
	assert.equal(submissions, 0);
	assert.equal(draft, manual ? "Manual editor ticket" : "Existing draft Nonempty dictation.");
	await assert.rejects(fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json")), { code: "ENOENT" });
});

test("forget clears a matching session pin and manual order without changing registration", async t => {
	const f = await fixture(t);
	f.store.place("d1", 0); await settle();
	picker = async options => {
		await options.onAction!({ kind: "pin", id: "d1" }, options.snapshot());
		return undefined;
	};
	await f.host.command("devices"); await settle();
	assert.equal(f.selected().pin, "d1");
	await f.host.command("device forget d1"); await settle();
	f.store.refresh();
	assert.equal(f.selected().pin, undefined);
	assert.equal(Object.hasOwn(f.store.snapshot.discovery, "d1"), false);
	assert.ok(!f.store.snapshot.user_order.includes("d1"));
	await f.event("d1", "d3");
	f.store.refresh();
	assert.ok(f.store.snapshot.discovery.d1, "future availability rediscovers, never blacklists");
});

test("higher arrival bypasses wait only after original scoped cleanup", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	await f.event("d4");
	await f.event("d2", "d4");
	assert.equal(f.selected().selected, "d2");
	assert.equal(f.worker.outputs.at(-1), "unix:///fixture/d2");
});


test("pin return adopts route even when F5 supersedes the pending resume", async t => {
	const f = await fixture(t);
	picker = async options => {
		await options.onAction!({ kind: "pin", id: "d2" }, options.snapshot());
		return undefined;
	};
	await f.host.command("devices"); await settle();
	await f.host.shortcut("f5"); await settle();
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	await f.event("d2", "d3");
	const replay = f.host.shortcut("f5"); await settle();
	proof.resolve(); await replay; await settle(); termination.mock.restore();
	assert.equal(f.selected().selected, "d2");
	assert.equal(f.worker.outputs.at(-1), "unix:///fixture/d2");
});

test("latest pinned arrival fences F5 superseding an in-flight handoff", async t => {
	const f = await fixture(t);
	picker = async options => {
		await options.onAction!({ kind: "pin", id: "d1" }, options.snapshot());
		return undefined;
	};
	await f.host.command("devices"); await settle();
	await f.host.shortcut("f5"); await settle();
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	await f.event("d2", "d3");
	const before = f.worker.outputs.length;
	const replay = f.host.shortcut("f5"); await settle();
	await f.event("d1", "d2", "d3");
	proof.resolve(); await replay; await settle(); termination.mock.restore();
	assert.equal(f.selected().selected, "d1");
	assert.ok(f.worker.outputs.length > before);
	assert.ok(f.worker.outputs.slice(before).every(output => output === "unix:///fixture/d1"));
});

for (const paused of [false, true]) test(`completed history handoff releases its speech lease at EOF (paused: ${paused})`, async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	if (paused) await f.host.shortcut("f8");
	await f.event("d2", "d3");
	if (paused) { await f.host.shortcut("f8"); await settle(); }
	const utterance = (f.worker.sent.at(-1) as any).utterance;
	f.worker.emit({ type: "idle", utterance }); await settle();
	await assert.rejects(fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json")), { code: "ENOENT" });
});

test("untracked test speech never resumes unrelated history on handoff", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	await f.host.command("test Unrelated test speech."); await settle();
	const before = f.worker.sent.length;
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	await f.event("d2", "d3");
	await fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json"));
	assert.equal(f.selected().selected, "d3");
	proof.resolve(); await settle(); termination.mock.restore();
	assert.equal(f.selected().selected, "d2");
	assert.equal(f.worker.sent.length, before);
	await assert.rejects(fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json")), { code: "ENOENT" });
});

test("reconnect retires waiting resume so F8 remains usable", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	await f.event();
	const proof = Promise.withResolvers<void>();
	const termination = t.mock.method(f.worker, "terminate", () => proof.promise);
	await f.event("d3");
	const reconnect = f.host.command("reconnect"); await settle();
	proof.resolve(); await reconnect; await settle(); termination.mock.restore();
	const before = f.worker.sent.length;
	await f.host.shortcut("f8"); await settle();
	assert.ok(f.worker.sent.length > before, "F8 resumes after explicit reconnect");
});

test("picker accepts a lower device added to its live snapshot", async t => {
	const f = await fixture(t);
	picker = async options => {
		await f.event("d3", "d4");
		assert.ok(options.snapshot().devices.some(row => row.id === "d4"));
		return "d4";
	};
	await f.host.command("devices"); await settle();
	assert.equal(f.selected().selected, "d4");
});

for (const changed of ["generation", "output", "input"]) test(`picker rejects a displayed device whose ${changed} changed after its snapshot`, async t => {
	const f = await fixture(t);
	picker = async options => {
		await f.event("d3", "d4");
		assert.ok(options.snapshot().devices.some(row => row.id === "d4"));
		const replacement = { ...device("d4"), ...(changed === "generation" ? { connectedAt: 2 }
			: changed === "output" ? { audioEndpoint: "unix:///fixture/replaced-output" } : { inputEndpoint: "unix:///fixture/replaced-input" }) };
		t.mock.method(DeviceRouter.prototype, "connected", () => [device("d3"), replacement]);
		return "d4";
	};
	await f.host.command("devices"); await settle();
	assert.equal(f.selected().selected, "d3");
});

for (const automatic of [false, true]) test(`automatic handoff retains real output scopes after wrong identity and partial cleanup (timer recovery: ${automatic})`, async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
	const bootId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	const endpoint = `unix://${join(f.root, "proof.sock")}`;
	let proveAll = false;
	const commands: string[] = [];
	const server = net.createServer(socket => socket.on("data", data => {
		const id = String(data).trim().split(" ")[1];
		commands.push(id);
		socket.end(`${JSON.stringify({ type: "stopped", id, proof: "reboot", expected_boot_id: bootId,
			boot_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", device_id: proveAll || id === ids[0] ? "d3" : "wrong-device" })}\n`);
	}));
	await new Promise<void>(resolve => server.listen(endpoint.slice(7), resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	for (const id of ids) f.worker.emit({ type: "remote-handle", output: "unix:///fixture/d3", id, utterance: 1, bootId, rebootSafe: true, deviceId: "d3" });
	const leasePath = join(f.root, "coordinator", "speech.lock", "lease.json");
	const owner = JSON.parse(await fs.readFile(leasePath, "utf8"));
	const retained = () => new StopRecovery(join(f.root, "coordinator"), owner.instanceId).episode("output")?.handles.map(handle => handle.id);
	const before = f.worker.sent.length;
	await f.event({ ...device("d3", 2), audioEndpoint: endpoint }, "d2");
	// Socket proof has real asynchronous IO, unlike the worker-only fixture.
	for (let i = 0; i < 100 && retained()?.length !== 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(retained(), [ids[1]], "only the correctly identified scope may retire");
	assert.equal(f.selected().selected, "d3");
	assert.equal(f.worker.sent.length, before);
	assert.equal(JSON.parse(await fs.readFile(leasePath, "utf8")).instanceId, owner.instanceId);
	await f.host.shortcut("f5"); await settle();
	assert.equal(f.worker.sent.length, before, "failed scoped proof fences superseding replay too");
	proveAll = true;
	if (automatic) await new Promise(resolve => setTimeout(resolve, 3_100));
	else await f.event({ ...device("d3", 2), audioEndpoint: endpoint }, "d2", "d4");
	for (let i = 0; i < 100 && f.selected().selected !== "d2"; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(retained(), undefined);
	assert.equal(f.selected().selected, "d2");
	await settle();
	assert.deepEqual((f.worker.sent.slice(before) as Array<{ text: string }>).map(s => s.text),
		["First sentence.", "Second sentence.", "Third sentence."], "successful scoped retry must resume the abandoned F5 exactly once");
	assert.ok(f.worker.outputs.slice(before).every(output => output === "unix:///fixture/d2"));
	assert.equal(f.worker.pauses.at(-1), false);
	for (let i = 0; i < 10; i++) f.poll();
	await settle();
	f.worker.emit({ type: "idle", utterance: (f.worker.sent.at(-1) as { utterance: number }).utterance }); await settle();
	assert.equal(f.worker.sent.length, before + 3, "neither stable polling nor EOF repeats the recovered replay");
	assert.ok(commands.includes(ids[1]));
	assert.equal(commands.filter(id => id === ids[0]).length, 1, "proved scopes are not retried");
});
