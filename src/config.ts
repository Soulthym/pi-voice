import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type VoiceMode = "all" | "assistant" | "yield";

export interface VoiceConfig {
	enabled: boolean;
	mode: VoiceMode;
	voice: string;
	speed: number;
	/** `local` for server speakers, or a TCP endpoint reached through an SSH reverse tunnel. */
	output: string;
	/** `disabled`, or the phone speech-to-text control endpoint reached through a second reverse tunnel. */
	input: string;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
	enabled: false,
	mode: "assistant",
	voice: "af_heart",
	speed: 1,
	output: "local",
	input: "disabled",
};

export function getVoiceConfigPath(): string {
	return process.env.PI_VOICE_CONFIG ?? path.join(os.homedir(), ".pi", "agent", "pi-voice.json");
}

function isMode(value: unknown): value is VoiceMode {
	return value === "all" || value === "assistant" || value === "yield";
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
