import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DeviceRouter } from "../src/device-router.js";
import { PhoneInputClient } from "../src/phone-input.js";
import { StopRecovery } from "../src/stop-recovery.js";

const ticket = `${"a".repeat(32)}.1`;
const bootId = "12345678-1234-1234-1234-123456789abc";

async function fixture(t: import("node:test").TestContext, response: string | null) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-input-recovery-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const commands: string[] = [];
	let confirmStop = false;
	const admitted = Promise.withResolvers<void>();
	const sockets = new Set<net.Socket>();
	const socketPath = path.join(root, "input.sock");
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		socket.on("data", chunk => {
			const command = String(chunk).trim();
			commands.push(command);
			if (command === "ticket-admit") socket.write(`ticket ${ticket} ${bootId} admit-v1 null\n`);
			else if (command === `record ${ticket} ${bootId}`) {
				admitted.resolve();
				if (response !== null) socket.end(response);
			} else if (command === `stop ${ticket}`) {
				socket.end(confirmStop ? `ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n` : "error dW5jb25maXJtZWQ=\n");
			}
		});
	});
	await new Promise<void>(resolve => server.listen(socketPath, resolve));
	t.after(() => {
		for (const socket of sockets) socket.destroy();
		return new Promise<void>(resolve => server.close(() => resolve()));
	});
	const endpoint = `unix://${socketPath}`;
	const journal = new StopRecovery(root, "owner");
	journal.initialize();
	const client = new PhoneInputClient(
		handle => journal.retain("input", { endpoint: handle.endpoint, id: handle.ticket, bootId: handle.bootId, networkAdmission: handle.networkAdmission, selection: "local", configured: handle.endpoint }, "Custom input"),
		handle => journal.retire("input", handle.ticket, handle.endpoint),
	);
	return { root, endpoint, journal, client, commands, admitted, confirmStop() { confirmStop = true; } };
}

for (const status of ["audio", "ok"]) test(`accepted single-response ${status} retires custom A before B restart recovery`, async t => {
	const a = await fixture(t, `${status} ${Buffer.from("capture").toString("base64")}\n`);
	const b = await fixture(t, null);
	a.confirmStop();
	assert.deepEqual(await a.client.capture(a.endpoint), { type: status === "audio" ? "audio" : "text", data: status === "audio" ? Buffer.from("capture") : "capture" });
	assert.deepEqual(new StopRecovery(a.root, "owner").episode("input")!.handles, []);
	await a.client.stop();
	assert.deepEqual(a.commands, ["ticket-admit", `record ${ticket} ${bootId}`, `stop ${ticket}`], "network completion requires an explicit stop receipt");
	a.journal.clear("input");
	assert.equal(new StopRecovery(a.root, "owner").isIdle("input"), true);

	// Use the same durable journal for the next endpoint, as the application does.
	const active = new PhoneInputClient(handle => a.journal.retain("input", {
		endpoint: handle.endpoint, id: handle.ticket, bootId: handle.bootId, networkAdmission: handle.networkAdmission, selection: "local", configured: handle.endpoint,
	}, "Custom B"));
	const capture = assert.rejects(active.capture(b.endpoint), /cancelled/);
	await b.admitted.promise;
	const restored = new StopRecovery(a.root, "owner");
	assert.deepEqual(restored.episode("input")!.handles, [{ endpoint: b.endpoint, id: ticket, bootId, networkAdmission: true, selection: "local", configured: b.endpoint }]);
	b.confirmStop();
	await restored.retry("input", new DeviceRouter(path.join(a.root, "devices"), "owner", {}), b.endpoint);
	assert.equal(new StopRecovery(a.root, "owner").isIdle("input"), true);
	assert.deepEqual(b.commands, ["ticket-admit", `record ${ticket} ${bootId}`, `stop ${ticket}`]);
	await active.cancel();
	await capture;
});

test("retains the boot-bound handle durably before START", async t => {
	const f = await fixture(t, "ok Y2FwdHVyZQ==\n");
	const retain = f.journal.retain.bind(f.journal);
	const retained = t.mock.method(f.journal, "retain", (...args: Parameters<StopRecovery["retain"]>) => {
		retain(...args);
		assert.deepEqual(f.commands, ["ticket-admit"], "START must wait for durable retention");
		assert.deepEqual(new StopRecovery(f.root, "owner").episode("input")!.handles, [
			{ endpoint: f.endpoint, id: ticket, bootId, networkAdmission: true, selection: "local", configured: f.endpoint },
		]);
	});
	f.confirmStop();
	assert.deepEqual(await f.client.capture(f.endpoint), { type: "text", data: "capture" });
	assert.equal(retained.mock.callCount(), 1);
	assert.deepEqual(f.commands, ["ticket-admit", `record ${ticket} ${bootId}`, `stop ${ticket}`]);
});

test("durable retain failure sends no record", async t => {
	const f = await fixture(t, null);
	// Force journal publication to fail, rather than merely throwing in the callback.
	await fs.unlink(f.journal.file);
	await fs.mkdir(f.journal.file, { recursive: true });
	await assert.rejects(f.client.capture(f.endpoint), { code: "EISDIR" });
	await assert.rejects(f.client.cancel(), /unconfirmed/);
	assert.deepEqual(f.commands, ["ticket-admit", `stop ${ticket}`], "failed retention must never send START");
});

for (const response of ["audio \n", "error cmVqZWN0ZWQ=\n", ""]) test(`rejected response ${JSON.stringify(response)} cannot retire a ticket`, async t => {
	const f = await fixture(t, response);
	await assert.rejects(f.client.capture(f.endpoint), /empty recording|rejected|connection closed/);
	await assert.rejects(f.client.cancel(), /unconfirmed/);
	assert.equal(new StopRecovery(f.root, "owner").episode("input")!.handles[0].id, ticket);
});

test("single-response retirement persistence failure rejects capture and retains the ticket for stop", async t => {
	const f = await fixture(t, "ok Y2FwdHVyZQ==\n");
	f.confirmStop();
	t.mock.method(f.journal, "retire", () => { throw new Error("disk full"); });
	await assert.rejects(f.client.capture(f.endpoint), /disk full/);
	await assert.rejects(f.client.cancel(), /disk full/);
	assert.ok(f.commands.includes(`stop ${ticket}`), "ticket must survive failed retirement");
	assert.equal(new StopRecovery(f.root, "owner").episode("input")!.handles[0].id, ticket);
});
