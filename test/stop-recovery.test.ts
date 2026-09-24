import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import test from "node:test";
import { StopRecovery } from "../src/stop-recovery.js";
import { DeviceRouter } from "../src/device-router.js";
import { PhoneInputClient } from "../src/phone-input.js";

const outputId = "11111111-1111-4111-8111-111111111111";
const ticket = `${"a".repeat(32)}.19`;

async function setup(t: import("node:test").TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-recovery-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const commands: string[] = [];
	let exact = true;
	const socketPath = path.join(root, "device.sock");
	const server = net.createServer(socket => {
		let data = "";
		socket.on("data", chunk => {
			data += chunk;
			if (!data.endsWith("\n")) return;
			commands.push(data.trim());
			if (data.startsWith("PI_VOICE_CONTROL")) socket.end(`${JSON.stringify({ type: "stopped", id: exact ? outputId : "other" })}\n`);
			else socket.end(`ok ${Buffer.from(`stopped ${exact ? ticket : "other"}`).toString("base64")}\n`);
		});
	});
	await new Promise<void>(resolve => server.listen(socketPath, resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const endpoint = `unix://${socketPath}`;
	await fs.mkdir(path.join(root, "devices"));
	await fs.writeFile(path.join(root, "devices", "A.json"), JSON.stringify({ version: 1, id: "A", name: "Original device", platform: "linux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 2, lastActive: 2 }));
	return { root, endpoint, commands, router: new DeviceRouter(path.join(root, "devices"), "replacement", {}), setExact(value: boolean) { exact = value; } };
}

test("durable input/output retries use original identity and old scope through changed registration; never remove fence", async t => {
	const { root, commands, router, setExact } = await setup(t);
	await fs.mkdir(path.join(root, "speech.lock"));
	await fs.writeFile(path.join(root, "speech.lock", "lease.json"), "original fence");
	const original = new StopRecovery(root, "old-owner");
	original.retain("input", { endpoint: "unix:///old-input", id: ticket, selection: "A", configured: "auto" }, "Original device");
	original.retain("output", { endpoint: "unix:///old-output", id: outputId, selection: "A", configured: "auto" }, "Original device");
	original.fail("input", "Original device", "microphone stop unconfirmed");
	const restored = new StopRecovery(root, "old-owner");
	assert.equal(restored.episode("input")?.cause, "microphone stop unconfirmed");
	setExact(false);
	await assert.rejects(restored.retry("input", router, "auto"), /not confirmed/);
	await assert.rejects(restored.retry("output", router, "auto"), /missing scoped/);
	assert.equal(new StopRecovery(root, "old-owner").episode("input")?.handles[0].id, ticket);
	assert.equal(restored.episode("output")?.handles.length, 1);
	setExact(true);
	await restored.retry("input", router, "auto");
	await restored.retry("output", router, "auto");
	assert.deepEqual(commands, [`stop ${ticket}`, `PI_VOICE_CONTROLstop ${outputId}`, `stop ${ticket}`, `PI_VOICE_CONTROLstop ${outputId}`]);
	const proven = new StopRecovery(root, "old-owner");
	assert.equal(proven.episode("input")?.handles.length, 0);
	assert.match(proven.episode("output")!.cause, /coverage remains unproven/);
	assert.equal(await fs.readFile(path.join(root, "speech.lock", "lease.json"), "utf8"), "original fence");
	await assert.rejects(proven.retry("input", router, "auto"), /no retained/);
});

test("invalid metadata, changed config and malformed journals fail closed without connecting", async t => {
	const { root, commands, router } = await setup(t);
	const journal = new StopRecovery(root, "old-owner");
	journal.retain("output", { endpoint: "unix:///old", id: outputId, selection: "A", configured: "auto" }, "Original device");
	await assert.rejects(journal.retry("output", router, "disabled"), /configuration changed/);
	await fs.writeFile(path.join(root, "devices", "A.json"), JSON.stringify({ version: 1, id: "replacement" }));
	await assert.rejects(journal.retry("output", router, "auto"), /unavailable/);
	assert.deepEqual(commands, []);
	await fs.writeFile(journal.file, '{"version":1,"input":{"device":"A","cause":"lost","handles":[{}]}}');
	assert.throws(() => new StopRecovery(root, "old-owner"), /Invalid recovery journal/);
	assert.throws(() => new StopRecovery(root, "../escape"), /Invalid recovery owner/);
	await assert.rejects(PhoneInputClient.retryStop({ endpoint: "unix:///unused", ticket: "bad\nrecord" }), /Invalid retained/);
});

test("receipt retirement matches endpoint and ticket and survives persistence failure", async t => {
	const { root, endpoint } = await setup(t);
	const journal = new StopRecovery(root, "owner");
	journal.retain("input", { endpoint, id: ticket, selection: "A", configured: "auto" }, "A");
	journal.retire("input", ticket, "unix:///other");
	journal.retire("input", `${"b".repeat(32)}.19`, endpoint);
	assert.equal(journal.episode("input")!.handles.length, 1);
	await fs.rename(journal.file, `${journal.file}.backup`);
	await fs.mkdir(journal.file);
	assert.throws(() => journal.retire("input", ticket, endpoint));
	assert.equal(journal.episode("input")!.handles.length, 1);
	await fs.rmdir(journal.file);
	journal.retire("input", ticket, endpoint);
	assert.deepEqual(new StopRecovery(root, "owner").episode("input")!.handles, []);
});

test("input persistence failure aborts before recording admission", async t => {
	const { root } = await setup(t);
	const commands: string[] = [];
	const endpoint = path.join(root, "input.sock");
	const server = net.createServer(socket => socket.on("data", chunk => {
		const command = String(chunk).trim();
		commands.push(command);
		if (command === "ticket") socket.write(`ticket ${ticket}\n`);
		else if (command === `stop ${ticket}`) socket.end(`ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`);
	}));
	await new Promise<void>(resolve => server.listen(endpoint, resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const input = new PhoneInputClient(() => { throw new Error("disk full"); });
	await assert.rejects(input.capture(`unix://${endpoint}`), /disk full/);
	await input.cancel();
	assert.ok(commands.includes("ticket"));
	assert.ok(commands.includes(`stop ${ticket}`));
	assert.ok(!commands.some(command => command.startsWith("record ")));
});
