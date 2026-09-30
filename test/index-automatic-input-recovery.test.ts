import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import test, { mock } from "node:test";
import { DeviceRouter } from "../src/device-router.js";
import { StopRecovery } from "../src/stop-recovery.js";
import { FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(resolve => setImmediate(resolve)); };

for (const failedOutput of [false, true]) test(`automatic input recovery preserves draft, pin, and fence until both resources resolve (failed output: ${failedOutput})`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-auto-input-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_ID: "A" };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
	const host = new FakeVoiceHost(root, "input-owner");
	const original = `unix://${path.join(root, "old.sock")}`;
	const moved = `unix://${path.join(root, "moved.sock")}`;
	const ticket = `${"a".repeat(32)}.1`;
	const boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	const commands: string[] = [];
	const sockets = new Set<net.Socket>();
	const admitted = Promise.withResolvers<void>();
	let grantClosed = false;
	let identity = "B";
	const servers: net.Server[] = [];
	for (const endpoint of [original, moved]) {
		const server = net.createServer(socket => {
			sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
			socket.on("data", data => {
				const command = String(data).trim(); commands.push(`${endpoint} ${command}`);
				if (command === "ticket-admit") {
					socket.on("end", () => { grantClosed = true; });
					socket.write(`ticket ${ticket} ${boot} admit-v1 "A"\n`);
				} else if (command === `record ${ticket} ${boot}`) admitted.resolve();
				else if (endpoint === moved && command === `stop-admit ${ticket} ${boot} A`) {
					assert.equal(grantClosed, true);
					socket.end(`ok ${Buffer.from(`stopped-reboot ${ticket} ${boot} bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb ${identity}`).toString("base64")}\n`);
				} else socket.end("error dW5jb25maXJtZWQ=\n");
			});
		});
		servers.push(server); await new Promise<void>(resolve => server.listen(endpoint.slice(7), resolve));
	}
	t.after(async () => {
		t.mock.timers.reset(); identity = "A"; await host.shutdown().catch(() => {});
		for (const socket of sockets) socket.destroy();
		await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.mkdir(env.PI_VOICE_DEVICE_DIR);
	const register = (endpoint: string) => fs.writeFile(path.join(env.PI_VOICE_DEVICE_DIR, "A.json"), JSON.stringify({ version: 1, id: "A", name: "Original", platform: "linux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 2, lastActive: 2 }));
	await register(original);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "auto", output: "local", editMode: "append", submitMode: "auto", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const lookup = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "A" }));
	t.mock.method(DeviceRouter.prototype, "route", async function(this: DeviceRouter, ...args: Parameters<DeviceRouter["route"]>) { return this.routeMetadata(...args); });
	let editor = "Manual draft";
	let submitted = 0;
	host.ctx.ui.getEditorText = () => editor;
	host.ctx.ui.setEditorText = (text: string) => { editor = text; };
	host.api.sendUserMessage = () => { submitted++; };
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await host.start(); await host.shortcut("f4"); await admitted.promise;
	let outputProven = !failedOutput;
	const terminate = t.mock.method(MockedVoiceWorkerClient.prototype, "terminate", async () => {
		if (!outputProven) throw new Error("output stop unconfirmed");
	});
	const fence = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
	const owner = JSON.parse(await fs.readFile(fence, "utf8"));
	const journal = () => new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, owner.instanceId);
	t.mock.timers.tick(3_000); await settle();
	assert.equal(commands.filter(command => command.includes(" stop")).length, 0, "healthy admission isn't a stop failure");
	await host.command("stop"); await settle();
	editor = "New manual draft";
	assert.match(host.widgetLines()!.join("\n"), /Input stop unconfirmed/);
	if (failedOutput) assert.match(host.widgetLines()!.join("\n"), /Output stop unconfirmed/);
	outputProven = true;
	await register(moved);
	const lookups = lookup.mock.callCount();
	lookup.mock.mockImplementation(async () => { throw new Error("ambiguous new attachment"); });
	t.mock.timers.tick(3_000); await settle();
	assert.equal(journal().isIdle("input"), false);
	assert.equal(JSON.parse(await fs.readFile(fence, "utf8")).instanceId, owner.instanceId);
	assert.equal(commands.filter(command => command.includes("stop-admit")).length, 1);
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /Output stop unconfirmed/);
	const outputStops = terminate.mock.callCount();
	identity = "A";
	t.mock.timers.tick(6_000); await settle();
	assert.equal(journal().isIdle("input"), true);
	assert.equal(terminate.mock.callCount(), outputStops, "later input proof does not retry already-proven output");
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /Input stop unconfirmed/);
	assert.equal(editor, "New manual draft"); assert.equal(submitted, 0);
	assert.equal(commands.filter(command => command.endsWith("ticket-admit")).length, 1, "recovery never records again");
	assert.equal(lookup.mock.callCount(), lookups, "original registered identity only; no pin adoption");
	await assert.rejects(fs.stat(fence), { code: "ENOENT" });
	await host.command("input disabled");
	assert.equal(JSON.parse(await fs.readFile(env.PI_VOICE_CONFIG, "utf8")).input, "disabled", "successful proof replaces the rejected input barrier");
});
