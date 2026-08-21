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

test("rejects malformed persisted descriptions", () => {
	assert.equal(parseCodeDescriptionCacheSnapshot({ version: 1, key: "short", plan: PLAN }), undefined);
	assert.equal(
		parseCodeDescriptionCacheSnapshot({ version: 1, key: KEY, plan: { guided: false, records: [] } }),
		undefined,
	);
});
