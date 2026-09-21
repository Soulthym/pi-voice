import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { PhoneInputClient, type PhoneCapture, type PhoneCaptureOptions } from "../src/phone-input.js";
import { DeviceRouter } from "../src/device-router.js";
import { FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";
import { voiceQueryCases } from "./helpers/voice-query-cases.js";

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
	const phone = { version: 1 as const, id: "phone", name: "Phone", platform: "termux" as const,
		audioEndpoint: "local", inputEndpoint: "local", connectedAt: 1, lastActive: 1 };
	await fs.mkdir(process.env.PI_VOICE_DEVICE_DIR!);
	await fs.writeFile(path.join(process.env.PI_VOICE_DEVICE_DIR!, "phone.json"), JSON.stringify(phone));
	mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "phone" }));
	const newer = { ...phone, id: "newer", name: "Newer" };
	let devices = [phone];
	mock.method(DeviceRouter.prototype, "connected", () => devices);
	const claim = mock.method(DeviceRouter.prototype, "claim");
	const started = Promise.withResolvers<PhoneCaptureOptions>();
	const drained = Promise.withResolvers<PhoneCapture>();
	const decoded = Promise.withResolvers<string>();
	let transcriptions = 0;
	mock.method(PhoneInputClient.prototype, "capture", async (_endpoint: string, options: PhoneCaptureOptions) => {
		started.resolve(options);
		return drained.promise;
	});
	const cancel = mock.method(PhoneInputClient.prototype, "cancel", async () => {});
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
	await host.shortcut("f4");
	const callbacks = await started.promise;
	devices = [newer, phone];
	const claims = claim.mock.callCount();
	const cancellations = cancel.mock.callCount();
	const widgetOperations = host.widgetOperations.length;
	for (const [command] of voiceQueryCases) {
		await host.command(command);
		assert.equal(host.notices.at(-1)?.level, "info", command);
	}
	await host.command("device");
	assert.equal(host.notices.at(-1)?.message, "Voice · device: auto → phone (Phone)", "capture retains its pinned device");
	assert.equal(claim.mock.callCount(), claims, "queries must not claim a device");
	assert.equal(cancel.mock.callCount(), cancellations, "queries must not cancel active capture");
	assert.equal(host.widgetOperations.length, widgetOperations, "queries must leave input progress intact");
	assert.equal(editor, "Original draft");
	const speech = new Float32Array(16000).fill(0.1);
	callbacks.onAudio!(speech);
	await settle();
	assert.equal(transcriptions, 1, "start an ASR request before cancellation");

	// Socket EOF may already have happened, while capture still awaits ffmpeg stdout.
	const stopped = Promise.withResolvers<void>();
	cancel.mock.mockImplementation(() => stopped.promise);
	const noticeCount = host.notices.length;
	const beforeStop = await fs.readFile(process.env.PI_VOICE_CONFIG, "utf8");
	const staleSetter = host.command("input local");
	await settle();
	const latestSetter = host.command("input disabled");
	await settle();
	assert.equal(await fs.readFile(process.env.PI_VOICE_CONFIG, "utf8"), beforeStop, "input must not apply before confirmed capture stop");
	stopped.resolve();
	await Promise.all([staleSetter, latestSetter]);
	assert.equal(JSON.parse(await fs.readFile(process.env.PI_VOICE_CONFIG, "utf8")).input, "disabled");
	assert.equal(host.notices.slice(noticeCount).some(n => n.message.includes("Connected to")), false, "stale setter cannot announce success after input stop");
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

test("failed input stop blocks every device setter until reconnect proves cleanup", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-input-stop-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const old = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "local", output: "local", audioCache: false, timingPreprocessConcurrency: 0 }));
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "intentional_local" as const }));
	const started = Promise.withResolvers<void>();
	const capture = Promise.withResolvers<PhoneCapture>();
	t.mock.method(PhoneInputClient.prototype, "capture", () => { started.resolve(); return capture.promise; });
	const cancel = t.mock.method(PhoneInputClient.prototype, "cancel", async () => {});
	const host = new FakeVoiceHost(root, "input-stop");
	t.after(async () => {
		cancel.mock.mockImplementation(async () => {});
		capture.resolve({ type: "audio", data: Buffer.alloc(0) });
		await host.shutdown();
		keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	await host.shortcut("f4");
	await started.promise;
	cancel.mock.mockImplementation(async () => { throw new Error("input stop unconfirmed"); });
	const snapshot = await fs.readFile(process.env.PI_VOICE_CONFIG, "utf8");
	const notices = host.notices.length;
	for (const command of ["input disabled", "device local", "output local", "input local"]) {
		await assert.rejects(host.command(command), /input stop unconfirmed/);
	}
	await host.command("reconnect");
	for (const command of ["device local", "input disabled", "output local"]) {
		await assert.rejects(host.command(command), /input stop unconfirmed/);
	}
	assert.equal(await fs.readFile(process.env.PI_VOICE_CONFIG, "utf8"), snapshot);
	assert.equal(host.notices.slice(notices).some(n => n.message.includes("Connected to")), false);
	const stopped = Promise.withResolvers<void>();
	cancel.mock.mockImplementation(() => stopped.promise);
	const reconnect = host.command("reconnect");
	await settle();
	assert.equal(host.notices.slice(notices).some(n => n.message.includes("Connected to")), false);
	stopped.resolve();
	await reconnect;
	await host.command("input disabled");
	assert.equal(JSON.parse(await fs.readFile(process.env.PI_VOICE_CONFIG, "utf8")).input, "disabled");
});
