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
	let proof: Record<string, unknown> = {};
	let inputReceipt: string | undefined;
	const socketPath = path.join(root, "device.sock");
	const server = net.createServer(socket => {
		let data = "";
		socket.on("data", chunk => {
			data += chunk;
			if (!data.endsWith("\n")) return;
			commands.push(data.trim());
			if (data.startsWith("PI_VOICE_CONTROL")) socket.end(`${JSON.stringify({ type: "stopped", id: exact ? outputId : "other", ...proof })}\n`);
			else socket.end(`ok ${Buffer.from(inputReceipt ?? `stopped ${exact ? ticket : "other"}`).toString("base64")}\n`);
		});
	});
	await new Promise<void>(resolve => server.listen(socketPath, resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const endpoint = `unix://${socketPath}`;
	await fs.mkdir(path.join(root, "devices"));
	await fs.writeFile(path.join(root, "devices", "A.json"), JSON.stringify({ version: 1, id: "A", name: "Original device", platform: "linux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 2, lastActive: 2 }));
	return { root, endpoint, commands, router: new DeviceRouter(path.join(root, "devices"), "replacement", {}), setExact(value: boolean) { exact = value; }, setProof(value: Record<string, unknown>) { proof = value; }, setInputReceipt(value: string) { inputReceipt = value; } };
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
	assert.equal(restored.isCovered("input"), false);
	assert.equal(restored.isCovered("output"), false);
	assert.match(new StopRecovery(root, "old-owner").episode("input")!.cause, /not confirmed/);
	assert.match(new StopRecovery(root, "old-owner").episode("output")!.cause, /missing scoped/);
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

test("boot-bound input scopes persist locally and remotely but never claim complete coverage", async t => {
	const { root, endpoint } = await setup(t);
	for (const input of ["local", endpoint]) {
		const owner = input === "local" ? "local-owner" : "remote-owner";
		const journal = new StopRecovery(root, owner);
		journal.initialize();
		journal.beforeIO("input");
		const handle = { endpoint: input, id: ticket, selection: "local", configured: input, bootId: outputId };
		journal.retain("input", handle, "Microphone");
		assert.deepEqual(new StopRecovery(root, owner).episode("input")?.handles, [handle]);
		assert.throws(() => journal.retain("input", { ...handle, bootId: "bad" }, "Microphone"), /Invalid recovery handle/);
		assert.throws(() => journal.retain("input", { ...handle, bootId: "22222222-2222-2222-2222-222222222222" }, "Microphone"), /identity changed/);
		journal.retire("input", ticket, input);
		journal.clear("input");
		assert.equal(new StopRecovery(root, owner).isIdle("input"), false);
	}
});

test("covered null-boot output retires only with a null-boot receipt", async t => {
	const { root, endpoint, router, setProof } = await setup(t);
	const journal = new StopRecovery(root, "null-owner");
	journal.initialize();
	journal.beforeIO("output", true);
	journal.retain("output", { endpoint, id: outputId, selection: "A", configured: "auto", bootId: null }, "A");
	const restored = new StopRecovery(root, "null-owner");
	await assert.rejects(restored.retry("output", router, "auto"), /missing scoped/);
	const pending = new StopRecovery(root, "null-owner");
	assert.equal(pending.isCovered("output"), true);
	assert.equal(pending.isIdle("output"), false);
	assert.match(pending.episode("output")!.cause, /missing scoped/);
	assert.equal(JSON.parse(await fs.readFile(pending.file, "utf8")).version, 4);
	setProof({ boot_id: null });
	await restored.retry("output", router, "auto");
	assert.equal(new StopRecovery(root, "null-owner").isIdle("output"), true);
});

test("native exit proof is capability-bound across restart and live cleanup; legacy handles never upgrade", async t => {
	const { root, endpoint, router, setProof } = await setup(t);
	const bootId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	for (const nativeWatchdog of [undefined, true] as const) {
		for (const live of [false, true]) {
			const owner = `native-${nativeWatchdog}-${live}`;
			const journal = new StopRecovery(root, owner);
			journal.initialize();
			const handle = { endpoint, id: outputId, bootId, selection: "A", configured: "auto", nativeWatchdog };
			journal.retain("output", handle, "A");
			assert.throws(() => journal.retain("output", { ...handle, nativeWatchdog: nativeWatchdog ? undefined : true }, "A"), /identity changed/);
			const restored = new StopRecovery(root, owner);
			assert.equal(restored.episode("output")?.handles[0].nativeWatchdog, nativeWatchdog);
			const stop = () => live ? restored.stopOutputScope({ output: endpoint, id: outputId, bootId }, router, "auto") : restored.retry("output", router, "auto");
			setProof({ boot_id: bootId, ...(nativeWatchdog ? {} : { proof: "native-process-exit" }) });
			await assert.rejects(stop(), /missing scoped/);
			assert.equal(new StopRecovery(root, owner).episode("output")?.handles.length, 1);
			setProof({ boot_id: bootId, ...(nativeWatchdog ? { proof: "native-process-exit" } : {}) });
			await stop();
			assert.equal(new StopRecovery(root, owner).episode("output")?.handles.length ?? 0, 0);
		}
	}
	const invalid = new StopRecovery(root, "invalid-native");
	assert.throws(() => invalid.retain("output", { endpoint, id: outputId, bootId: null, selection: "A", configured: "auto", nativeWatchdog: true }, "A"), /Invalid recovery handle/);
});

test("reboot discharge requires original registered identity and persisted commit fencing", async t => {
	const { root, endpoint, router, commands, setProof } = await setup(t);
	const bootId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	const reboot = { proof: "reboot", expected_boot_id: bootId, boot_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", device_id: "A" };
	setProof(reboot);
	for (const scenario of ["registered", "foreign", "missing-identity", "historical", "custom", "legacy", "unknown", "uncertain"] as const) {
		setProof(scenario === "foreign" ? { ...reboot, device_id: "B" } : scenario === "missing-identity" ? { ...reboot, device_id: null } : reboot);
		const journal = new StopRecovery(root, scenario);
		if (scenario !== "unknown") journal.initialize();
		if (scenario === "uncertain") journal.beforeIO("output");
		const configured = scenario === "custom" ? endpoint : "auto";
		journal.retain("output", { endpoint: scenario === "custom" ? endpoint : "unix:///old-endpoint",
			id: outputId, selection: scenario === "legacy" ? "legacy-loopback" : "A", configured,
			bootId, ...(scenario !== "historical" ? { rebootSafe: true } : {}) }, "Original device");
		const restored = new StopRecovery(root, scenario);
		// A legacy-loopback route is deliberately not a stable device identity.
		const originalRoute = router.routeMetadata.bind(router);
		if (scenario === "legacy") router.routeMetadata = () => ({ kind: "device", endpoint,
			device: { ...router.resolve("A")!, id: "legacy-loopback" } });
		try {
			if (scenario === "registered" || scenario === "uncertain") {
				await restored.retry("output", router, configured);
				assert.equal(new StopRecovery(root, scenario).isIdle("output"), scenario === "registered");
				assert.equal(commands.at(-1), `PI_VOICE_CONTROLstop ${outputId} ${bootId}`);
			} else {
				await assert.rejects(restored.retry("output", router, configured), /missing scoped/);
				assert.equal(restored.episode("output")?.handles.length, 1);
				assert.equal(commands.at(-1), `PI_VOICE_CONTROLstop ${outputId}${scenario === "foreign" || scenario === "missing-identity" ? ` ${bootId}` : ""}`);
			}
		} finally { router.routeMetadata = originalRoute; }
	}
});

test("covered network retry preserves identity across restart and retires only a verified reboot", async t => {
	const { root, endpoint, router, commands, setInputReceipt } = await setup(t);
	const journal = new StopRecovery(root, "network-owner");
	journal.initialize();
	const handle = { endpoint: "unix:///old-input", id: ticket, selection: "A", configured: "auto", bootId: outputId, networkAdmission: true, rebootSafe: true };
	journal.retain("input", handle, "Original device");
	const restored = new StopRecovery(root, "network-owner");
	assert.deepEqual(restored.episode("input")!.handles, [handle]);
	const reboot = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
	setInputReceipt(`stopped-reboot ${ticket} ${outputId} ${reboot} B`);
	await assert.rejects(restored.retry("input", router, "auto"), /not confirmed/);
	const pending = new StopRecovery(root, "network-owner");
	assert.deepEqual(pending.episode("input")!.handles, [handle]);
	assert.equal(pending.isCovered("input"), true);
	assert.equal(pending.isIdle("input"), false);
	assert.match(pending.episode("input")!.cause, /not confirmed/);
	setInputReceipt(`stopped-reboot ${ticket} ${outputId} ${reboot} A`);
	await restored.retry("input", router, "auto");
	assert.equal(new StopRecovery(root, "network-owner").isIdle("input"), true);
	assert.deepEqual(commands, Array(2).fill(`stop-admit ${ticket} ${outputId} A`));
	assert.notEqual(endpoint, handle.endpoint, "retry uses the registered original identity's new endpoint");
});

test("partial covered retry retains only the pending scope and its actual failure", async t => {
	const { root, endpoint, router } = await setup(t);
	const journal = new StopRecovery(root, "partial-owner");
	journal.initialize();
	const handle = { endpoint, id: ticket, selection: "A", configured: "auto", bootId: outputId, networkAdmission: true };
	const remaining = { ...handle, id: `${"b".repeat(32)}.20` };
	journal.retain("input", handle, "A");
	journal.retain("input", remaining, "A");
	const failure = new Error("guardian wait receipt missing");
	t.mock.method(PhoneInputClient, "retryStop", async (scope: Parameters<typeof PhoneInputClient.retryStop>[0]) => {
		if (scope.ticket === remaining.id) {
			assert.match(new StopRecovery(root, "partial-owner").episode("input")!.cause, /Admission coverage complete/);
			throw failure;
		}
	});
	await assert.rejects(journal.retry("input", router, "auto"), error => error === failure);
	const restored = new StopRecovery(root, "partial-owner");
	assert.deepEqual(restored.episode("input")!.handles, [remaining]);
	assert.equal(restored.episode("input")!.cause, failure.message);
	assert.equal(restored.isCovered("input"), true);
	assert.equal(restored.isIdle("input"), false);
});

test("input persistence failure aborts before recording admission", async t => {
	const { root } = await setup(t);
	const commands: string[] = [];
	const endpoint = path.join(root, "input.sock");
	const server = net.createServer(socket => socket.on("data", chunk => {
		const command = String(chunk).trim();
		commands.push(command);
		if (command === "ticket-admit") socket.write(`ticket ${ticket} ${outputId} admit-v1 null\n`);
		else if (command === `stop ${ticket}`) socket.end(`ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`);
	}));
	await new Promise<void>(resolve => server.listen(endpoint, resolve));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const input = new PhoneInputClient(() => { throw new Error("disk full"); });
	await assert.rejects(input.capture(`unix://${endpoint}`), /disk full/);
	await input.cancel();
	assert.ok(commands.includes("ticket-admit"));
	assert.ok(commands.includes(`stop ${ticket}`));
	assert.ok(!commands.some(command => command.startsWith("record ")));
});
