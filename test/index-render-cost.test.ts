import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { assistant, FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";
import * as codeDescriber from "../src/code-describer.js";
import { plainCodeNarration } from "../src/code-narration.js";

let sourceKeyCalls = 0;
let chargeKeyWork = () => {};
mock.module("../src/code-describer.js", { namedExports: {
	...codeDescriber,
	codeDescriptionCacheKey: (...args: Parameters<typeof codeDescriber.codeDescriptionCacheKey>) => {
		sourceKeyCalls++;
		chargeKeyWork();
		return codeDescriber.codeDescriptionCacheKey(...args);
	},
	describeCodeBlock: async () => plainCodeNarration("Synthetic code description."),
} });

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });

for (const context of ["block-only", "conversation"] as const) test(`${context} rendering reuses historical identities`, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-render-cost-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({
		enabled: false, codeDescriptionContext: context, codeDescriptionPreprocessConcurrency: 0,
		timingPreprocessConcurrency: 0, input: "disabled", output: "local",
	}));
	const host = new FakeVoiceHost(root, "render-cost");
	t.after(async () => {
		await host.shutdown();
		mock.restoreAll();
		for (const name of names) {
			if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	const texts = Array.from({ length: 400 }, (_, i) => `Response ${i}.\n\n\`\`\`js\nconst value = ${i};\n\`\`\``);
	texts.forEach((text, i) => host.addMessage(String(i), i ? String(i - 1) : null, assistant(text)));
	let branchReads = 0;
	let entryReads = 0;
	mock.method(host.sessionManager, "getBranch", () => { branchReads++; return host.entries; });
	mock.method(host.sessionManager, "getEntries", () => { entryReads++; return host.entries; });
	const start = performance.now();
	for (const text of texts) host.render(text);
	console.log(`400 fenced messages: ${(performance.now() - start).toFixed(1)}ms; branch=${branchReads}, entries=${entryReads}`);
	assert.equal(branchReads, context === "conversation" ? 1 : 0, "scan the unchanged branch at most once");
	if (context === "block-only") assert.equal(entryReads, 0, "block-only rendering must not build historical provider contexts");
	branchReads = entryReads = 0;
	const warmStart = performance.now();
	for (const text of texts) host.render(text);
	console.log(`${context} warm render: ${(performance.now() - warmStart).toFixed(1)}ms; branch=${branchReads}, entries=${entryReads}`);
	assert.equal(branchReads, 0, "word ticks must reuse the completed-message index");
	assert.equal(entryReads, 0, "word ticks must reuse contextual source identities");
	assert.equal(host.modelRequests.length, 0);
	// The 200ms ownership poll must not repeatedly rescan a settled session.
	host.entries.length = 0;
	await host.command("timing workers 1");
	const widgetWrites = host.widgetOperations.filter(operation => operation.name === "pi-voice-progress").length;
	await host.command("timing workers 1");
	assert.equal(host.widgetOperations.filter(operation => operation.name === "pi-voice-progress").length, widgetWrites,
		"identical progress refreshes must not recreate the widget");
	// Enabling preprocessing schedules asynchronous history preparation.
	for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
	branchReads = entryReads = 0;
	await new Promise(resolve => setTimeout(resolve, 650));
	assert.equal(branchReads, 0, "unchanged idle polls must not rebuild timing identities");
	assert.equal(entryReads, 0);
});

test("completed conversation keys survive replay, settling and custom leaves; cold replay yields", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-history-cost-"));
	const names = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"] as const;
	const previous = names.map(name => process.env[name]);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({
		enabled: true, codeDescriptionContext: "conversation", codeDescriptionPreprocessConcurrency: 0,
		codeDescriptionPreprocessScope: "all", timingPreprocessConcurrency: 0, input: "disabled", output: "local",
	}));
	const host = new FakeVoiceHost(root, "history-cost");
	t.after(async () => {
		chargeKeyWork = () => {};
		await host.shutdown();
		mock.restoreAll();
		names.forEach((name, i) => {
			if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
		});
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	const texts = Array.from({ length: 40 }, (_, i) => `Response ${i}.\n\n\`\`\`js\nconst value = ${i};\n\`\`\``);
	texts.forEach((text, i) => host.addMessage(String(i), i ? String(i - 1) : null, assistant(text)));
	// Replay plain prose so transport narration does not create unrelated live-code keys.
	host.addMessage("tail", String(texts.length - 1), assistant("Replay target."));
	let branchReads = 0;
	let entriesReads = 0;
	const ancestorReads: string[] = [];
	// The shared fake lacks getEntry; model the real host's indexed ancestor lookup.
	const entriesById = new Map(host.entries.map(entry => [entry.id, entry]));
	host.sessionManager.getEntry = (id: string) => { ancestorReads.push(id); return entriesById.get(id); };
	const appendEntry = host.api.appendEntry;
	mock.method(host.api, "appendEntry", (type: string, data: unknown) => {
		appendEntry(type, data);
		const entry = host.entries.at(-1);
		entriesById.set(entry.id, entry);
	});
	mock.method(host.sessionManager, "getBranch", () => { branchReads++; return host.entries; });
	mock.method(host.sessionManager, "getEntries", () => { entriesReads++; return host.entries; });
	const sentCount = () => MockedVoiceWorkerClient.instances.reduce((sum, worker) => sum + worker.sent.length, 0);
	const replay = async () => {
		const before = sentCount();
		await host.shortcut("f5");
		// The shortcut does not await preparation. Observe actual mocked transport work.
		for (let i = 0; i < 2000 && sentCount() === before; i++) {
			await new Promise(resolve => setImmediate(resolve));
		}
		assert.ok(sentCount() > before, "replay must reach the worker before measuring cache reuse");
	};
	const settle = async () => {
		await host.emit("agent_settled", { type: "agent_settled" });
		for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
	};
	sourceKeyCalls = 0;
	// Use an integer origin so synthetic 8ms slices stay exact across floating-point boundaries.
	let clock = 0;
	const now = mock.method(performance, "now", () => clock);
	host.scrollView.setDocument(Array.from({ length: 300 }, (_, line) =>
		line === 160 ? () => host.render("Replay target.") : `line ${line}`), 40);
	host.scrollView.manualScrollTo(0);
	chargeKeyWork = () => {
		if (sourceKeyCalls === 1) assert.equal(host.scrollView.scrollTop, 152, "frame before the first identity computation");
		clock += 4;
	};
	const slices = [0];
	let heartbeat: NodeJS.Immediate;
	const sample = () => {
		slices.push(sourceKeyCalls);
		if (sourceKeyCalls > 0) host.scrollView.manualScrollTo(50);
		heartbeat = setImmediate(sample);
	};
	heartbeat = setImmediate(sample);
	try { await replay(); } finally { clearImmediate(heartbeat); }
	slices.push(sourceKeyCalls);
	assert.equal(host.scrollView.scrollTop, 50, "audio startup must not rearm after manual browsing during identity work");
	chargeKeyWork = () => {};
	now.mock.restore();
	assert.equal(sourceKeyCalls, texts.length, "empty caches compute only current source keys, never legacy serialized contexts");
	assert.ok(slices.some(count => count > 0 && count < texts.length), "cold history must yield before finishing");
	assert.ok(slices.slice(1).every((count, i) => count - slices[i]! <= 4),
		`heartbeat gaps must stay bounded to four synthetic 4ms key computations: ${slices}`);

	// Prime the renderer's mode-specific index and finish synthetic description work.
	for (const text of texts) host.render(text);
	await settle();
	await replay();
	await settle();
	assert.equal(sourceKeyCalls, texts.length,
		"conversation rendering shares current keys prepared by replay");
	const warmKeys = sourceKeyCalls;
	branchReads = entriesReads = 0;
	for (const text of texts) host.render(text);
	await replay();
	await settle();
	assert.equal(sourceKeyCalls, warmKeys, "render, replay and agent_settled reuse completed source keys");
	assert.equal(branchReads, 0, "warm paths must not rescan the branch");
	assert.equal(entriesReads, 0, "warm paths must not rebuild provider contexts");

	// Multiple non-message leaves must walk back to the cached leaf, not rebuild history.
	for (let i = 0; i < 3; i++) host.api.appendEntry("synthetic-cost", { i });
	ancestorReads.length = 0;
	await replay();
	await settle();
	for (const text of texts) host.render(text);
	assert.deepEqual(ancestorReads, host.entries.slice(-3).reverse().map(entry => entry.id));
	assert.equal(branchReads, 0, "custom-only ancestry must skip getBranch");
	assert.equal(entriesReads, 0);
	assert.equal(sourceKeyCalls, warmKeys, "custom entries must preserve completed keys");

	// A genuine message invalidates the branch index, but not older entry identities.
	const next = "New response.\n\n```js\nconst added = true;\n```";
	host.addMessage("new", host.entries.at(-1).id, assistant(next));
	entriesById.set("new", host.entries.at(-1));
	await replay();
	await settle();
	assert.ok(branchReads > 0, "message leaves still invalidate the branch index");
	assert.equal(sourceKeyCalls, warmKeys + 1, "only the new message needs a source key after rebuilding history");
	assert.equal(host.modelRequests.length, 0, "all narration is synthetic; no provider calls");
});
