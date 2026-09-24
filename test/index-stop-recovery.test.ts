import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { DeviceRouter } from "../src/device-router.js";
import { PhoneInputClient } from "../src/phone-input.js";
import { StopRecovery } from "../src/stop-recovery.js";
import { FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });

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
	assert.equal(input.mock.callCount(), journalAvailable ? 1 : 0);
	if (journalAvailable) assert.deepEqual(input.mock.calls[0].arguments, [{ endpoint: "unix:///reconnected-input", ticket }]);
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
