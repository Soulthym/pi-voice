import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import test from "node:test";
import { StopRecovery } from "../src/stop-recovery.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { DeviceRouter } from "../src/device-router.js";

const handle = { endpoint: "unix:///unused", id: "11111111-1111-4111-8111-111111111111", bootId: "22222222-2222-4222-8222-222222222222", selection: "local", configured: "unix:///unused" };
function rootFor(t: import("node:test").TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-output-ledger-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

test("public output scopes bound endpoint and configuration sizes before journaling", t => {
	const ledger = new StopRecovery(rootFor(t), "owner");
	ledger.initialize();
	for (const field of ["endpoint", "configured"] as const) {
		assert.throws(() => ledger.retain("output", { ...handle, [field]: `unix:///${"x".repeat(4096)}` }, "device"), /Invalid recovery handle/);
	}
	assert.equal(ledger.isIdle("output"), true);
});

test("covered output remains fenced until all receipts and closed dispatch are durable", t => {
	const root = rootFor(t);
	const ledger = new StopRecovery(root, "owner");
	ledger.initialize();
	ledger.beforeIO("output", true);
	ledger.retain("output", handle, "device");
	ledger.retain("output", { ...handle, id: "33333333-3333-4333-8333-333333333333" }, "device");
	ledger.fail("output", "device", "lost acknowledgement");
	ledger.clear("output");
	assert.equal(ledger.episode("output")?.handles.length, 2);
	ledger.retire("output", handle.id);
	ledger.clear("output");
	assert.equal(ledger.isIdle("output"), false);
	ledger.retire("output", "33333333-3333-4333-8333-333333333333");
	fs.renameSync(ledger.file, `${ledger.file}.backup`);
	fs.mkdirSync(ledger.file);
	assert.throws(() => ledger.clear("output"));
	assert.equal(ledger.isIdle("output"), false, "failed durability cannot publish in-memory idle");
	fs.rmdirSync(ledger.file);
	ledger.clear("output");
	const restored = new StopRecovery(root, "owner");
	assert.equal(restored.isIdle("output"), true);
	assert.equal(restored.isIdle("input"), true);
});

test("dead covered empty dispatch recovers only under matching generation and every direction idle", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-output-ledger-"));
	const owner = new SessionCoordinator(root, "first", root);
	const next = new SessionCoordinator(root, "second", root);
	t.after(() => { owner.shutdown(); next.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
	owner.start(); next.start();
	assert.equal(owner.tryAcquireSpeech(), true);
	owner.recovery.beforeIO("output", true); // Crash before prepare/grant: no physical resource can exist.
	const lease = next.speechOwner()!;
	fs.writeFileSync(path.join(root, "speech.lock", "lease.json"), JSON.stringify({ ...lease, pid: 2147483647 }));
	const dead = next.speechOwner()!;
	assert.equal(next.recoverIdleSpeech(dead), false);
	const restored = new StopRecovery(root, dead.instanceId);
	await restored.retry("output", new DeviceRouter(path.join(root, "devices"), "local", {}), "auto");
	assert.equal(next.recoverIdleSpeech({ ...dead, speechGeneration: "wrong" }), false);
	assert.equal(next.recoverIdleSpeech(dead), true);
	assert.equal(next.tryAcquireSpeech(), true);
});

test("orphan retry needs exact original boot receipt before durable idle", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-output-ledger-"));
	let exact = false;
	const socketPath = path.join(root, "output.sock");
	const endpoint = `unix://${socketPath}`;
	const server = net.createServer(socket => socket.on("data", () => socket.end(`${JSON.stringify({ type: "stopped", id: handle.id, boot_id: exact ? handle.bootId : "44444444-4444-4444-8444-444444444444" })}\n`)));
	await new Promise<void>(resolve => server.listen(socketPath, resolve));
	t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
	const ledger = new StopRecovery(root, "owner");
	ledger.initialize();
	ledger.beforeIO("output", true);
	ledger.retain("output", { ...handle, endpoint, configured: endpoint }, "device");
	const restored = new StopRecovery(root, "owner");
	const router = new DeviceRouter(path.join(root, "devices"), "local", {});
	await assert.rejects(restored.retry("output", router, endpoint), /missing scoped/);
	assert.equal(new StopRecovery(root, "owner").episode("output")?.handles.length, 1);
	exact = true;
	await restored.retry("output", router, endpoint);
	assert.equal(new StopRecovery(root, "owner").isIdle("output"), true);
	assert.equal(new StopRecovery(root, "owner").isIdle("input"), true);
});

for (const kind of ["local", "legacy", "input"] as const) test(`${kind} uncertainty cannot be upgraded by complete output receipts`, t => {
	const root = rootFor(t);
	const ledger = new StopRecovery(root, "owner");
	ledger.initialize();
	if (kind === "legacy") fs.writeFileSync(ledger.file, JSON.stringify({ version: 2, owner: "owner", admission: { input: "idle", output: "uncertain" } }));
	const current = new StopRecovery(root, "owner");
	if (kind === "local") current.beforeIO("output");
	if (kind === "input") current.beforeIO("input");
	current.beforeIO("output", true);
	current.retain("output", handle, "device");
	current.retire("output", handle.id);
	current.clear("output");
	assert.equal(current.isIdle("input") && current.isIdle("output"), false);
});
