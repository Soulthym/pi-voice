import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, streamCompletedResponse } from "./helpers/fake-voice-host.js";

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test("historical second request cannot overtake foreground narration at concurrency one", async t => {
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
	await streamCompletedResponse(host, "live", "old2", "Speak immediately.\n```ts\nliveCode();\n```\nDone.");
	assert.equal(calls.length, 1, "slot stays occupied until the historical provider finishes");
	first.resolve();
	await new Promise(resolve => setTimeout(resolve, 150)); await settle();
	assert.equal(calls.length, 2);
	assert.match(calls[1], /liveCode/, JSON.stringify({ notices: host.notices, workers: MockedVoiceWorkerClient.instances.map(w => w.sent) }));
	const worker = MockedVoiceWorkerClient.instances.find(instance => instance.sent.length);
	assert.ok(worker, "foreground prose starts without waiting for historical generation");
	await host.command("stop"); await settle();
	assert.equal(liveSignal?.aborted, true, "Stop aborts the sole foreground provider consumer");
	await host.emit("agent_settled", {}); await settle();
	assert.equal(calls.length, 2, "sticky Stop does not restart abandoned descriptions");
});
