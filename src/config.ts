import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";

export type VoiceMode = "all" | "assistant" | "yield";
export type VoiceSubmitMode = "auto" | "review";

export interface VoiceConfig {
	enabled: boolean;
	mode: VoiceMode;
	voice: string;
	speed: number;
	/** `local` for server speakers, or a TCP endpoint reached through an SSH reverse tunnel. */
	output: string;
	/** `disabled`, or the phone speech-to-text control endpoint reached through a second reverse tunnel. */
	input: string;
	/** Pi key identifier used to start/stop phone recording, or `disabled`. */
	talkShortcut: KeyId | "disabled";
	/** Submit recognized speech immediately, or leave it in the editor for review. */
	submitMode: VoiceSubmitMode;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
	enabled: false,
	mode: "assistant",
	voice: "af_heart",
	speed: 1,
	output: "local",
	input: "disabled",
	talkShortcut: "alt+m",
	submitMode: "review",
};

export function getVoiceConfigPath(): string {
	return process.env.PI_VOICE_CONFIG ?? path.join(os.homedir(), ".pi", "agent", "pi-voice.json");
}

function isMode(value: unknown): value is VoiceMode {
	return value === "all" || value === "assistant" || value === "yield";
}

function isSubmitMode(value: unknown): value is VoiceSubmitMode {
	return value === "auto" || value === "review";
}

export function normalizeTcpEndpoint(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "tcp:" || url.username || url.password || url.pathname !== "" || url.search || url.hash) {
			return undefined;
		}
		const port = Number(url.port);
		if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
		const host = url.hostname.startsWith("[") ? url.hostname : url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname;
		return `tcp://${host}:${port}`;
	} catch {
		return undefined;
	}
}

export function normalizeVoiceOutput(value: unknown): string | undefined {
	return value === "local" ? "local" : normalizeTcpEndpoint(value);
}

export function normalizeVoiceInput(value: unknown): string | undefined {
	return value === "disabled" ? "disabled" : normalizeTcpEndpoint(value);
}

const MODIFIERS = new Set(["alt", "ctrl", "shift", "super"]);
const BASE_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
	..."`-=[]\\;',./!@#$%^&*()_+|~{}:<>?",
]);

export function normalizeTalkShortcut(value: unknown): KeyId | "disabled" | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.toLowerCase() === "disabled") return "disabled";
	if (!trimmed) return undefined;

	let parts: string[];
	let base: string;
	if (trimmed === "+") {
		parts = [];
		base = "+";
	} else if (trimmed.endsWith("++")) {
		parts = trimmed.slice(0, -2).split("+");
		base = "+";
	} else {
		parts = trimmed.split("+");
		base = parts.pop() ?? "";
	}
	parts = parts.map(part => part.toLowerCase());
	const baseLower = base.toLowerCase();
	if (baseLower === "pageup") base = "pageUp";
	else if (baseLower === "pagedown") base = "pageDown";
	else base = baseLower;
	if (!BASE_KEYS.has(base) || parts.some(part => !MODIFIERS.has(part)) || new Set(parts).size !== parts.length) {
		return undefined;
	}
	return [...parts, base].join("+") as KeyId;
}

export async function loadVoiceConfig(): Promise<VoiceConfig> {
	try {
		const parsed = JSON.parse(await fs.readFile(getVoiceConfigPath(), "utf8")) as Partial<VoiceConfig>;
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_VOICE_CONFIG.enabled,
			mode: isMode(parsed.mode) ? parsed.mode : DEFAULT_VOICE_CONFIG.mode,
			voice: typeof parsed.voice === "string" && parsed.voice.length > 0 ? parsed.voice : DEFAULT_VOICE_CONFIG.voice,
			speed:
				typeof parsed.speed === "number" && Number.isFinite(parsed.speed) && parsed.speed >= 0.5 && parsed.speed <= 2
					? parsed.speed
					: DEFAULT_VOICE_CONFIG.speed,
			output: normalizeVoiceOutput(parsed.output) ?? DEFAULT_VOICE_CONFIG.output,
			input: normalizeVoiceInput(parsed.input) ?? DEFAULT_VOICE_CONFIG.input,
			talkShortcut: normalizeTalkShortcut(parsed.talkShortcut) ?? DEFAULT_VOICE_CONFIG.talkShortcut,
			submitMode: isSubmitMode(parsed.submitMode) ? parsed.submitMode : DEFAULT_VOICE_CONFIG.submitMode,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_VOICE_CONFIG };
		throw error;
	}
}

export async function saveVoiceConfig(config: VoiceConfig): Promise<void> {
	const target = getVoiceConfigPath();
	await fs.mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.${process.pid}.tmp`;
	await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	await fs.rename(temporary, target);
}
