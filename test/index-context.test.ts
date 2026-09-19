import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { VoiceWorkerClient } from "../src/worker-client.js";
import { CodeDescriptionCache } from "../src/code-description-cache.js";
import { PlaybackHistory } from "../src/playback-history.js";
import { codeDescriptionCacheKey, legacyCodeDescriptionCacheKey } from "../src/code-describer.js";
import { assistantCodeContext, legacyStructuredContextIdentity } from "../src/code-context.js";
import { plainCodeNarration } from "../src/code-narration.js";
import { loadVoiceConfig } from "../src/config.js";
import { narrationRenderKey } from "../src/render-identity.js";
import { SpeakableStream } from "../src/speakable.js";
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

test("paused sentence navigation uses cached code units without timings or new model requests", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-sentence-controls-"));
	const restoreEnvironment = await configure(root, "block-only");
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, input: "disabled", output: "local",
		codeNarration: "summary", codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const restoreWorker = mockWorker();
	const originalPause = VoiceWorkerClient.prototype.setPlaybackPaused;
	const sent: string[] = []; const pauses: boolean[] = [];
	VoiceWorkerClient.prototype.sendSegment = function (_utterance, _id, text): void { sent.push(text); };
	VoiceWorkerClient.prototype.setPlaybackPaused = function (paused): void { pauses.push(paused); };
	const host = new FakeVoiceHost(path.join(root, "project"), "sentence-controls", async request =>
		modelResponse(requestText(request).includes("fail()") ? "" : "It calls run. The call has no arguments."));
	t.after(async () => { await host.shutdown().catch(() => {}); restoreWorker(); VoiceWorkerClient.prototype.setPlaybackPaused = originalPause; await restoreEnvironment(); });
	host.addMessage("answer", null, assistant("Intro.\n```ts\nrun();\n```\nOutro."));
	await host.start(); await host.shortcut("f11"); await settle();
	assert.equal(host.modelRequests.length, 1);
	await host.shortcut("f8");
	assert.equal(pauses.at(-1), true);
	sent.length = 0;
	await host.shortcut("f9"); await settle();
	assert.ok(sent.includes("It calls run."));
	sent.length = 0;
	await host.shortcut("f9"); await settle();
	assert.deepEqual(sent.filter(text => !text.startsWith("Project ")), ["The call has no arguments.", "Outro."]);
	assert.equal(pauses.at(-1), true, "sentence steps retain pause intent");
	await host.shortcut("f7"); await settle();
	assert.ok(sent.includes("It calls run."));
	await host.shortcut("f9"); await settle();
	await host.shortcut("f9"); await settle();
	const beforeTail = sent.length;
	await host.shortcut("f9"); await settle();
	assert.equal(sent.length, beforeTail, "stepping past the latest sentence follows the tail without more speech");
	assert.equal(host.modelRequests.length, 1);
	host.addMessage("failed", "answer", assistant("Last prose.\n```ts\nfail();\n```"));
	await host.shortcut("f10"); await settle();
	const omittedCount = sent.length;
	await host.shortcut("f9"); await settle();
	assert.equal(sent.length, omittedCount, "a terminal omission is not a pending playable unit");
	assert.doesNotMatch(host.notices.at(-1)?.message ?? "", /boundaries.*pending/);
});

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

