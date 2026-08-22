import assert from "node:assert/strict";
import test from "node:test";
import {
	processConcurrently,
	resolveCodeDescriptionConcurrency,
	resolveTimingConcurrency,
} from "../src/preprocessing.js";

test("resolves automatic preprocessing concurrency from CPU and memory", () => {
	assert.equal(resolveCodeDescriptionConcurrency("auto", { availableMemory: 1024, parallelism: 16 }), 4);
	assert.equal(resolveCodeDescriptionConcurrency("auto", { availableMemory: 1024, parallelism: 2 }), 2);
	assert.equal(resolveTimingConcurrency("auto", "q8", { availableMemory: 8 * 1024 ** 3, parallelism: 16 }), 4);
	assert.equal(resolveTimingConcurrency("auto", "fp32", { availableMemory: 2 * 1024 ** 3, parallelism: 16 }), 1);
	assert.equal(resolveTimingConcurrency(6, "fp32", { availableMemory: 1, parallelism: 1 }), 6);
});

test("processes only the configured number of items concurrently", async () => {
	let active = 0;
	let maximum = 0;
	const completed: number[] = [];
	await processConcurrently([1, 2, 3, 4, 5], 3, async item => {
		active += 1;
		maximum = Math.max(maximum, active);
		await new Promise(resolve => setTimeout(resolve, 5));
		completed.push(item);
		active -= 1;
	});
	assert.equal(maximum, 3);
	assert.deepEqual(completed.toSorted(), [1, 2, 3, 4, 5]);
});
