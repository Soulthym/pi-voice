import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { mock, test } from "node:test";
import { DeviceRouter, type ConnectionDevice } from "../src/device-router.js";
import type { VoiceConfig } from "../src/config.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant, streamBlockedResponse } from "./helpers/fake-voice-host.js";

class Worker extends MockedVoiceWorkerClient {
	outputs: string[] = [];
	override sendSegment(utterance: number, id: number, text: string, config?: VoiceConfig) {
		this.outputs.push(config!.output);
		super.sendSegment(utterance, id, text);
	}
}
mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: Worker } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test("cancelled reconnect rejection does not block later automatic local narration", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-cancelled-lookup-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR", "PI_VOICE_DEVICE_ID"];
	const old = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	delete process.env.PI_VOICE_DEVICE_ID;
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0 }));
	const resolve = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async (): Promise<ConnectionDevice> => ({ kind: "intentional_local" }));
	const host = new FakeVoiceHost(root, "cancelled-lookup");
	const index = Worker.instances.length;
	t.after(async () => {
		await host.shutdown();
		keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	const worker = Worker.instances[index] as Worker;
	const lookup = Promise.withResolvers<ConnectionDevice>();
	const started = Promise.withResolvers<void>();
	resolve.mock.mockImplementation(() => { started.resolve(); return lookup.promise; });
	const reconnect = host.command("reconnect");
	await started.promise;
	await host.command("stop");
	lookup.reject(new Error("obsolete identity lookup"));
	await reconnect; await settle();
	assert.ok(!host.notices.some(notice => notice.message.startsWith("Voice device:")), "obsolete adoption must not request a retry");
	await streamBlockedResponse(host, "Automatic local narration still works.");
	await settle();
	assert.ok(worker.sent.length, "cancelled lookup must not set the automatic narration retry gate");
	assert.ok(worker.outputs.every(output => output === "local"));
	assert.equal(resolve.mock.callCount(), 2, "automatic narration must not require another lookup");
});

