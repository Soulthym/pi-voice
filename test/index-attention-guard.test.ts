import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { VoiceWorkerClient } from "../src/worker-client.js";
import { FakeVoiceHost, assistant, streamCompletedResponse, type ModelRequest } from "./helpers/fake-voice-host.js";

async function settle(): Promise<void> {
	for (let index = 0; index < 10; index += 1) await new Promise(resolve => setImmediate(resolve));
}

async function configure(root: string): Promise<() => Promise<void>> {
	const previous = {
		config: process.env.PI_VOICE_CONFIG,
		coordinator: process.env.PI_VOICE_COORDINATOR_DIR,
		devices: process.env.PI_VOICE_DEVICE_DIR,
	};
	const configPath = path.join(root, "voice.json");
	await fs.writeFile(
		configPath,
		JSON.stringify({
			enabled: true,
			mode: "assistant",
			input: "disabled",
			audioCache: false,
			codeNarration: "summary",
			codeDescriptionContext: "block-only",
			timingPreprocessConcurrency: 1,
		}),
	);
	process.env.PI_VOICE_CONFIG = configPath;
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	return async () => {
		if (previous.config === undefined) delete process.env.PI_VOICE_CONFIG;
		else process.env.PI_VOICE_CONFIG = previous.config;
		if (previous.coordinator === undefined) delete process.env.PI_VOICE_COORDINATOR_DIR;
		else process.env.PI_VOICE_COORDINATOR_DIR = previous.coordinator;
		if (previous.devices === undefined) delete process.env.PI_VOICE_DEVICE_DIR;
		else process.env.PI_VOICE_DEVICE_DIR = previous.devices;
		await fs.rm(root, { recursive: true, force: true });
	};
}

function mockWorker(): () => void {
	const original = {
		sendSegment: VoiceWorkerClient.prototype.sendSegment,
		measureSegment: VoiceWorkerClient.prototype.measureSegment,
		endUtterance: VoiceWorkerClient.prototype.endUtterance,
		cancel: VoiceWorkerClient.prototype.cancel,
		terminate: VoiceWorkerClient.prototype.terminate,
	};
	VoiceWorkerClient.prototype.sendSegment = function (): void {};
	VoiceWorkerClient.prototype.measureSegment = async function (): Promise<number> {
		return 1;
	};
	VoiceWorkerClient.prototype.endUtterance = function (): void {};
	VoiceWorkerClient.prototype.cancel = function (): undefined { return undefined; };
	VoiceWorkerClient.prototype.terminate = async function (): Promise<void> {};
	return () => {
		VoiceWorkerClient.prototype.sendSegment = original.sendSegment;
		VoiceWorkerClient.prototype.measureSegment = original.measureSegment;
		VoiceWorkerClient.prototype.endUtterance = original.endUtterance;
		VoiceWorkerClient.prototype.cancel = original.cancel;
		VoiceWorkerClient.prototype.terminate = original.terminate;
	};
}

function user(text: string): any {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

test("manual playback controls work while a response is generating", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-attention-guard-"));
	const restoreEnvironment = await configure(root);
	const restoreWorker = mockWorker();
	const host = new FakeVoiceHost(path.join(root, "project"), "guard", async (_request: ModelRequest) => ({
		role: "assistant",
		content: [{ type: "text", text: "A block description." }],
		stopReason: "stop",
	}));
	t.after(async () => {
		await host.shutdown().catch(() => {});
		restoreWorker();
		await restoreEnvironment();
	});

	host.addMessage("user-1", null, user("Explain the example."));
	await host.start();

	// Simulate Pi streaming the very first response: nothing completed yet.
	host.idle = false;

	// F8 without any playback reports the specific state instead of an idle guard.
	await host.shortcut("f8");
	assert.ok(
		host.notices.some(notice => notice.message.includes("no assistant message playing")),
		`F8 should report playback state; got: ${JSON.stringify(host.notices)}`,
	);

	// A response completes normally even though controls were pressed meanwhile.
	await streamCompletedResponse(host, "assistant-1", "user-1", "First answer with content.");

	// F11 forces attention transfer and replays completed responses while generating.
	const requestsBefore = host.modelRequests.length;
	await host.shortcut("f11");
	await settle();
	assert.equal(
		host.notices.filter(notice => notice.message.includes("before navigating playback")).length,
		0,
		"the removed idle warning must never appear",
	);
	assert.equal(host.modelRequests.length, requestsBefore, "replay must not re-describe cached blocks");

	// F6/F10 navigate completed snapshots during generation too.
	await host.shortcut("f10");
	await settle();
	assert.match(host.widgetLines()?.join("\n") ?? "", /message 1\/1/);

	await host.shortcut("f6");
	await settle();
	assert.match(host.widgetLines()?.join("\n") ?? "", /message 1\/1/);

	// The fake generation is untouched by any of the controls above.
	assert.equal(host.idle, false);
});

test("/voice attention falls back to replay while generating", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-attention-cmd-"));
	const restoreEnvironment = await configure(root);
	const restoreWorker = mockWorker();
	const host = new FakeVoiceHost(path.join(root, "project"), "cmd", async (_request: ModelRequest) => ({
		role: "assistant",
		content: [{ type: "text", text: "A block description." }],
		stopReason: "stop",
	}));
	t.after(async () => {
		await host.shutdown().catch(() => {});
		restoreWorker();
		await restoreEnvironment();
	});

	host.addMessage("user-1", null, user("Say something."));
	await host.start();
	await streamCompletedResponse(host, "assistant-1", "user-1", "A completed response.");
	host.idle = false;
	const requestsBefore = host.modelRequests.length;

	await host.command("attention");
	await settle();

	assert.equal(
		host.notices.filter(notice => notice.message.includes("before navigating playback")).length,
		0,
	);
	assert.match(host.widgetLines()?.join("\n") ?? "", /message 1\/1/);
	assert.equal(host.modelRequests.length, requestsBefore);
});
