import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
for (const key of ["f11", "f8"]) test(`${key} replay from tail restores bottom unless the user browses away`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tail-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local",
		codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "tail");
	t.after(async () => {
		await host.shutdown();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("answer", null, assistant("First sentence. Second sentence."));
	await host.start();
	host.scrollView.setDocument(Array.from({ length: 300 }, (_, i) => i === 100 ? `${NARRATION_ACTIVE_MARKER}First` : `line ${i}`), 40);
	for (const manual of [false, true]) {
		await host.command("bottom");
		await host.shortcut(key); await settle();
		assert.equal(host.scrollView.scrollTop, 92, "replay immediately leaves tail for the spoken position");
		const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
		const last = worker.sent.at(-1) as { utterance: number };
		const segments = worker.sent as Array<{ utterance: number; segmentId: number; text: string }>;
		segments.filter(segment => segment.utterance === last.utterance).forEach((segment, i) =>
			worker.emit({ type: "segment-audio", utterance: segment.utterance, segmentId: segment.segmentId, start: i * 2, duration: 2 }));
		if (manual) host.scrollView.manualScrollTo(50);
		worker.emit({ type: "idle", utterance: last.utterance }); await settle();
		assert.equal(host.scrollView.scrollTop, manual ? 50 : 260);
		assert.equal(host.scrollView.isFollowingEnd, !manual);
		const before = worker.sent.length;
		await host.shortcut("f7"); await settle();
		assert.equal(segments[before].text, manual ? "First sentence." : "Second sentence.",
			"completion restores logical tail only when it restores the viewport");
	}
});
