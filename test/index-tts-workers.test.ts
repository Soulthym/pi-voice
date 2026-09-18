import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { mock, test } from "node:test";
import { FakeVoiceHost, streamCompletedResponse } from "./helpers/fake-voice-host.js";
import { voiceQueryCases } from "./helpers/voice-query-cases.js";

test("real tts-workers command persists and reaches the worker protocol without playback or asset side effects", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-runtime-workers-"));
	const env = {
		PI_VOICE_CONFIG: path.join(root, "voice.json"),
		PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"),
		PI_VOICE_DEVICE_DIR: path.join(root, "devices"),
		PI_VOICE_TTS_WORKERS: "8",
	};
	const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local", audioCache: false }));
	const packets: any[] = [];
	let spawned = 0;
	const cp = await import("node:child_process");
	mock.module("node:child_process", { namedExports: { ...cp, spawn: (_exe: string, args: string[]) => {
		assert.match(args[0]!, /worker\.mjs$/);
		spawned++;
		const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
		return Object.assign(child, { stdin: new Writable({ write(chunk, _encoding, done) {
			const packet = JSON.parse(String(chunk));
			packets.push(packet);
			if (packet.type === "shutdown") { child.exitCode = 0; child.emit("exit", 0); }
			done();
		} }) });
	} } });
	const { VoiceWorkerClient } = await import("../src/worker-client.js");
	mock.method(VoiceWorkerClient.prototype, "measureSegment", async () => 1);
	const host = new FakeVoiceHost(path.join(root, "project"), "workers");
	t.after(async () => {
		await host.shutdown();
		mock.reset();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	mock.method(host.ctx.ui, "select", async () => assert.fail("queries must not open a picker"));
	const query = async (expected: number) => {
		const configBefore = await fs.readFile(env.PI_VOICE_CONFIG, "utf8");
		const statBefore = await fs.stat(env.PI_VOICE_CONFIG);
		const packetsBefore = packets.length;
		const spawnedBefore = spawned;
		const entriesBefore = JSON.stringify(host.entries);
		const widgetsBefore = host.widgetOperations.length;
		const requestsBefore = host.modelRequests.length;
		for (const [command, output] of voiceQueryCases) {
			for (const spelling of [command, ` ${command.toUpperCase()}  `]) {
				await host.command(spelling);
				assert.equal(host.notices.at(-1)?.level, "info", spelling);
				assert.match(host.notices.at(-1)!.message, output, spelling);
				if (command.startsWith("tts-worker")) {
					assert.equal(host.notices.at(-1)!.message, `tts-workers concurrency: ${expected}`);
				}
			}
		}
		assert.equal(host.modelRequests.length, requestsBefore);
		assert.equal(await fs.readFile(env.PI_VOICE_CONFIG, "utf8"), configBefore);
		assert.equal((await fs.stat(env.PI_VOICE_CONFIG)).mtimeMs, statBefore.mtimeMs, "queries must not save config");
		assert.equal(packets.length, packetsBefore, "no worker or playback commands");
		assert.equal(spawned, spawnedBefore, "no workers started");
		assert.equal(JSON.stringify(host.entries), entriesBefore);
		assert.equal(host.widgetOperations.length, widgetsBefore);
	};
	await query(8);
	await host.command("tts-workers 2");
	await query(2);
	assert.equal(spawned, 0, "idle setting must not spawn models");
	assert.equal(JSON.parse(await fs.readFile(env.PI_VOICE_CONFIG, "utf8")).ttsWorkers, 2);
	const command = host.commands.get("voice") as any;
	const actionsAndReports = ["on", "off", "toggle", "status", "stop", "setup", "test", "talk", "attention", "scroll-to", "bottom", "timing", "code-retry"];
	assert.deepEqual(
		command.getArgumentCompletions("").map((item: any) => item.value).sort(),
		[...voiceQueryCases.map(([name]) => name), ...actionsAndReports].sort(),
		"every advertised command must be audited as a setting query or an intentional action/report",
	);
	assert.deepEqual(command.getArgumentCompletions("tts-workers ").map((item: any) => item.label), ["1", "2", "3", "4", "5", "6", "7", "8"]);
	assert.ok(command.getArgumentCompletions("tts-w").some((item: any) => item.value === "tts-workers"));
	assert.deepEqual(command.getArgumentCompletions("tts-worker ").map((item: any) => item.label), ["1", "2", "3", "4", "5", "6", "7", "8"]);
	for (const action of ["tts-workers", "tts-worker"]) {
		for (const value of ["0", "9", "1.5", "NaN", "2 extra"]) {
			await host.command(`${action} ${value}`);
			assert.match(host.notices.at(-1)!.message, /Usage:/);
		}
	}
	assert.equal(JSON.parse(await fs.readFile(env.PI_VOICE_CONFIG, "utf8")).ttsWorkers, 2);
	host.addMessage("user", null, { role: "user", content: "Hello", timestamp: 1 });
	await streamCompletedResponse(host, "reply", "user", "A complete sentence.");
	assert.ok(packets.some(packet => packet.type === "segment"));
	assert.deepEqual(packets.filter(packet => packet.type === "tts-workers"), [{ type: "tts-workers", workers: 2 }]);
	const leasePath = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
	const owner = JSON.parse(await fs.readFile(leasePath, "utf8")).instanceId;
	assert.ok(owner);
	const entries = JSON.stringify(host.entries);
	await query(2);
	await host.shortcut("f8");
	await query(2);
	await host.shortcut("f8");
	const resizeStart = packets.length;
	await host.command("tts-worker 1");
	await query(1);
	assert.deepEqual(packets.slice(resizeStart), [{ type: "tts-workers", workers: 1 }], "no cancel, pause, resume, or regenerated segments");
	assert.equal(JSON.stringify(host.entries), entries, "no asset metadata invalidation");
	assert.equal(JSON.parse(await fs.readFile(leasePath, "utf8")).instanceId, owner, "speech ownership retained");
	await host.command("status");
	assert.match(host.notices.at(-1)!.message, /ttsWorkers=1/);
	assert.equal(JSON.parse(await fs.readFile(env.PI_VOICE_CONFIG, "utf8")).ttsWorkers, 1);
	assert.equal(host.modelRequests.length, 0);
});
