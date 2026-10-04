import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import type { VoiceConfig } from "../src/config.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant, streamCompletedResponse } from "./helpers/fake-voice-host.js";

class Worker extends MockedVoiceWorkerClient {
	outputs: string[] = [];
	override sendSegment(utterance: number, segmentId: number, text: string, config?: VoiceConfig): void {
		this.outputs.push(config!.output);
		super.sendSegment(utterance, segmentId, text);
	}
}
mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: Worker } });
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve)); };
const segments = (worker: Worker) => worker.sent as Array<{ text: string; utterance: number }>;
const announcements = (worker: Worker) => segments(worker).filter(segment => segment.text.includes("requires attention next"));

async function fixture(t: TestContext, registered = true) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "waiting-origin-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config.json"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"),
		PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_DEVICE_ID: "shared" };
	const previous = Object.keys(env).map(key => process.env[key]);
	Object.assign(process.env, env);
	await fs.mkdir(env.PI_VOICE_DEVICE_DIR);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "auto", audioCache: false,
		timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const register = async (id: string, generation = 1) => {
		const socket = path.join(root, `${id}-${generation}`);
		await fs.writeFile(socket, ""); // Metadata availability only; the inert worker never opens this path.
		const endpoint = `unix://${socket}`;
		await fs.writeFile(path.join(env.PI_VOICE_DEVICE_DIR, `${id}.json`), JSON.stringify({ version: 1, id, name: id, platform: "linux",
			audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: generation, lastActive: generation }));
		return endpoint;
	};
	const disappear = (id: string) => fs.rm(path.join(env.PI_VOICE_DEVICE_DIR, `${id}.json`));
	if (registered) await register("shared");
	const hosts: FakeVoiceHost[] = [];
	const observer = new SessionCoordinator(path.join(root, "observer"), "observer");
	observer.start();
	t.after(async () => {
		for (const host of hosts) await host.shutdown();
		observer.shutdown();
		Object.keys(env).forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	const start = async (name: string, device = "shared") => {
		process.env.PI_VOICE_DEVICE_ID = device;
		const host = new FakeVoiceHost(path.join(root, name), name);
		hosts.push(host);
		await host.start();
		return { host, worker: Worker.instances.at(-1) as Worker };
	};
	const owner = await start("owner");
	if (registered) await streamCompletedResponse(owner.host, "owner-answer", "", "Owner is speaking.");
	else assert.equal(observer.tryAcquireSpeech(), true, "hold the real lease without requiring an unknown output");
	const waiting = await start("waiting");
	const pending = () => observer.waitingSessions().find(session => session.sessionId === "waiting");
	const blockUntilTurnEnd = async () => {
		await waiting.host.emit("before_agent_start", {});
		const message = assistant("Waiting answer.");
		await waiting.host.emit("message_start", { message });
		await waiting.host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Waiting answer." } });
		waiting.host.addMessage(`answer-${waiting.host.entries.length}`, null, message);
		await waiting.host.emit("message_end", { message });
		assert.equal(pending(), undefined, "the disappearance must precede markWaiting at turn_end");
		return async () => { await waiting.host.emit("turn_end", { message }); await settle(); assert.ok(pending()); };
	};
	return { root, owner, waiting, observer, register, disappear, start, pending, blockUntilTurnEnd };
}

test("registry disappearance at markWaiting retains adopted origin; same ID returns on a new endpoint", async t => {
	const { owner, waiting, observer, register, disappear, pending, blockUntilTurnEnd } = await fixture(t);
	const finish = await blockUntilTurnEnd();
	await disappear("shared");
	await finish();
	const generation = pending()!.generation;
	assert.deepEqual(pending()!.connection, { kind: "device", id: "shared" });
	assert.equal(waiting.worker.sent.length, 0, "blocked project never acquires or sends audio");
	const endpoint = await register("shared", 2);
	await owner.host.command("reconnect");
	await owner.host.command("stop"); await settle();
	assert.equal(announcements(owner.worker).length, 1);
	assert.equal(owner.worker.outputs.at(-1), endpoint, "delivery uses the returned stable ID's current endpoint");
	assert.equal(pending()!.generation, generation);
	assert.equal(pending()!.announced, false, "dispatch is not successful delivery");
	owner.worker.emit({ type: "idle", utterance: announcements(owner.worker)[0]!.utterance }); await settle();
	assert.equal(pending()!.announced, true);
	assert.equal(observer.speechOwner(), undefined);
});

test("another selected device cannot deliver or rebind the missing origin's existing generation", async t => {
	const { owner, waiting, register, disappear, pending, blockUntilTurnEnd } = await fixture(t);
	const finish = await blockUntilTurnEnd();
	await disappear("shared"); await finish();
	const original = pending()!;
	await register("other");
	await owner.host.command("device other");
	await waiting.host.command("device other");
	await streamCompletedResponse(waiting.host, "later", "", "Another waiting answer.");
	assert.equal(pending()!.generation, original.generation);
	assert.deepEqual(pending()!.connection, { kind: "device", id: "shared" }, "selection changes cannot rewrite an existing request");
	await owner.host.shortcut("f5"); await settle();
	owner.worker.emit({ type: "idle", utterance: segments(owner.worker).at(-1)!.utterance }); await settle();
	await new Promise(resolve => setTimeout(resolve, 250)); await settle();
	assert.equal(announcements(owner.worker).length, 0);
	assert.equal(announcements(waiting.worker).length, 0);
	assert.equal(pending()!.announced, false);
});

test("new waiting generation after selection change retains only the newly verified device", async t => {
	const { waiting, register, disappear, pending, blockUntilTurnEnd } = await fixture(t);
	await register("other");
	await waiting.host.command("device other");
	const finish = await blockUntilTurnEnd();
	await disappear("other"); await finish();
	assert.deepEqual(pending()!.connection, { kind: "device", id: "other" });
	assert.equal(waiting.worker.sent.length, 0);
});

test("restored selection retains its verified startup origin when the registry later disappears", async t => {
	const { waiting, disappear, pending, blockUntilTurnEnd } = await fixture(t);
	await waiting.host.emit("session_start", {});
	const finish = await blockUntilTurnEnd();
	await disappear("shared"); await finish();
	assert.deepEqual(pending()!.connection, { kind: "device", id: "shared" });
});

test("selection changed to an unverified ID cannot inherit the previous device origin", async t => {
	const { waiting, disappear, pending, blockUntilTurnEnd } = await fixture(t);
	await disappear("shared");
	process.env.PI_VOICE_DEVICE_ID = "unknown";
	await waiting.host.command("reconnect");
	assert.equal(waiting.host.entries.findLast(entry => entry.customType === "pi-voice.device-selection")?.data.selected, "unknown");
	const finish = await blockUntilTurnEnd(); await finish();
	assert.equal(pending()!.connection, undefined);
	assert.equal(waiting.worker.sent.length, 0);
});

test("unknown initial registration never invents a waiting origin or binds it on later discovery", async t => {
	const { waiting, register, pending, blockUntilTurnEnd } = await fixture(t, false);
	const finish = await blockUntilTurnEnd(); await finish();
	const generation = pending()!.generation;
	assert.equal(pending()!.connection, undefined);
	await register("shared");
	await waiting.host.command("reconnect");
	await streamCompletedResponse(waiting.host, "later", "", "Still waiting.");
	assert.equal(pending()!.generation, generation);
	assert.equal(pending()!.connection, undefined, "discovery cannot rebind a generation with unknown origin");
});

for (const output of ["local", "unix:///synthetic/custom"]) test(`output override ${output} cannot reuse an old device origin`, async t => {
	const { waiting, disappear, pending, blockUntilTurnEnd } = await fixture(t);
	await waiting.host.command(`output ${output}`);
	const finish = await blockUntilTurnEnd();
	await disappear("shared"); await finish();
	assert.deepEqual(pending()!.connection, output === "local" ? { kind: "intentional_local" } : undefined);
});
