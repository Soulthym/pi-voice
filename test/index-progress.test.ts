import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { VoiceWorkerClient } from "../src/worker-client.js";
import { FakeVoiceHost, assistant, type ModelRequest } from "./helpers/fake-voice-host.js";

async function settle(): Promise<void> {
	for (let index = 0; index < 10; index += 1) await new Promise(resolve => setImmediate(resolve));
}

async function waitForWidgetLines(
	host: FakeVoiceHost,
	predicate: (lines: string[]) => boolean,
	timeoutMs = 2_000,
): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const lines = host.widgetLines();
		if (lines && predicate(lines)) return lines;
		if (Date.now() > deadline) {
			assert.fail(`widget did not reach expected state; last lines: ${JSON.stringify(lines)}`);
		}
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

/** Starts a fake STT endpoint that accepts recordings; any "stop" closes all clients. */
function startFakeSttServer(socketPath: string): Promise<net.Server> {
	return new Promise(resolve => {
		const clients = new Set<net.Socket>();
		const server = net.createServer(socket => {
			clients.add(socket);
			socket.on("close", () => clients.delete(socket));
			socket.on("data", chunk => {
				if (chunk.toString("utf8").trim() === "stop") {
					for (const client of clients) client.destroy();
				}
			});
			socket.write("stream\n");
		});
		server.listen(socketPath, () => resolve(server));
	});
}

async function configure(root: string, socketPath: string): Promise<() => Promise<void>> {
	const previous = {
		config: process.env.PI_VOICE_CONFIG,
		coordinator: process.env.PI_VOICE_COORDINATOR_DIR,
		devices: process.env.PI_VOICE_DEVICE_DIR,
	};
	const configPath = path.join(root, "voice.json");
	await fs.writeFile(
		configPath,
		JSON.stringify({
			enabled: true,
			mode: "assistant",
			input: `unix://${socketPath}`,
			output: "local",
			audioCache: false,
			codeNarration: "summary",
			codeDescriptionContext: "conversation",
			codeDescriptionPreprocessConcurrency: 1,
			timingPreprocessConcurrency: 1,
		}),
	);
	process.env.PI_VOICE_CONFIG = configPath;
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	return async () => {
		if (previous.config === undefined) delete process.env.PI_VOICE_CONFIG;
		else process.env.PI_VOICE_CONFIG = previous.config;
		if (previous.coordinator === undefined) delete process.env.PI_VOICE_COORDINATOR_DIR;
		else process.env.PI_VOICE_COORDINATOR_DIR = previous.coordinator;
		if (previous.devices === undefined) delete process.env.PI_VOICE_DEVICE_DIR;
		else process.env.PI_VOICE_DEVICE_DIR = previous.devices;
		await fs.rm(root, { recursive: true, force: true });
	};
}

function mockWorker(): () => void {
	const original = {
		sendSegment: VoiceWorkerClient.prototype.sendSegment,
		measureSegment: VoiceWorkerClient.prototype.measureSegment,
		endUtterance: VoiceWorkerClient.prototype.endUtterance,
		cancel: VoiceWorkerClient.prototype.cancel,
		terminate: VoiceWorkerClient.prototype.terminate,
	};
	VoiceWorkerClient.prototype.sendSegment = function (): void {};
	VoiceWorkerClient.prototype.measureSegment = async function (): Promise<number> {
		return 1;
	};
	VoiceWorkerClient.prototype.endUtterance = function (): void {};
	VoiceWorkerClient.prototype.cancel = function (): undefined { return undefined; };
	VoiceWorkerClient.prototype.terminate = async function (): Promise<void> {};
	return () => {
		VoiceWorkerClient.prototype.sendSegment = original.sendSegment;
		VoiceWorkerClient.prototype.measureSegment = original.measureSegment;
		VoiceWorkerClient.prototype.endUtterance = original.endUtterance;
		VoiceWorkerClient.prototype.cancel = original.cancel;
		VoiceWorkerClient.prototype.terminate = original.terminate;
	};
}

