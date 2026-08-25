import type { Message } from "@earendil-works/pi-ai";
import type { WorkerEvent } from "../../src/worker-client.js";

type VoiceExtensionModule = { default: (api: unknown) => Promise<void> };
let extensionPromise: Promise<VoiceExtensionModule> | undefined;

/**
 * Loads the extension lazily. Test files that registered `mock.module` for
 * `src/worker-client.js` must do so before the first call; Node resolves each
 * test file in its own process, so per-file mocks stay isolated.
 */
export async function loadVoiceExtension(): Promise<VoiceExtensionModule> {
	extensionPromise ??= import("../../src/index.js") as Promise<VoiceExtensionModule>;
	return extensionPromise;
}

/** Minimal stand-in for VoiceWorkerClient that records its event pipeline. */
export class MockedVoiceWorkerClient {
	static instances: MockedVoiceWorkerClient[] = [];
	#onEvent: (event: WorkerEvent) => void;
	sent: unknown[] = [];

	constructor(onEvent: (event: WorkerEvent) => void) {
		this.#onEvent = onEvent;
		MockedVoiceWorkerClient.instances.push(this);
	}

	emit(event: WorkerEvent): void {
		this.#onEvent(event);
	}

	sendSegment(utterance: number, segmentId: number, text: string): void {
		this.sent.push({ type: "segment", utterance, segmentId, text });
	}
	measureSegment(): Promise<number> {
		return Promise.resolve(1);
	}
	endUtterance(): void {}
	setPlaybackPaused(): void {}
	cancel(): void {}
	async transcribe(): Promise<string[]> {
		return [];
	}
	async transcribePcm(): Promise<string> {
		return "";
	}
	async preload(): Promise<void> {}
	async preloadAlignment(): Promise<void> {}
	async terminate(): Promise<void> {}
}

export interface Notice {
	message: string;
	level: string;
}

/** ScrollView-shaped TUI test double used by narration auto-scroll tests. */
export class FakeScrollView {
	scrollTop = 0;
	viewportHeight = 40;
	contentHeight = 0;
	lines: string[] = [];

	setDocument(lines: string[], viewportHeight = this.viewportHeight): void {
		this.lines = [...lines];
		this.contentHeight = lines.length;
		this.viewportHeight = viewportHeight;
		this.scrollTop = Math.min(this.scrollTop, Math.max(0, this.contentHeight - this.viewportHeight));
	}

	getContentWidth(width: number): number {
		return width;
	}

	render(_width: number): string[] {
		return [...this.lines];
	}

	scrollTo(top: number): void {
		this.scrollTop = Math.max(0, Math.min(Math.max(0, this.contentHeight - this.viewportHeight), Math.trunc(top)));
	}

	scrollToEnd(): void {
		this.scrollTop = Math.max(0, this.contentHeight - this.viewportHeight);
	}

	manualScrollTo(top: number): void {
		this.scrollTo(top);
	}
}

export interface ModelRequest {
	model: unknown;
	context: { systemPrompt?: string; messages: Message[]; tools?: unknown[] };
	options: Record<string, unknown>;
}

