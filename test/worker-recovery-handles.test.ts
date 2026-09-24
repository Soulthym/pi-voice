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
	child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});
