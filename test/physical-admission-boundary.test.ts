import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import childProcess from "node:child_process";
import net from "node:net";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";
import { MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";

// No actual helper, socket, microphone, player, or model can start in this test.
let connections = 0;
mock.module("node:child_process", { defaultExport: childProcess, namedExports: { ...childProcess, spawn: () => { connections++; throw new Error("mock local connection"); } } });
mock.module("node:net", { defaultExport: net, namedExports: { ...net, createConnection: () => { connections++; throw new Error("mock remote connection"); } } });
mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const { PhoneInputClient } = await import("../src/phone-input.js");
const { Vocalizer } = await import("../src/vocalizer.js");
const { StopRecovery } = await import("../src/stop-recovery.js");

for (const endpoint of ["local", "unix:///fake", "tcp://127.0.0.1:1"]) test(`input ledger precedes even connection/helper creation: ${endpoint}`, async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-input-boundary-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const ledger = new StopRecovery(root, "input-owner");
	ledger.initialize();
	let fail = true;
	const input = new PhoneInputClient(undefined, undefined, () => {
		if (fail) throw new Error("durability failed");
		ledger.beforeIO("input");
	});
	const before = connections;
	await assert.rejects(input.capture(endpoint), /durability failed/);
	assert.equal(connections, before);
	fail = false;
	await assert.rejects(input.capture(endpoint), /mock .* connection/);
	assert.equal(connections, before + 1);
	assert.equal(new StopRecovery(root, "input-owner").isIdle("input"), false);
});

test("all narration dispatch is write-ahead; background metadata work is not admission", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-output-boundary-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const ledger = new StopRecovery(root, "output-owner");
	ledger.initialize();
	let fail = false;
	const worker = new MockedVoiceWorkerClient(() => {});
	const errors: string[] = [];
	const vocalizer = new Vocalizer(() => ({ ...DEFAULT_VOICE_CONFIG, enabled: true }), event => {
		if (event.type === "error") errors.push(event.message);
	},
		undefined, undefined, worker, undefined, undefined, undefined, undefined, () => {
			if (fail) throw new Error("durability failed");
			ledger.beforeIO("output");
		});
	await vocalizer.warm(); await vocalizer.measureSegment("Metadata only.");
	assert.equal(new StopRecovery(root, "output-owner").isIdle("output"), true);
	const send = worker.sendSegment.bind(worker);
	t.mock.method(worker, "sendSegment", (...args: Parameters<typeof send>) => {
		assert.equal(new StopRecovery(root, "output-owner").isIdle("output"), false);
		send(...args);
	});
	vocalizer.speakUntracked("Project notification.");
	vocalizer.speakFrom("Replay.", 0);
	vocalizer.pushDelta("Live narration. "); vocalizer.flush();
	vocalizer.speak("```js\nconst x = 1;\n```");
	await new Promise(resolve => setImmediate(resolve));
	assert.ok(worker.sent.length >= 4);
	const before = worker.sent.length;
	vocalizer.clear(); fail = true;
	vocalizer.speak("Must not dispatch.");
	assert.deepEqual(errors, ["durability failed"]);
	assert.equal(worker.sent.length, before);
	await vocalizer.shutdown();
	ledger.clear("output");
	assert.equal(new StopRecovery(root, "output-owner").isIdle("output"), false);
});