test("unified progress widget orders input, playback, and preprocessing and cleans up", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-progress-"));
	const socketPath = path.join(root, "stt.sock");
	const restoreEnvironment = await configure(root, socketPath);
	const restoreWorker = mockWorker();
	const sttServer = await startFakeSttServer(socketPath);
	const deferredDescription = Promise.withResolvers<any>();
	const host = new FakeVoiceHost(path.join(root, "project"), "progress", async (_request: ModelRequest) => {
		await deferredDescription.promise;
		return { role: "assistant", content: [{ type: "text", text: "A contextual description." }], stopReason: "stop" };
	});
	t.after(async () => {
		await host.shutdown().catch(() => {});
		sttServer.close();
		restoreWorker();
		await restoreEnvironment();
	});

	host.addMessage("user-1", null, { role: "user", content: [{ type: "text", text: "Show it." }], timestamp: 1 });
	await host.start();

	const removals = host.widgetOperations.filter(operation => operation.value === undefined).map(operation => operation.name);
	assert.ok(removals.includes("pi-voice-input"), "legacy input widget must be removed");
	assert.ok(removals.includes("pi-voice-playback"), "legacy playback widget must be removed");
	assert.ok(removals.includes("pi-voice-preprocessing"), "legacy preprocessing widget must be removed");
	assert.equal(host.widgetLines(), undefined);

	const text = "This answer contains several words for precise timing.\n```ts\nrun();\n```";
	const partial = assistant(text, "pending");
	const complete = assistant(text, "stop");
	await host.emit("before_agent_start", { type: "before_agent_start" });
	await host.emit("message_start", { type: "message_start", message: partial });
	host.addMessage("assistant-1", "user-1", complete);
	await host.emit("message_end", { type: "message_end", message: complete });
	await host.emit("turn_end", { type: "turn_end", message: complete, toolResults: [] });
	await host.emit("agent_settled", { type: "agent_settled" });
	await settle();

	let lines = await waitForWidgetLines(host, candidate => candidate.length >= 2);
	assert.match(lines[0], /Playback · message 1\/1: speech timing pending/);
	assert.match(lines[1], /Preprocessing · code descriptions \(0\/25 budget\): 0\/1 ready/);
	assert.equal(
		lines.some(line => line.includes("Preprocessing · speech timing")),
		false,
		"timing work must not contend with an allocated deferred speech utterance",
	);

	void host.command("talk");
	await new Promise(resolve => setTimeout(resolve, 150));
	lines = host.widgetLines() ?? lines;
	assert.match(lines[0], /🎙 Listening: 0s|🎙 Listening: 1s/);
	assert.equal(lines.some(line => line.includes("Preprocessing · code descriptions")), true);

	// Stop the recording; once its lease is released, timing preprocessing joins
	// the still-pending code work in deterministic playback/code/timing order.
	await host.command("talk");
	lines = await waitForWidgetLines(
		host,
		candidate =>
			candidate.every(line => !line.includes("🎙")) &&
			candidate.some(line => line.includes("Preprocessing · speech timing")),
	);
	assert.match(lines[0], /Playback · message 1\/1/);
	assert.match(lines[1], /Preprocessing · code descriptions/);
	assert.match(lines[2], /Preprocessing · speech timing/);

	deferredDescription.resolve({
		role: "assistant",
		content: [{ type: "text", text: "A contextual description." }],
		stopReason: "stop",
	});
	lines = await waitForWidgetLines(
		host,
		candidate => candidate.length > 0 && candidate.every(line => !line.includes("Preprocessing ·")),
	);
	assert.match(lines[0], /message 1\/1/);
	const timingEntry = host.entries.findLast(
		entry => entry.type === "custom" && entry.customType === "pi-voice.playback-timing",
	);
	assert.ok(timingEntry?.data.checkpoints.some((checkpoint: any) => checkpoint.duration === 0 && checkpoint.sourceOffset > 0));

	await host.shutdown();
	assert.equal(host.widgetLines(), undefined);
});
