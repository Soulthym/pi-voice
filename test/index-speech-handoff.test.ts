import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import {
	FakeVoiceHost,
	MockedVoiceWorkerClient,
	assistant,
} from "./helpers/fake-voice-host.js";

async function waitUntil(predicate: () => boolean, message: string, timeout = 3_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail(message);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

test("delayed speech handoff keeps only the latest replay target and desired pause state", async t => {
	mock.module("../src/worker-client.js", {
		namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient },
	});

	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-handoff-"));
	const coordinatorRoot = path.join(root, "coordinator");
	const modulePath = path.resolve("src/session-coordinator.ts");
	const childScript = `
		const { SessionCoordinator } = await import(${JSON.stringify(modulePath)});
		const coordinator = new SessionCoordinator('/owner/project', 'owner', ${JSON.stringify(coordinatorRoot)});
		coordinator.start();
		if (!coordinator.tryAcquireSpeech()) process.exit(2);
		process.stdout.write('ready\\n');
		const poll = setInterval(() => {
			if (!coordinator.consumeSpeechPreemptionRequest()) return;
			clearInterval(poll);
			setTimeout(() => {
				coordinator.releaseSpeech();
				process.stdout.write('released\\n');
			}, 900);
		}, 10);
	`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
		cwd: path.resolve("."),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let childOutput = "";
	child.stdout.on("data", chunk => {
		childOutput += String(chunk);
	});
	await waitUntil(() => childOutput.includes("ready"), "owner did not acquire speech");

	const previous = {
		config: process.env.PI_VOICE_CONFIG,
		coordinator: process.env.PI_VOICE_COORDINATOR_DIR,
		devices: process.env.PI_VOICE_DEVICE_DIR,
	};
	await fs.writeFile(
		path.join(root, "voice.json"),
		JSON.stringify({
			enabled: true,
			mode: "assistant",
			input: "disabled",
			audioCache: false,
			timingPreprocessConcurrency: 0,
		}),
	);
	process.env.PI_VOICE_CONFIG = path.join(root, "voice.json");
	process.env.PI_VOICE_COORDINATOR_DIR = coordinatorRoot;
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");

	const host = new FakeVoiceHost(path.join(root, "project"), "contender");
	t.after(async () => {
		await host.shutdown().catch(() => {});
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise(resolve => child.once("close", resolve));
		}
		mock.reset();
		if (previous.config === undefined) delete process.env.PI_VOICE_CONFIG;
		else process.env.PI_VOICE_CONFIG = previous.config;
		if (previous.coordinator === undefined) delete process.env.PI_VOICE_COORDINATOR_DIR;
		else process.env.PI_VOICE_COORDINATOR_DIR = previous.coordinator;
		if (previous.devices === undefined) delete process.env.PI_VOICE_DEVICE_DIR;
		else process.env.PI_VOICE_DEVICE_DIR = previous.devices;
		await fs.rm(root, { recursive: true, force: true });
	});

	host.addMessage("user-1", null, { role: "user", content: [{ type: "text", text: "First" }], timestamp: 1 });
	host.addMessage("assistant-1", "user-1", assistant("First historical response."));
	host.addMessage("user-2", "assistant-1", { role: "user", content: [{ type: "text", text: "Second" }], timestamp: 2 });
	host.addMessage("assistant-2", "user-2", assistant("Second latest response."));
	await host.start();

	const worker = host.firstWorkerClient();
	assert.ok(worker);
	await host.shortcut("f11");
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(worker.sent.length, 0, "replay must not start before ownership is released");

	await host.shortcut("f6");
	await host.shortcut("f8");
	await waitUntil(() => worker.sent.length > 0, "superseding replay did not start after handoff");

	const spoken = worker.sent
		.map(segment => (segment as { text?: string }).text ?? "")
		.join(" ");
	assert.match(spoken, /First historical response/);
	assert.doesNotMatch(spoken, /Second latest response/);
	assert.equal(worker.pauses.at(-1), true, "F8 during handoff must keep replacement playback paused");

	await host.shortcut("f8");
	assert.equal(worker.pauses.at(-1), false, "F8 must resume the acquired replacement transport");
});
