import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test("suffix playback ticks and completed tail-follow preserve sentence navigation", async t => {
	mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-sentence-native-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local",
		codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(path.join(root, "project"), "sentences");
	t.after(async () => {
		await host.shutdown().catch(() => {}); mock.reset();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("answer", null, assistant("First sentence. Second sentence.\nFinal line."));
	await host.start(); await host.shortcut("f5"); await settle();
	const worker = MockedVoiceWorkerClient.instances.find(worker => worker.sent.length)!;
	const spoken = worker.sent as Array<{ utterance: number; segmentId: number; text: string }>;
	await host.shortcut("f9"); await settle();
	const second = spoken.findLast(segment => segment.text === "Second sentence.")!;
	worker.emit({ type: "segment-audio", utterance: second.utterance, segmentId: second.segmentId, start: 0, duration: 2 });
	worker.emit({ type: "playback", utterance: second.utterance, position: 0.5 });
	const before = spoken.length;
	await host.shortcut("f9"); await settle();
	assert.deepEqual(spoken.slice(before).map(segment => segment.text), ["Final line."], "the tick must not reset the suffix cursor to zero");
	// Start a full replay, then finish without a final clock tick.
	await host.shortcut("f5"); await settle();
	const first = spoken.findLast(segment => segment.text === "First sentence.")!;
	const full = spoken.filter(segment => segment.utterance === first.utterance);
	full.forEach((segment, i) => worker.emit({ type: "segment-audio", utterance: segment.utterance, segmentId: segment.segmentId, start: i * 2, duration: 2 }));
	worker.emit({ type: "idle", utterance: first.utterance }); await settle();
	worker.emit({ type: "playback", utterance: first.utterance, position: 0.5 }); // Late buffered clock packet.
	const finished = worker.sent.length;
	await host.shortcut("f9"); await settle();
	assert.equal(worker.sent.length, finished, "confirmed completion must go to tail, not replay an earlier sentence");
	await host.shortcut("f7"); await settle();
	assert.deepEqual(spoken.slice(finished).map(segment => segment.text), ["Final line."], "tail stays a navigation position after ownership release");
});
