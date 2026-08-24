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

interface ScenarioOptions {
	scope?: "all" | "since-compaction";
	budget?: number | "unlimited";
	respond?: string;
}

async function setup(root: string, options: ScenarioOptions = {}) {
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
			codeDescriptionPreprocessConcurrency: 1,
			codeDescriptionPreprocessScope: options.scope ?? "since-compaction",
			codeDescriptionPreprocessBudget: options.budget ?? 25,
		}),
	);
	process.env.PI_VOICE_CONFIG = configPath;
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");

	const original = VoiceWorkerClient.prototype.measureSegment;
	VoiceWorkerClient.prototype.measureSegment = async function (): Promise<number> {
		return 1;
	};
	const restoreWorker = (): void => {
		VoiceWorkerClient.prototype.measureSegment = original;
	};

	const host = new FakeVoiceHost(path.join(root, "project"), "budget", async (_request: ModelRequest) => ({
		role: "assistant",
		content: [{ type: "text", text: options.respond ?? "A contextual description." }],
		stopReason: "stop",
	}));

	const restoreEnvironment = async () => {
		await host.shutdown().catch(() => {});
		restoreWorker();
		if (previous.config === undefined) delete process.env.PI_VOICE_CONFIG;
		else process.env.PI_VOICE_CONFIG = previous.config;
		if (previous.coordinator === undefined) delete process.env.PI_VOICE_COORDINATOR_DIR;
		else process.env.PI_VOICE_COORDINATOR_DIR = previous.coordinator;
		if (previous.devices === undefined) delete process.env.PI_VOICE_DEVICE_DIR;
		else process.env.PI_VOICE_DEVICE_DIR = previous.devices;
		await fs.rm(root, { recursive: true, force: true });
	};
	return { host, restoreEnvironment };
}

function user(text: string): any {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** Branch with one summarized-away fenced message and one retained fenced message. */
function seedCompactedBranch(host: FakeVoiceHost): void {
	host.addMessage("old-user", null, user("Old prompt"));
	host.addMessage("old-assistant", "old-user", { role: "assistant", content: [{ type: "text", text: "Old.\n```ts\noldCode();\n```" }], stopReason: "stop" });
	host.addMessage("kept-user", "old-assistant", user("Kept prompt"));
	host.entries.push({
		type: "compaction",
		id: "compaction-entry",
		parentId: "kept-user",
		timestamp: new Date().toISOString(),
		summary: "Earlier discussion.",
		firstKeptEntryId: "kept-user",
		tokensBefore: 100,
	});
}

test("default since-compaction scope skips blocks summarized away by compaction", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-budget-scope-"));
	const { host, restoreEnvironment } = await setup(root, { scope: "since-compaction" });
	t.after(restoreEnvironment);

	seedCompactedBranch(host);
	host.addMessage("current-user", "compaction-entry", user("Show it."));
	await host.start();
	await streamCompletedResponse(host, "kept-answer", "compaction-entry", "Kept.\n```ts\nkeptCode();\n```");
	await settle();

	assert.equal(host.modelRequests.length, 1, `expected only the retained block; got ${JSON.stringify(host.modelRequests.map(r => r.context.messages))}`);
	assert.match(JSON.stringify(host.modelRequests[0].context.messages), /keptCode/);
});

test("scope all revisits blocks that compaction summarized away", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-budget-all-"));
	const { host, restoreEnvironment } = await setup(root, { scope: "all" });
	t.after(restoreEnvironment);

	seedCompactedBranch(host);
	host.addMessage("current-user", "compaction-entry", user("Show it."));
	await host.start();
	await streamCompletedResponse(host, "kept-answer", "compaction-entry", "Kept.\n```ts\nkeptCode();\n```");
	await settle();

	assert.equal(host.modelRequests.length, 2);
	assert.match(JSON.stringify(host.modelRequests), /oldCode/);
});

test("backfill budget caps historical work while live descriptions stay free", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-budget-limit-"));
	const { host, restoreEnvironment } = await setup(root, { scope: "all", budget: 1 });
	t.after(restoreEnvironment);

	// Two purely historical fenced messages plus one that arrives live.
	host.addMessage("a-user", null, user("First"));
	host.addMessage("a-assistant", "a-user", { role: "assistant", content: [{ type: "text", text: "A.\n```ts\ncodeA();\n```" }], stopReason: "stop" });
	host.addMessage("b-user", "a-assistant", user("Second"));
	host.addMessage("b-assistant", "b-user", { role: "assistant", content: [{ type: "text", text: "B.\n```ts\ncodeB();\n```" }], stopReason: "stop" });
	await host.start();

	// Live work never consumes backfill budget even though it shares the queue.
	await streamCompletedResponse(host, "live-answer", "b-assistant", "Live.\n```ts\ncodeLive();\n```");
	await new Promise(resolve => setTimeout(resolve, 120));
	const serialized = JSON.stringify(host.modelRequests);
	assert.match(serialized, /codeLive/);
	assert.ok(serialized.includes("codeA") !== serialized.includes("codeB"), `exactly one historical block may run: ${serialized}`);

	// The skipped block must be B or A consistently; whichever lost the race stays absent.
	const skipped = serialized.includes("codeA") ? "codeB" : "codeA";
	assert.doesNotMatch(serialized, new RegExp(skipped));
	assert.ok(
		host.notices.some(notice => notice.message.includes("backfill stopped at its budget")),
		`exhaustion should be reported; got ${JSON.stringify(host.notices)}`,
	);

	// Topping up resumes the skipped historical block.
	await host.command("code-budget unlimited");
	await settle();
	assert.match(JSON.stringify(host.modelRequests), new RegExp(skipped));

	// And a further live message still works normally afterwards.
	await streamCompletedResponse(host, "second-live", "live-answer", "Again.\n```ts\ncodeSecond();\n```");
	assert.match(JSON.stringify(host.modelRequests), /codeSecond/);
});
