import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { NARRATION_ACTIVE_MARKER } from "../src/narration-progress.js";
import { CodeDescriptionCache } from "../src/code-description-cache.js";
import * as describer from "../src/code-describer.js";

let keys = 0;
mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
mock.module("../src/code-describer.js", { namedExports: { ...describer,
	codeDescriptionCacheKey: (...args: Parameters<typeof describer.codeDescriptionCacheKey>) => {
		keys++; return describer.codeDescriptionCacheKey(...args);
	},
} });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
async function setup(t: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-preview-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = names.map(name => process.env[name]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local",
		codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "preview");
	t.after(async () => {
		await host.shutdown();
		names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	return host;
}

test("failed previous-message acquisition keeps subsequent preview and audio on the same selected target", async t => {
	const host = await setup(t);
	for (const id of ["A", "B", "C"]) host.addMessage(id, null, assistant(`${id} sentence.`));
	await host.start();
	const acquire = mock.method(SessionCoordinator.prototype, "tryAcquireSpeech", () => false);
	const force = mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", async () => false);
	t.after(() => { acquire.mock.restore(); force.mock.restore(); });
	await host.shortcut("f6"); await settle();
	assert.ok(host.render("B sentence.").includes(NARRATION_ACTIVE_MARKER));
	assert.match(host.widgetLines()?.join(" ") ?? "", /message 2\/3/);
	acquire.mock.restore(); force.mock.restore();
	await host.shortcut("f6"); await settle();
	assert.ok(host.render("A sentence.").includes(NARRATION_ACTIVE_MARKER));
	assert.equal(host.render("B sentence.").includes(NARRATION_ACTIVE_MARKER), false);
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	assert.equal((worker.sent.at(-1) as { text: string }).text, "A sentence.");
});

test("sentence preview precedes whole-history identity preparation", async t => {
	const host = await setup(t);
	for (let i = 0; i < 40; i++) host.addMessage(`answer-${i}`, null,
		assistant(`First sentence ${i}. Second sentence ${i}.\n\`\`\`js\nconst x = ${i};\n\`\`\``));
	await host.start(); await settle();
	keys = 0;
	const pending = host.shortcut("f9");
	assert.ok(host.render("First sentence 39. Second sentence 39.\n```js\nconst x = 39;\n```").includes(NARRATION_ACTIVE_MARKER));
	assert.ok(keys < 5, `preview must not prepare all 40 identities (got ${keys})`);
	await pending; await settle();
});

for (const key of ["f7", "f9"]) for (const changedCount of [false, true]) {
	test(`${key} ignores discarded branch cursors with ${changedCount ? "different" : "equal"} message counts`, async t => {
		const host = await setup(t);
		host.addMessage("discarded", null, assistant("Discarded first. Discarded second."));
		await host.start(); await host.shortcut("f11"); await settle();
		const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
		const before = worker.sent.length;
		host.entries.splice(host.entries.findIndex(entry => entry.id === "discarded"), 1);
		if (changedCount) host.addMessage("earlier", null, assistant("Earlier branch sentence."));
		host.addMessage("replacement", null, assistant("Replacement first. Replacement second."));
		await host.shortcut(key); await settle();
		const spoken = worker.sent.slice(before) as Array<{ text: string }>;
		assert.equal(spoken[0]?.text, key === "f7"
				? (changedCount ? "Earlier branch sentence." : "Replacement first.") : "Replacement second.");
		assert.ok(spoken.every(segment => !segment.text.includes("Discarded")));
		assert.equal(host.render("Discarded first. Discarded second.").includes(NARRATION_ACTIVE_MARKER), false);
	});
}

for (const resumeDuringPreparation of [false, true]) test(`F8 retains pending sentence navigation (early resume: ${resumeDuringPreparation})`, async t => {
	const host = await setup(t);
	const text = "First sentence. Second sentence. Third sentence.";
	host.addMessage("answer", null, assistant(text));
	await host.start(); await host.shortcut("f11"); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const before = worker.sent.length;
	const pending = host.shortcut("f9");
	await host.shortcut("f8");
	assert.equal(worker.pauses.at(-1), true);
	if (resumeDuringPreparation) await host.shortcut("f8");
	await pending; await settle();
	assert.equal(worker.pauses.at(-1), !resumeDuringPreparation);
	const segments = worker.sent.slice(before) as Array<{ text: string; utterance: number; segmentId: number }>;
	assert.deepEqual(segments.map(segment => segment.text), ["Second sentence.", "Third sentence."]);
	if (!resumeDuringPreparation) await host.shortcut("f8");
	await settle();
	const third = segments[1];
	worker.emit({ type: "segment-audio", utterance: third.utterance, segmentId: third.segmentId, start: 2, duration: 2 });
	worker.emit({ type: "playback", utterance: third.utterance, position: 2.5 });
	assert.ok(host.render(text).includes(`${NARRATION_ACTIVE_MARKER}Third`), "resumed replacement ticks still update highlights");
});

test("sentence navigation resolves known absolute timing after the branch grows", async t => {
	t.mock.method(MockedVoiceWorkerClient.prototype, "measureSegment", async () => 2);
	const host = await setup(t);
	host.addMessage("answer", null, assistant("First sentence. Second sentence. Third sentence."));
	await host.start(); await host.shortcut("f11"); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const full = worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
	full.forEach((segment, i) => worker.emit({ type: "segment-audio", utterance: segment.utterance, segmentId: segment.segmentId, start: i * 2, duration: 2 }));
	host.addMessage("later", "answer", assistant("Later message."));
	const before = full.length;
	await host.shortcut("f9"); await settle();
	const second = full[before];
	assert.equal(second.text, "Second sentence.");
	worker.emit({ type: "segment-audio", utterance: second.utterance, segmentId: second.segmentId, start: 0, duration: 2 });
	worker.emit({ type: "playback", utterance: second.utterance, position: 1 });
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.match(host.widgetLines()?.join(" ") ?? "", /\] 0:03 \/ /);
});

test("cached description sentence previews carry description offsets before acquisition", async t => {
	const host = await setup(t);
	const cached = mock.method(CodeDescriptionCache.prototype, "get", () => ({ guided: false,
		records: [{ speech: "First description. Second description.", operations: [] }] }));
	const acquire = mock.method(SessionCoordinator.prototype, "tryAcquireSpeech", () => false);
	const force = mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", async () => false);
	t.after(() => { cached.mock.restore(); acquire.mock.restore(); force.mock.restore(); });
	const text = "```js\nconst x = 1;\n```";
	host.addMessage("answer", null, assistant(text));
	await host.start(); await host.shortcut("f11"); await settle();
	assert.ok(host.render(text).includes(`${NARRATION_ACTIVE_MARKER}First`), "first description word, not raw fence");
	await host.shortcut("f9"); await settle();
	assert.ok(host.render(text).includes(`${NARRATION_ACTIVE_MARKER}Second`), "skipUnits maps to the second description sentence");
	assert.equal(MockedVoiceWorkerClient.instances.at(-1)?.sent.length ?? 0, 0, "failed acquisition never sends audio");
});
