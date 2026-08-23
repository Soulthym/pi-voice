import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import voiceExtension from "../src/index.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { VoiceWorkerClient } from "../src/worker-client.js";

interface Notice {
	message: string;
	level: string;
}

class FakeVoiceHost {
	readonly handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	readonly commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
	readonly notices: Notice[] = [];
	readonly entries: any[] = [];
	readonly model = {
		provider: "test",
		id: "model",
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
	readonly sessionManager: any;
	readonly ctx: any;
	readonly api: any;

	constructor(readonly cwd: string, sessionId: string) {
		this.sessionManager = {
			getSessionId: () => sessionId,
			getEntries: () => this.entries,
			getBranch: () => this.entries,
			getLeafId: () => this.entries.at(-1)?.id ?? null,
			getLeafEntry: () => this.entries.at(-1),
			getSessionName: () => undefined,
		};
		const theme = {
			fg: (_name: string, text: string) => text,
			bg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		this.ctx = {
			ui: {
				theme,
				notify: (message: string, level: string) => this.notices.push({ message, level }),
				setStatus: () => {},
				setWidget: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
			},
			mode: "tui",
			hasUI: true,
			cwd,
			sessionManager: this.sessionManager,
			modelRegistry: {
				find: () => this.model,
				complete: async () => {
					throw new Error("Unexpected model request in attention integration test");
				},
			},
			model: this.model,
			scopedModels: [],
			isIdle: () => true,
			isProjectTrusted: () => true,
			signal: undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => ({ tokens: 100, contextWindow: 128_000, percent: 0.1 }),
			compact: () => {},
			getSystemPrompt: () => "Test system prompt",
		};
		this.api = {
			on: (name: string, handler: (event: any, ctx: any) => unknown) => {
				const handlers = this.handlers.get(name) ?? [];
				handlers.push(handler);
				this.handlers.set(name, handlers);
			},
			registerShortcut: () => {},
			registerMarkdownTransformer: () => {},
			registerCommand: (name: string, command: { handler: (args: string, ctx: any) => unknown }) => {
				this.commands.set(name, command);
			},
			appendEntry: () => {},
			sendUserMessage: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
		};
	}

	async start(): Promise<void> {
		await voiceExtension(this.api);
		await this.emit("session_start", { type: "session_start" });
	}

	async emit(name: string, event: any): Promise<void> {
		for (const handler of this.handlers.get(name) ?? []) await handler(event, this.ctx);
	}

	async command(args: string): Promise<void> {
		await this.commands.get("voice")?.handler(args, this.ctx);
	}

	async shutdown(): Promise<void> {
		await this.emit("session_shutdown", { type: "session_shutdown" });
	}
}

function assistant(text: string, stopReason = "stop"): any {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
		stopReason,
	};
}

async function streamBlockedResponse(host: FakeVoiceHost, text: string, stopReason = "stop"): Promise<void> {
	const partial = assistant(text, "pending");
	const complete = assistant(text, stopReason);
	await host.emit("message_start", { type: "message_start", message: partial });
	if (text) {
		await host.emit("message_update", {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial },
		});
	}
	await host.emit("message_end", { type: "message_end", message: complete });
	await host.emit("turn_end", { type: "turn_end", message: complete, toolResults: [] });
}

