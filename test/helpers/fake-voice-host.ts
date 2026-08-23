import type { Message } from "@earendil-works/pi-ai";
import voiceExtension from "../../src/index.js";

export interface Notice {
	message: string;
	level: string;
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
				complete: async (model: unknown, context: ModelRequest["context"], options: Record<string, unknown>) => {
					const request = { model, context, options };
					this.modelRequests.push(request);
					return this.completeModel(request);
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

	async shortcut(key: string): Promise<void> {
		await this.shortcuts.get(key)?.handler(this.ctx);
	}

	render(markdown: string, messageType = "assistant"): string {
		return this.transformers.reduce(
			(current, transformer) => transformer(current, { messageType }),
			markdown,
		);
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
