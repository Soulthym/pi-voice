import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { boundedStopRecovery, StopRecovery } from "../src/stop-recovery.js";
import { DeviceRouter } from "../src/device-router.js";
import { PhoneInputClient } from "../src/phone-input.js";
import { SessionCoordinator } from "../src/session-coordinator.js";

for (const supersede of ["timeout", "generation", "owner"] as const) test(`bounded coalesced retry rejects late ${supersede} proof`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-auto-guard-"));
	t.after(async () => { t.mock.timers.reset(); await fs.rm(root, { recursive: true, force: true }); });
	const journal = new StopRecovery(root, "original"); journal.initialize(); journal.beforeIO("input", false, true);
	const handle = { endpoint: "local", id: `${"a".repeat(32)}.1`, selection: "local", configured: "local", bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", desktopWait: true };
	journal.retain("input", handle, "Original");
	journal.fail("input", "Original", "Initial recorder disconnect");
	const stopped = Promise.withResolvers<void>();
	const retry = t.mock.method(PhoneInputClient, "retryStop", () => stopped.promise);
	const router = new DeviceRouter(path.join(root, "devices"), undefined, {});
	let current = true;
	let raw: Promise<void> | undefined;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const attempt = boundedStopRecovery(signal => {
		raw = journal.retry("input", router, "local", { signal, current: () => current });
		assert.equal(journal.retry("input", router, "local"), raw, "duplicates share original in-flight scope");
		return raw;
	});
	const rejected = assert.rejects(attempt, supersede === "timeout" ? /20000ms/ : /ownership retained/);
	if (supersede === "timeout") { t.mock.timers.tick(20_000); await rejected; }
	if (supersede === "generation") journal.retain("input", { ...handle, id: `${"b".repeat(32)}.2` }, "Original");
	if (supersede === "owner") current = false;
	stopped.resolve();
	await rejected;
	await assert.rejects(raw!);
	assert.equal(retry.mock.callCount(), 1);
	assert.equal(journal.isIdle("input"), false);
	assert.equal(new StopRecovery(root, "original").episode("input")!.originalCause, "Initial recorder disconnect");
	assert.ok(journal.episode("input")!.handles.some(scope => scope.id === handle.id), "late receipt cannot clear a newer attempt/owner");
});

test("orphan recovery compares owner generation and requires ESRCH, not stale heartbeat", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-auto-authority-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const coordinator = new SessionCoordinator(root, "replacement", root);
	const file = path.join(root, "speech.lock", "lease.json"); await fs.mkdir(path.dirname(file));
	const expected = { kind: "speech", interactive: true as const, instanceId: "dead", pid: 2147483647, speechGeneration: "original", cwd: root, updatedAt: 0 };
	await fs.writeFile(file, JSON.stringify(expected));
	assert.equal(coordinator.canRecoverSpeech(expected), true);
	const pending = Promise.withResolvers<void>();
	let calls = 0;
	const first = coordinator.withSpeechRecovery(expected, async () => { calls++; await pending.promise; });
	const other = new SessionCoordinator(root, "other", root);
	await other.withSpeechRecovery(expected, async () => { calls++; });
	assert.equal(calls, 1, "duplicate sessions cannot issue overlapping stop requests");
	pending.resolve(); await first;
	await other.withSpeechRecovery(expected, async () => { calls++; });
	assert.equal(calls, 2, "settled recovery releases its lock");
	await fs.writeFile(file, JSON.stringify({ ...expected, speechGeneration: "new" }));
	assert.equal(coordinator.canRecoverSpeech(expected), false);
	await fs.writeFile(file, JSON.stringify({ ...expected, pid: process.pid }));
	assert.equal(coordinator.canRecoverSpeech({ ...expected, pid: process.pid }), false);
});
