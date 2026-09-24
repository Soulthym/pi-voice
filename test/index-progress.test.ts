import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

/** Scoped admission/record/stop fixture; unscoped commands must never be sent. */
function startFakeSttServer(socketPath: string): Promise<net.Server> {
	return new Promise(resolve => {
		const clients = new Map<string, net.Socket>();
		let nextTicket = 0;
		const epoch = randomUUID().replaceAll("-", "");
		const server = net.createServer(socket => {
			let ticket: string | undefined;
			socket.on("close", () => { if (ticket) clients.delete(ticket); });
			socket.on("data", chunk => {
				const command = chunk.toString("utf8").trim();
				if (command === "ticket") {
					ticket = `${epoch}.${++nextTicket}`;
					clients.set(ticket, socket);
					socket.write(`ticket ${ticket}\n`);
				} else if (command.startsWith("stop ")) {
					assert.match(command, /^stop [0-9a-f]{32}\.[1-9][0-9]*$/);
					clients.get(command.slice(5))?.destroy();
					socket.end(`ok ${Buffer.from(`stopped ${command.slice(5)}`).toString("base64")}\n`);
				} else {
					assert.ok(ticket);
					assert.equal(command, `record ${ticket}`);
					socket.write("stream\n");
				}
			});
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

test("timing batch replaces its visible row without holes between fast adjacent jobs", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-stable-progress-"));
	const restoreEnvironment = await configure(root, path.join(root, "unused.sock"));
	const restoreWorker = mockWorker();
	const host = new FakeVoiceHost(root, "stable-progress");
	// Exercise Pi's actual widget replacement/layout, without starting a session.
	const { InteractiveMode } = await import("@earendil-works/pi-coding-agent");
	const { Container } = await import("@earendil-works/pi-tui");
	const widgetRows: number[] = [];
	const mobileRows: string[][] = [];
	const nativeUI = Object.assign(Object.create(InteractiveMode.prototype), {
		extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
		widgetContainerAbove: new Container(), widgetContainerBelow: new Container(),
		ui: { requestRender: () => {
			widgetRows.push(nativeUI.widgetContainerBelow.render(160).length);
			const rendered = nativeUI.extensionWidgetsBelow.get("pi-voice-progress")?.render(32);
			if (rendered) {
				assert.match(rendered[0], /\[🎧:.*\]$/);
				mobileRows.push(rendered);
			}
		} },
	});
	const setWidget = host.ctx.ui.setWidget;
	host.ctx.ui.setWidget = (name: string, value: any, options: any) => {
		setWidget(name, value, options);
		if (name === "pi-voice-progress") nativeUI.setExtensionWidget(name, value, options);
	};
	const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let jobs = 0;
	VoiceWorkerClient.prototype.measureSegment = async function (): Promise<number> {
		jobs++;
		if (jobs === 1 || jobs === 3) await gates[jobs === 1 ? 0 : 1].promise;
		return 1;
	};
	t.after(async () => { await host.shutdown(); restoreWorker(); await restoreEnvironment(); });
	for (let i = 0; i < 3; i++) host.addMessage(`m${i}`, i ? `m${i - 1}` : null, assistant(`Sentence ${i}.`));
	await host.start();
	const startup = await waitForWidgetLines(host, lines => lines.some(line => line.includes("Recovering speech timing")));
	assert.match(startup[0], /^○ Idle \[━+\] --:-- · 3\/3 · timing pending\s+\[🎧:/);
	assert.equal(startup.length, 2);
	await host.command("timing");
	assert.match(host.notices.at(-1)!.message, /^Voice · Word timing: unknown\/pending\n/);
	while (!jobs) await settle();
	const start = host.widgetOperations.length;
	const firstRow = widgetRows.length - 1;
	gates[0].resolve();
	while (jobs < 3) await settle();
	await new Promise(resolve => setTimeout(resolve, 120));
	const operations = host.widgetOperations.slice(start).filter(operation => operation.name === "pi-voice-progress");
	assert.equal(operations.length, 0, "content changes request native renders without re-registering widgets");
	assert.ok(widgetRows.slice(firstRow).every(rows => rows === 2), "native Pi widget layout retains playback + recovery, one fewer row, between jobs");
	gates[1].resolve();
	const idle = await waitForWidgetLines(host, lines => lines.length === 1 && !lines.some(line => line.includes("Recovering")));
	assert.match(idle[0], /^○ Idle /);
	await host.command("timing");
	assert.match(host.notices.at(-1)!.message, /^Voice · Word timing: 2\/2 estimated\n/);
	assert.ok(mobileRows.length > 1);
	assert.ok(mobileRows.every(rows => !/Word timing:| · \[|message /.test(rows.join("\n"))));
	const settled = host.widgetOperations.filter(operation => operation.name === "pi-voice-progress").length;
	await new Promise(resolve => setTimeout(resolve, 160));
	assert.equal(host.widgetOperations.filter(operation => operation.name === "pi-voice-progress").length, settled, "settled batch clears once");
});

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
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.match(host.widgetLines()![0], /Voice · ready/);
	assert.ok(host.widgetLines()![0].endsWith(`[🎧:${os.hostname()}]`));

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

	let lines = await waitForWidgetLines(host, candidate => /Queued|Describing/.test(candidate[0] ?? ""));
	assert.match(lines[0], /^◷ (?:Queued|Describing) \[━+\] --:-- · 2\/2 · timing pending\s+\[🎧:/);
	assert.equal(lines.length, 1);
	assert.equal(lines.some(line => line.includes("Preparing code descriptions")), false,
		"background descriptions must not contend with the deferred foreground utterance");
	assert.equal(
		lines.some(line => line.includes("Recovering speech timing")),
		false,
		"timing work must not contend with an allocated deferred speech utterance",
	);

	void host.command("talk");
	await new Promise(resolve => setTimeout(resolve, 150));
	lines = host.widgetLines() ?? lines;
	assert.match(lines[0], /🎙 Input · (connecting|listening) · [01]s/);
	assert.match(lines[1], /^○ Idle /);
	assert.equal(lines.some(line => line.includes("Preparing code descriptions")), false,
		"microphone ownership also defers background descriptions");
	assert.equal(lines.length, 2);

	// Stop the recording; once its lease is released, timing preprocessing joins
	// the still-pending code work in deterministic playback/code/timing order.
	await host.command("talk");
	lines = await waitForWidgetLines(
		host,
		candidate =>
			candidate.every(line => !line.includes("🎙")) &&
			candidate.some(line => line.includes("Recovering speech timing")),
	);
	assert.match(lines[0], /^○ Idle .*1\/1/);
	assert.match(lines[1], /Preparing code descriptions/);
	assert.match(lines[2], /Recovering speech timing/);
	assert.equal(lines.length, 3);

	deferredDescription.resolve({
		role: "assistant",
		content: [{ type: "text", text: "A contextual description." }],
		stopReason: "stop",
	});
	lines = await waitForWidgetLines(
		host,
		candidate => candidate.length > 0 && candidate.every(line => !/Preparing code|Recovering speech/.test(line)),
	);
	assert.match(lines[0], /^○ Idle .*1\/1/);
	await host.command("timing");
	assert.match(host.notices.at(-1)!.message, /^Voice · Word timing: 8\/8 estimated\n/);
	assert.equal(lines.length, 1);
	assert.ok(host.widgetOperations.every(operation => !operation.value?.lines?.some(line => /clock/i.test(line))));
	const timingEntry = host.entries.findLast(
		entry => entry.type === "custom" && entry.customType === "pi-voice.playback-timing",
	);
	assert.ok(timingEntry?.data.checkpoints.some((checkpoint: any) => checkpoint.duration === 0 && checkpoint.sourceOffset > 0));

	await host.shutdown();
	assert.equal(host.widgetLines(), undefined);
});
