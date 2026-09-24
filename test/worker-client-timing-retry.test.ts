import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";

test("retryTiming snapshots config, isolates result events and supports consumer cancellation", async t => {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null,
	});
	const requests: any[] = [], events: any[] = [];
	child.stdin.on("data", bytes => requests.push(JSON.parse(String(bytes))));
	mock.module("node:child_process", { namedExports: { spawn: () => child } });
	t.after(() => mock.reset());
	const { VoiceWorkerClient } = await import("../src/worker-client.js");
	const config = { ...DEFAULT_VOICE_CONFIG, audioCache: false };
	const client = new VoiceWorkerClient(event => events.push(event), () => config);
	client.setPlaybackPaused(true);
	const result = client.retryTiming("Synthetic sentence.");
	const request = requests.at(-1);
	assert.equal(request.type, "retry-timing");
	assert.equal(request.model, config.ttsModel);
	assert.equal(request.audioCacheBitrate, config.audioCacheBitrate);
	assert.equal(request.output, undefined);
	assert.deepEqual(requests[0], { type: "pause", paused: true });
	child.stdout.write(JSON.stringify({ type: "timing-retry", requestId: request.requestId, result: { status: "cache-miss" } }) + "\n");
	assert.deepEqual(await result, { status: "cache-miss" });
	assert.deepEqual(events, []);
	const abort = new AbortController();
	const cancelled = client.retryTiming("Synthetic sentence.", abort.signal);
	const rejection = assert.rejects(cancelled, /interrupted/);
	abort.abort(); await rejection;
	assert.equal(requests.at(-1).type, "cancel-timing-retry");
	const count = requests.length;
	await assert.rejects(client.retryTiming("Synthetic sentence.", abort.signal));
	assert.equal(requests.length, count);
	const stopped = client.retryTiming("Synthetic sentence.");
	const stoppedRejection = assert.rejects(stopped, /interrupted/);
	client.cancel(); await stoppedRejection;
	const failed = client.retryTiming("Synthetic sentence.");
	const failedRejection = assert.rejects(failed, /broken pipe/);
	child.stdin.emit("error", new Error("broken pipe")); await failedRejection;
});
