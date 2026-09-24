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
			if (command === "ticket") socket.write(`ticket ${ticket}\n`);
			else if (command === `record ${ticket}`) {
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
	const client = new PhoneInputClient(
		handle => journal.retain("input", { endpoint: handle.endpoint, id: handle.ticket, selection: "local", configured: handle.endpoint }, "Custom input"),
		handle => journal.retire("input", handle.ticket, handle.endpoint),
	);
	return { root, endpoint, journal, client, commands, admitted, confirmStop() { confirmStop = true; } };
}

for (const status of ["audio", "ok"]) test(`accepted single-response ${status} retires custom A before B restart recovery`, async t => {
	const a = await fixture(t, `${status} ${Buffer.from("capture").toString("base64")}\n`);
	const b = await fixture(t, null);
	assert.deepEqual(await a.client.capture(a.endpoint), { type: status === "audio" ? "audio" : "text", data: status === "audio" ? Buffer.from("capture") : "capture" });
	assert.deepEqual(new StopRecovery(a.root, "owner").episode("input")!.handles, []);
	await a.client.stop();
	assert.deepEqual(a.commands, ["ticket", `record ${ticket}`], "successful completion cleared the ticket without an extra stop");

	// Use the same durable journal for the next endpoint, as the application does.
	const active = new PhoneInputClient(handle => a.journal.retain("input", {
		endpoint: handle.endpoint, id: handle.ticket, selection: "local", configured: handle.endpoint,
	}, "Custom B"));
	const capture = assert.rejects(active.capture(b.endpoint), /cancelled/);
	await b.admitted.promise;
	const restored = new StopRecovery(a.root, "owner");
	assert.deepEqual(restored.episode("input")!.handles.map(handle => handle.endpoint), [b.endpoint]);
	b.confirmStop();
	await restored.retry("input", new DeviceRouter(path.join(a.root, "devices"), "owner", {}), b.endpoint);
	assert.deepEqual(new StopRecovery(a.root, "owner").episode("input")!.handles, []);
	assert.deepEqual(b.commands, ["ticket", `record ${ticket}`, `stop ${ticket}`]);
	await active.cancel();
	await capture;
});

for (const response of ["audio \n", "error cmVqZWN0ZWQ=\n", ""]) test(`rejected response ${JSON.stringify(response)} cannot retire a ticket`, async t => {
	const f = await fixture(t, response);
	await assert.rejects(f.client.capture(f.endpoint), /empty recording|rejected|connection closed/);
	await assert.rejects(f.client.cancel(), /unconfirmed/);
	assert.equal(new StopRecovery(f.root, "owner").episode("input")!.handles[0].id, ticket);
});

test("single-response retirement persistence failure rejects capture and retains the ticket for stop", async t => {
	const f = await fixture(t, "ok Y2FwdHVyZQ==\n");
	t.mock.method(f.journal, "retire", () => { throw new Error("disk full"); });
	await assert.rejects(f.client.capture(f.endpoint), /disk full/);
	await assert.rejects(f.client.cancel(), /unconfirmed/);
	assert.ok(f.commands.includes(`stop ${ticket}`), "ticket must survive failed retirement");
	assert.equal(new StopRecovery(f.root, "owner").episode("input")!.handles[0].id, ticket);
});
