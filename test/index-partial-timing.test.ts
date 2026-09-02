import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import {
	FakeVoiceHost,
	MockedVoiceWorkerClient,
	streamCompletedResponse,
} from "./helpers/fake-voice-host.js";

test("F9 does not follow transcript tail from an incomplete latest timing prefix", async t => {
	mock.module("../src/worker-client.js", {
		namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient },
	});

	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-partial-timing-"));
	const previous = {
		config: process.env.PI_VOICE_CONFIG,
		coordinator: process.env.PI_VOICE_COORDINATOR_DIR,
		devices: process.env.PI_VOICE_DEVICE_DIR,
	};
	await fs.writeFile(
		path.join(root, "voice.json"),
		JSON.stringify({
			enabled: true,
			mode: "assistant",
			input: "disabled",
			audioCache: false,
			timingPreprocessConcurrency: 0,
		}),
	);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");

	const host = new FakeVoiceHost(path.join(root, "project"), "partial-timing");
	t.after(async () => {
		await host.shutdown().catch(() => {});
		mock.reset();
		if (previous.config === undefined) delete process.env.PI_VOICE_CONFIG;
		else process.env.PI_VOICE_CONFIG = previous.config;
		if (previous.coordinator === undefined) delete process.env.PI_VOICE_COORDINATOR_DIR;
		else process.env.PI_VOICE_COORDINATOR_DIR = previous.coordinator;
		if (previous.devices === undefined) delete process.env.PI_VOICE_DEVICE_DIR;
		else process.env.PI_VOICE_DEVICE_DIR = previous.devices;
		await fs.rm(root, { recursive: true, force: true });
	});

	host.addMessage("user", null, {
		role: "user",
		content: [{ type: "text", text: "Narrate several checkpoints." }],
		timestamp: 1,
	});
	await host.start();
	await streamCompletedResponse(
		host,
		"assistant",
		"user",
		"First sentence has enough words. Second sentence has enough words. Third sentence has enough words.",
	);

	const worker = MockedVoiceWorkerClient.instances.find(instance => instance.sent.length > 0);
	assert.ok(worker);
	const replayStart = worker.sent.length;
	await host.shortcut("f11");
	const replaySegments = worker.sent.slice(replayStart) as Array<{
		utterance: number;
		segmentId: number;
	}>;
	assert.ok(replaySegments.length >= 2, "fixture must expose an incomplete timing prefix");

	const first = replaySegments[0]!;
	worker.emit({ type: "segment-audio", segmentId: first.segmentId, start: 0, duration: 2 } as never);
	worker.emit({ type: "playback", utterance: first.utterance, position: 2 } as never);
	const beforeSeek = worker.sent.length;
	const pausesBeforeSeek = worker.pauses.length;

	await host.shortcut("f9");

	assert.ok(worker.sent.length > beforeSeek, "F9 must replay the furthest known checkpoint instead of following tail");
	assert.equal(
		worker.pauses.slice(pausesBeforeSeek).includes(true),
		false,
		"an incomplete final known checkpoint must not pause for transcript-tail following",
	);
});
