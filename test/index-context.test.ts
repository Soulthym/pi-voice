import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { VoiceWorkerClient } from "../src/worker-client.js";
import { FakeVoiceHost, assistant, streamCompletedResponse, type ModelRequest } from "./helpers/fake-voice-host.js";

async function settle(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await new Promise(resolve => setImmediate(resolve));
}

async function configure(root: string, context: "block-only" | "conversation"): Promise<() => Promise<void>> {
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
			codeDescriptionContext: context,
			codeDescriptionPreprocessConcurrency: 1,
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
	VoiceWorkerClient.prototype.measureSegment = async function (): Promise<number> { return 1; };
	VoiceWorkerClient.prototype.endUtterance = function (): void {};
	VoiceWorkerClient.prototype.cancel = function (): void {};
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

function modelResponse(text = "A contextual description of the concerned block."): any {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}


function requestText(request: ModelRequest): string {
	const text: string[] = [];
	for (const message of request.context.messages as any[]) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as any[]) {
			if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
		}
	}
	return text.join("\n");
}

test("live, rendering, replay, and timing share one contextual description request", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-context-"));
	const restoreEnvironment = await configure(root, "conversation");
	const restoreWorker = mockWorker();
	const host = new FakeVoiceHost(path.join(root, "project"), "context", async () => modelResponse());
	t.after(async () => {
		await host.shutdown().catch(() => {});
		restoreWorker();
		await restoreEnvironment();
	});

	host.addMessage("user-1", null, user("Explain the first use."));
	await host.start();
	const first = "First answer.\n```ts\nrun();\n```";
	await streamCompletedResponse(host, "assistant-1", "user-1", first);
	assert.equal(host.modelRequests.length, 1);
	assert.match(host.render(first), /contextual description/);
	await host.shortcut("f11");
	await settle();
	assert.equal(host.modelRequests.length, 1);

	host.addMessage("user-2", "assistant-1", user("Explain the second, unrelated use."));
	const second = "Second answer.\n```ts\nrun();\n```";
	await streamCompletedResponse(host, "assistant-2", "user-2", second);
	assert.equal(host.modelRequests.length, 2);

	host.addMessage("later-user", "assistant-2", user("A later turn must not change either historical key."));
	assert.match(host.render(first), /contextual description/);
	assert.match(host.render(second), /contextual description/);
	await host.shortcut("f11");
	await settle();
	assert.equal(host.modelRequests.length, 2);

	for (const request of host.modelRequests) {
		assert.equal(request.options.sessionId, "context");
		assert.equal(request.options.cacheRetention, undefined);
		assert.equal(request.context.systemPrompt, "Test system prompt");
		const finalRequest = request.context.messages.at(-1) as any;
		const concernedAssistant = request.context.messages.at(-2) as any;
		assert.doesNotMatch(JSON.stringify(finalRequest), /run\(\);/);
		assert.equal(JSON.stringify(concernedAssistant).split("run();").length - 1, 1);
	}
});

test("extension narration uses the compaction summary applicable before a historical block", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-compaction-"));
	const restoreEnvironment = await configure(root, "conversation");
	const restoreWorker = mockWorker();
	const host = new FakeVoiceHost(path.join(root, "project"), "compaction", async () => modelResponse());
	t.after(async () => {
		await host.shutdown().catch(() => {});
		restoreWorker();
		await restoreEnvironment();
	});

	host.addMessage("old-user", null, user("Old prompt that should be summarized away."));
	host.addMessage("old-assistant", "old-user", assistant("Old answer."));
	host.addMessage("kept-user", "old-assistant", user("Kept prompt."));
	host.entries.push({
		type: "compaction",
		id: "compaction-entry",
		parentId: "kept-user",
		timestamp: new Date().toISOString(),
		summary: "Applicable compacted discussion.",
		firstKeptEntryId: "kept-user",
		tokensBefore: 100,
	});
	host.addMessage("current-user", "compaction-entry", user("Show the implementation."));
	await host.start();
	await streamCompletedResponse(host, "assistant", "current-user", "Result.\n```ts\nrun();\n```");

	assert.equal(host.modelRequests.length, 1);
	const serialized = JSON.stringify(host.modelRequests[0].context.messages);
	assert.match(serialized, /Applicable compacted discussion/);
	assert.doesNotMatch(serialized, /Old prompt that should be summarized away/);
});

test("block-only mode shares identical blocks without sending conversation history", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-block-only-"));
	const restoreEnvironment = await configure(root, "block-only");
	const restoreWorker = mockWorker();
	const host = new FakeVoiceHost(path.join(root, "project"), "block-only", async () => modelResponse("A block-only description."));
	t.after(async () => {
		await host.shutdown().catch(() => {});
		restoreWorker();
		await restoreEnvironment();
	});

	host.addMessage("user-1", null, user("Private first discussion."));
	await host.start();
	await streamCompletedResponse(host, "assistant-1", "user-1", "First.\n```ts\nrun();\n```");
	host.addMessage("user-2", "assistant-1", user("Private second discussion."));
	await streamCompletedResponse(host, "assistant-2", "user-2", "Second.\n```ts\nrun();\n```");

	assert.equal(host.modelRequests.length, 1);
	const request = host.modelRequests[0];
	assert.equal(request.context.messages.length, 1);
	assert.doesNotMatch(requestText(request), /Private first discussion|Private second discussion/);
	assert.equal(requestText(request).split("run();").length - 1, 1);
	assert.equal(request.options.cacheRetention, "none");
});
