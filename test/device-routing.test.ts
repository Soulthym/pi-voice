import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevicePriorityStore } from "../src/device-priorities.js";
import { DeviceRouting } from "../src/device-routing.js";
import type { VoiceDeviceRegistration } from "../src/device-router.js";

const device = (id: string, connectedAt = 1): VoiceDeviceRegistration => ({ version: 1, id, name: id, platform: "linux", connectedAt, lastActive: 1, audioEndpoint: `unix:///fixture/${id}`, inputEndpoint: `unix:///fixture/${id}-input` });

test("relational routing caches heartbeat snapshots and compares local fallback by position", t => {
	const root = mkdtempSync(join(tmpdir(), "routing-cache-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new DevicePriorityStore(join(root, "priorities.json"));
	store.discover(Array.from({ length: 8 }, (_, i) => ({ id: `d${i + 1}`, date: i + 1 })));
	const routing = new DeviceRouting(store);
	const discover = t.mock.method(store, "discover");
	const ranking = t.mock.method(store, "ranking");
	const refresh = t.mock.method(store, "refresh");
	for (let m = 2; m <= 8; m++) for (let n = 1; n <= 8; n++) {
		routing.update([device(`d${n}`)], `d${m}`);
		assert.equal(routing.winner(`d${m}`), n <= m ? `d${n}` : undefined);
	}
	routing.update([device("d2"), device("d3")], "d3");
	const snapshot = routing.snapshot;
	const calls = ranking.mock.callCount();
	for (let i = 0; i < 100; i++) assert.equal(routing.update([{ ...device("d2"), lastActive: i, name: `renamed ${i}` }, device("d3")], "d3"), false);
	assert.equal(routing.snapshot, snapshot);
	assert.equal(ranking.mock.callCount(), calls);
	assert.equal(discover.mock.callCount(), 0);
	assert.equal(refresh.mock.callCount(), 0);
	assert.equal(routing.selected?.priority, 3);
	store.place("local", 0);
	assert.equal(routing.update([device("d2"), device("d3")], "d3"), true);
	assert.equal(routing.selected?.priority, 4);
	assert.equal(routing.winner("d3"), "local");
	routing.update([device("d2"), device("d3")], "d3", "d3");
	assert.equal(routing.selected?.priority, 0);
	assert.equal(routing.winner("local"), "d3");
	assert.equal(routing.update([device("d2", 2), device("d3")], "d3", "d3"), true);
	store.place("d3", 0);
	store.forget("d3");
	assert.equal(Object.hasOwn(store.snapshot.discovery, "d3"), false);
	assert.deepEqual(store.snapshot.user_order, ["local"]);
	routing.update([device("d3", 2)], "local");
	assert.ok(store.snapshot.discovery.d3, "forget is not a hidden discovery blacklist");
});
