import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant, streamCompletedResponse, type ModelRequest } from "./helpers/fake-voice-host.js";

const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
	for (const worker of MockedVoiceWorkerClient.instances) {
		for (const clip of worker.sent as Array<{ text: string; utterance: number }>) {
			if (clip.text.startsWith("Project ")) worker.emit({ type: "idle", utterance: clip.utterance });
		}
	}
	await new Promise(resolve => setTimeout(resolve, 100));
};

test("historical second request cannot overtake foreground narration at concurrency one", async t => {
	MockedVoiceWorkerClient.instances = [];
	mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
	const root = await mkdtemp(join(tmpdir(), "description-priority-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const previous = keys.map(key => process.env[key]);
	[keys[0], keys[1], keys[2]].forEach((key, i) => { process.env[key] = join(root, ["voice.json", "coordinator", "devices"][i]); });
	await writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false, timingPreprocessConcurrency: 0, codeNarration: "summary", codeDescriptionContext: "block-only", codeDescriptionPreprocessConcurrency: 1 }));
	const first = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const calls: string[] = [];
	let liveSignal: AbortSignal | undefined;
	const host = new FakeVoiceHost(root, "priority", async request => {
		calls.push(JSON.stringify(request.context));
		if (calls.length === 1) { started.resolve(); await first.promise; }
		else if (calls.at(-1)!.includes("liveCode")) {
			liveSignal = request.options.signal as AbortSignal;
			await new Promise((_, reject) => liveSignal!.addEventListener("abort", () => reject(liveSignal!.reason), { once: true }));
		}
		return { role: "assistant", content: [{ type: "text", text: "The code prints a value." }], stopReason: "stop" };
	});
	t.after(async () => {
		first.resolve(); await host.shutdown().catch(() => {}); mock.reset();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await rm(root, { recursive: true, force: true });
	});
	for (let i = 1; i <= 2; i++) host.addMessage(`old${i}`, null, { role: "assistant", content: [{ type: "text", text: `History.\n\`\`\`ts\nhistorical${i}();\n\`\`\`` }], stopReason: "stop" });
	await host.start(); await started.promise;
	await streamCompletedResponse(host, "live", "old2", "```ts\nliveCode();\n```");
	await settle();
	assertPhase(host, "Queued");
	await assertBudget(host, 1);
	assert.equal(calls.length, 1, "slot stays occupied until the historical provider finishes");
	first.resolve();
	await new Promise(resolve => setTimeout(resolve, 150)); await settle();
	assert.equal(calls.length, 2);
	assertPhase(host, "Describing");
	await assertBudget(host, 1);
	assert.match(calls[1], /liveCode/, JSON.stringify({ notices: host.notices, workers: MockedVoiceWorkerClient.instances.map(w => w.sent) }));
	const worker = MockedVoiceWorkerClient.instances.find(instance => instance.sent.length);
	assert.ok(worker, "foreground transport starts without waiting for historical generation");
	await host.command("stop"); await settle();
	assert.equal(liveSignal?.aborted, true, "Stop aborts the sole foreground provider consumer");
	assert.doesNotMatch(host.widgetLines()?.join("\n") ?? "", /Describing/);
	await assertBudget(host, 1);
	await host.emit("agent_settled", {}); await settle();
	assert.equal(calls.length, 2, "sticky Stop does not restart abandoned descriptions");
});

function assertPhase(host: FakeVoiceHost, phase: "Queued" | "Describing"): void {
	const lines = host.widgetLines()?.join("\n") ?? "";
	assert.match(lines, new RegExp(`\\b${phase}\\b`));
	assert.doesNotMatch(lines, new RegExp(`\\b${phase === "Queued" ? "Describing" : "Queued"}\\b`));
}

async function assertBudget(host: FakeVoiceHost, used: number): Promise<void> {
	await host.command("code-budget");
	assert.match(host.notices.at(-1)!.message, new RegExp(`used=${used};`));
}

