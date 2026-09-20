import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";
import { PlaybackHistory } from "../src/playback-history.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
const lines = (host: FakeVoiceHost) => host.widgetOperations.flatMap(operation => operation.value?.lines ?? []);

test("605 targets restore in a fresh host without provider, measurement, synthesis or alignment work", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-restart-phases-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coord");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled",
		output: "local", codeDescriptionContext: "conversation", codeNarration: "summary",
		codeDescriptionPreprocessBudget: "unlimited", timingPreprocessConcurrency: 4 }));
	let measures = 0;
	let phase = "cache-decode";
	let failMeasurement = false;
	const measurement = mock.method(MockedVoiceWorkerClient.prototype, "measureSegment", async (...args: any[]) => {
		measures++;
		args[2]?.(phase);
		if (measures === 1 || measures === 613) await new Promise(resolve => setTimeout(resolve, 120));
		if (failMeasurement) throw new Error("Synthetic measurement failure");
		return 1;
	});
	const synthesis = mock.method(MockedVoiceWorkerClient.prototype, "sendSegment", () => { assert.fail("Unexpected playback/synthesis"); });
	const alignment = mock.method(MockedVoiceWorkerClient.prototype, "preloadAlignment", async () => { assert.fail("Unexpected alignment"); });
	const restore = mock.method(PlaybackHistory.prototype, "restore");
	const hosts: FakeVoiceHost[] = [];
	t.after(async () => {
		for (const host of hosts) await host.shutdown();
		mock.restoreAll();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	const fresh = () => {
		const host = new FakeVoiceHost(path.join(root, "project"), "restart", async () => assistant("Runs the requested operation."));
		hosts.push(host);
		return host;
	};
	const original = fresh();
	for (let i = 0; i < 605; i++) original.addMessage(`answer-${i}`, i ? `answer-${i - 1}` : null,
		assistant(i % 100 === 0 ? `Answer ${i}.\n\`\`\`ts\nrun${i}();\n\`\`\`` : `Answer ${i}.`));
	await original.start();
	const snapshots = (host: FakeVoiceHost) => host.entries.filter(entry => entry.customType === "pi-voice.playback-timing");
	for (let i = 0; i < 300 && snapshots(original).length < 605; i++) await settle();
	assert.equal(snapshots(original).length, 605);
	assert.equal(measures, 612, "605 prose units + 7 code-description units");
	assert.equal(original.entries.filter(entry => entry.customType === "pi-voice.code-description").length, 7);
	assert.equal(original.modelRequests.length, 7, "cold descriptions really use the fake provider");
	assert.ok(lines(original).some(line => /Recovering speech timing.*decoding cached audio/.test(line)));
	// Sub-frame word-estimation phases are intentionally coalesced, not flashed.
	// Refined sparse checkpoints survive, but cannot establish complete word coverage.
	for (const point of snapshots(original).find(entry => entry.data.messageId === "answer-604").data.checkpoints) point.quality = "ctc-refined";
	const persisted = JSON.stringify(original.entries);
	await original.shutdown();
	const before = { measures, restores: restore.mock.callCount() };
	const restarted = fresh();
	restarted.model.id = "other-editing-model";
	restarted.entries.push(...JSON.parse(persisted)); // No shared entry objects, caches or extension closure.
	await restarted.start(); await settle();
	assert.equal(restarted.modelRequests.length, 0);
	assert.equal(measures, before.measures);
	assert.ok(restore.mock.callCount() > before.restores, "persisted snapshots were checked/restored");
	assert.equal(synthesis.mock.callCount(), 0);
	assert.equal(alignment.mock.callCount(), 0);
	assert.ok(lines(restarted).some(line => /Checking saved timing · \d+\/605 targets checked/.test(line)));
	assert.ok(!lines(restarted).some(line => /Recovering speech timing|generating speech|decoding cached audio/.test(line)));
	assert.equal(snapshots(restarted).length, 605, "no duplicate persistence on compatible restart");
	assert.match(restarted.widgetLines()![0], /^○ Idle ·.*message 605\/605/);
	assert.equal(restarted.widgetLines()?.at(-1), "Word timing: unknown/pending");
	assert.ok(lines(restarted).every(line => !/clock|Word timing: \d/i.test(line)), "restored sparse timing never fabricates word counts");
	await restarted.command("timing");
	assert.match(restarted.notices.at(-1)!.message, /^Voice · Word timing: unknown\/pending\n/);
	assert.doesNotMatch(restarted.notices.at(-1)!.message, /clock|\d+\/\d+ estimated/i);

	// A genuine synthesis-setting mismatch must still recover, never masquerade as a check.
	phase = "synthesis";
	await restarted.command("speed 1.2");
	for (let i = 0; i < 300 && snapshots(restarted).length < 1210; i++) await settle();
	assert.equal(snapshots(restarted).length, 1210);
	assert.equal(measures - before.measures, 612);
	assert.equal(restarted.modelRequests.length, 0, "description identity is independent of speech speed");
	assert.ok(lines(restarted).some(line => /Recovering speech timing · \d+\/605 targets ready/.test(line)));
	assert.ok(lines(restarted).some(line => /Recovering speech timing.*generating speech/.test(line)));
	assert.equal(measurement.mock.callCount(), measures);
	failMeasurement = true;
	await restarted.command("speed 1.3");
	for (let i = 0; i < 300 && !restarted.notices.some(notice => /Timing incomplete/.test(notice.message)); i++) await settle();
	assert.equal(snapshots(restarted).length, 1210, "failed targets are never persisted as ready");
	assert.equal(restarted.notices.filter(notice => /Timing incomplete.*605 targets failed.*replay to retry/.test(notice.message)).length, 1);
});