test("render and timing dependencies stay live when a missing plan becomes ready or its content changes under the same key", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-plan-content-"));
	const restoreEnvironment = await configure(root, "block-only");
	const restoreWorker = mockWorker();
	const response = Promise.withResolvers<any>();
	const host = new FakeVoiceHost(root, "plan-content", () => response.promise);
	host.sessionManager.getEntry = (id: string) => host.entries.find(entry => entry.id === id);
	t.after(async () => {
		response.resolve(modelResponse());
		await host.shutdown().catch(() => {});
		restoreWorker();
		await restoreEnvironment();
	});
	const renderKeys: string[] = [];
	const sync = PlaybackHistory.prototype.sync;
	t.mock.method(PlaybackHistory.prototype, "sync", function (this: PlaybackHistory, ...args: Parameters<typeof sync>) {
		const message = args[0].find(message => message.id === "answer");
		if (message?.renderKey) renderKeys.push(message.renderKey);
		return sync.apply(this, args);
	});
	const measured: string[] = [];
	VoiceWorkerClient.prototype.measureSegment = async text => { measured.push(text); return 1; };
	const text = "```ts\nrun();\n```";
	host.addMessage("answer", null, assistant(text));
	await host.start(); await settle();
	const missingKey = renderKeys.at(-1);
	assert.ok(missingKey);
	assert.equal(host.modelRequests.length, 1);
	assert.deepEqual(measured, []);

	response.resolve(modelResponse("The first description."));
	await settle();
	const description = host.entries.find(entry => entry.customType === "pi-voice.code-description");
	assert.ok(description);
	const config = await loadVoiceConfig();
	assert.equal(missingKey, narrationRenderKey(text, config, [JSON.stringify([description.data.key, "missing"])]));
	const timings = () => host.entries.filter(entry => entry.customType === "pi-voice.playback-timing");
	assert.equal(timings().length, 1);
	const firstKey = timings()[0].data.renderKey;
	assert.notEqual(firstKey, missingKey, "missing-to-ready must invalidate the render dependency");
	assert.equal(firstKey, narrationRenderKey(text, config, [JSON.stringify([description.data.key, description.data.plan])]));
	assert.deepEqual(measured, ["The first description."]);

	const replacement = plainCodeNarration("A different description.");
	const get = CodeDescriptionCache.prototype.get;
	t.mock.method(CodeDescriptionCache.prototype, "get", function (this: CodeDescriptionCache, key: string) {
		return key === description.data.key ? replacement : get.call(this, key);
	});
	await host.emit("agent_settled", { type: "agent_settled" }); await settle();
	assert.equal(timings().length, 2, "ready-to-ready content changes must discard old timing");
	const secondKey = timings()[1].data.renderKey;
	assert.notEqual(secondKey, firstKey);
	assert.equal(secondKey, narrationRenderKey(text, config, [JSON.stringify([description.data.key, replacement])]));
	assert.equal(renderKeys.at(-1), secondKey);
	assert.deepEqual(measured, ["The first description.", "A different description."]);
	await host.emit("agent_settled", { type: "agent_settled" }); await settle();
	assert.equal(timings().length, 2, "unchanged content must reuse its timing");
	assert.equal(host.modelRequests.length, 1);
});

test("timing jobs cannot relabel old spoken wording after an in-flight plan change", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-stale-plan-"));
	const restoreEnvironment = await configure(root, "block-only");
	const restoreWorker = mockWorker();
	const measured = Promise.withResolvers<number>();
	let started = false;
	VoiceWorkerClient.prototype.measureSegment = async () => { started = true; return measured.promise; };
	const host = new FakeVoiceHost(root, "stale-plan", async () => modelResponse("The original description."));
	t.after(async () => { measured.resolve(1); await host.shutdown().catch(() => {}); restoreWorker(); await restoreEnvironment(); });
	host.addMessage("answer", null, assistant("```ts\nrun();\n```"));
	await host.start(); await settle();
	assert.equal(started, true);
	const get = CodeDescriptionCache.prototype.get;
	t.mock.method(CodeDescriptionCache.prototype, "get", function (this: CodeDescriptionCache, key: string) {
		const plan = get.call(this, key);
		return plan ? plainCodeNarration("The replacement description.") : plan;
	});
	measured.resolve(1); await settle();
	assert.equal(host.entries.filter(entry => entry.customType === "pi-voice.playback-timing").length, 0);
});

