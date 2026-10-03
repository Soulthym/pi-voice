import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
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
	override sendSegment(utterance: number, segmentId: number, text: string, config?: VoiceConfig) {
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
	const interval = globalThis.setInterval;
	t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number, ...args: unknown[]) => {
		if (ms === 1_000) { poll = callback; return interval(() => {}, 100_000); }
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
	return { host, worker, store, selected, event, progress, poll: routePoll, root };
}

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

test("completed history handoff releases its speech lease at EOF", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	await f.event("d2", "d3");
	const utterance = (f.worker.sent.at(-1) as any).utterance;
	f.worker.emit({ type: "idle", utterance }); await settle();
	await assert.rejects(fs.stat(join(f.root, "coordinator", "speech.lock", "lease.json")), { code: "ENOENT" });
});

test("untracked test speech never resumes unrelated history on handoff", async t => {
	const f = await fixture(t);
	await f.host.shortcut("f5"); await settle();
	await f.host.command("test Unrelated test speech."); await settle();
	const before = f.worker.sent.length;
	await f.event("d2", "d3");
	assert.equal(f.selected().selected, "d2");
	assert.equal(f.worker.sent.length, before);
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

test("automatic handoff retains real output scopes after wrong identity and partial cleanup", async t => {
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
	await f.event({ ...device("d3", 2), audioEndpoint: endpoint }, "d2", "d4");
	for (let i = 0; i < 100 && f.selected().selected !== "d2"; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(retained(), undefined);
	assert.equal(f.selected().selected, "d2");
	assert.ok(commands.includes(ids[1]));
	assert.equal(commands.filter(id => id === ids[0]).length, 1, "proved scopes are not retried");
});
