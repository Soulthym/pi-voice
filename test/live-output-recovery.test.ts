import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { StopRecovery } from "../src/stop-recovery.js";
import { DeviceRouter } from "../src/device-router.js";

const boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const nextBoot = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const id = "11111111-1111-4111-8111-111111111111";
const lateId = "22222222-2222-4222-8222-222222222222";

test("live recovery closes dispatch before scoped current-device receipts, including concurrent cancellation", async t => {
	const children: Array<ReturnType<typeof makeChild>> = [];
	function makeChild() {
		return Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null,
			stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
	}
	mock.module("node:child_process", { namedExports: { spawn: () => {
		const child = makeChild(); children.push(child); return child;
	} } });
	t.after(() => mock.reset());
	// Never signal any real process, even on assertion failure.
	t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
	const { VoiceWorkerClient } = await import("../src/worker-client.js");
	for (const reboot of [false, true]) await t.test(reboot ? "changed boot and socket" : "same boot, changed socket", async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-live-recovery-"));
		t.after(() => fs.rm(root, { recursive: true, force: true }));
		const oldEndpoint = `unix://${path.join(root, "old.sock")}`;
		const endpoint = `unix://${path.join(root, "current.sock")}`;
		let identity = "wrong-device";
		const commands: string[] = [];
		let releaseReceipt: (() => void) | undefined;
		const server = net.createServer(socket => {
			let data = "";
			socket.on("data", chunk => {
				data += chunk;
				if (!data.endsWith("\n")) return;
				commands.push(data.trim());
				const scopeId = data.trim().split(" ")[1];
				const reply = () => socket.end(`${JSON.stringify({ type: "stopped", id: scopeId,
					...(reboot ? { proof: "reboot", expected_boot_id: boot, boot_id: nextBoot } : { boot_id: boot }), device_id: identity })}\n`);
				if (identity === "A" && scopeId === id) releaseReceipt = reply;
				else reply();
			});
		});
		await new Promise<void>(resolve => server.listen(endpoint.slice(7), resolve));
		t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
		await fs.mkdir(path.join(root, "devices"));
		await fs.writeFile(path.join(root, "devices", "A.json"), JSON.stringify({ version: 1, id: "A", name: "Original", platform: "linux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 2, lastActive: 2 }));
		const router = new DeviceRouter(path.join(root, "devices"), "replacement", {});
		const ledger = new StopRecovery(root, "live-owner");
		ledger.initialize(); ledger.beforeIO("output", true);
		const grants: Array<() => void> = [];
		const released: string[] = [];
		const worker = new VoiceWorkerClient(event => {
			if (event.type === "remote-handle") {
				ledger.retain("output", { endpoint: event.output, id: event.id, bootId: event.bootId,
					selection: "A", configured: "auto", rebootSafe: true }, "Original");
				if (event.grant) grants.push(event.grant);
			} else if (event.type === "remote-released") released.push(event.id);
		});
		worker.sendSegment(1, 1, "No inference", { ...DEFAULT_VOICE_CONFIG, output: oldEndpoint });
		const child = children.at(-1)!;
		const emit = (event: object) => child.stdout.write(`${JSON.stringify(event)}\n`);
		const handle = (id: string) => emit({ type: "remote-handle", output: oldEndpoint, id, utterance: 1, bootId: boot });
		handle(id);
		const cancelId = worker.cancel();
		const ordinary = worker.terminate();
		const ordinaryRejected = assert.rejects(ordinary, /Remote playback unconfirmed/);
		const recover = () => worker.terminate(scope => ledger.stopOutputScope(scope, router, "auto"));
		const retry = recover(); // Joins existing termination; never stops before group closure.
		const rejected = reboot ? assert.rejects(retry, /missing scoped/) : undefined;
		handle(lateId); // Pipes can still deliver a prepared handle during cancellation.
		for (const grant of grants) grant();
		assert.doesNotMatch(child.stdin.read()?.toString() ?? "", /output-grant/);
		assert.throws(() => worker.sendSegment(2, 2, "blocked", DEFAULT_VOICE_CONFIG), /cleanup is in progress/);
		emit({ type: "idle", cancelId }); // Not a scoped receipt.
		assert.equal(ledger.episode("output")?.handles.length, 2);
		assert.deepEqual(commands, []);
		child.stdout.end(); child.stderr.end(); child.emit("close");
		await ordinaryRejected;
		if (reboot) {
			await rejected;
			assert.equal(ledger.episode("output")?.handles.length, 2, "foreign reboot cannot retire scopes");
			assert.deepEqual(released, []);
		} else {
			// Same-boot exact receipt does not need reboot identity inference.
			await retry;
			assert.deepEqual(released, [id, lateId]);
			ledger.clear("output");
			assert.equal(ledger.isIdle("output"), true);
			return;
		}
		identity = "A";
		const successful = recover();
		while (!releaseReceipt) await new Promise(resolve => setImmediate(resolve));
		assert.equal(ledger.isIdle("output"), false, "in-flight receipt is not proof");
		worker.cancel(); // Concurrent cancellation cannot reopen dispatch or forget the scopes.
		for (const grant of grants) grant();
		releaseReceipt();
		await successful;
		assert.deepEqual(released, [id, lateId]);
		assert.equal(ledger.episode("output")?.handles.length, 0);
		ledger.clear("output");
		assert.equal(new StopRecovery(root, "live-owner").isIdle("output"), true);
		// An old cancellation ACK cannot discharge a newer unknown remote submission.
		worker.sendSegment(2, 2, "Still fake", { ...DEFAULT_VOICE_CONFIG, output: oldEndpoint });
		const newer = children.at(-1)!;
		newer.stdout.write(`${JSON.stringify({ type: "idle", cancelId })}\n`);
		const unknown = worker.terminate();
		const unknownRejected = assert.rejects(unknown, /no scoped remote receipt/);
		newer.stdout.end(); newer.stderr.end(); newer.emit("close");
		await unknownRejected;
	});
});
