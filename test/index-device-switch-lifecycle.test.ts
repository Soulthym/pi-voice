import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { DeviceRouter } from "../src/device-router.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

for (const action of ["device local", "reconnect"]) for (const finishBeforeResume of [false, true]) {
	test(`${action} retains streaming source and cursor across retirement; complete before resume: ${finishBeforeResume}`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-switch-lifecycle-"));
		const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR", "PI_VOICE_DEVICE_ID"];
		const old = keys.map(key => process.env[key]);
		process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
		process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
		process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
		delete process.env.PI_VOICE_DEVICE_ID;
		await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local", audioCache: false, timingPreprocessConcurrency: 0 }));
		t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
		const host = new FakeVoiceHost(root, "switch-lifecycle");
		const index = MockedVoiceWorkerClient.instances.length;
		t.after(async () => {
			await host.shutdown();
			keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
			await fs.rm(root, { recursive: true, force: true });
		});
		await host.start();
		const worker = MockedVoiceWorkerClient.instances[index]!;
		let text = "First sentence. Second sentence. ";
		const delta = async (chunk: string) => {
			const partial = assistant(text, "pending");
			await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk, partial } });
		};
		await host.emit("message_start", { message: assistant("", "pending") });
		await delta(text); await settle();
		const segments = worker.sent as Array<{ utterance: number; segmentId: number; text: string }>;
		const first = segments.find(s => s.text === "First sentence.")!;
		const second = segments.find(s => s.text === "Second sentence.")!;
		assert.ok(second);
		worker.emit({ ...first, type: "segment-audio", start: 0, duration: 2 });
		worker.emit({ ...second, type: "segment-audio", start: 2, duration: 2 });
		worker.emit({ type: "playback", utterance: second.utterance, position: 2.5 });
		await host.command(action);
		const count = worker.sent.length;
		text += "Future sentence. ";
		await delta("Future sentence. ");
		const finish = async () => {
			const complete = assistant(text);
			host.addMessage("complete", null, complete);
			await host.emit("message_end", { message: complete });
			await host.emit("turn_end", { message: complete, toolResults: [] });
		};
		if (finishBeforeResume) await finish();
		await settle();
		assert.equal(worker.sent.length, count, "switch and completion never restart audio in the background");
		await host.shortcut("f8"); await settle();
		assert.ok(worker.sent.length > count, "resume rebuilds the retired sink");
		assert.equal(segments[count].text, "Second sentence.", "resume preserves the audible cursor");
		assert.ok(segments.slice(count).some(s => s.text === "Future sentence."), "suppressed deltas remain available for resume");
		if (!finishBeforeResume) {
			text += "After resume. ";
			await delta("After resume. ");
			await finish(); await settle();
			assert.ok(segments.slice(count).some(s => s.text === "After resume."), "live continuation survives retirement");
		}
	});
}