test("session pins, fresh explicit attachment, read-only metadata and lookup/stop/rebind races", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-device-integration-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR", "PI_VOICE_DEVICE_ID"];
	const old = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	process.env.PI_VOICE_DEVICE_ID = "A";
	await fs.mkdir(process.env.PI_VOICE_DEVICE_DIR);
	for (const id of ["A", "B"]) await fs.writeFile(path.join(process.env.PI_VOICE_DEVICE_DIR, `${id}.json`), JSON.stringify({
		version: 1, id, name: id === "A" ? "Desktop 雪 'quoted'" : "Phone B", platform: "termux", audioEndpoint: `unix:///test/${id}`, inputEndpoint: `unix:///test/${id}-input`, connectedAt: 1, lastActive: 1,
	}));
	const config = JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0 });
	await fs.writeFile(process.env.PI_VOICE_CONFIG, config);
	let current: ConnectionDevice = { kind: "device", id: "A" };
	let lookup: Promise<ConnectionDevice> | undefined;
	const resolve = mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => lookup ?? Promise.resolve(current));
	const host = new FakeVoiceHost(root, "device");
	host.addMessage("a", null, assistant("First sentence. Second sentence."));
	const index = Worker.instances.length;
	t.after(async () => {
		await host.shutdown(); mock.restoreAll();
		keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	const worker = Worker.instances[index] as Worker;
	const pin = () => host.entries.filter(e => e.customType === "pi-voice.device-selection").at(-1)?.data.pin;
	assert.equal(pin(), "A");
	const connected = () => host.notices.filter(notice => notice.message.startsWith("Voice · Connected to "));
	assert.match(connected().at(-1)!.message, /^Voice · Connected to Desktop 雪 'quoted' · identity selected; audio readiness not checked$/);
	assert.equal(connected().length, 1);
	await host.command("output auto");
	assert.match(host.notices.at(-1)!.message, /Connected to Desktop/);
	await host.command("input auto");
	assert.match(host.notices.at(-1)!.message, /Connected to Desktop/);
	await host.command("input disabled");
	assert.match(host.notices.at(-1)!.message, /input: disabled/);
	const beforeAutomatic = connected().length;
	current = { kind: "device", id: "B" };
	await streamBlockedResponse(host, "Automatic narration stays on A.");
	assert.ok(worker.outputs.length);
	assert.ok(worker.outputs.every(output => output === "unix:///test/A"));
	assert.equal(resolve.mock.callCount(), 1);
	assert.equal(connected().length, beforeAutomatic, "automatic activity must not repeat connection toasts");
	await host.shortcut("f8");
	assert.equal(resolve.mock.callCount(), 1, "pause-only must not look up identity");
	await host.shortcut("f8"); await settle();
	assert.equal(pin(), "B", "resume adopts the fresh attachment in one action");
	assert.match(connected().at(-1)!.message, /^Voice · Connected to Phone B/);
	assert.equal(worker.outputs.at(-1), "unix:///test/B");
	await host.shortcut("f5"); await settle();
	assert.equal(pin(), "B");
	assert.equal(worker.outputs.at(-1), "unix:///test/B");
	assert.equal(process.env.PI_VOICE_DEVICE_ID, "A");

	const savedConfig = await fs.readFile(process.env.PI_VOICE_CONFIG, "utf8");
	const calls = resolve.mock.callCount();
	const sent = worker.sent.length;
	await host.command("device");
	assert.match(host.notices.at(-1)!.message, /B \(Phone B\)/);
	assert.equal(resolve.mock.callCount(), calls);
	const beforeReconnect = connected().length;
	await host.command("reconnect"); await settle();
	assert.equal(connected().length, beforeReconnect + 1, "one success notice per explicit reconnect");
	assert.equal(worker.sent.length, sent, "query/reconnect never starts playback");
	assert.equal(await fs.readFile(process.env.PI_VOICE_CONFIG, "utf8"), savedConfig, "queries and reconnect preserve the whole config file");

	// A paused navigation does not wait for or even request attachment identity.
	const deferred = Promise.withResolvers<ConnectionDevice>(); lookup = deferred.promise;
	const pausedCalls = resolve.mock.callCount();
	await host.shortcut("f7"); await settle();
	assert.equal(resolve.mock.callCount(), pausedCalls);
	assert.equal(worker.pauses.at(-1), true);
	await host.shortcut("f5"); await settle();
	const beforeStop = worker.sent.length;
	await host.command("stop");
	deferred.resolve({ kind: "device", id: "A" }); lookup = undefined;
	await settle();
	assert.equal(pin(), "B", "Stop fences late identity adoption");
	assert.equal(worker.sent.length, beforeStop, "Stop fences late playback");

	current = { kind: "device", id: "A" };
	const beforeReload = resolve.mock.callCount();
	await host.emit("session_start", {});
	assert.equal(pin(), "B", "reload restores the session pin, not a new attachment");
	assert.equal(resolve.mock.callCount(), beforeReload);
	const beforeFailure = connected().length;
	lookup = Promise.reject(new Error("Multiple attached clients; identity is ambiguous"));
	await host.command("reconnect"); lookup = undefined;
	assert.equal(pin(), "B", "ambiguous reconnect never selects another device");
	assert.match(host.notices.at(-1)!.message, /ambiguous/);
	assert.equal(connected().length, beforeFailure, "failed lookup must not announce connected");
	assert.equal(worker.sent.length, beforeStop);
	current = { kind: "device", id: "B" };
	await fs.rm(path.join(process.env.PI_VOICE_DEVICE_DIR, "B.json"));
	await host.command("device");
	assert.match(host.notices.at(-1)!.message, /unavailable/);
	await host.command("test Missing device."); await settle();
	assert.equal(worker.sent.length, beforeStop, "missing pin cannot fall back to local or A");
	assert.ok(!worker.outputs.some(output => String(output) === "local"));

	// Old-device termination must finish before explicit playback can use a new pin.
	current = { kind: "device", id: "A" };
	await host.command("test Active A.");
	const active = worker.sent.at(-1) as { utterance: number };
	worker.emit({ type: "error", utterance: active.utterance, message: "Reverse forward accepted but client disconnected" });
	await settle();
	const failedCount = worker.sent.length;
	await streamBlockedResponse(host, "Must not retry a failed transport automatically.");
	assert.equal(worker.sent.length, failedCount);
	await host.command("test Explicit retry A.");
	assert.ok(worker.sent.length > failedCount);
	const terminated = Promise.withResolvers<void>();
	const termination = mock.method(worker, "terminate", () => terminated.promise);
	current = { kind: "device", id: "B" };
	const beforeBlockedRebind = connected().length;
	const reconnect = host.command("reconnect"); await settle();
	assert.equal(connected().length, beforeBlockedRebind, "no connected toast before stop proof");
	assert.equal(termination.mock.callCount(), 1);
	const beforeRebind = worker.sent.length;
	await host.shortcut("f5"); await settle();
	assert.equal(worker.sent.length, beforeRebind);
	terminated.resolve(); await reconnect; await settle();
	assert.equal(connected().length, beforeBlockedRebind, "unavailable registration cannot claim connected");
	assert.equal(worker.sent.length, beforeRebind, "missing B does not start after old sink terminates");
});

