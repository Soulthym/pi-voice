import assert from "node:assert/strict";
import test from "node:test";
import {
	CodeDescriptionCache,
	parseCodeDescriptionCacheSnapshot,
	type CodeDescriptionCacheSnapshot,
} from "../src/code-description-cache.js";
import { plainCodeNarration } from "../src/code-narration.js";

const KEY = "a".repeat(64);
const PLAN = plainCodeNarration("The code prints each FizzBuzz value.");

test("reuses a restored code description without another model request", async () => {
	const cache = new CodeDescriptionCache();
	cache.restore([{ version: 1, key: KEY, plan: PLAN }]);
	let requests = 0;
	const result = await cache.getOrCreate(KEY, async () => {
		requests += 1;
		return plainCodeNarration("unused");
	});

	assert.deepEqual(result, PLAN);
	assert.equal(requests, 0);
});

test("coalesces simultaneous descriptions and persists the generated plan once", async () => {
	const cache = new CodeDescriptionCache();
	const deferred = Promise.withResolvers<typeof PLAN>();
	const stored: CodeDescriptionCacheSnapshot[] = [];
	let requests = 0;
	const create = () => {
		requests += 1;
		return deferred.promise;
	};

	const first = cache.getOrCreate(KEY, create, snapshot => stored.push(snapshot));
	const second = cache.getOrCreate(KEY, create, snapshot => stored.push(snapshot));
	deferred.resolve(PLAN);

	assert.deepEqual(await Promise.all([first, second]), [PLAN, PLAN]);
	assert.equal(requests, 1);
	assert.deepEqual(stored, [{ version: 1, key: KEY, plan: PLAN }]);
});

test("adopts a legacy key without invalidating timing dependencies and restores its source alias", async () => {
	const identity = "b".repeat(64);
	const cache = new CodeDescriptionCache();
	cache.restore([{ version: 1, key: KEY, plan: PLAN }]);
	const adopted = cache.adopt(identity, KEY);
	assert.ok(adopted);
	assert.equal(cache.resolveKey(identity), KEY);
	const restored = new CodeDescriptionCache();
	restored.restore([adopted]);
	assert.equal(restored.resolveKey(identity), KEY);
	assert.deepEqual(await restored.getOrCreate(restored.resolveKey(identity), async () => {
		throw new Error("a model switch must not regenerate the restored plan");
	}), PLAN);
});

test("uncharged joiners retry a charged rejection with their own creator and store once", async () => {
	const cache = new CodeDescriptionCache();
	const exhausted = Symbol("budget exhausted");
	const charged = Promise.withResolvers<typeof PLAN>();
	const stored: CodeDescriptionCacheSnapshot[] = [];
	let requests = 0;
	const historical = cache.getOrCreate(KEY, () => charged.promise);
	const create = async () => { requests++; return PLAN; };
	const retry = (error: unknown) => error === exhausted;
	const live = cache.getOrCreate(KEY, create, snapshot => stored.push(snapshot), retry);
	const replay = cache.getOrCreate(KEY, create, snapshot => stored.push(snapshot), retry);
	charged.reject(exhausted);
	await assert.rejects(historical, error => error === exhausted);
	assert.deepEqual(await Promise.all([live, replay]), [PLAN, PLAN]);
	assert.equal(requests, 1);
	assert.deepEqual(stored, [{ version: 1, key: KEY, plan: PLAN }]);
	assert.equal(cache.get(KEY), PLAN);
});

test("joiners do not retry unrelated failures or requests from a restored session", async () => {
	for (const restore of [false, true]) {
		const cache = new CodeDescriptionCache();
		const deferred = Promise.withResolvers<typeof PLAN>();
		const failure = new Error("rejected");
		let requests = 0;
		const first = cache.getOrCreate(KEY, () => deferred.promise);
		const joined = cache.getOrCreate(KEY, async () => { requests++; return PLAN; }, undefined, () => restore);
		await Promise.resolve(); // Let the provider start before replacing its session.
		if (restore) cache.restore([]);
		deferred.reject(failure);
		await assert.rejects(first, error => error === failure);
		await assert.rejects(joined, error => error === failure);
		assert.equal(requests, 0);
	}
});

test("rejects malformed persisted descriptions", () => {
	assert.equal(parseCodeDescriptionCacheSnapshot({ version: 1, key: "short", plan: PLAN }), undefined);
	assert.equal(
		parseCodeDescriptionCacheSnapshot({ version: 1, key: KEY, plan: { guided: false, records: [] } }),
		undefined,
	);
});
