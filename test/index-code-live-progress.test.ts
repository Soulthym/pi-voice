import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => {
	for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setTimeout(resolve, 100));
};

test("a consumed multi-unit description reaches live without moving its source highlight", async t => {
	const root = await mkdtemp(join(tmpdir(), "code-live-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const previous = keys.map(key => process.env[key]);
	keys.forEach((key, i) => { process.env[key] = join(root, ["voice.json", "coordinator", "devices"][i]); });
	await writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local",
		audioCache: false, codeNarration: "summary", codeDescriptionContext: "block-only", codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const ready = Promise.withResolvers<void>();
	const host = new FakeVoiceHost(root, "code-live", async () => {
		await ready.promise;
		return assistant("Declares a value. Initializes it to one.");
	});
	t.after(async () => {
		ready.resolve(); await host.shutdown(); mock.reset();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await rm(root, { recursive: true, force: true });
	});
	await host.start();
	host.idle = false;
	await host.emit("before_agent_start", {});
	const message = assistant("```ts\nconst value = 1;\n```\n"); delete message.stopReason;
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /● live/, "pending description is not live");
	ready.resolve(); await settle();
	const worker = MockedVoiceWorkerClient.instances.find(worker => worker.sent.length)!;
	const sent = worker.sent as Array<{ utterance: number; segmentId: number; text: string }>;
	for (const prefix of sent.filter(clip => clip.text.startsWith("Project "))) worker.emit({ type: "idle", utterance: prefix.utterance });
	const clips = sent.filter(clip => !clip.text.startsWith("Project "));
	assert.deepEqual(clips.map(clip => clip.text), ["Declares a value.", "Initializes it to one."]);
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /● live/, "pending synthesis is not live");
	const [first, last] = clips;
	worker.emit({ type: "segment-audio", utterance: first.utterance, segmentId: first.segmentId, start: 0, duration: 1 });
	worker.emit({ type: "playback", utterance: first.utterance, position: 1 }); await settle();
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /● live/, "first description unit cannot consume the fence");
	worker.emit({ type: "segment-audio", utterance: last.utterance, segmentId: last.segmentId, start: 1, duration: 1 });
	worker.emit({ type: "playback", utterance: last.utterance, position: 1.5 }); await settle();
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /● live/, "unplayed code is not live");
	await host.shortcut("f8"); await settle();
	worker.emit({ type: "playback", utterance: last.utterance, position: 2 }); await settle();
	assert.match(host.widgetLines()!.join("\n"), /Paused/);
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /● live/);
	await host.shortcut("f8"); await settle();
	worker.emit({ type: "playback", utterance: last.utterance, position: 2 });
	worker.emit({ type: "idle", utterance: last.utterance }); await settle();
	assert.match(host.widgetLines()!.join("\n"), /Playing.*● live/, "consumed code ending is live while waiting for more output");
	await host.shortcut("f8"); await settle();
	assert.match(host.widgetLines()!.join("\n"), /Paused/);
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /● live/, "paused at the consumed frontier is never live");
	await host.shortcut("f7"); await settle();
	assert.doesNotMatch(host.widgetLines()!.join("\n"), /● live/, "navigating back to a description leaves the live edge");
	assert.equal(host.modelRequests.length, 1, "cached navigation never calls another description responder");
});
