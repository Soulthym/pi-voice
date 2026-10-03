import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { DevicePriorityStore, rankDevicePriorities } from "../src/device-priorities.js";

function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "device-priorities-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "priorities.json");
	return { root, file, store: new DevicePriorityStore(file) };
}

test("manual prefix, automatic discoveries, offline positions, separate pin and local fallback", t => {
	const { store, file } = fixture(t);
	store.discover([{ id: "b", date: 20 }, { id: "a", date: 10 }, { id: "c", date: 30 }]);
	store.place("c", 0);
	store.discover([{ id: "d", date: 40 }, { id: "a", date: 999 }]);
	assert.deepEqual(store.snapshot.user_order, ["c"]);
	assert.equal(store.snapshot.discovery.a.date, 10);
	const available = new Set(["a", "local"]);
	const rows = rankDevicePriorities(store.snapshot, available, "b");
	assert.deepEqual(rows.map(row => [row.id, row.priority, row.available]), [["b", 0, false], ["c", 1, false], ["a", 2, true], ["d", 4, false], ["local", -1, true]]);
	assert.equal(rows.find(row => row.available)?.id, "a", "local -1 is not numeric minimum");
	assert.deepEqual(store.snapshot.user_order, ["c"], "pin leaves underlying order unchanged");
	store.place("local", 0);
	assert.deepEqual(rankDevicePriorities(store.snapshot, available).map(row => [row.id, row.priority]), [["local", 1], ["c", 2], ["a", 3], ["b", 4], ["d", 5]]);
	store.reset("local");
	assert.equal(rankDevicePriorities(store.snapshot, available).at(-1)?.priority, -1);
	store.reset("c");
	assert.deepEqual(rankDevicePriorities(store.snapshot, available).map(row => row.id), ["a", "b", "c", "d", "local"]);
	assert.deepEqual(new DevicePriorityStore(file).snapshot, store.snapshot);
	assert.ok(Object.isFrozen(store.snapshot.discovery.a));
	assert.ok(Object.isFrozen(rows[0]));
});

test("cached snapshots have no reads; stale sessions merge operations, not whole snapshots", t => {
	const { store, file } = fixture(t);
	const other = new DevicePriorityStore(file);
	store.discover([{ id: "one", date: 1 }]);
	store.place("one", 0);
	other.discover([{ id: "two", date: 2 }]);
	other.place("two", 0);
	store.discover([{ id: "three", date: 3 }]);
	assert.deepEqual(store.snapshot.user_order, ["two", "one"]);
	const cached = store.snapshot;
	const ranked = store.ranking(new Set(["one", "local"]), "two");
	store.discover([{ id: "one", date: 999 }]);
	assert.equal(store.snapshot, cached, "unchanged heartbeat preserves event snapshot");
	store.refresh();
	assert.equal(store.snapshot, cached, "unchanged disk refresh preserves event snapshot");
	assert.equal(store.ranking(new Set(["local", "one"]), "two"), ranked);
	assert.notEqual(store.ranking(new Set(["local"]), "two"), ranked, "availability is a ranking event");
	writeFileSync(file, "invalid");
	assert.equal(store.snapshot, cached);
	assert.throws(() => store.refresh());
	assert.throws(() => store.reset());
	assert.equal(readFileSync(file, "utf8"), "invalid", "corrupt stores never silently overwritten");
});

test("validates disk and operation boundaries, including prototype-shaped stable IDs", t => {
	const { store, file } = fixture(t);
	store.discover([{ id: "__proto__", date: 1 }, { id: "constructor", date: 1 }]);
	store.place("__proto__", 0);
	assert.deepEqual(Object.keys(store.snapshot.discovery), ["__proto__", "constructor"]);
	assert.equal(new DevicePriorityStore(file).snapshot.discovery.__proto__.date, 1);
	assert.throws(() => store.discover([{ id: "../bad", date: 1 }]));
	assert.throws(() => store.discover([{ id: "ok", date: NaN }]));
	assert.throws(() => store.place("unknown", 0));
	assert.throws(() => store.place("local", -1));
	for (const data of [
		{ version: 2, discovery: {}, user_order: [] },
		{ version: 1, discovery: { x: { date: "bad" } }, user_order: [] },
		{ version: 1, discovery: {}, user_order: ["missing"] },
		{ version: 1, discovery: {}, user_order: ["local", "local"] },
	]) {
		writeFileSync(file, JSON.stringify(data));
		assert.throws(() => new DevicePriorityStore(file));
	}
});

test("concurrent Pi processes retain every discovery and manual edit", { timeout: 20000 }, async t => {
	const { store, file, root } = fixture(t);
	const module = new URL("../src/device-priorities.ts", import.meta.url).href;
	const workers = Array.from({ length: 8 }, (_, index) => new Promise<void>((resolve, reject) => {
		const source = `import { DevicePriorityStore } from ${JSON.stringify(module)};
		const store = new DevicePriorityStore(${JSON.stringify(file)});
		store.discover([{id: 'same', date: ${100 - index}}, {id: 'device-${index}', date: ${index}}]);
		store.place('device-${index}', 0);`;
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
			env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CACHE_HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, PI_CODING_AGENT_DIR: root },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let error = "";
		child.stderr.on("data", data => { error += data; });
		child.on("error", reject);
		child.on("exit", code => code === 0 ? resolve() : reject(new Error(error || `exit ${code}`)));
	}));
	const reads: unknown[] = [];
	const reader = setInterval(() => {
		try { JSON.parse(readFileSync(file, "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reads.push(error); }
	}, 1);
	try { await Promise.all(workers); } finally { clearInterval(reader); }
	assert.deepEqual(reads, [], "atomic publication never exposes partial JSON");
	store.refresh();
	assert.equal(Object.keys(store.snapshot.discovery).length, 9);
	assert.equal(store.snapshot.discovery.same.date, 93);
	assert.equal(store.snapshot.user_order.length, 8);
	assert.equal(new Set(store.snapshot.user_order).size, 8);
	assert.equal(rankDevicePriorities(store.snapshot, new Set()).at(-2)?.id, "same");
});