async function setupActivity(t: TestContext, context: "conversation" | "block-only", respond: (request: ModelRequest) => Promise<any>, budget = 25) {
	MockedVoiceWorkerClient.instances = [];
	mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
	const root = await mkdtemp(join(tmpdir(), "description-activity-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const previous = keys.map(key => process.env[key]);
	keys.forEach((key, i) => { process.env[key] = join(root, ["voice.json", "coordinator", "devices"][i]); });
	await writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false,
		timingPreprocessConcurrency: 0, codeNarration: "summary", codeDescriptionContext: context, codeDescriptionPreprocessConcurrency: 1, codeDescriptionPreprocessBudget: budget }));
	const host = new FakeVoiceHost(root, "activity", respond);
	t.after(async () => {
		await host.shutdown(); mock.reset();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await rm(root, { recursive: true, force: true });
	});
	return host;
}

for (const cancel of [false, true]) {
	test(`conversation context wait is Queued and ${cancel ? "cancellation submits nothing" : "submission alone becomes Describing"}`, async t => {
		const response = Promise.withResolvers<any>();
		t.after(() => response.resolve(assistant("It runs the requested operation.")));
		const host = await setupActivity(t, "conversation", () => response.promise);
		await host.start(); host.idle = false;
		await host.emit("before_agent_start", {});
		const message = assistant("```ts\nrun();\n```\n", "pending");
		await host.emit("message_start", { message });
		await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
		await settle();
		assertPhase(host, "Queued");
		assert.equal(host.modelRequests.length, 0);
		await assertBudget(host, 0);
		if (cancel) await host.command("stop");
		const complete = assistant(message.content[0].text);
		host.addMessage("answer", null, complete);
		await host.emit("message_end", { message: complete });
		await settle();
		assert.equal(host.modelRequests.length, cancel ? 0 : 1);
		if (cancel) assert.doesNotMatch(host.widgetLines()?.join("\n") ?? "", /Describing/);
		else assertPhase(host, "Describing");
		await assertBudget(host, 0);
		await host.command("stop");
	});
}

for (const rejectRetry of [false, true]) {
	test(`foreground joins active background description; ${rejectRetry ? "budget-rejected retry is free and restarts foreground" : "cache replay stays inactive"}`, async t => {
		const first = Promise.withResolvers<any>();
		const second = Promise.withResolvers<any>();
		t.after(() => { first.resolve(assistant("It runs the requested operation.")); second.resolve(assistant("It runs the requested operation.")); });
		let attempts = 0;
		const host = await setupActivity(t, "block-only", () => ++attempts === 1 ? first.promise : second.promise, 1);
		const retryPreflight = Promise.withResolvers<void>();
		t.after(() => retryPreflight.resolve());
		let submissions = 0;
		const complete = host.ctx.modelRegistry.complete;
		host.ctx.modelRegistry.complete = async (...args: Parameters<typeof complete>) => {
			submissions++;
			// Hold the free foreground replacement after the budget rejects the historical retry.
			if (rejectRetry && submissions === 3) await retryPreflight.promise;
			return complete(...args);
		};
		const text = "```ts\nrun();\n```";
		host.addMessage("history", null, assistant(text));
		await host.start(); await settle();
		assert.equal(host.modelRequests.length, 1);
		await assertBudget(host, 1);
		await streamCompletedResponse(host, "live", "history", text);
		await settle();
		assertPhase(host, "Describing");
		assert.equal(host.modelRequests.length, 1, "join must not submit or charge again");
		await assertBudget(host, 1);
		first.resolve(assistant(rejectRetry ? "A JSON file contains 4 lines." : "It runs the requested operation."));
		await new Promise(resolve => setTimeout(resolve, 150)); await settle();
		assert.equal(host.modelRequests.length, 1, "budget-rejected attempts never submit");
		await assertBudget(host, 1);
		if (rejectRetry) {
			assert.equal(submissions, 3, "initial attempt, rejected historical retry, free foreground replacement");
			assertPhase(host, "Queued");
			retryPreflight.resolve(); await settle();
			assert.equal(host.modelRequests.length, 2);
			assertPhase(host, "Describing");
			second.resolve(assistant("It runs the requested operation."));
			await settle();
			assert.equal(host.modelRequests.length, 2);
			await assertBudget(host, 1);
			return;
		}
		const beforeReplay = host.widgetOperations.length;
		await host.shortcut("f5");
		await new Promise(resolve => setTimeout(resolve, 150)); await settle();
		assert.equal(host.modelRequests.length, 1, "cache replay never submits");
		await assertBudget(host, 1);
		assert.doesNotMatch(host.widgetOperations.slice(beforeReplay).flatMap(op => op.value?.lines ?? []).join("\n"), /Describing/, "cache hits must never advertise provider activity");
	});
}
