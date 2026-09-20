import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";

test("non-admission removes only the matching handle, never newer ownership or idle evidence", async t => {
	const child = Object.assign(new EventEmitter(), {
		pid: 23456, exitCode: null as number | null, signalCode: null,
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
	});
	mock.module("node:child_process", { namedExports: { spawn: () => child } });
	t.mock.method(process, "kill", () => { throw Object.assign(Error("gone"), { code: "ESRCH" }); });
	t.after(() => mock.reset());
	const { VoiceWorkerClient } = await import("../src/worker-client.js");
	const worker = new VoiceWorkerClient(() => {});
	const output = `unix:///tmp/pi-voice-non-admission-missing-${process.pid}.sock`;
	const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const next = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	const send = (event: object) => child.stdout.write(JSON.stringify(event) + "\n");
	worker.sendSegment(1, 1, "A", { ...DEFAULT_VOICE_CONFIG, output });
	send({ type: "remote-handle", output, id: first, utterance: 1 });
	worker.sendSegment(2, 1, "B", { ...DEFAULT_VOICE_CONFIG, output });
	send({ type: "remote-handle", output, id: next, utterance: 2 });
	send({ type: "remote-not-admitted", id: first });
	send({ type: "idle", utterance: 2 });
	child.exitCode = 0; child.emit("close", 0);
	await assert.rejects(worker.terminate(), { code: "REMOTE_PLAYBACK_UNCONFIRMED" });
	send({ type: "remote-released", id: next });
	await worker.terminate(); // First handle was removed, not merely ignored until a receipt.
});
