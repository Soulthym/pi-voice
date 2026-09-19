import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";

test("worker termination waits after owned group kill until transport close and fences retired events", async t => {
	const child = Object.assign(new EventEmitter(), {
		pid: 12345, exitCode: null, signalCode: null,
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
	});
	mock.module("node:child_process", { namedExports: { spawn: (_command: string, _args: string[], options: any) => {
		assert.equal(options.detached, process.platform !== "win32");
		return child;
	} } });
	t.after(() => mock.reset());
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let groupExists = true;
	const kill = t.mock.method(process, "kill", (_pid: number, signal?: NodeJS.Signals | number) => {
		if (signal === 0 && !groupExists) throw Object.assign(new Error("Group exited"), { code: "ESRCH" });
		return true;
	});
	const { VoiceWorkerClient } = await import("../src/worker-client.js");
	const events: unknown[] = [];
	const worker = new VoiceWorkerClient(event => events.push(event));
	worker.sendSegment(1, 1, "Test only.", DEFAULT_VOICE_CONFIG);
	let stopped = false;
	const termination = worker.terminate().then(() => { stopped = true; });
	t.mock.timers.tick(2_000);
	await Promise.resolve();
	assert.equal(stopped, false, "SIGKILL is not a termination acknowledgement");
	assert.deepEqual(kill.mock.calls[0]?.arguments, [-12345, "SIGKILL"]);
	child.emit("exit", null, "SIGKILL");
	await Promise.resolve();
	assert.equal(stopped, false, "descendant transport pipes have not closed");
	child.stdout.write('{"type":"idle","utterance":1}\n');
	assert.deepEqual(events, []);
	child.stdout.write('{"type":"idle","cancelId":7}\n');
	assert.deepEqual(events, [{ type: "idle", cancelId: 7 }], "retirement must preserve cancellation acknowledgement routing");
	child.stdout.end(); child.stderr.end(); child.emit("close", null, "SIGKILL");
	await Promise.resolve();
	assert.equal(stopped, false, "the owned player group must also exit");
	groupExists = false;
	t.mock.timers.tick(10);
	await termination;
	assert.equal(stopped, true);
});
