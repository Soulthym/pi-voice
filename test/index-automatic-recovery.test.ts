import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import test, { mock } from "node:test";
import { DeviceRouter } from "../src/device-router.js";
import { PhoneInputClient } from "../src/phone-input.js";
import { StopRecovery } from "../src/stop-recovery.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";
import type { RemoteOutputStop } from "../src/worker-client.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(resolve => setImmediate(resolve)); };
const id = "11111111-1111-4111-8111-111111111111";
const bootId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

for (const retired of [false, true]) test(`automatic recovery ignores healthy scopes, retries only original native scope, never resumes (retired: ${retired})`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-auto-stop-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_ID: "A" };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const host = new FakeVoiceHost(root, "original");
	const replacement = new FakeVoiceHost(root, "replacement");
	let stopped = false;
	let acknowledged = false;
	const original = `unix://${path.join(root, "old.sock")}`;
	const moved = `unix://${path.join(root, "moved.sock")}`;
	const commands: string[] = [];
	const server = net.createServer(socket => socket.on("data", data => {
		commands.push(String(data));
		socket.end(JSON.stringify({ type: "stopped", id, boot_id: bootId, proof: acknowledged ? "native-process-exit" : undefined }) + "\n");
	}));
	await new Promise<void>(resolve => server.listen(moved.slice(7), resolve));
	t.after(async () => {
		t.mock.timers.reset(); stopped = true;
		await host.shutdown().catch(() => {}); await replacement.shutdown().catch(() => {});
		await new Promise<void>(resolve => server.close(() => resolve()));
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.mkdir(env.PI_VOICE_DEVICE_DIR);
	const register = (endpoint: string) => fs.writeFile(path.join(env.PI_VOICE_DEVICE_DIR, "A.json"), JSON.stringify({ version: 1, id: "A", name: "Original", platform: "linux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 2, lastActive: 2 }));
	await register(original);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const lookup = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "A" }));
	t.mock.method(DeviceRouter.prototype, "route", async function(this: DeviceRouter, ...args: Parameters<DeviceRouter["route"]>) { return this.routeMetadata(...args); });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	host.addMessage("answer", null, assistant("A replayable answer."));
	const index = MockedVoiceWorkerClient.instances.length;
	await host.start(); await host.shortcut("f5"); await settle();
	const worker = MockedVoiceWorkerClient.instances[index]!;
	worker.emit({ type: "remote-handle", output: original, id, utterance: 1, bootId, rebootSafe: true, deviceId: "A", nativeWatchdog: true });
	const fence = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
	const owner = JSON.parse(await fs.readFile(fence, "utf8"));
	const ledger = () => new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, owner.instanceId);
	assert.equal(ledger().episode("output")!.handles[0].nativeWatchdog, true, "event capability persists without inference");
	const terminate = t.mock.method(worker, "terminate", async (stopScope?: RemoteOutputStop) => {
		if (stopped) return;
		if (!stopScope) throw new Error("original sink disconnected");
		await stopScope({ output: original, id, bootId });
		stopped = true;
		worker.emit({ type: "remote-released", id });
	});
	for (let i = 0; i < 3; i++) { t.mock.timers.tick(3_000); await settle(); }
	assert.equal(terminate.mock.callCount(), 0, "healthy retained output must never trigger shutdown");
	assert.equal(commands.length, 0);
	if (retired) {
		await assert.rejects(host.shutdown());
		await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local", timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
		await replacement.start();
	} else {
		await host.command("stop"); await settle();
		assert.match(host.widgetLines()!.join("\n"), /Output stop unconfirmed/);
	}
	const current = retired ? replacement : host;
	const sent = worker.sent.length;
	const pauses = [...worker.pauses];
	const lookups = lookup.mock.callCount();
	lookup.mock.mockImplementation(async () => { throw new Error("new attachment is ambiguous"); });
	await register(moved);
	t.mock.timers.tick(3_000); await settle();
	assert.equal(commands.length, 1);
	assert.equal(stopped, false, "legacy proof is not native watchdog proof");
	const notices = current.notices.length;
	t.mock.timers.tick(6_000); await settle();
	assert.equal(commands.length, 2);
	assert.equal(current.notices.length, notices, "same episode notification is coalesced");
	acknowledged = true;
	t.mock.timers.tick(12_000); await settle();
	assert.equal(stopped, true);
	assert.equal(ledger().isIdle("output"), true);
	assert.equal(worker.sent.length, sent, "proof never resumes playback");
	assert.deepEqual(worker.pauses, pauses, "recovery does not change pause intent");
	assert.equal(lookup.mock.callCount(), lookups, "recovery refreshes original registration, never adopts current attachment");
	assert.doesNotMatch(current.widgetLines()!.join("\n"), /Output stop unconfirmed/);
	await assert.rejects(fs.stat(fence), { code: "ENOENT" });
	await current.shutdown();
	const count = commands.length;
	t.mock.timers.tick(120_000); await settle();
	assert.equal(commands.length, count, "shutdown cancels retry timers");
});

for (const variant of ["dead", "alive", "legacy", "unknown-input"] as const) test(`automatic orphan eligibility: ${variant}`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-auto-orphan-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator") };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
	const host = new FakeVoiceHost(root, "replacement");
	t.after(async () => {
		t.mock.timers.reset(); await host.shutdown().catch(() => {});
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "local", output: "local", timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const ledger = new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, "old-owner"); ledger.initialize();
	ledger.beforeIO("input", false, variant !== "unknown-input");
	if (variant !== "unknown-input") ledger.retain("input", { endpoint: "local", id: `${"a".repeat(32)}.1`, bootId, desktopWait: true, configured: "local", selection: "local" }, "Original");
	const file = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json"); await fs.mkdir(path.dirname(file));
	const fence = JSON.stringify({ kind: "speech", instanceId: "old-owner", pid: variant === "alive" ? process.pid : 2147483647, speechGeneration: variant === "legacy" ? undefined : "original", interactive: true, updatedAt: 1, cwd: root });
	await fs.writeFile(file, fence);
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
	const retry = t.mock.method(PhoneInputClient, "retryStop", async () => {});
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await host.start();
	assert.equal(retry.mock.callCount(), 0);
	t.mock.timers.tick(3_000); await settle();
	assert.equal(retry.mock.callCount(), variant === "dead" ? 1 : 0);
	if (variant === "dead") await assert.rejects(fs.stat(file), { code: "ENOENT" });
	else assert.equal(await fs.readFile(file, "utf8"), fence);
	t.mock.timers.tick(60_000); await settle();
	assert.equal(retry.mock.callCount(), variant === "dead" ? 1 : 0, "no unknown/unscoped microphone stop spam");
});
