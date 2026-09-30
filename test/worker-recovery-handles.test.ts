import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";

test("worker forwards validated original scopes to the durable recovery observer", async t => {
	const child = Object.assign(new EventEmitter(), {
		pid: 12345, exitCode: null, signalCode: null,
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
	});
	mock.module("node:child_process", { namedExports: { spawn: () => child } });
	t.after(() => mock.reset());
	const { VoiceWorkerClient } = await import("../src/worker-client.js");
	const events: unknown[] = [];
	const worker = new VoiceWorkerClient(event => events.push(event));
	worker.sendSegment(1, 1, "Mock only", DEFAULT_VOICE_CONFIG);
	const handle = { type: "remote-handle", output: "unix:///original", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", utterance: 1 };
	child.stdout.write(`${JSON.stringify(handle)}\n`);
	child.stdout.write(`${JSON.stringify({ ...handle, id: "invalid" })}\n`);
	assert.deepEqual(events, [handle]);
	child.stdout.write(`${JSON.stringify({ type: "remote-released", id: handle.id })}\n`);
	child.stdout.write(`${JSON.stringify({ type: "remote-released", id: handle.id })}\n`);
	assert.deepEqual(events, [handle, { type: "remote-released", id: handle.id }]);
	child.stdout.write(`${JSON.stringify(handle)}\n`);
	child.stdout.write(`${JSON.stringify({ type: "remote-not-admitted", id: handle.id })}\n`);
	assert.deepEqual(events.slice(-2), [handle, { type: "remote-not-admitted", id: handle.id }]);
	const bootId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	child.stdout.write(`${JSON.stringify({ ...handle, bootId, nativeWatchdog: true })}\n`);
	mock.method(process, "kill", () => { throw Object.assign(new Error("Synthetic group is gone"), { code: "ESRCH" }); }); // Never signal a real process group.
	const scopes: unknown[] = [];
	const stopped = worker.terminate(async scope => { scopes.push(scope); });
	child.emit("close", 0, null);
	await stopped;
	assert.deepEqual(scopes, [{ output: handle.output, id: handle.id, utterance: 1, bootId, nativeWatchdog: true }]);
	child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});
