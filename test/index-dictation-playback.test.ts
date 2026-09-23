import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { PhoneInputClient, type PhoneCapture } from "../src/phone-input.js";
import { DeviceRouter, type ConnectionDevice } from "../src/device-router.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test("playback finalizes capture into a review draft; Stop and second microphone press cancel pending work", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-dictation-playback-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "local", output: "local", editMode: "append", submitMode: "auto", audioCache: false }));
	const host = new FakeVoiceHost(root, "dictation-playback", async () => assistant("Captured dictation."));
	let editor = "Draft.";
	let submissions = 0;
	host.ctx.ui.getEditorText = () => editor;
	host.ctx.ui.setEditorText = (text: string) => { editor = text; };
	host.api.sendUserMessage = () => { submissions++; };
	let capture = Promise.withResolvers<PhoneCapture>();
	let transcript = Promise.withResolvers<string[]>();
	let recording = false;
	const captureMock = mock.method(PhoneInputClient.prototype, "capture", async () => { recording = true; return capture.promise; });
	mock.method(PhoneInputClient.prototype, "cancel", async () => { recording = false; });
	mock.method(PhoneInputClient.prototype, "stop", async () => { recording = false; capture.resolve({ type: "audio", data: Buffer.from("mock") }); });
	mock.method(MockedVoiceWorkerClient.prototype, "transcribe", () => transcript.promise);
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	t.after(async () => {
		capture.resolve({ type: "text", data: "" }); transcript.resolve([]);
		await settle(); await host.shutdown(); mock.restoreAll();
		for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("a", null, assistant("Replay this response."));
	await host.start();
	const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
	for (const action of ["test Playback test.", "attention"]) {
		capture = Promise.withResolvers<PhoneCapture>(); transcript = Promise.withResolvers<string[]>();
		await host.command("talk"); await settle(); assert.equal(recording, true);
		const before = worker.sent.length;
		const playback = host.command(action); await settle();
		assert.equal(recording, false, "capture must stop before test/replay speech");
		assert.equal(worker.sent.length, before);
		transcript.resolve(["Captured dictation."]); await playback; await settle();
		assert.match(editor, /Captured dictation/);
		assert.equal(submissions, 0, "playback is never implicit submit permission");
		assert.ok(worker.sent.length > before);
	}
	capture = Promise.withResolvers<PhoneCapture>(); transcript = Promise.withResolvers<string[]>();
	await host.command("talk"); await settle();
	editor = "Manual draft";
	const playback = host.command("test Preserve manual draft."); await settle();
	transcript.resolve(["Ignored dictation."]); await playback; await settle();
	assert.equal(editor, "Manual draft"); assert.equal(submissions, 0);

	capture = Promise.withResolvers<PhoneCapture>(); transcript = Promise.withResolvers<string[]>();
	await host.command("talk"); await settle();
	const before = worker.sent.length;
	const obsolete = host.command("test Must not speak."); await settle();
	await host.command("stop");
	await obsolete;
	editor = "New draft after Stop";
	transcript.resolve(["Obsolete transcript."]); await settle();
	assert.equal(editor, "New draft after Stop"); assert.equal(worker.sent.length, before);

	const lookup = mock.method(DeviceRouter.prototype, "resolveCurrentConnection");
	for (const action of ["device auto", "reconnect"]) {
		for (const fail of [false, true]) {
			lookup.mock.mockImplementation(async () => ({ kind: "intentional_local" }));
			capture = Promise.withResolvers<PhoneCapture>();
			transcript = Promise.withResolvers<string[]>();
			await host.command("talk"); await settle();
			const attachment = Promise.withResolvers<ConnectionDevice>();
			lookup.mock.mockImplementation(() => attachment.promise);
			const switching = host.command(action); await settle();
			assert.equal(recording, true, "lookup alone must not stop capture");
			if (fail) editor = "Manual draft during lookup";
			capture.resolve({ type: "text", data: "Natural finish during lookup." });
			await settle();
			assert.equal(submissions, 0, "explicit switch intent prevents natural-finish auto-submit before lookup completes");
			if (fail) assert.equal(editor, "Manual draft during lookup");
			else assert.match(editor, /Captured dictation/);
			if (fail) attachment.reject(new Error("ambiguous attachment"));
			else attachment.resolve({ kind: "intentional_local" });
			await switching; await settle();
			assert.equal(submissions, 0);
		}
	}
	lookup.mock.restore();

	const other = new SessionCoordinator(path.join(root, "other"), "other"); other.start(); other.tryAcquireSpeech();
	try {
		const acquired = Promise.withResolvers<boolean>();
		const force = mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", () => acquired.promise);
		const calls = captureMock.mock.callCount();
		await host.command("talk"); await settle();
		await host.command("talk");
		acquired.resolve(true); await settle();
		assert.equal(captureMock.mock.callCount(), calls, "second tap cancels future capture startup");
		force.mock.restore();
	} finally { other.shutdown(); }
});
