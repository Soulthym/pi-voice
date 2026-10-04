import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";

const phone = { kind: "device", id: "phone" } as const;
function fixture(t: test.TestContext, heartbeat = true) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "waiting-generation-"));
	const owner = new SessionCoordinator("/owner", "owner", root);
	const sender = new SessionCoordinator("/sender", "sender", root);
	if (heartbeat) { owner.start(); sender.start(); }
	else { owner.setAttentionEnabled(true); sender.setAttentionEnabled(true); }
	t.after(() => { owner.shutdown(); sender.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
	const file = (directory: string) => path.join(root, directory, `${sender.instanceId}.json`);
	const change = (directory: string, values: object) => fs.writeFileSync(file(directory), JSON.stringify({
		...JSON.parse(fs.readFileSync(file(directory), "utf8")), ...values,
	}));
	return { root, owner, sender, file, change };
}

test("waiting batch survives old snapshot with fresh matching presence and keeps its generation", t => {
	const { owner, sender, change } = fixture(t);
	const waiting = sender.markWaiting(phone);
	change("waiting", { updatedAt: Date.now() - 60_000, waitingSince: 1 });
	assert.equal(owner.waitingSessions().length, 1);
	assert.equal(owner.nextUnannouncedWaiting(phone)?.waitingSince, 1);
	assert.ok(waiting.generation);
	assert.equal(owner.markAnnounced(waiting), true);
	const repeated = sender.markWaiting({ kind: "device", id: "other" });
	assert.equal(repeated.generation, waiting.generation);
	assert.equal(repeated.waitingSince, 1);
	assert.equal(repeated.announced, true);
	assert.deepEqual(repeated.connection, phone, "pending origin cannot silently retarget");
});

test("old delivery ACK cannot announce a replacement or resurrect a cleared batch", t => {
	const { owner, sender, file } = fixture(t);
	const old = sender.markWaiting(phone);
	sender.clearWaiting();
	assert.equal(owner.markAnnounced(old), false);
	assert.equal(fs.existsSync(file("waiting")), false);
	const next = sender.markWaiting(phone);
	assert.notEqual(next.generation, old.generation);
	assert.equal(owner.markAnnounced(old.instanceId, old.generation), false);
	assert.equal(owner.markAnnounced(next.instanceId), false, "legacy unscoped ACK fails closed");
	assert.equal(owner.nextUnannouncedWaiting(phone)?.generation, next.generation);
	assert.equal(owner.markAnnounced(next.instanceId, next.generation), true);
	assert.equal(owner.nextUnannouncedWaiting(phone), undefined);
});

for (const invalid of [{ updatedAt: 0 }, { pid: 2147483647 }, { attentionEnabled: false }, { instanceId: "impostor" }, { sessionId: "replacement" }, { cwd: "/other" }]) {
	test(`waiting purges nonmatching/dead/disabled presence ${JSON.stringify(invalid)}`, t => {
		const { owner, sender, change, file } = fixture(t);
		sender.markWaiting(phone);
		change("sessions", invalid);
		assert.deepEqual(owner.waitingSessions(), []);
		assert.equal(fs.existsSync(file("waiting")), false);
	});
}

test("announcement requires matching proven device, not unrelated idle or unknown route", t => {
	const { owner, sender } = fixture(t);
	sender.markWaiting(phone);
	assert.equal(owner.tryAcquireWaitingAnnouncement(), undefined);
	assert.equal(owner.tryAcquireWaitingAnnouncement({ kind: "device", id: "other" }), undefined);
	assert.equal(owner.tryAcquireWaitingAnnouncement({ kind: "intentional_local" }), undefined);
	assert.equal(owner.ownsSpeech(), false);
	assert.equal(sender.tryAcquireSpeech(), true);
	assert.equal(owner.tryAcquireWaitingAnnouncement(phone), undefined, "matching device never bypasses owner fence");
	sender.releaseSpeech();
	assert.equal(owner.tryAcquireWaitingAnnouncement({ ...phone, target: "fresh-alias" })?.instanceId, sender.instanceId);
});

test("cross-process ACK rereads its generation under the waiting mutation lock", async t => {
	const { root, owner, sender, change } = fixture(t, false);
	const old = sender.markWaiting(phone);
	const fd = fs.openSync(path.join(root, ".waiting-mutation.lock"), "a", 0o600);
	assert.equal(spawnSync("flock", ["3"], { stdio: ["ignore", "ignore", "pipe", fd] }).status, 0);
	const script = `
		const { SessionCoordinator } = await import(${JSON.stringify(path.resolve("src/session-coordinator.ts"))});
		const coordinator = new SessionCoordinator('/ack', 'ack', ${JSON.stringify(root)});
		process.stdout.write('ready\\n');
		console.log(coordinator.markAnnounced(${JSON.stringify(old)}));
	`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout.on("data", chunk => { stdout += String(chunk); });
	child.stderr.on("data", chunk => { stderr += String(chunk); });
	const closed = new Promise(resolve => child.once("close", resolve));
	try {
		const deadline = Date.now() + 5_000;
		while (!stdout.includes("ready") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
		assert.match(stdout, /ready/, stderr);
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(stdout.trim(), "ready", "ACK must wait for the writer, not read/write unlocked");
		change("waiting", { generation: "replacement", announced: false });
	} finally { fs.closeSync(fd); }
	assert.equal(await closed, 0, stderr);
	assert.match(stdout, /false/);
	assert.equal(owner.nextUnannouncedWaiting(phone)?.generation, "replacement");
});

test("unknown origin cannot be guessed and explicit requests still expire after eight seconds", t => {
	const { root, owner, sender, change } = fixture(t);
	sender.markWaiting();
	assert.equal(owner.nextUnannouncedWaiting(phone), undefined);
	sender.clearWaiting(); sender.markWaiting(phone);
	owner.requestAttention(sender.instanceId, phone);
	const file = path.join(root, "attention", `${sender.instanceId}.json`);
	const request = JSON.parse(fs.readFileSync(file, "utf8"));
	request.requestedAt = Date.now() - 8_001;
	fs.writeFileSync(file, JSON.stringify(request));
	change("waiting", { updatedAt: 0 });
	assert.equal(sender.takeAttentionRequest(), undefined);
	assert.equal(sender.isWaiting(), true);
});
