import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient as VoiceWorkerClient, streamCompletedResponse, type ModelRequest } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient } });

async function settle(): Promise<void> {
	for (let index = 0; index < 10; index += 1) await new Promise(resolve => setImmediate(resolve));
}

test("failed descriptions render retry errors, stay silent, and recover via code-retry", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-code-retry-"));
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
			codeDescriptionPreprocessBudget: "unlimited",
		}),
	);
	process.env.PI_VOICE_CONFIG = configPath;
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");

	// The provider first only produces filler; flip the flag to simulate a fix.
	let providerHealthy = false;
	const calls: string[] = [];
	const originalMeasure = VoiceWorkerClient.prototype.measureSegment;
	VoiceWorkerClient.prototype.measureSegment = async function (): Promise<number> {
		return 1;
	};
	const originalSend = VoiceWorkerClient.prototype.sendSegment;
	let spoken = 0;
	VoiceWorkerClient.prototype.sendSegment = function (): void { spoken++; };
	const originalPause = VoiceWorkerClient.prototype.setPlaybackPaused;
	const pauses: boolean[] = [];
	VoiceWorkerClient.prototype.setPlaybackPaused = function (paused): void { pauses.push(paused); };
	const healthyResult = Promise.withResolvers<any>();

	const host = new FakeVoiceHost(path.join(root, "project"), "retry", async (_request: ModelRequest) => {
		calls.push(new Date().toISOString());
		if (!providerHealthy) {
			return { role: "assistant", content: [{ type: "text", text: "A JSON file contains 4 lines." }], stopReason: "stop" };
		}
		return healthyResult.promise;
	});

	t.after(async () => {
		await host.shutdown().catch(() => {});
		VoiceWorkerClient.prototype.measureSegment = originalMeasure;
		VoiceWorkerClient.prototype.sendSegment = originalSend;
		VoiceWorkerClient.prototype.setPlaybackPaused = originalPause;
		if (previous.config === undefined) delete process.env.PI_VOICE_CONFIG;
		else process.env.PI_VOICE_CONFIG = previous.config;
		if (previous.coordinator === undefined) delete process.env.PI_VOICE_COORDINATOR_DIR;
		else process.env.PI_VOICE_COORDINATOR_DIR = previous.coordinator;
		if (previous.devices === undefined) delete process.env.PI_VOICE_DEVICE_DIR;
		else process.env.PI_VOICE_DEVICE_DIR = previous.devices;
		await fs.rm(root, { recursive: true, force: true });
	});

	host.addMessage("user-1", null, { role: "user", content: [{ type: "text", text: "Show it." }], timestamp: 1 });
	await host.start();
	const text = "Answer.\n```ts\nrun();\n```\nSame block.\n```ts\nrun();\n```";
	await streamCompletedResponse(host, "assistant-1", "user-1", text);

	// Quality failures exhaust three attempts before the omission is recorded.
	assert.equal(calls.length, 3, "matching occurrences share one sequence of quality retries");

	await new Promise(resolve => setTimeout(resolve, 200));
	// The written callout is a retry error, not filler.
	const rendered = host.render(text);
	assert.match(rendered, /Description omitted \(quality\)/);
	assert.doesNotMatch(rendered, /contains 4 lines/);

	// Sweeps, unrelated settings, generator changes, and replay do not retry omissions.
	await host.command("autoscroll off");
	await host.command("edit-model test/other");
	await host.emit("agent_settled", {});
	await settle();
	assert.equal(calls.length, 3);
	assert.match(host.render(text), /Description omitted/);

	// Recovery through the command after the provider improves.
	providerHealthy = true;
	const before = calls.length;
	const beforeReplay = spoken;
	await host.shortcut("f11");
	for (let index = 0; index < 150 && spoken === beforeReplay; index++) await new Promise(resolve => setTimeout(resolve, 10));
	await settle();
	assert.ok(spoken > beforeReplay, "replay acquired the mocked transport");
	assert.equal(calls.length, before, "replay must leave omissions intact");
	const spokenBefore = spoken;
	await host.command("code-retry historical all");
	assert.equal(pauses.at(-1), true, `retry pauses the dirty current asset before its replacement exists: ${JSON.stringify(host.notices)}`);
	healthyResult.resolve({ role: "assistant", content: [{ type: "text", text: "It registers the toggle shortcuts." }], stopReason: "stop" });
	await new Promise(resolve => setTimeout(resolve, 150));
	await settle();

	assert.equal(calls.length, before + 1, "one retry per complete cache key, not per occurrence");
	const recovered = host.render(text);
	assert.match(recovered, /toggle shortcuts/);
	assert.doesNotMatch(recovered, /Description omitted/);
	assert.equal(pauses.at(-1), true, "regeneration completion must not resume");
	assert.equal(spoken, spokenBefore);
	await host.shortcut("f8");
	// The cold mocked transport has no cancel acknowledgement; wait for the bounded stop proof.
	for (let index = 0; index < 150 && pauses.at(-1) !== false; index++) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	await settle();
	assert.equal(pauses.at(-1), false, `one resume rebuilds the current description: ${JSON.stringify(host.notices)}`);
});
