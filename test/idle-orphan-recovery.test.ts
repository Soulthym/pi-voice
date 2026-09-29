import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { StopRecovery } from "../src/stop-recovery.js";
import { PhoneInputClient } from "../src/phone-input.js";
import { DeviceRouter } from "../src/device-router.js";

for (const evidence of ["idle", "input", "output", "legacy", "missing", "malformed"] as const) {
	test(`only durable never-admitted owners recover: ${evidence}`, t => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-idle-orphan-"));
		const first = new SessionCoordinator(root, "first", root);
		const second = new SessionCoordinator(root, "second", root);
		t.after(() => { first.shutdown(); second.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
		first.start(); second.start();
		assert.equal(first.recovery.isIdle("input"), true);
		assert.equal(first.recovery.isIdle("output"), true);
		assert.equal(first.tryAcquireSpeech(), true);
		if (evidence === "input" || evidence === "output") {
			first.recovery.beforeIO(evidence);
			first.recovery.clear(evidence); // Cleanup/empty handle lists never reset admission coverage.
		} else if (evidence === "legacy") fs.writeFileSync(first.recovery.file, '{"version":1}');
		else if (evidence === "missing") fs.unlinkSync(first.recovery.file);
		else if (evidence === "malformed") fs.writeFileSync(first.recovery.file, '{"version":2}');
		const file = path.join(root, "speech.lock", "lease.json");
		const live = second.speechOwner()!;
		assert.equal(second.recoverIdleSpeech(live), false, "heartbeat expiry is not authority death");
		fs.writeFileSync(file, JSON.stringify({ ...live, pid: 2147483647, updatedAt: 0 }));
		const dead = second.speechOwner()!;
		const kill = t.mock.method(process, "kill", () => { throw Object.assign(new Error("unknown authority"), { code: "EPERM" }); });
		assert.equal(second.recoverIdleSpeech(dead), false, "unknown authority cannot authorize recovery");
		kill.mock.restore();
		assert.equal(second.recoverIdleSpeech({ ...dead, speechGeneration: "stale-generation" }), false);
		assert.equal(second.recoverIdleSpeech({ ...dead, instanceId: "wrong-owner" }), false);
		const fd = fs.openSync(path.join(root, ".speech-mutation.lock"), "a");
		try {
			assert.equal(spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "pipe", fd] }).status, 0);
			assert.equal(second.recoverIdleSpeech(dead), false, "all mutation paths serialize");
			assert.equal(second.tryAcquireSpeech(), false);
		} finally { fs.closeSync(fd); }
		const before = fs.readFileSync(file, "utf8");
		assert.equal(second.recoverIdleSpeech(dead), evidence === "idle");
		if (evidence !== "idle") assert.equal(fs.readFileSync(file, "utf8"), before);
		else {
			assert.equal(second.tryAcquireSpeech(), true);
			assert.equal(second.recoverIdleSpeech(dead), false, "stale recovery cannot remove replacement");
			assert.equal(second.ownsSpeech(), true);
		}
	});
}

test("old evidence cannot be initialized as complete; failed persistence blocks admission and can be retried", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-admission-ledger-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const ledger = new StopRecovery(root, "new-owner");
	assert.equal(ledger.isIdle("input"), false, "missing is not idle");
	assert.throws(() => ledger.beforeIO("input"), /unavailable/);
	ledger.initialize();
	assert.throws(() => ledger.initialize(), /already exists/);
	assert.throws(() => new StopRecovery(root, "new-owner").initialize(), /already exists/);
	fs.renameSync(ledger.file, `${ledger.file}.backup`);
	fs.mkdirSync(ledger.file);
	const input = new PhoneInputClient(undefined, undefined, () => ledger.beforeIO("input"));
	await assert.rejects(input.capture("not-an-endpoint"), /EISDIR|ENOTDIR/);
	fs.rmdirSync(ledger.file);
	await assert.rejects(input.capture("not-an-endpoint"), /Invalid URL/);
	assert.equal(new StopRecovery(root, "new-owner").isIdle("input"), false);
	assert.equal(new StopRecovery(root, "new-owner").isIdle("output"), true);
});

