import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve)); };

for (const canonicalBefore of [false, true]) for (const bottom of [false, true]) for (const ended of [true, false]) for (const started of [true, false]) test(`live-tail Pause retains the current sink (canonical before: ${canonicalBefore}, bottom: ${bottom}, turn ended: ${ended}, audio started: ${started})`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-pause-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false, codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "pause-tail");
	t.after(async () => {
		await host.shutdown();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	await host.shortcut("f10"); // Waiting at an empty live tail, not a historical replay.
	host.idle = false;
	const message = assistant("First sentence. Second sentence. ");
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	if (ended) {
		await host.emit("message_end", { message });
		await host.emit("turn_end", { message });
	}
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	assert.ok(worker, "new latest message autoplays without Replay");
	const segment = worker.sent.at(-1) as { utterance: number; segmentId: number };
	if (started) {
		worker.emit({ type: "segment-audio", ...segment, start: 0, duration: 10 });
		worker.emit({ type: "playback", utterance: segment.utterance, position: 3 });
	}
	await settle();
	if (canonicalBefore) {
		host.addMessage("canonical-answer", null, message);
		await host.emit("agent_settled", {}); await settle();
	}
	const sent = worker.sent.length;
	if (bottom) await host.command("bottom"); // Native End / explicit tail framing while audio is still active.
	await host.shortcut("f8"); await settle();
	assert.equal(worker.sent.length, sent, "Pause must not restart the message by sending replacement segments from zero");
	assert.equal(worker.pauses.at(-1), true, "Pause must pause the existing autoplay sink");
	assert.match(host.widgetLines()!.join("\n"), /Paused/);
	// Canonical adoption and late worker/frame callbacks must not erase pause intent.
	if (!canonicalBefore) host.addMessage("canonical-answer", null, message);
	if (!ended) {
		await host.emit("message_update", { message: assistant(message.content[0].text + "Third sentence. "), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Third sentence. " } });
	}
	await host.emit("agent_settled", {});
	worker.emit({ type: "ready" });
	worker.emit({ type: "playback", utterance: segment.utterance, position: 4 });
	await settle();
	assert.equal(worker.pauses.at(-1), true, "late updates cannot unpause");
	assert.match(host.widgetLines()!.join("\n"), /Paused/);
	const beforeResume = worker.sent.length;
	const pauseCount = worker.pauses.length;
	await host.shortcut("f8"); await settle();
	assert.equal(worker.sent.length, beforeResume, "explicit Resume reuses the sink rather than replaying zero");
	assert.deepEqual(worker.pauses.slice(pauseCount), [false], "explicit Resume unpauses exactly once");
});