test("extension attention ignores tool-only turns, avoids repeated warnings, and announces after owner release", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-attention-"));
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

	const spoken: string[] = [];
	const original = {
		sendSegment: VoiceWorkerClient.prototype.sendSegment,
		endUtterance: VoiceWorkerClient.prototype.endUtterance,
		cancel: VoiceWorkerClient.prototype.cancel,
		terminate: VoiceWorkerClient.prototype.terminate,
	};
	VoiceWorkerClient.prototype.sendSegment = function (_utterance, _segmentId, text): void {
		spoken.push(text);
	};
	VoiceWorkerClient.prototype.endUtterance = function (): void {};
	VoiceWorkerClient.prototype.cancel = function (): void {};
	VoiceWorkerClient.prototype.terminate = async function (): Promise<void> {};

	const owner = new SessionCoordinator(path.join(root, "owner"), "owner");
	const host = new FakeVoiceHost(path.join(root, "waiter"), "waiter");
	t.after(async () => {
		await host.shutdown().catch(() => {});
		owner.shutdown();
		VoiceWorkerClient.prototype.sendSegment = original.sendSegment;
		VoiceWorkerClient.prototype.endUtterance = original.endUtterance;
		VoiceWorkerClient.prototype.cancel = original.cancel;
		VoiceWorkerClient.prototype.terminate = original.terminate;
		if (previous.config === undefined) delete process.env.PI_VOICE_CONFIG;
		else process.env.PI_VOICE_CONFIG = previous.config;
		if (previous.coordinator === undefined) delete process.env.PI_VOICE_COORDINATOR_DIR;
		else process.env.PI_VOICE_COORDINATOR_DIR = previous.coordinator;
		if (previous.devices === undefined) delete process.env.PI_VOICE_DEVICE_DIR;
		else process.env.PI_VOICE_DEVICE_DIR = previous.devices;
		await fs.rm(root, { recursive: true, force: true });
	});

	owner.start();
	assert.equal(owner.tryAcquireSpeech(), true);
	await host.start();

	await streamBlockedResponse(host, "", "toolUse");
	assert.equal(host.notices.filter(item => item.message.includes("paused behind another project")).length, 0);

	await streamBlockedResponse(host, "A completed response that should request attention.");
	await streamBlockedResponse(host, "Another update while the same project is waiting.");
	assert.equal(host.notices.filter(item => item.message.includes("paused behind another project")).length, 1);
	assert.equal(spoken.length, 0);

	owner.releaseSpeech();
	await new Promise(resolve => setTimeout(resolve, 350));
	assert.equal(spoken.filter(text => text.includes("requires attention next")).length, 1);
});

test("project name is announced only when audible attention changes", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-index-project-"));
	const previous = {
		config: process.env.PI_VOICE_CONFIG,
		coordinator: process.env.PI_VOICE_COORDINATOR_DIR,
		devices: process.env.PI_VOICE_DEVICE_DIR,
	};
	const configPath = path.join(root, "voice.json");
	await fs.writeFile(configPath, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", audioCache: false }));
	process.env.PI_VOICE_CONFIG = configPath;
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");

	const spoken: string[] = [];
	const original = {
		sendSegment: VoiceWorkerClient.prototype.sendSegment,
		endUtterance: VoiceWorkerClient.prototype.endUtterance,
		cancel: VoiceWorkerClient.prototype.cancel,
		terminate: VoiceWorkerClient.prototype.terminate,
	};
	VoiceWorkerClient.prototype.sendSegment = function (_utterance, _segmentId, text): void { spoken.push(text); };
	VoiceWorkerClient.prototype.endUtterance = function (): void {};
	VoiceWorkerClient.prototype.cancel = function (): void {};
	VoiceWorkerClient.prototype.terminate = async function (): Promise<void> {};
	const host = new FakeVoiceHost(path.join(root, "alpha"), "alpha");
	t.after(async () => {
		await host.shutdown().catch(() => {});
		VoiceWorkerClient.prototype.sendSegment = original.sendSegment;
		VoiceWorkerClient.prototype.endUtterance = original.endUtterance;
		VoiceWorkerClient.prototype.cancel = original.cancel;
		VoiceWorkerClient.prototype.terminate = original.terminate;
		if (previous.config === undefined) delete process.env.PI_VOICE_CONFIG;
		else process.env.PI_VOICE_CONFIG = previous.config;
		if (previous.coordinator === undefined) delete process.env.PI_VOICE_COORDINATOR_DIR;
		else process.env.PI_VOICE_COORDINATOR_DIR = previous.coordinator;
		if (previous.devices === undefined) delete process.env.PI_VOICE_DEVICE_DIR;
		else process.env.PI_VOICE_DEVICE_DIR = previous.devices;
		await fs.rm(root, { recursive: true, force: true });
	});

	await host.start();
	await host.command("test First audible response.");
	await host.command("stop");
	await host.command("test Second audible response.");

	assert.equal(spoken.filter(text => text.startsWith("Project ")).length, 1);
	assert.equal(spoken.filter(text => text.includes("audible response")).length, 2);
});
