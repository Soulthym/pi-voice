import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { VoiceWorkerClient } from "../src/worker-client.js";
import { FakeVoiceHost, streamCompletedResponse, type ModelRequest } from "./helpers/fake-voice-host.js";

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
	VoiceWorkerClient.prototype.sendSegment = function (): void {};

	const host = new FakeVoiceHost(path.join(root, "project"), "retry", async (_request: ModelRequest) => {
		calls.push(new Date().toISOString());
		if (!providerHealthy) {
			return { role: "assistant", content: [{ type: "text", text: "A JSON file contains 4 lines." }], stopReason: "stop" };
		}
		return { role: "assistant", content: [{ type: "text", text: "It registers the toggle shortcuts." }], stopReason: "stop" };
	});

	t.after(async () => {
		await host.shutdown().catch(() => {});
		VoiceWorkerClient.prototype.measureSegment = originalMeasure;
		VoiceWorkerClient.prototype.sendSegment = originalSend;
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
	const text = "Answer.\n```ts\nrun();\n```";
	await streamCompletedResponse(host, "assistant-1", "user-1", text);

	// Quality failures exhaust three attempts before the omission is recorded.
	assert.ok(calls.length >= 3, `expected quality retries; got ${calls.length}`);

	await new Promise(resolve => setTimeout(resolve, 200));
	console.error("CALLS:", calls.length);
	// The written callout is a retry error, not filler.
	const rendered = host.render(text);
	console.error("RENDER:", JSON.stringify(rendered.slice(0,300)));
	assert.match(rendered, /No semantic description available \(quality\)/);
	assert.doesNotMatch(rendered, /contains 4 lines/);

	// Recovery through the command after the provider improves.
	providerHealthy = true;
	const before = calls.length;
	await host.command("code-retry historical all");
	await new Promise(resolve => setTimeout(resolve, 150));
	console.error("AFTER-RETRY calls:", calls.length, "before:", before, "requests:", host.modelRequests.length, "notices:", JSON.stringify(host.notices.map(n=>n.message)));
	await settle();
	console.error("AFTER-SETTLE calls:", calls.length);

	const recovered = host.render(text);
	assert.match(recovered, /toggle shortcuts/);
	assert.doesNotMatch(recovered, /No semantic description available/);
});