for (const setting of ["device", "input", "output"]) test(`${setting} setters fence stale requests and tolerate metadata-only failures`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-setting-race-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR", "PI_VOICE_DEVICE_ID"];
	const old = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	delete process.env.PI_VOICE_DEVICE_ID;
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0 }));
	const resolve = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async (): Promise<ConnectionDevice> => ({ kind: "intentional_local" }));
	const host = new FakeVoiceHost(root, "setting-race");
	t.after(async () => {
		await host.shutdown();
		keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	for (const fail of [false, true]) {
		const lookup = Promise.withResolvers<ConnectionDevice>();
		resolve.mock.mockImplementation(() => lookup.promise);
		const reconnect = host.command("reconnect");
		await settle();
		const notices = host.notices.length;
		const stale = host.command(`${setting} ${setting === "device" ? "auto" : "tcp://localhost:12345"}`);
		await settle();
		const latest = host.command(`${setting} local`);
		await settle();
		if (fail) lookup.reject(new Error("ambiguous metadata"));
		else lookup.resolve({ kind: "intentional_local" });
		await Promise.all([reconnect, stale, latest]);
		await host.command(setting);
		assert.match(host.notices.at(-1)!.message, new RegExp(`${setting}: local`));
		assert.equal(host.notices.slice(notices).filter(n => n.message.includes("Connected to")).length, 1, "only the current setter announces success");
		assert.equal(host.notices.slice(notices).some(n => n.message.includes("Stop unconfirmed")), false, "metadata failures are not stop failures");
	}
	// Session replacement also invalidates a setter waiting on metadata.
	const lookup = Promise.withResolvers<ConnectionDevice>();
	resolve.mock.mockImplementation(() => lookup.promise);
	const reconnect = host.command("reconnect");
	await settle();
	const stale = host.command(`${setting} ${setting === "device" ? "auto" : "tcp://localhost:12345"}`);
	await settle();
	const snapshot = await fs.readFile(process.env.PI_VOICE_CONFIG, "utf8");
	const replacement = host.emit("session_start", {});
	await settle();
	lookup.resolve({ kind: "intentional_local" });
	await Promise.all([reconnect, stale, replacement]);
	assert.equal(await fs.readFile(process.env.PI_VOICE_CONFIG, "utf8"), snapshot);
	await host.command(setting);
	assert.match(host.notices.at(-1)!.message, new RegExp(`${setting}: local`));
	const hostname = t.mock.method(os, "hostname");
	try {
		for (const name of ["bad\u001b[31mhost", "\u00a0\ufeff", "bad\u202ehost", "x".repeat(129)]) {
			hostname.mock.mockImplementation(() => name);
			syncBuiltinESMExports();
			await host.command(`${setting} local`);
			assert.match(host.notices.at(-1)!.message, /Connected to local device ·/);
			assert.ok(!host.notices.at(-1)!.message.includes(name));
		}
	} finally { hostname.mock.restore(); syncBuiltinESMExports(); }
});
