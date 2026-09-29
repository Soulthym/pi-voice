import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import type { RemoteOutputStop } from "../src/worker-client.js";
import test, { mock } from "node:test";
import { DeviceRouter } from "../src/device-router.js";
import { normalizeVoiceOutput } from "../src/config.js";
import { PhoneInputClient } from "../src/phone-input.js";
import { StopRecovery } from "../src/stop-recovery.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });

test("live reconnect supplies durable recovery to shutdown and fences foreground until scoped proof", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-live-index-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_ID: "A" };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const host = new FakeVoiceHost(root, "live-owner");
	let stopped = false;
	t.after(async () => {
		stopped = true;
		await host.shutdown().catch(() => {});
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	const original = `unix://${path.join(root, "old.sock")}`;
	const current = `unix://${path.join(root, "new.sock")}`;
	const id = "11111111-1111-4111-8111-111111111111";
	const bootId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	let identity = "B";
	const commands: string[] = [];
	const server = net.createServer(socket => socket.on("data", data => {
		commands.push(String(data));
		socket.end(`${JSON.stringify({ type: "stopped", id, proof: "reboot", expected_boot_id: bootId,
			boot_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", device_id: identity })}\n`);
	}));
	await new Promise<void>(resolve => server.listen(current.slice(7), resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	await fs.mkdir(env.PI_VOICE_DEVICE_DIR);
	const registration = (endpoint: string) => fs.writeFile(path.join(env.PI_VOICE_DEVICE_DIR, "A.json"), JSON.stringify({ version: 1, id: "A", name: "Original", platform: "linux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 2, lastActive: 2 }));
	await registration(original);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const lookup = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "A" }));
	t.mock.method(DeviceRouter.prototype, "route", async function(this: DeviceRouter, ...args: Parameters<DeviceRouter["route"]>) { return this.routeMetadata(...args); });
	host.addMessage("answer", null, assistant("A replayable answer."));
	const index = MockedVoiceWorkerClient.instances.length;
	await host.start();
	const worker = MockedVoiceWorkerClient.instances[index]!;
	await host.shortcut("f5");
	for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
	assert.ok(worker.sent.length);
	worker.emit({ type: "remote-handle", output: original, id, utterance: 1, bootId, rebootSafe: true, deviceId: "A" });
	t.mock.method(worker, "terminate", async (stopScope?: RemoteOutputStop) => {
		if (stopped) return;
		if (!stopScope) throw new Error("saved endpoint unavailable");
		await stopScope({ output: original, id, bootId });
		stopped = true;
		worker.emit({ type: "remote-released", id });
	});
	await registration(current);
	await host.command("reconnect");
	assert.equal(stopped, false);
	assert.match(host.widgetLines()!.join("\n"), /Output stop unconfirmed/);
	await fs.stat(path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json"));
	const sent = worker.sent.length;
	await host.shortcut("f5");
	for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
	assert.equal(worker.sent.length, sent, "replay cannot bypass failed recovery");
	identity = "A";
	lookup.mock.mockImplementation(async () => { throw new Error("ambiguous current attachment"); });
	await host.command("reconnect");
	assert.equal(stopped, true, "original-device cleanup precedes unrelated current-attachment lookup");
	lookup.mock.mockImplementation(async () => ({ kind: "device" as const, id: "A" }));
	await host.command("reconnect");
	assert.ok(commands.length >= 2);
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /Output stop unconfirmed/);
	assert.equal(worker.sent.length, sent, "reconnect does not resume playback");
});

for (const [stopFirst, replace] of [[false, false], [true, false], [true, true]]) test(`live network input reconnect proves the original moved device before adopting a new pin (stop first: ${stopFirst}, replacement: ${replace})`, { timeout: 15_000 }, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-live-input-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_ID: "A" };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const host = new FakeVoiceHost(root, "live-input-owner");
	const replacement = new FakeVoiceHost(root, "replacement-input-owner");
	let currentHost = host;
	const ticket = `${"a".repeat(32)}.1`;
	const boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	const original = `unix://${path.join(root, "old.sock")}`;
	const moved = `unix://${path.join(root, "moved.sock")}`;
	const commands: string[] = [];
	const sockets = new Set<net.Socket>();
	const admitted = Promise.withResolvers<void>();
	let identity = "B";
	let grantClosed = false;
	const servers: net.Server[] = [];
	t.after(async () => {
		identity = "A";
		await currentHost.command("reconnect").catch(() => {});
		await host.shutdown().catch(() => {});
		if (replace) await replacement.shutdown().catch(() => {});
		for (const socket of sockets) socket.destroy();
		await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	for (const endpoint of [original, moved]) {
		const server = net.createServer(socket => {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
			socket.on("data", data => {
				const command = String(data).trim();
				commands.push(`${endpoint} ${command}`);
				if (command === "ticket-admit") {
					socket.on("end", () => { grantClosed = true; });
					socket.write(`ticket ${ticket} ${boot} admit-v1 A\n`);
				} else if (command === `record ${ticket} ${boot}`) admitted.resolve();
				else if (endpoint === moved && command === `stop-admit ${ticket} ${boot} A`) {
					assert.equal(grantClosed, true, "close the live grant before ledger recovery");
					socket.end(`ok ${Buffer.from(`stopped-reboot ${ticket} ${boot} bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb ${identity}`).toString("base64")}\n`);
				} else socket.end("error dW5jb25maXJtZWQ=\n");
			});
		});
		servers.push(server);
		await new Promise<void>(resolve => server.listen(endpoint.slice(7), resolve));
	}
	await fs.mkdir(env.PI_VOICE_DEVICE_DIR);
	const register = (id: string, endpoint: string) => fs.writeFile(path.join(env.PI_VOICE_DEVICE_DIR, `${id}.json`), JSON.stringify({ version: 1, id, name: id, platform: "linux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 2, lastActive: 2 }));
	await register("A", original);
	await register("B", `unix://${path.join(root, "new-pin.sock")}`);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "auto", output: "local", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const lookup = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "A" }));
	t.mock.method(DeviceRouter.prototype, "route", async function(this: DeviceRouter, ...args: Parameters<DeviceRouter["route"]>) { return this.routeMetadata(...args); });
	await host.start();
	await host.shortcut("f4");
	await admitted.promise;
	const fence = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
	const owner = JSON.parse(await fs.readFile(fence, "utf8"));
	const ledger = () => new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, owner.instanceId);
	assert.equal(ledger().episode("input")!.handles[0].endpoint, original);
	if (stopFirst) {
		await host.command("stop");
		for (let i = 0; i < 100 && !host.widgetLines()!.join("\n").includes("Input stop unconfirmed"); i++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.match(host.widgetLines()!.join("\n"), /Input stop unconfirmed/);
	}
	if (replace) {
		await assert.rejects(host.shutdown());
		await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local", timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
		await replacement.start();
		currentHost = replacement;
	}
	await register("A", moved);
	lookup.mock.mockImplementation(async () => ({ kind: "device" as const, id: "B" }));
	const lookups = lookup.mock.callCount();
	const admissions = commands.filter(command => command.endsWith("ticket-admit")).length;
	if (stopFirst) {
		await currentHost.command("reconnect");
		if (!replace) assert.match(host.widgetLines()!.join("\n"), /Input stop unconfirmed/);
		assert.equal(JSON.parse(await fs.readFile(fence, "utf8")).instanceId, owner.instanceId);
		assert.equal(ledger().episode("input")!.handles[0].id, ticket);
		assert.equal(lookup.mock.callCount(), lookups, "wrong-device proof cannot adopt the new pin");
		await currentHost.shortcut("f4");
		assert.equal(commands.filter(command => command.endsWith("ticket-admit")).length, admissions, "failed recovery keeps capture fenced");
	}
	identity = "A";
	lookup.mock.mockImplementation(async () => { throw new Error("ambiguous attachment after input proof"); });
	await currentHost.command("reconnect");
	assert.equal(ledger().isIdle("input"), true);
	for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
	assert.doesNotMatch(currentHost.widgetLines()!.join("\n"), /Input stop unconfirmed/);
	assert.ok(lookup.mock.callCount() > lookups);
	assert.equal(commands.filter(command => command === `${moved} stop-admit ${ticket} ${boot} A`).length, stopFirst ? 2 : 1);
	assert.equal(commands.filter(command => command.endsWith("ticket-admit")).length, admissions, "reconnect never starts a new recording");
	await currentHost.command("input disabled");
	assert.equal(JSON.parse(await fs.readFile(env.PI_VOICE_CONFIG, "utf8")).input, "disabled", "proved recovery clears rejected cancellation");
	await assert.rejects(fs.stat(fence), { code: "ENOENT" }, "proved reconnect must release the microphone ownership fence");
});

for (const manual of [false, true]) test(`healthy retained capture finishes to review before reconnect recovery (manual edit: ${manual})`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-healthy-capture-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_ID: "A" };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const host = new FakeVoiceHost(root, "healthy-input");
	const endpoint = `unix://${path.join(root, "input.sock")}`;
	const ticket = `${"a".repeat(32)}.1`;
	const boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	let capture: net.Socket | undefined;
	const admitted = Promise.withResolvers<void>();
	const server = net.createServer(socket => socket.on("data", data => {
		const command = String(data).trim();
		if (command === "ticket-admit") socket.write(`ticket ${ticket} ${boot} admit-v1 A\n`);
		else if (command === `record ${ticket} ${boot}`) { capture = socket; admitted.resolve(); }
		else if (command === `stop ${ticket}`) {
			capture?.end(`ok ${Buffer.from("Healthy dictation.").toString("base64")}\n`);
			socket.end(`ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`);
		} else socket.end("error dW5jb25maXJtZWQ=\n");
	}));
	await new Promise<void>(resolve => server.listen(endpoint.slice(7), resolve));
	t.after(async () => {
		await host.shutdown().catch(() => {});
		await new Promise<void>(resolve => server.close(() => resolve()));
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.mkdir(env.PI_VOICE_DEVICE_DIR);
	await fs.writeFile(path.join(env.PI_VOICE_DEVICE_DIR, "A.json"), JSON.stringify({ version: 1, id: "A", name: "A", platform: "linux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 2, lastActive: 2 }));
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "auto", output: "local", editMode: "append", submitMode: "auto", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "A" }));
	t.mock.method(DeviceRouter.prototype, "route", async function(this: DeviceRouter, ...args: Parameters<DeviceRouter["route"]>) { return this.routeMetadata(...args); });
	let editor = "Draft.";
	let submitted = 0;
	host.ctx.ui.getEditorText = () => editor;
	host.ctx.ui.setEditorText = (text: string) => { editor = text; };
	host.api.sendUserMessage = () => { submitted++; };
	await host.start();
	await host.shortcut("f4"); await admitted.promise;
	const owner = JSON.parse(await fs.readFile(path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json"), "utf8"));
	assert.equal(new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, owner.instanceId).episode("input")?.handles[0].id, ticket);
	if (manual) editor = "Manual draft";
	await host.command("reconnect");
	assert.equal(submitted, 0);
	if (manual) assert.equal(editor, "Manual draft");
	else assert.match(editor, /Healthy dictation/);
	assert.equal(new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, owner.instanceId).isIdle("input"), true);
});

test("single-slash Unix config normalizes to the sink's remote prefix", () => {
	assert.equal(normalizeVoiceOutput("unix:/test-output"), "unix:///test-output");
});

for (const diesAfterStartup of [false, true]) for (const journalAvailable of [true, false]) for (const retryFails of [false, true]) test(`startup restores orphan warnings without stop IO; explicit reconnect retains fence (journal: ${journalAvailable}, late death: ${diesAfterStartup}, retry failure: ${retryFails})`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-recovery-index-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator") };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const host = new FakeVoiceHost(root, "new-owner");
	t.after(async () => {
		await host.shutdown().catch(() => {});
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.mkdir(env.PI_VOICE_DEVICE_DIR);
	await fs.writeFile(path.join(env.PI_VOICE_DEVICE_DIR, "A.json"), JSON.stringify({ version: 1, id: "A", name: "Original device", platform: "linux", audioEndpoint: "unix:///old-output", inputEndpoint: "unix:///reconnected-input", connectedAt: 2, lastActive: 2 }));
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "all", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const fence = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
	await fs.mkdir(path.dirname(fence), { recursive: true });
	const owner = JSON.stringify({ kind: "speech", instanceId: "dead-owner", pid: 2147483647, interactive: true, updatedAt: 1, cwd: root, sessionId: "previous" });
	await fs.writeFile(fence, owner);
	const ticket = `${"a".repeat(32)}.12`;
	if (journalAvailable) {
		const journal = new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, "dead-owner");
		journal.retain("input", { endpoint: "unix:///old-input", id: ticket, selection: "A", configured: "auto" }, "Original device");
		journal.fail("input", "Original device", "lost recorder receipt");
		journal.fail("output", "Original device", "lost player scope");
	}
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => { throw new Error("ambiguous new connection"); });
	const input = t.mock.method(PhoneInputClient, "retryStop", async () => { if (retryFails) throw new Error("recorder still disconnected"); });
	const firstWorker = MockedVoiceWorkerClient.instances.length;
	let alive = diesAfterStartup;
	const kill = process.kill.bind(process);
	t.mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid === 2147483647 && alive) return true;
		return kill(pid, signal);
	}) as typeof process.kill);
	await host.start();
	assert.equal(input.mock.callCount(), 0, "startup never sends recovered stop commands");
	const worker = MockedVoiceWorkerClient.instances[firstWorker]!;
	worker.emit({ type: "ready" });
	worker.emit({ type: "idle" });
	const rows = () => host.widgetLines()!.join("\n");
	if (!diesAfterStartup) {
		assert.match(rows(), /Input stop unconfirmed/);
		assert.match(rows(), /Output stop unconfirmed/);
		if (journalAvailable) assert.match(rows(), /Original device.*lost recorder receipt/);
	}
	alive = false;
	await host.command("reconnect");
	assert.ok(host.notices.some(notice => notice.message.includes("Interrupted transport coverage remains unproven. Ownership retained; reconnect cannot reconstruct missing admission evidence. Preserve the original device receipts and see docs/troubleshooting.md#unconfirmed-stop; restarting or deleting the fence is not stop proof.")), JSON.stringify(host.notices));
	assert.equal(input.mock.callCount(), journalAvailable ? 1 : 0);
	if (journalAvailable) assert.deepEqual(input.mock.calls[0].arguments, [{ endpoint: "unix:///reconnected-input", ticket, bootId: undefined, deviceId: "A", allowReboot: false }]);
	assert.equal(await fs.readFile(fence, "utf8"), owner);
	assert.match(rows(), /Output stop unconfirmed/);
	const before = input.mock.callCount();
	const failures = () => host.notices.filter(notice => /recorder still disconnected|no retained output scope/.test(notice.message)).length;
	const notices = failures();
	if (journalAvailable && retryFails) assert.equal(notices, 2, "each orphan resource reports its initial failure");
	await host.command("reconnect");
	assert.equal(input.mock.callCount(), before + (journalAvailable && retryFails ? 1 : 0), "only unresolved scopes are retried");
	assert.equal(failures(), notices, "repeated reconnect preserves each inherited resource's notification episode");
	assert.equal(await fs.readFile(fence, "utf8"), owner);
	assert.equal(worker.sent.length, 0);
	await host.shutdown();
	await host.emit("session_start", { type: "session_start" });
	assert.equal(await fs.readFile(fence, "utf8"), owner, "own transport-free lifecycle never releases inherited fence");
	assert.match(rows(), /Output stop unconfirmed/);
});

