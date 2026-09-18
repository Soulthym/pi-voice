import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { assistant, FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";

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
	await host.command("timing-preprocess 1");
	const widgetWrites = host.widgetOperations.filter(operation => operation.name === "pi-voice-progress").length;
	await host.command("timing-preprocess 1");
	assert.equal(host.widgetOperations.filter(operation => operation.name === "pi-voice-progress").length, widgetWrites,
		"identical progress refreshes must not recreate the widget");
	branchReads = entryReads = 0;
	await new Promise(resolve => setTimeout(resolve, 650));
	assert.equal(branchReads, 0, "unchanged idle polls must not rebuild timing identities");
	assert.equal(entryReads, 0);
});