for (const format of ["block-only", "serialized-source", "serialized-alias"] as const) {
test(`legacy descriptions and timing survive model changes/reload with fresh per-event contexts (${format})`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-source-cache-"));
	const restoreEnvironment = await configure(root, format === "block-only" ? "block-only" : "conversation");
	const restoreWorker = mockWorker();
	let measurements = 0;
	VoiceWorkerClient.prototype.measureSegment = async () => { measurements++; return 1; };
	const host = new FakeVoiceHost(root, "source-cache", async () => modelResponse());
	const restarted = new FakeVoiceHost(root, "source-cache", async () => modelResponse());
	for (const instance of [host, restarted]) {
		instance.emit = async (name, event) => {
			for (const handler of instance.handlers.get(name) ?? []) await handler(event, Object.create(instance.ctx));
		};
	}
	t.after(async () => {
		await host.shutdown().catch(() => {}); await restarted.shutdown().catch(() => {});
		restoreWorker(); await restoreEnvironment();
	});
	const text = "```ts\nrun();\n```";
	const parser = new SpeakableStream();
	const item = [...parser.push(text), ...parser.flush()].find(item => item.kind === "code");
	assert.ok(item?.kind === "code");
	const serialized = legacyStructuredContextIdentity(assistantCodeContext([], assistant(text), 0, item.source.end)!);
	const oldSource = codeDescriptionCacheKey(host.ctx, item.block, "current", "summary", serialized, "conversation");
	const legacy = format === "block-only"
		? legacyCodeDescriptionCacheKey(host.ctx, item.block, "current", "summary", "", "block-only")
		: format === "serialized-source" ? oldSource : "a".repeat(64);
	host.addMessage("answer", null, assistant(text));
	host.entries.push({ type: "custom", id: "description", parentId: "answer", customType: "pi-voice.code-description",
		data: { version: 1, key: legacy, ...(format === "serialized-alias" ? { identity: oldSource } : {}),
			plan: plainCodeNarration("The legacy description explains the configured action.") } });
	const renderKey = narrationRenderKey(text, await loadVoiceConfig(), [JSON.stringify([legacy, plainCodeNarration("The legacy description explains the configured action.")])]);
	host.entries.push({ type: "custom", id: "timing", parentId: "description", customType: "pi-voice.playback-timing",
		data: { version: 3, messageId: "answer", renderKey, duration: 1, checkpoints: [{ time: 0, duration: 1, sourceOffset: 0 }] } });
	await host.start(); await settle();
	assert.match(host.render(text), /legacy description/);
	assert.equal(measurements, 0, "adopting a legacy description key must retain content-identified timing");
	assert.equal(host.modelRequests.length, 0);
	assert.ok(host.entries.some(entry => entry.customType === "pi-voice.code-description" && entry.data.identity));
	host.ctx.model = { ...host.model, provider: "other", id: "replacement" };
	host.ctx.getSystemPrompt = () => "A different model-specific prefix";
	await host.command("edit-model other/pinned");
	host.ctx.thinkingLevel = "high";
	await host.emit("agent_settled", { type: "agent_settled" }); await settle();
	assert.match(host.render(text), /legacy description/);
	assert.equal(measurements, 0);
	assert.equal(host.modelRequests.length, 0);
	await host.shutdown();
	restarted.entries.push(...structuredClone(host.entries));
	restarted.ctx.model = host.ctx.model;
	await restarted.start(); await settle();
	assert.match(restarted.render(text), /legacy description/);
	assert.equal(measurements, 0);
	assert.equal(restarted.modelRequests.length, 0);
	// New source still generates; the generator setting is not frozen globally.
	await restarted.command("edit-model current");
	restarted.addMessage("new-answer", restarted.entries.at(-1)?.id ?? null, assistant("```ts\nnewAction();\n```"));
	await restarted.emit("agent_settled", { type: "agent_settled" }); await settle();
	assert.equal(restarted.modelRequests.length, 1);
	assert.equal((restarted.modelRequests[0]!.model as { id: string }).id, "replacement");
	assert.ok(restarted.entries.some(entry => entry.customType === "pi-voice.code-description" && entry.data.key !== legacy),
		"fresh event contexts must not suppress cache persistence");
});
}

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
