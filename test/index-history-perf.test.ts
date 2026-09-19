import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { assistant, FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const scenario of ["f6", "f9", "timing", "aborted", "error", "prefix", "cold"] as const) {
	test(`history preparation regression: ${scenario}`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-history-perf-"));
		const env = {
			PI_VOICE_CONFIG: path.join(root, "voice.json"),
			PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"),
			PI_VOICE_DEVICE_DIR: path.join(root, "devices"),
		};
		const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
		Object.assign(process.env, env);
		await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({
			enabled: true, input: "disabled", output: "local", audioCache: false, codeDescriptionContext: scenario === "cold" ? "conversation" : "block-only",
			codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0,
		}));
		const host = new FakeVoiceHost(root, scenario);
		t.after(async () => {
			mock.restoreAll();
			await host.shutdown();
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			await fs.rm(root, { recursive: true, force: true });
		});
		const workerIndex = MockedVoiceWorkerClient.instances.length;
		if (scenario === "prefix") host.entries.push({ type: "custom", id: "legacy", parentId: null,
			customType: "pi-voice.code-description", data: { version: 1, key: "a".repeat(64),
				plan: { guided: false, records: [{ speech: "Old description.", operations: [] }] } } });
		await host.start();
		const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
		if (scenario === "aborted" || scenario === "error") {
			const partial = assistant("Interrupted.", "pending");
			await host.emit("message_start", { message: partial });
			const cancel = mock.method(worker, "cancel", () => 71);
			await host.emit("message_end", { message: assistant("Interrupted.", scenario) });
			cancel.mock.restore();
			worker.emit({ type: "idle", cancelId: 71 });
			await tick();
			await host.emit("message_start", { message: partial });
			const lease = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
			await fs.stat(lease);
			await host.emit("message_update", { message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Replacement speech. " } });
			await host.emit("message_end", { message: assistant("Replacement speech.") });
			await host.emit("turn_end", { message: assistant("Replacement speech."), toolResults: [] });
			await tick();
			assert.ok(worker.sent.some(segment => (segment as { text: string }).text.includes("Replacement speech")));
			worker.emit({ type: "idle", utterance: (worker.sent.at(-1) as { utterance: number }).utterance });
			await tick();
			await assert.rejects(fs.stat(lease), { code: "ENOENT" });
			return;
		}
		if (scenario === "cold") {
			for (let i = 0; i < 500; i++) host.addMessage(`m${i}`, i ? `m${i - 1}` : null,
				assistant((`Synthetic explanation number ${i}. `).repeat(15) + `\n\`\`\`js\nconst value = ${i};\n\`\`\`\n`));
			const memos: Array<{ identity: string; legacy?: string[] }> = [];
			const set = WeakMap.prototype.set;
			mock.method(WeakMap.prototype, "set", function (this: WeakMap<object, unknown>, key: object, value: any) {
				if (value && typeof value.identity === "string" && "settings" in value) memos.push(value);
				return set.call(this, key, value);
			});
			let last = performance.now(), maxGap = 0;
			const heartbeat = setInterval(() => {
				const now = performance.now();
				maxGap = Math.max(maxGap, now - last);
				last = now;
			}, 1);
			t.after(() => clearInterval(heartbeat));
			let previewIdentities: number | undefined;
			mock.method(host.tui, "requestRender", () => { previewIdentities ??= memos.length; });
			const start = performance.now();
			await host.shortcut("f11");
			const handlerMs = performance.now() - start;
			assert.equal(previewIdentities, 0, "immediate preview must not resolve the whole history");
			assert.ok(memos.length < 500, "handler returns before cold history catch-up completes");
			const deadline = performance.now() + 3000;
			while (!worker.sent.length && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
			assert.ok(worker.sent.length, `cold catch-up must finish and replay the selection (${memos.length} identities; workers ${MockedVoiceWorkerClient.instances.slice(workerIndex).map(worker => worker.sent.length)}; ${JSON.stringify(host.notices)})`);
			assert.ok(memos.length >= 500, "catch-up resolves all canonical source identities");
			assert.ok(memos.every(memo => !memo.legacy), "empty/new caches never serialize legacy context");
			const warmed = memos.length;
			await host.shortcut("f11");
			for (let i = 0; i < 80; i++) await tick();
			assert.ok(memos.length <= warmed + 1, "warm completed identities are reused");
			assert.ok(maxGap < 100, `cold catch-up blocked heartbeat for ${maxGap.toFixed(1)}ms`);
			t.diagnostic(`500 messages: F11 handler ${handlerMs.toFixed(1)}ms; max heartbeat gap ${maxGap.toFixed(1)}ms`);
			return;
		}
		const texts = Array.from({ length: 30 }, (_, i) => scenario === "prefix"
			? `Response ${i}.\n\n\`\`\`js\nconst value = ${i};\n\`\`\`` : `Response ${i}.`);
		texts.forEach((text, i) => host.addMessage(String(i), i ? String(i - 1) : null, assistant(text)));
		host.addMessage("tail", "29", assistant("Tail first. Tail second."));
		if (scenario === "prefix") {
			const memos: Array<{ identity: string; legacySettings?: string; legacy?: string[] }> = [];
			const set = WeakMap.prototype.set;
			mock.method(WeakMap.prototype, "set", function (this: WeakMap<object, unknown>, key: object, value: any) {
				if (value && typeof value.identity === "string" && "settings" in value) memos.push(value);
				return set.call(this, key, value);
			});
			let prompt = "large runtime system prompt ".repeat(10000);
			mock.method(host.ctx, "getSystemPrompt", () => prompt);
			for (const text of texts) host.render(text);
			assert.equal(memos.length, texts.length);
			assert.ok(memos.every(memo => memo.legacySettings && memo.legacySettings.length <= 64),
				"each block retains only a compact runtime-prefix fingerprint");
			await host.shortcut("f11");
			const old = new Map(memos.map(memo => [memo.identity, { ...memo }]));
			prompt += "changed";
			await host.shortcut("f11");
			for (const text of texts) host.render(text);
			assert.ok(memos.some(memo => memo.legacySettings !== old.get(memo.identity)?.legacySettings), "runtime prefix changes invalidate the memo");
			assert.deepEqual(memos.map(memo => memo.legacy), memos.map(memo => old.get(memo.identity)?.legacy), "block-only legacy keys retain compatibility");
			assert.ok(memos.every(memo => memo.legacy?.every(key => /^[a-f0-9]{64}$/.test(key))), "legacy contexts retain only hashes");
			host.ctx.model = { ...host.ctx.model, id: "changed-model" };
			await host.shortcut("f11");
			for (const text of texts) host.render(text);
			assert.ok(memos.some(memo => JSON.stringify(memo.legacy) !== JSON.stringify(old.get(memo.identity)?.legacy)), "model changes refresh legacy keys");
			assert.equal(host.modelRequests.length, 0);
			return;
		}
		let clock = performance.now();
		mock.method(performance, "now", () => clock += 5);
		if (scenario === "timing") {
			const measure = mock.method(MockedVoiceWorkerClient.prototype, "measureSegment", async () => 1);
			await host.command("timing-preprocess 1");
			await host.emit("message_start", { message: assistant("New live response.", "pending") });
			for (let i = 0; i < 80; i++) await tick();
			assert.equal(measure.mock.callCount(), 0, "cancelled history preparation must not start timing workers");
			return;
		}
		const older = host.shortcut("f11");
		await tick();
		const newer = host.shortcut(scenario);
		await Promise.all([older, newer]);
		for (let i = 0; i < 80; i++) await tick();
		const spoken = worker.sent.map(segment => (segment as { text: string }).text).join(" ");
		assert.ok(!spoken.includes("Tail first"), `older replay must not win: ${spoken}`);
		if (scenario === "f6") assert.match(spoken, /Response 29/);
		else assert.match(spoken, /Tail second/);
		assert.equal(host.modelRequests.length, 0);
	});
}