test("covered empty output orphan reconnect retires durably without inventing an input episode", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-covered-index-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator") };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const host = new FakeVoiceHost(root, "replacement");
	t.after(async () => {
		await host.shutdown().catch(() => {});
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const ledger = new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, "dead-owner");
	ledger.initialize();
	ledger.beforeIO("output", true);
	const file = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
	await fs.mkdir(path.dirname(file));
	await fs.writeFile(file, JSON.stringify({ kind: "speech", instanceId: "dead-owner", pid: 2147483647, speechGeneration: "original-generation", interactive: true, updatedAt: 1, cwd: root, sessionId: "previous" }));
	const resolveConnection = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
	await host.start();
	assert.match(host.widgetLines()!.join("\n"), /Output stop unconfirmed/);
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /Input stop unconfirmed/);
	const beforeReconnect = resolveConnection.mock.callCount();
	const previousNotices = host.notices.length;
	await host.command("reconnect");
	assert.ok(resolveConnection.mock.callCount() > beforeReconnect, "successful recovery continues connection adoption");
	assert.equal(host.notices.slice(previousNotices).some(notice => /Previous voice owner stop remains unconfirmed/.test(notice.message)), false);
	await assert.rejects(fs.stat(file), { code: "ENOENT" });
	const restored = new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, "dead-owner");
	assert.equal(restored.isIdle("output"), true);
	assert.equal(restored.isIdle("input"), true);
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /stop unconfirmed/);
});

