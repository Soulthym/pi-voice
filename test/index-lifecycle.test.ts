import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant, streamBlockedResponse } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const tick = () => new Promise(resolve => setTimeout(resolve, 250));

test("Stop and session replacement fence pending test/replay and suppress attention until fresh work", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-lifecycle-"));
	const env = { ...process.env };
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(path.join(root, "project"), "project");
	const owner = new SessionCoordinator(path.join(root, "other"), "other");
	owner.start();
	t.after(async () => {
		await host.shutdown(); owner.shutdown(); mock.restoreAll();
		for (const key of ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"]) {
			if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("a", null, assistant("This project's response."));
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	await host.start();
	const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
	for (const action of ["test Obsolete test.", "attention"]) {
		for (const lifecycle of ["stop", "reload", "shutdown"]) {
			owner.tryAcquireSpeech();
			let release!: (value: boolean) => void;
			const delayed = mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", () => new Promise<boolean>(resolve => { release = resolve; }));
			const pending = host.command(action);
			await new Promise(resolve => setImmediate(resolve));
			assert.ok(release);
			if (lifecycle === "stop") await host.command("stop");
			else if (lifecycle === "reload") await host.emit("session_start", {});
			else await host.shutdown();
			release(true);
			await pending;
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(worker.sent.length, 0, `${action} survived ${lifecycle}`);
			delayed.mock.restore();
			if (lifecycle === "shutdown") await host.emit("session_start", {});
		}
	}
	owner.releaseSpeech();
	owner.markWaiting();
	await host.command("stop");
	await tick();
	assert.equal(worker.sent.length, 0, "Stop must suppress the announcement poll");
	await host.command("off"); await host.command("on"); await tick();
	assert.equal(worker.sent.length, 0, "enable must not revive Stop-cancelled work");
	await host.shortcut("f11");
	await tick();
	assert.match(JSON.stringify(worker.sent), /This project's response/);
	assert.equal(owner.hasAttentionRequest(), false, "replay must not route to the waiting project");
});

test("disabled waiting sessions leave the queue and re-enable only outstanding attention", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-enable-"));
	const env = { ...process.env };
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0 }));
	const owner = new SessionCoordinator(path.join(root, "owner"), "owner"); owner.start(); owner.tryAcquireSpeech();
	const host = new FakeVoiceHost(path.join(root, "project"), "project");
	t.after(async () => {
		await host.shutdown(); owner.shutdown();
		for (const key of ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"]) {
			if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	await streamBlockedResponse(host, "Waiting response.");
	assert.equal(owner.waitingSessions().length, 1);
	await host.command("off"); assert.equal(owner.waitingSessions().length, 0);
	await host.command("on"); assert.equal(owner.waitingSessions().length, 1);
	await host.command("off");
	await host.emit("input", { text: "Handled that response" });
	await host.command("on"); assert.equal(owner.waitingSessions().length, 0, "a new prompt handles the disabled session's old wait");
	await streamBlockedResponse(host, "A genuinely new waiting response.");
	assert.equal(owner.waitingSessions().length, 1);
	await host.command("stop"); await host.command("off"); await host.command("on");
	assert.equal(owner.waitingSessions().length, 0);
});
