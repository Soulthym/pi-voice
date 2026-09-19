import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, streamCompletedResponse } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 150)); };

test("worker quality reaches the widget independently of clock estimates and preserves paused framing", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-quality-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false }));
	const host = new FakeVoiceHost(root, "quality");
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	t.after(async () => {
		await host.shutdown(); mock.restoreAll();
		for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("user", null, { role: "user", content: [{ type: "text", text: "Narrate." }], timestamp: 1 });
	await host.start();
	const text = "Alpha beta gamma.";
	await streamCompletedResponse(host, "a", "user", text);
	const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
	const segment = worker.sent.at(-1) as { segmentId: number; utterance: number };
	const { segmentId, utterance } = segment;
	const widget = () => host.widgets.get("pi-voice-progress")?.lines?.join("\n") ?? "";
	worker.emit({ type: "segment-audio", segmentId, utterance, start: 0, duration: 6, timingQuality: "estimated" });
	worker.emit({ type: "playback", utterance, position: 1, estimated: false });
	await settle();
	assert.match(widget(), /word timing: estimated/);
	assert.doesNotMatch(widget(), /playback clock: estimated/);
	worker.emit({ type: "alignment-error", segmentId, quality: "estimated", message: "Alignment superseded by upcoming speech" });
	assert.match(widget(), /word timing: estimated/);
	worker.emit({ type: "playback", utterance, position: 1, estimated: true });
	await settle();
	assert.match(widget(), /playback clock: estimated/);
	await host.shortcut("f8");
	const frozen = host.render(text);
	const top = host.scrollView.scrollTop;
	worker.emit({ type: "alignment", segmentId, quality: "mixed", words: [
		{ text: "Alpha", start: 0, end: 1, quality: "ctc-refined" },
		{ text: "beta", start: 3, end: 4, quality: "estimated" },
		{ text: "gamma", start: 5, end: 6, quality: "ctc-refined" },
	] });
	assert.match(widget(), /word timing: mixed \(includes estimates\)/);
	assert.equal(host.render(text), frozen);
	assert.equal(host.scrollView.scrollTop, top);
	worker.emit({ type: "alignment", segmentId, quality: "ctc-refined", words: ["Alpha", "beta", "gamma"].map((text, i) => ({ text, start: i * 2, end: i * 2 + 1, quality: "ctc-refined" })) });
	assert.match(widget(), /word timing: CTC-refined/);
	assert.equal(host.render(text), frozen);
	await host.command("stop");
	worker.emit({ type: "alignment-error", segmentId: segmentId + 999, message: "obsolete" });
	assert.match(widget(), /word timing: CTC-refined/);
});
