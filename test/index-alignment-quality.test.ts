import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { PlaybackHistory, type PlaybackTimingSnapshot } from "../src/playback-history.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, streamCompletedResponse } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 150)); };

test("worker quality reaches timing diagnostics independently of clock estimates and preserves paused framing", async t => {
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
	const widget = () => host.widgetLines()?.join("\n") ?? "";
	const timing = async (target = host) => {
		await target.command("timing");
		return target.notices.at(-1)!.message.split("\n")[0].replace(/^Voice · /, "");
	};
	assert.match(widget(), /^◷ Queued .*--:-- · 1\/1 · timing pending\s+\[🎧:/);
	assert.equal(await timing(), "Word timing: unknown/pending");
	worker.emit({ type: "loading" });
	await settle();
	assert.match(widget(), /^◷ Queued .*1\/1/, "unscoped model loading does not claim foreground work");
	for (const earlier of worker.sent as Array<{ utterance: number }>) if (earlier.utterance < utterance) worker.emit({ type: "idle", utterance: earlier.utterance });
	worker.emit({ type: "playback-phase", utterance, segmentId, phase: "playing" });
	worker.emit({ type: "speaking" });
	await settle();
	assert.match(widget(), /^▶ Playing .*--:-- · 1\/1 · timing pending\s+\[🎧:/);
	await host.shortcut("f8");
	assert.match(widget(), /^⏯ Paused .*--:-- · 1\/1 · timing pending\s+\[🎧:/);
	await host.shortcut("f8");
	worker.emit({ type: "segment-audio", segmentId, utterance, start: 0, duration: 6, timingQuality: "estimated" });
	worker.emit({ type: "playback", utterance, position: 1, estimated: false });
	await settle();
	assert.equal(await timing(), "Word timing: 3/3 estimated");
	assert.doesNotMatch(widget(), /clock/i);
	worker.emit({ type: "alignment-error", segmentId, quality: "estimated", message: "Alignment superseded by upcoming speech" });
	assert.equal(await timing(), "Word timing: 3/3 estimated");
	const beforeClockChange = widget();
	worker.emit({ type: "playback", utterance, position: 1, estimated: true });
	await settle();
	assert.equal(widget(), beforeClockChange, "clock provenance never changes visible rows");
	assert.doesNotMatch(widget(), /clock/i);
	await host.shortcut("f8");
	worker.emit({ type: "idle", utterance });
	const snapshots = () => host.entries.filter(entry => entry.customType === "pi-voice.playback-timing").map(entry => entry.data as PlaybackTimingSnapshot);
	assert.equal(snapshots().length, 1);
	const estimated = structuredClone(snapshots()[0]);
	const frozen = host.render(text);
	const top = host.scrollView.scrollTop;
	const pausedLine = host.widgetLines()![0];
	assert.match(pausedLine, /^⏯ Paused /);
	worker.emit({ type: "alignment", segmentId, quality: "mixed", words: [
		{ text: "Alpha", start: 0, end: 1, quality: "ctc-refined" },
		{ text: "beta", start: 3, end: 4, quality: "estimated" },
		{ text: "gamma", start: 5, end: 6, quality: "ctc-refined" },
	] });
	assert.equal(await timing(), "Word timing: 1/3 estimated");
	assert.equal(host.widgetLines()![0], pausedLine);
	assert.equal(host.render(text), frozen);
	assert.equal(host.scrollView.scrollTop, top);
	worker.emit({ type: "alignment", segmentId, quality: "ctc-refined", words: ["Alpha", "beta", "gamma"].map((text, i) => ({ text, start: i * 2, end: i * 2 + 1, quality: "ctc-refined" })) });
	assert.equal(await timing(), "Word timing: 0/3 estimated");
	assert.equal(host.widgetLines()![0], pausedLine);
	assert.equal(host.scrollView.scrollTop, top);
	assert.equal(host.render(text), frozen);
	assert.equal(snapshots().length, 3, "idle snapshot must not suppress late alignment revisions");
	assert.deepEqual(snapshots()[0], estimated, "later refinements must not mutate persisted entries");
	worker.emit({ type: "alignment", segmentId, quality: "ctc-refined", words: ["Alpha", "beta", "gamma"].map((text, i) => ({ text, start: i * 2, end: i * 2 + 1, quality: "ctc-refined" })) });
	worker.emit({ type: "idle", utterance });
	assert.equal(snapshots().length, 3, "unchanged metadata is not persisted twice");
	const reloaded = new PlaybackHistory();
	reloaded.sync([{ id: "a", text, renderKey: estimated.renderKey }]);
	reloaded.restore(JSON.parse(JSON.stringify(snapshots())));
	assert.equal(reloaded.status()?.timingQuality, "ctc-refined");
	assert.equal(reloaded.seekTarget(2)?.sourceOffset, text.indexOf("beta"));
	assert.equal(reloaded.seekTarget(2)?.time, 2);
	await host.command("stop");
	worker.emit({ type: "alignment-error", segmentId: segmentId + 999, message: "obsolete" });
	assert.equal(await timing(), "Word timing: 0/3 estimated");
	await host.shutdown();
	const restoredHost = new FakeVoiceHost(root, "quality-reloaded");
	t.after(() => restoredHost.shutdown());
	restoredHost.entries.push(...JSON.parse(JSON.stringify(host.entries)));
	await restoredHost.start();
	assert.equal(await timing(restoredHost), "Word timing: 0/3 estimated", "persisted measured coverage survives reload");
	assert.match(restoredHost.widgetLines()![0], /^○ Idle /);
	await restoredHost.shutdown();
	const legacyHost = new FakeVoiceHost(root, "quality-legacy");
	t.after(() => legacyHost.shutdown());
	legacyHost.entries.push(...JSON.parse(JSON.stringify(host.entries)));
	for (const entry of legacyHost.entries) {
		if (entry.customType === "pi-voice.playback-timing") delete (entry.data as PlaybackTimingSnapshot).units;
	}
	await legacyHost.start();
	assert.equal(await timing(legacyHost), "Word timing: unknown/pending", "legacy sparse checkpoints cannot fabricate word coverage");
	assert.ok(host.widgetFrames.every(lines => !lines.some(line => /clock/i.test(line))));
	assert.ok(host.widgetFrames.every(lines => !lines.some(line => /Word timing:| · \[|message /.test(line))), "quality changes never add a timing row or restore old playback decoration");
});
