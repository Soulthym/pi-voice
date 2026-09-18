import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";

test("sentence pool grows lazily, drains excess busy workers, shrinks idle workers and cleans up", async t => {
	const children: any[] = [];
	const requests: any[] = [];
	mock.module("node:child_process", { namedExports: { fork: () => {
		const child = Object.assign(new EventEmitter(), {
			killed: false,
			send: (packet: any) => requests.push({ child, ...packet }),
			kill: () => { child.killed = true; child.emit("exit", null, "SIGKILL"); },
		});
		children.push(child);
		return child;
	} } });
	t.after(() => mock.reset());
	const { SentencePool } = await import(new URL("../src/sentence-pool.mjs", import.meta.url).href);
	const pool = new SentencePool(3);
	t.after(() => pool.close());
	for (const value of [0, 9, 1.5, NaN, "2"]) assert.throws(() => pool.resize(value), RangeError);
	const complete = (index: number) => {
		const request = requests[index];
		request.child.emit("message", { id: request.id, audio: request.operation });
	};
	const jobs = [1, 2, 3, 4].map(id => pool.generate(id));
	assert.equal(requests.length, 3);
	pool.resize(1);
	assert.equal(children.filter(child => child.killed).length, 0);
	complete(1); complete(2);
	assert.equal(children.filter(child => child.killed).length, 2);
	assert.equal(requests.length, 3, "no new jobs while excess workers drain");
	complete(0);
	assert.equal(requests.length, 4);
	complete(3);
	assert.deepEqual(await Promise.all(jobs), [1, 2, 3, 4]);
	pool.resize(3);
	assert.equal(children.length, 3, "idle growth is lazy");
	const more = [5, 6, 7].map(id => pool.generate(id));
	assert.equal(children.length, 5);
	complete(4); complete(5); complete(6);
	await Promise.all(more);
	pool.resize(1);
	assert.equal(children.filter(child => !child.killed).length, 1);
	pool.resize(2);
	const cancelled = [8, 9, 10].map(id => assert.rejects(pool.generate(id), /cancelled/));
	pool.resize(1);
	pool.cancel();
	await Promise.all(cancelled);
	complete(7); complete(8); // Retired/cancelled child messages cannot revive jobs.
	const replacement = pool.generate(11);
	complete(9);
	assert.equal(await replacement, 11);
	pool.close();
	assert.ok(children.every(child => child.killed));
	await assert.rejects(pool.generate(12), /closed/);
});