for (const [admitted, output] of [[false, "local"], [true, "local"], [true, "tcp:local-player"], [true, "unix:/test-output"]] as const) test(`new-format orphan after disconnected F5 vs output admission (${admitted}, ${output})`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-idle-index-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator") };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const host = new FakeVoiceHost(root, "first");
	const replacement = new FakeVoiceHost(root, "replacement");
	t.after(async () => {
		await host.shutdown().catch(() => {}); await replacement.shutdown().catch(() => {});
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
	host.addMessage("answer", null, assistant("A replayable answer."));
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	await host.start();
	const file = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
	let snapshot: string | undefined;
	const route = DeviceRouter.prototype.routeMetadata;
	t.mock.method(DeviceRouter.prototype, "routeMetadata", function(this: DeviceRouter, ...args: Parameters<typeof route>) {
		if (!admitted && snapshot && args[1] === "output") throw new Error("F5 device disconnected before route validation");
		const resolved = route.apply(this, args);
		return args[1] === "output" ? { ...resolved, endpoint: output } : resolved;
	});
	const acquire = SessionCoordinator.prototype.tryAcquireSpeech;
	t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech", function(this: SessionCoordinator) {
		const acquired = acquire.call(this);
		if (acquired) snapshot = JSON.stringify(this.speechOwner());
		return acquired;
	});
	// The fake worker is the first boundary that could dispatch a remote handshake/local player.
	const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
	const send = worker.sendSegment.bind(worker);
	t.mock.method(worker, "sendSegment", (...args: Parameters<typeof send>) => {
		const owner = JSON.parse(snapshot!);
		const ledger = new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, owner.instanceId);
		assert.equal(ledger.isIdle("output"), false, "write-ahead precedes worker dispatch, not stream-ID receipt");
		assert.equal(ledger.isIdle("input"), true);
		assert.equal(JSON.parse(readFileSync(ledger.file, "utf8")).admission.output, "uncertain", "only sink-recognized remote prefixes have covered admission");
		send(...args);
	});
	await host.shortcut("f5");
	for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
	assert.ok(snapshot, "F5 acquired ownership before route validation");
	assert.equal(worker.sent.length > 0, admitted, JSON.stringify(host.notices));
	const owner = JSON.parse(snapshot!);
	const ledger = new StopRecovery(env.PI_VOICE_COORDINATOR_DIR, owner.instanceId);
	assert.equal(ledger.isIdle("input"), true);
	assert.equal(ledger.isIdle("output"), !admitted);
	await host.shutdown();
	// Reconstruct only this test's interrupted owner: never touch live state.
	await fs.mkdir(path.dirname(file), { recursive: true });
	const fence = JSON.stringify({ ...owner, kind: "speech", pid: 2147483647 });
	await fs.writeFile(file, fence);
	await replacement.start();
	const rows = replacement.widgetLines()!.join("\n");
	assert.doesNotMatch(rows, /Input stop unconfirmed/, "durably idle input is not a microphone failure");
	if (admitted) {
		assert.match(rows, /Output stop unconfirmed/);
		await replacement.command("reconnect");
		assert.equal(await fs.readFile(file, "utf8"), fence, "empty handles are not complete accounting");
	} else {
		assert.doesNotMatch(rows, /Output stop unconfirmed/);
		await assert.rejects(fs.stat(file), { code: "ENOENT" });
	}
});
