import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { PhoneInputClient, type PhoneCapture, type PhoneCaptureOptions } from "../src/phone-input.js";
import { FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

test("cancelled dictation ignores late decoder progress, PCM and ASR results during drainage", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-input-cancellation-"));
	const variables = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const previous = Object.fromEntries(variables.map(name => [name, process.env[name]]));
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({
		enabled: true, input: "local", output: "local", submitMode: "review",
	}));
	const started = Promise.withResolvers<PhoneCaptureOptions>();
	const drained = Promise.withResolvers<PhoneCapture>();
	const decoded = Promise.withResolvers<string>();
	let transcriptions = 0;
	mock.method(PhoneInputClient.prototype, "capture", async (_endpoint: string, options: PhoneCaptureOptions) => {
		started.resolve(options);
		return drained.promise;
	});
	mock.method(PhoneInputClient.prototype, "cancel", async () => {});
	mock.method(MockedVoiceWorkerClient.prototype, "transcribePcm", async () => {
		transcriptions++;
		return decoded.promise;
	});
	const host = new FakeVoiceHost(root, "cancelled-input");
	let editor = "Original draft";
	host.ctx.ui.getEditorText = () => editor;
	host.ctx.ui.setEditorText = (text: string) => { editor = text; };
	t.after(async () => {
		decoded.resolve("stale transcript");
		drained.resolve({ type: "audio", data: Buffer.from("cancelled recording") });
		await settle();
		await host.shutdown();
		mock.restoreAll();
		for (const name of variables) {
			if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	await host.command("talk");
	const callbacks = await started.promise;
	const speech = new Float32Array(16000).fill(0.1);
	callbacks.onAudio!(speech);
	await settle();
	assert.equal(transcriptions, 1, "start an ASR request before cancellation");

	// Socket EOF may already have happened, while capture still awaits ffmpeg stdout.
	await host.command("input disabled");
	editor = "New draft after cancellation";
	const widget = host.widgets.get("pi-voice-progress");
	callbacks.onProgress!({ elapsedSeconds: 99, level: 0.1, speechDetected: true });
	callbacks.onAudio!(speech);
	decoded.resolve("stale transcript");
	await settle();
	assert.equal(editor, "New draft after cancellation", "late ASR must not replace the editor");
	assert.equal(transcriptions, 1, "late PCM must not start more transcription");
	assert.deepEqual(host.widgets.get("pi-voice-progress"), widget, "late progress must not restore a cancelled widget");
	assert.equal(host.modelRequests.length, 0);
});