test("ledger initialization failure prevents ownership", t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-init-failure-"));
	const owner = new SessionCoordinator(root, "new", root);
	t.after(() => { owner.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
	fs.writeFileSync(path.join(root, "stop-recovery"), "not a directory");
	assert.throws(() => owner.start());
	assert.throws(() => owner.tryAcquireSpeech());
	assert.equal(fs.existsSync(path.join(root, "speech.lock")), false);
});

for (const outputUncertain of [false, true]) test(`desktop input scoped reclaim requires other direction idle (output uncertain: ${outputUncertain})`, async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-input-orphan-"));
	const first = new SessionCoordinator(root, "first", root);
	const second = new SessionCoordinator(root, "second", root);
	t.after(() => { first.shutdown(); second.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
	first.start(); second.start(); assert.equal(first.tryAcquireSpeech(), true);
	first.recovery.beforeIO("input", false, true);
	const handle = { endpoint: "local", id: `${"a".repeat(32)}.1`, bootId: "12345678-1234-1234-1234-123456789abc", desktopWait: true, selection: "local", configured: "local" };
	first.recovery.retain("input", handle, "Desktop");
	if (outputUncertain) first.recovery.beforeIO("output");
	const file = path.join(root, "speech.lock", "lease.json");
	fs.writeFileSync(file, JSON.stringify({ ...second.speechOwner(), pid: 2147483647, updatedAt: 0 }));
	const dead = second.speechOwner()!;
	assert.equal(second.recoverIdleSpeech(dead), false);
	const receipt = t.mock.method(PhoneInputClient, "retryStop", async () => { throw new Error("missing wait receipt"); });
	const recovered = new StopRecovery(root, first.instanceId);
	await assert.rejects(recovered.retry("input", new DeviceRouter(root), "local"), /missing wait/);
	assert.equal(second.recoverIdleSpeech(dead), false);
	receipt.mock.restore();
	t.mock.method(PhoneInputClient, "retryStop", async (value: Parameters<typeof PhoneInputClient.retryStop>[0]) => { assert.deepEqual(value, { endpoint: "local", ticket: handle.id, bootId: handle.bootId, desktopWait: true }); });
	await recovered.retry("input", new DeviceRouter(root), "local");
	assert.equal(second.recoverIdleSpeech({ ...dead, speechGeneration: "wrong" }), false);
	// Local output remains uncertain even when every capture has a receipt.
	assert.equal(second.recoverIdleSpeech(dead), !outputUncertain);
});

for (const version of [2, 3]) test(`desktop wait handles do not upgrade v${version} input coverage`, async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-input-legacy-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const fresh = new StopRecovery(root, "owner"); fresh.initialize();
	fs.writeFileSync(fresh.file, JSON.stringify({ version, owner: "owner", admission: { input: "uncertain", output: "idle" } }));
	const legacy = new StopRecovery(root, "owner");
	legacy.beforeIO("input", false, true); legacy.clear("input");
	await legacy.retry("input", new DeviceRouter(root), "local");
	assert.equal(legacy.isIdle("input"), false);
	assert.equal(JSON.parse(fs.readFileSync(fresh.file, "utf8")).version, version);
});

test("malformed or empty speech fences are never stale-cleaned", t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-empty-fence-"));
	const owner = new SessionCoordinator(root, "new", root);
	t.after(() => { owner.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
	owner.start();
	fs.mkdirSync(path.join(root, "speech.lock"));
	fs.utimesSync(path.join(root, "speech.lock"), 0, 0);
	assert.equal(owner.tryAcquireSpeech(), false);
	assert.equal(fs.existsSync(path.join(root, "speech.lock")), true);
});
