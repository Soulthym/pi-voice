import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeDescriptionCache } from "../src/code-description-cache.js";
import { describeCodeBlock } from "../src/code-describer.js";
import { SessionCoordinator } from "../src/session-coordinator.js";

for (const mode of ["sole", "shared", "reload"] as const) test(`SDK callback cancellation: ${mode}`, async () => {
	const shared = mode === "shared";
	const cache = new CodeDescriptionCache();
	const owner = new AbortController();
	const started = Promise.withResolvers<AbortSignal>();
	const reply = Promise.withResolvers<any>();
	const model = { provider: "test", id: "model", contextWindow: 128000 };
	let attempts = 0;
	const ctx = { model, modelRegistry: { find: () => model, complete: async (_model: unknown, _context: unknown, options: any) => {
		options.onPayload();
		started.resolve(options.signal);
		options.signal.addEventListener("abort", () => reply.reject(options.signal.reason), { once: true });
		return reply.promise;
	} } } as never;
	const create = (signal: AbortSignal) => describeCodeBlock(ctx, { language: "ts", code: "print(1)" }, "current", "summary", undefined, signal, { onAttempt: () => { attempts++; } });
	const first = cache.getOrCreate("key", create, undefined, undefined, owner.signal);
	const second = shared ? cache.getOrCreate("key", create) : undefined;
	const providerSignal = await started.promise;
	if (mode === "reload") cache.restore([]);
	else owner.abort();
	await assert.rejects(first, { name: "AbortError" });
	assert.equal(providerSignal.aborted, !shared);
	if (second) {
		reply.resolve({ content: [{ type: "text", text: "The code prints the number one." }], stopReason: "stop" });
		await second;
		assert.ok(cache.get("key"));
	} else {
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(cache.get("key"), undefined);
	}
	assert.equal(attempts, 1);
});

test("last consumer cancels a queued resource lease before provider submission", async () => {
	const root = mkdtempSync(join(tmpdir(), "description-cancel-"));
	const coordinator = new SessionCoordinator(root, "test", root);
	coordinator.start();
	const held = Promise.withResolvers<void>();
	try {
		const busy = coordinator.withResource("code", 1, () => held.promise);
		const cache = new CodeDescriptionCache();
		const owner = new AbortController();
		let calls = 0;
		const request = cache.getOrCreate("queued", signal => coordinator.withResource("code", 1, async () => {
			calls++;
			return { guided: false, records: [] };
		}, signal), undefined, undefined, owner.signal);
		await new Promise(resolve => setImmediate(resolve));
		owner.abort();
		await assert.rejects(request, { name: "AbortError" });
		held.resolve();
		await busy;
		await new Promise(resolve => setTimeout(resolve, 120));
		assert.equal(calls, 0);
	} finally {
		held.resolve();
		coordinator.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});
