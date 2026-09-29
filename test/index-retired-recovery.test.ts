import assert from "node:assert/strict";
import * as childProcessModule from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { mock, test } from "node:test";
import { DeviceRouter } from "../src/device-router.js";
import { FakeVoiceHost, assistant } from "./helpers/fake-voice-host.js";

const children: Array<EventEmitter & { pid: number; exitCode: null; signalCode: null; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }> = [];
function childProcess() {
	const child = Object.assign(new EventEmitter(), { pid: 987654, exitCode: null, signalCode: null,
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
	child.stdin.on("data", data => {
		for (const line of String(data).trim().split("\n")) {
			const command = JSON.parse(line);
			if (command.type === "cancel") child.stdout.write(`${JSON.stringify({ type: "idle", cancelId: command.cancelId })}\n`);
			if (command.type === "shutdown") queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit("close"); });
		}
	});
	children.push(child);
	return child;
}
mock.module("node:child_process", { namedExports: { ...childProcessModule, spawn: childProcess } });
let failSync = false;
mock.module("node:fs", { defaultExport: { ...fsSync }, namedExports: { ...fsSync, fsyncSync(fd: number) {
	if (failSync) throw new Error("injected retirement fsync failure");
	fsSync.fsyncSync(fd);
} } });
const { StopRecovery } = await import("../src/stop-recovery.js");
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };

for (const replace of [false, true]) for (const journalOnly of [false, true]) test(`real worker replays original scopes (replacement: ${replace}, journal only: ${journalOnly})`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-retired-real-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_ID: "A" };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const host = new FakeVoiceHost(root, "original");
	const replacement = new FakeVoiceHost(root, "replacement");
	const original = `unix://${path.join(root, "old.sock")}`;
	const moved = `unix://${path.join(root, "new.sock")}`;
	const id = "11111111-1111-4111-8111-111111111111";
	const boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	let identity = "B";
	const commands: string[] = [];
	const server = net.createServer(socket => socket.on("data", data => {
		commands.push(String(data));
		socket.end(`${JSON.stringify({ type: "stopped", id, proof: "reboot", expected_boot_id: boot, boot_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", device_id: identity })}\n`);
	}));
	await new Promise<void>(resolve => server.listen(moved.slice(7), resolve));
	t.after(async () => {
		identity = "A";
		await replacement.command("reconnect").catch(() => {});
		await host.shutdown().catch(() => {});
		await replacement.shutdown().catch(() => {});
		await new Promise<void>(resolve => server.close(() => resolve()));
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	const kill = process.kill;
	t.mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid === -987654) throw Object.assign(new Error("mock group gone"), { code: "ESRCH" });
		return kill(pid, signal);
	}) as typeof process.kill);
	await fs.mkdir(env.PI_VOICE_DEVICE_DIR);
	const register = (endpoint: string) => fs.writeFile(path.join(env.PI_VOICE_DEVICE_DIR, "A.json"), JSON.stringify({ version: 1, id: "A", name: "Original", platform: "linux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 2, lastActive: 2 }));
	await register(original);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "A" }));
	t.mock.method(DeviceRouter.prototype, "route", async function(this: DeviceRouter, ...args: Parameters<DeviceRouter["route"]>) { return this.routeMetadata(...args); });
	host.addMessage("answer", null, assistant("A replayable answer."));
	await host.start();
	await host.shortcut("f5"); await settle();
	const child = children.at(-1)!;
	assert.ok(child);
	child.stdout.write(`${JSON.stringify({ type: "remote-handle", output: original, id, utterance: 1, bootId: boot, rebootSafe: true, deviceId: "A" })}\n`);
	const fence = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
	const owner = JSON.parse(await fs.readFile(fence, "utf8"));
	const ledger = () => new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, owner.instanceId);
	assert.equal(ledger().episode("output")?.handles[0].id, id);
	if (journalOnly) {
		failSync = true;
		try { child.stdout.write(`${JSON.stringify({ type: "remote-released", id })}\n`); }
		finally { failSync = false; }
		assert.equal(ledger().episode("output")?.handles[0].id, id);
	}
	if (replace) await assert.rejects(host.shutdown());
	await register(moved);
	if (replace) {
		await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local", timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
		await replacement.start();
	}
	const current = replace ? replacement : host;
	await current.command("reconnect");
	assert.equal(JSON.parse(await fs.readFile(fence, "utf8")).instanceId, owner.instanceId, "wrong device receipt retains original same-PID lease");
	identity = "A";
	await current.command("reconnect"); await settle();
	assert.equal(ledger().isIdle("output"), true);
	assert.ok(commands.length >= 2, "real worker/journal cleanup reached the moved original device");
	if (replace) await assert.rejects(fs.stat(fence), { code: "ENOENT" });
});
