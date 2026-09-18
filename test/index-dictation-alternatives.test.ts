import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { PhoneInputClient, type PhoneCapture, type PhoneCaptureOptions } from "../src/phone-input.js";
import { formatAsrCandidates } from "../src/prompt-editor.js";
import { FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test("live/final evidence matches LLM syntax, and manual edits or Stop prevent stale submission", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-alternatives-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({
		enabled: true, input: "local", output: "local", editMode: "append", submitMode: "review",
		codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0,
	}));
	let started = Promise.withResolvers<PhoneCaptureOptions>();
	let capture = Promise.withResolvers<PhoneCapture>();
	let resolution = Promise.withResolvers<any>();
	const host = new FakeVoiceHost(root, "alternatives", async () => resolution.promise);
	let editor = "Existing draft.";
	let submissions = 0;
	let terminations = 0;
	mock.method(MockedVoiceWorkerClient.prototype, "terminate", async () => { terminations++; });
	host.ctx.ui.getEditorText = () => editor;
	host.ctx.ui.setEditorText = (text: string) => { editor = text; };
	host.api.sendUserMessage = () => { submissions++; };
	mock.method(PhoneInputClient.prototype, "capture", async (_endpoint: string, options: PhoneCaptureOptions) => {
		started.resolve(options); return capture.promise;
	});
	mock.method(PhoneInputClient.prototype, "cancel", async () => {});
	mock.method(MockedVoiceWorkerClient.prototype, "transcribePcmCandidates", async () => ["clear cash", "clear cache"]);
	const finalCandidates = ["Clear the cash.", "Clear the cache."];
	mock.method(MockedVoiceWorkerClient.prototype, "transcribe", async () => finalCandidates);
	const answer = { role: "assistant", content: [{ type: "text", text: "Clear the cache." }], stopReason: "stop" };
	t.after(async () => {
		capture.resolve({ type: "text", data: "" }); resolution.resolve(answer);
		await settle(); await host.shutdown(); mock.restoreAll();
		for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const begin = async () => {
		started = Promise.withResolvers<PhoneCaptureOptions>();
		capture = Promise.withResolvers<PhoneCapture>();
		resolution = Promise.withResolvers<any>();
		await host.command("talk");
		const callbacks = await started.promise;
		callbacks.onAudio!(new Float32Array(16000).fill(0.1));
		await settle();
		return callbacks;
	};
	const finishCapture = async () => { capture.resolve({ type: "audio", data: Buffer.from("mock audio") }); await settle(); };
	await begin();
	assert.ok(editor.includes(formatAsrCandidates(["clear cash", "clear cache"])), editor);
	await finishCapture();
	assert.ok(editor.includes(formatAsrCandidates(finalCandidates)), editor);
	assert.equal(host.modelRequests.length, 1);
	const requestText = JSON.stringify(host.modelRequests[0]!.context.messages);
	assert.ok(requestText.includes(JSON.stringify(formatAsrCandidates(finalCandidates)).slice(1, -1)));
	resolution.resolve(answer); await settle();
	assert.equal(editor, "Existing draft. Clear the cache.");
	assert.equal(submissions, 0);
	const previousTerminations = terminations;
	t.mock.timers.tick(60_001);
	await settle();
	assert.ok(terminations > previousTerminations, "review completion must arm the idle worker shutdown");

	await host.command("submit auto");
	await begin(); await finishCapture();
	editor = "Manual changes while resolving";
	resolution.resolve(answer); await settle();
	assert.equal(editor, "Manual changes while resolving");
	assert.equal(submissions, 0, "manual edits must disable auto-submit for this capture");

	await begin(); await finishCapture();
	const signal = host.modelRequests.at(-1)!.options.signal as AbortSignal;
	await host.command("stop");
	assert.equal(editor, "Manual changes while resolving", "cancelled evidence must not become the next capture's draft");
	assert.equal(signal.aborted, true, "Stop must abort provider resolution as well as the microphone");
	editor = "New draft after Stop";
	resolution.resolve(answer); await settle();
	assert.equal(editor, "New draft after Stop");
	assert.equal(submissions, 0);

	const before = host.modelRequests.length;
	const callbacks = await begin();
	editor = "Typing during recording";
	callbacks.onAudio!(new Float32Array(16000).fill(0.1)); await settle();
	await finishCapture();
	assert.equal(editor, "Typing during recording");
	assert.equal(host.modelRequests.length, before, "do not resolve against an obsolete manually edited draft");
	assert.equal(submissions, 0);
});
