import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";

test("cold/restarted workers receive pause intent before audio, while cancellation clears it", async t => {
	const children: Array<{ messages: any[] }> = [];
	mock.module("node:child_process", { namedExports: { spawn: () => {
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
			exitCode: null as number | null, messages: [] as any[],
		});
		child.stdin.on("data", bytes => {
			const message = JSON.parse(String(bytes)); child.messages.push(message);
			if (message.type === "shutdown") queueMicrotask(() => {
				child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit("exit", 0); child.emit("close", 0);
			});
		});
		children.push(child);
		return child;
	} } });
	const { VoiceWorkerClient } = await import("../src/worker-client.js");
	const worker = new VoiceWorkerClient(() => {});
	t.after(async () => { await worker.terminate(); mock.reset(); });
	worker.setPlaybackPaused(true);
	assert.equal(children.length, 0, "pause alone should not launch a worker");
	worker.sendSegment(1, 1, "First sentence.", DEFAULT_VOICE_CONFIG);
	assert.deepEqual(children[0]!.messages[0], { type: "pause", paused: true });
	assert.deepEqual(children[0]!.messages[1], { type: "tts-workers", workers: 3 });
	assert.equal(children[0]!.messages[2].type, "segment");
	for (const workers of [0, 9, 1.5, NaN]) assert.throws(() => worker.setTtsWorkers(workers), RangeError);
	worker.setTtsWorkers(1);
	assert.deepEqual(children[0]!.messages.slice(3), [{ type: "tts-workers", workers: 1 }], "resize must not resume paused playback");
	await worker.terminate();
	worker.sendSegment(2, 2, "Still paused.", { ...DEFAULT_VOICE_CONFIG, ttsWorkers: 1 });
	assert.deepEqual(children[1]!.messages[0], { type: "pause", paused: true });
	assert.deepEqual(children[1]!.messages[1], { type: "tts-workers", workers: 1 });
	worker.cancel();
	await worker.terminate();
	worker.sendSegment(3, 3, "After cancellation.", DEFAULT_VOICE_CONFIG);
	assert.deepEqual(children[2]!.messages[0], { type: "pause", paused: false });
});
