import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { FakeVoiceHost, streamCompletedResponse } from "./helpers/fake-voice-host.js";

test("worker events drive speaking styling, idle completion, and error notices", async t => {
	// Intercept the worker client before the extension loads so real worker
	// events flow through Pi Voice's genuine handleWorkerEvent pipeline.
	mock.module("../src/worker-client.js", {
		namedExports: {
			VoiceWorkerClient: (await import("./helpers/fake-voice-host.js")).MockedVoiceWorkerClient,
		},
	});

	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-worker-events-"));
	const previous = {
		config: process.env.PI_VOICE_CONFIG,
		coordinator: process.env.PI_VOICE_COORDINATOR_DIR,
		devices: process.env.PI_VOICE_DEVICE_DIR,
	};
	const configPath = path.join(root, "voice.json");
	await fs.writeFile(
		configPath,
		JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", audioCache: false }),
	);
	process.env.PI_VOICE_CONFIG = configPath;
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");

	const host = new FakeVoiceHost(path.join(root, "project"), "events", async () => ({
		role: "assistant",
		content: [{ type: "text", text: "A block description." }],
		stopReason: "stop",
	}));
	t.after(async () => {
		await host.shutdown().catch(() => {});
		mock.reset();
		if (previous.config === undefined) delete process.env.PI_VOICE_CONFIG;
		else process.env.PI_VOICE_CONFIG = previous.config;
		if (previous.coordinator === undefined) delete process.env.PI_VOICE_COORDINATOR_DIR;
		else process.env.PI_VOICE_COORDINATOR_DIR = previous.coordinator;
		if (previous.devices === undefined) delete process.env.PI_VOICE_DEVICE_DIR;
		else process.env.PI_VOICE_DEVICE_DIR = previous.devices;
		await fs.rm(root, { recursive: true, force: true });
	});

	host.addMessage("user-1", null, { role: "user", content: [{ type: "text", text: "Play it." }], timestamp: 1 });
	await host.start();
	await streamCompletedResponse(host, "assistant-1", "user-1", "A completed response for replay.");

	// Replay through F11 acquires speech and starts a worker utterance.
	await host.shortcut("f11");

	const instance = host.firstWorkerClient();
	assert.ok(instance, "the extension must have created its worker client");

	// The speaking event must reach the status/widget pipeline as an accent state.
	instance!.emit({ type: "speaking" } as never);
	assert.ok(
		host.styleCalls.some(call => call.style === "accent" && call.text.includes("speaking")),
		`speaking state must be styled accent; calls: ${JSON.stringify(host.styleCalls.slice(-6))}`,
	);
	assert.ok((host.widgetLines()?.length ?? 0) > 0);

	// Idle reverts the status away from accent-speaking.
	const accentWhileSpeaking = host.styleCalls.filter(call => call.style === "accent").length;
	instance!.emit({ type: "idle", utterance: 1 } as never);
	host.shortcut("f8");
	const accentAfterIdle = host.styleCalls.filter(
		call => call.style === "accent" && call.text.includes("speaking"),
	).length;
	assert.equal(accentAfterIdle, accentWhileSpeaking, "idle must clear the speaking state");

	// Idle completes the utterance and releases ownership without errors.
	instance!.emit({ type: "idle", utterance: 1 } as never);
	assert.ok(
		!host.notices.some(notice => notice.level === "error"),
		`idle transition must be clean: ${JSON.stringify(host.notices)}`,
	);

	// Worker errors surface as notifications.
	const errorCountBefore = host.notices.filter(notice => notice.message.startsWith("Voice mode:")).length;
	instance!.emit({ type: "error", message: "synthesis exploded" } as never);
	assert.equal(host.notices.filter(notice => notice.message.startsWith("Voice mode:")).length, errorCountBefore + 1);
});
