import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";

function coordinators() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-coordinator-"));
	const first = new SessionCoordinator("/work/alpha/app", "one", root);
	const second = new SessionCoordinator("/other/beta/app", "two", root);
	first.start();
	second.start();
	return { root, first, second };
}

test("grants speech to only the first session and records waiting attention", () => {
	const { root, first, second } = coordinators();
	try {
		assert.equal(first.tryAcquireSpeech(), true);
		assert.equal(second.speechOwner()?.instanceId, first.instanceId);
		assert.equal(second.tryAcquireSpeech(), false);
		assert.equal(second.forceAcquireSpeech(), true);
		assert.equal(first.ownsSpeech(), false);
		assert.equal(second.ownsSpeech(), true);
		second.releaseSpeech();
		assert.equal(first.tryAcquireSpeech(), true);
		const waiting = second.markWaiting();
		assert.equal(second.isWaiting(), true);
		assert.equal(first.isWaiting(second.instanceId), true);
		assert.equal(first.nextUnannouncedWaiting()?.instanceId, waiting.instanceId);
		first.markAnnounced(waiting.instanceId);
		assert.equal(first.nextUnannouncedWaiting(), undefined);
		first.releaseSpeech();
		assert.equal(second.tryAcquireSpeech(), true);
		second.clearWaiting();
		assert.equal(second.isWaiting(), false);
		assert.equal(first.waitingSessions().length, 0);
	} finally {
		first.shutdown();
		second.shutdown();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("routes an explicit attention request to the waiting session", () => {
	const { root, first, second } = coordinators();
	try {
		second.markWaiting();
		first.requestAttention(second.instanceId);
		assert.equal(first.hasAttentionRequest(), false);
		assert.equal(second.hasAttentionRequest(), true);
		assert.equal(second.consumeAttentionRequest(), true);
		assert.equal(second.consumeAttentionRequest(), false);
	} finally {
		first.shutdown();
		second.shutdown();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("uses parent directories only to disambiguate equal project names", () => {
	const { root, first, second } = coordinators();
	try {
		assert.equal(first.projectLabel(), "alpha/app");
		assert.equal(second.projectLabel(), "beta/app");
	} finally {
		first.shutdown();
		second.shutdown();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("shares preprocessing concurrency slots across sessions", async () => {
	const { root, first, second } = coordinators();
	let active = 0;
	let maximum = 0;
	try {
		await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				(index % 2 === 0 ? first : second).withResource("timing", 2, async () => {
					active += 1;
					maximum = Math.max(maximum, active);
					await new Promise(resolve => setTimeout(resolve, 10));
					active -= 1;
				}),
			),
		);
		assert.equal(maximum, 2);
	} finally {
		first.shutdown();
		second.shutdown();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
