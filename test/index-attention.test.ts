import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { VoiceWorkerClient } from "../src/worker-client.js";
import { FakeVoiceHost, streamBlockedResponse } from "./helpers/fake-voice-host.js";

async function configureTestEnvironment(root: string): Promise<() => Promise<void>> {
	const previous = {
		config: process.env.PI_VOICE_CONFIG,
		coordinator: process.env.PI_VOICE_COORDINATOR_DIR,
		devices: process.env.PI_VOICE_DEVICE_DIR,
	};
	const configPath = path.join(root, "voice.json");
	await fs.writeFile(
		configPath,
		JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", audioCache: false }),
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

function mockWorker(spoken: string[]): () => void {
	const original = {
		sendSegment: VoiceWorkerClient.prototype.sendSegment,
		endUtterance: VoiceWorkerClient.prototype.endUtterance,
		cancel: VoiceWorkerClient.prototype.cancel,
		terminate: VoiceWorkerClient.prototype.terminate,
	};
	VoiceWorkerClient.prototype.sendSegment = function (_utterance, _segmentId, text): void {
		spoken.push(text);
	};
	VoiceWorkerClient.prototype.endUtterance = function (): void {};
	VoiceWorkerClient.prototype.cancel = function (): void {};
	VoiceWorkerClient.prototype.terminate = async function (): Promise<void> {};
	return () => {
		VoiceWorkerClient.prototype.sendSegment = original.sendSegment;
		VoiceWorkerClient.prototype.endUtterance = original.endUtterance;
		VoiceWorkerClient.prototype.cancel = original.cancel;
		VoiceWorkerClient.prototype.terminate = original.terminate;
	};
}

test("extension attention ignores tool-only turns, warns once per response, and announces after owner release", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-attention-"));
	const restoreEnvironment = await configureTestEnvironment(root);
	const spoken: string[] = [];
	const restoreWorker = mockWorker(spoken);
	const owner = new SessionCoordinator(path.join(root, "owner"), "owner");
	const host = new FakeVoiceHost(path.join(root, "waiter"), "waiter");
	t.after(async () => {
		await host.shutdown().catch(() => {});
		owner.shutdown();
		restoreWorker();
		await restoreEnvironment();
	});

	owner.start();
	assert.equal(owner.tryAcquireSpeech(), true);
	await host.start();

	await streamBlockedResponse(host, "", "toolUse");
	assert.equal(host.notices.filter(item => item.message.includes("paused behind another project")).length, 0);

	await streamBlockedResponse(host, "A completed response that should request attention.");
	await streamBlockedResponse(host, "Another update while the same project is waiting.");
	assert.equal(host.notices.filter(item => item.message.includes("paused behind another project")).length, 2);
	assert.equal(spoken.length, 0);

	owner.releaseSpeech();
	await new Promise(resolve => setTimeout(resolve, 350));
	assert.equal(spoken.filter(text => text.includes("requires attention next")).length, 1);
});

test("project name is announced only when audible attention changes", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-project-"));
	const restoreEnvironment = await configureTestEnvironment(root);
	const spoken: string[] = [];
	const restoreWorker = mockWorker(spoken);
	const host = new FakeVoiceHost(path.join(root, "alpha"), "alpha");
	t.after(async () => {
		await host.shutdown().catch(() => {});
		restoreWorker();
		await restoreEnvironment();
	});

	await host.start();
	await host.command("test First audible response.");
	await host.command("stop");
	await host.command("test Second audible response.");

	assert.equal(spoken.filter(text => text.startsWith("Project ")).length, 1);
	assert.equal(spoken.filter(text => text.includes("audible response")).length, 2);
});
