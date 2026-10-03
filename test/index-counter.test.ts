import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { assistant, FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 120)); };

for (const count of [0, 50]) test(`full branch counter with ${count} cold messages, live Tail and canonicalization`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "counter-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "voice.json"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local", audioCache: false,
		codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "counter");
	t.after(async () => {
		await host.shutdown();
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	// Append after startup: no timing cache or render-identity hydration exists.
	for (let i = 1; i <= count; i++) host.addMessage(`m${i}`, i > 1 ? `m${i - 1}` : null, assistant(`Response number ${i}.`));
	const counter = (position: number, total: number) => assert.match(host.widgetLines()![0], new RegExp(` · ${position}/${total}(?: ·|\\s)`));
	if (count) {
		await host.shortcut("f5"); await settle(); counter(50, 50);
		await host.shortcut("f6"); await settle(); counter(49, 50);
		await host.shortcut("f6"); await settle(); counter(48, 50);
		host.scrollView.manualScrollTo(0);
		host.idle = false;
		await host.emit("tool_execution_start", { toolCallId: "tool", toolName: "read", args: {} });
		await settle(); counter(48, 50);
	}
	await host.shortcut("f10"); await settle();
	// From 48/50, advance through both existing messages before entering Tail.
	if (count) { await host.shortcut("f10"); await settle(); counter(50, 50); await host.shortcut("f10"); await settle(); }
	counter(count + 1, count);
	assert.match(host.widgetLines()![0], /● live/);
	const streaming = assistant("Next streaming sentence. "); delete streaming.stopReason;
	await host.emit("message_start", { message: streaming });
	await host.emit("message_update", { message: streaming, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: streaming.content[0].text } });
	await settle(); counter(count + 1, count + 1);
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const clip = worker.sent.at(-1) as { utterance: number; segmentId: number };
	worker.emit({ type: "segment-audio", utterance: clip.utterance, segmentId: clip.segmentId, start: 0, duration: 3 });
	worker.emit({ type: "playback", utterance: clip.utterance, position: 1 });
	await settle(); counter(count + 1, count + 1);
	const final = { ...streaming, stopReason: "stop" };
	host.addMessage("next", count ? `m${count}` : null, final);
	// Paint session insertion before message_end adopts the saved identity.
	worker.emit({ type: "ready" }); await settle(); counter(count + 1, count + 1);
	await host.emit("message_end", { message: final });
	await host.emit("turn_end", { message: final, toolResults: [] });
	await settle(); counter(count + 1, count + 1);
	for (const utterance of new Set(worker.sent.map(segment => (segment as { utterance: number }).utterance))) {
		worker.emit({ type: "idle", utterance });
	}
	await settle(); counter(count + 2, count + 1);
	// Real branch changes may reduce totals; no historical maximum is retained.
	await host.command("stop");
	host.entries.splice(0, host.entries.length);
	host.addMessage("branch", null, assistant("A different branch."));
	await host.shortcut("f5"); await settle(); counter(1, 1);
	assert.equal(host.modelRequests.length, 0);
});