export class FakeVoiceHost {
	readonly handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	readonly commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
	readonly shortcuts = new Map<string, { handler: (ctx: any) => unknown }>();
	readonly transformers: Array<(markdown: string, context: any) => string> = [];
	readonly notices: Notice[] = [];
	readonly entries: any[] = [];
	readonly modelRequests: ModelRequest[] = [];
	/** Active transcript viewport; intentionally differs from the implicit fallback. */
	readonly scrollView = new FakeScrollView();
	readonly implicitScrollView = new FakeScrollView();
	readonly tui = {
		terminal: { columns: 100 },
		implicitScrollView: this.implicitScrollView,
		getPrimaryScrollView: () => this.scrollView,
		invalidate: () => {},
		requestRender: () => {},
	};
	readonly widgetComponents = new Map<string, { dispose?: () => void }>();
	/** Latest value per widget name, in update order. */
	readonly styleCalls: Array<{ style: string; text: string }> = [];
	readonly widgets = new Map<string, { lines?: string[]; placement?: string } | undefined>();	readonly widgetOperations: Array<{ name: string; value: { lines?: string[]; placement?: string } | undefined }> = [];
	readonly model = {
		provider: "test",
		id: "model",
		api: "test",
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
	readonly sessionManager: any;
	readonly ctx: any;
	readonly api: any;
	/** Toggled by tests to simulate Pi generating a response. */
	idle = true;
	sessionName: string | undefined;
	#nextEntry = 0;

	constructor(
		readonly cwd: string,
		sessionId: string,
		readonly completeModel: (request: ModelRequest) => Promise<any> = async () => {
			throw new Error("Unexpected model request in fake voice host");
		},
	) {
		this.sessionManager = {
			getSessionId: () => sessionId,
			getEntries: () => this.entries,
			getBranch: () => this.entries,
			getLeafId: () => this.entries.at(-1)?.id ?? null,
			getLeafEntry: () => this.entries.at(-1),
			getSessionName: () => undefined,
		};
		const styleCalls: Array<{ style: string; text: string }> = [];
		const theme = {
			fg: (name: string, text: string) => {
				this.styleCalls.push({ style: name, text });
				return text;
			},
			bg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		this.ctx = {
			ui: {
				theme,
				notify: (message: string, level: string) => this.notices.push({ message, level }),
				select: async (_title: string, options: string[]) => options[0],
				confirm: async () => true,
				input: async () => undefined,
				setStatus: () => {},
				setWidget: (
					name: string,
					value:
						| { lines?: string[]; placement?: string }
						| string[]
						| ((tui: typeof this.tui, theme: any) => { dispose?: () => void })
						| undefined,
					options?: { placement?: string },
				) => {
					if (value === undefined) this.widgetComponents.get(name)?.dispose?.();
					let normalized: { lines?: string[]; placement?: string } | undefined;
					if (typeof value === "function") {
						this.widgetComponents.set(name, value(this.tui, theme));
						normalized = {};
					} else {
						normalized = Array.isArray(value)
							? { lines: value, ...(options ? { placement: options.placement } : {}) }
							: value;
					}
					this.widgets.set(name, normalized);
					this.widgetOperations.push({ name, value: normalized });
				},

				setEditorText: () => {},
				getEditorText: () => "",
			},
			mode: "tui",
			hasUI: true,
			cwd,
			sessionManager: this.sessionManager,
			modelRegistry: {
				find: () => this.model,
				complete: async (model: unknown, context: ModelRequest["context"], options: Record<string, unknown>) => {
					const request = { model, context, options };
					this.modelRequests.push(request);
					return this.completeModel(request);
				},
			},
			model: this.model,
			scopedModels: [],
			isIdle: () => this.idle,
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
			registerShortcut: (key: string, shortcut: { handler: (ctx: any) => unknown }) => {
				this.shortcuts.set(key, shortcut);
			},
			registerMarkdownTransformer: (transformer: (markdown: string, context: any) => string) => {
				this.transformers.push(transformer);
			},
			registerCommand: (name: string, command: { handler: (args: string, ctx: any) => unknown }) => {
				this.commands.set(name, command);
			},
			appendEntry: (customType: string, data: unknown) => {
				this.entries.push({
					type: "custom",
					id: `custom-${++this.#nextEntry}`,
					parentId: this.entries.at(-1)?.id ?? null,
					timestamp: new Date().toISOString(),
					customType,
					data,
				});
			},
			sendUserMessage: () => {},
			getSessionName: () => this.sessionName,
			setSessionName: (name: string) => {
				this.sessionName = name;
			},
			getActiveTools: () => [],
			getAllTools: () => [],
		};
	}

	async start(): Promise<void> {
		const { default: voiceExtension } = await loadVoiceExtension();
		await voiceExtension(this.api);
		await this.emit("session_start", { type: "session_start" });
	}

	async emit(name: string, event: any): Promise<void> {
		for (const handler of this.handlers.get(name) ?? []) await handler(event, this.ctx);
	}

	async command(args: string): Promise<void> {
		await this.commands.get("voice")?.handler(args, this.ctx);
	}

	async shortcut(key: string): Promise<void> {
		await this.shortcuts.get(key)?.handler(this.ctx);
	}

	render(markdown: string, messageType = "assistant"): string {
		return this.transformers.reduce(
			(current, transformer) => transformer(current, { messageType }),
			markdown,
		);
	}

	widgetLines(name = "pi-voice-progress"): string[] | undefined {
		return this.widgets.get(name)?.lines;
	}

	addMessage(id: string, parentId: string | null, message: unknown): void {
		this.entries.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		});
	}

	/** First worker-client instance created by the extension (mocked builds only). */
	firstWorkerClient(): MockedVoiceWorkerClient | undefined {
		return MockedVoiceWorkerClient.instances.at(-1);
	}

	async shutdown(): Promise<void> {
		await this.emit("session_shutdown", { type: "session_shutdown" });
	}
}

export function assistant(text: string, stopReason = "stop"): any {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
		stopReason,
	};
}

export async function streamBlockedResponse(
	host: FakeVoiceHost,
	text: string,
	stopReason = "stop",
): Promise<void> {
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

/** Drives a full assistant turn through the real extension handlers and session. */
export async function streamCompletedResponse(
	host: FakeVoiceHost,
	id: string,
	parentId: string,
	text: string,
): Promise<void> {
	const partial = assistant(text, "pending");
	const complete = assistant(text, "stop");
	await host.emit("before_agent_start", { type: "before_agent_start" });
	await host.emit("message_start", { type: "message_start", message: partial });
	await host.emit("message_update", {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial },
	});
	host.addMessage(id, parentId, complete);
	await host.emit("message_end", { type: "message_end", message: complete });
	await host.emit("turn_end", { type: "turn_end", message: complete, toolResults: [] });
	await host.emit("agent_settled", { type: "agent_settled" });
	for (let index = 0; index < 8; index += 1) await new Promise(resolve => setImmediate(resolve));
}
