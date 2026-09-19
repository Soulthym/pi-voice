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
