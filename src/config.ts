import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";

export type VoiceMode = "all" | "assistant" | "yield";
export type VoiceSubmitMode = "auto" | "review";
export type VoiceEditMode = "append" | "smart";
export type VoiceModelDtype = "fp32" | "q8" | "q4";

export interface VoiceConfig {
	enabled: boolean;
	mode: VoiceMode;
	voice: string;
	speed: number;
	/** Hugging Face repository for kokoro-js synthesis. */
	ttsModel: string;
	ttsDtype: VoiceModelDtype;
	/** Hugging Face repository for Transformers.js automatic speech recognition. */
	sttModel: string;
	sttDtype: VoiceModelDtype;
	/** Final hypotheses requested from the configured ASR model. */
	sttCandidates: number;
	/** Transformers.js CTC model used to force-align synthesized speech. */
	alignmentModel: string;
	alignmentDtype: VoiceModelDtype;
	/** `local` for server speakers, or a TCP endpoint reached through an SSH reverse tunnel. */
	output: string;
	/** `disabled`, or the phone speech-to-text control endpoint reached through a second reverse tunnel. */
	input: string;
	/** Pi key identifier used to start/stop phone recording, or `disabled`. */
	talkShortcut: KeyId | "disabled";
	/** Submit recognized speech immediately, or leave it in the editor for review. */
	submitMode: VoiceSubmitMode;
	/** Append resolved dictation, or let the resolver also apply spoken edits. */
	editMode: VoiceEditMode;
	/** `current`, or a `provider/model-id` resolved through Pi's model registry. */
	editModel: string;
	/** Dim unread assistant prose and reveal it as phone playback advances. */
	playbackHighlight: boolean;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
	enabled: false,
	mode: "assistant",
	voice: "af_heart",
	speed: 1,
	ttsModel: "onnx-community/Kokoro-82M-v1.0-ONNX",
	ttsDtype: "q8",
	sttModel: "onnx-community/whisper-tiny.en",
	sttDtype: "fp32",
	sttCandidates: 3,
	alignmentModel: "onnx-community/wav2vec2-base-960h-ONNX",
	alignmentDtype: "q8",
	output: "local",
	input: "disabled",
	talkShortcut: "alt+m",
	submitMode: "review",
	editMode: "smart",
	editModel: "current",
	playbackHighlight: true,
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

function isEditMode(value: unknown): value is VoiceEditMode {
	return value === "append" || value === "smart";
}

export function normalizeModelDtype(value: unknown): VoiceModelDtype | undefined {
	return value === "fp32" || value === "q8" || value === "q4" ? value : undefined;
}

export function normalizeSttCandidates(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8 ? value : undefined;
}

export function normalizeModelId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= 256 && !/\s/.test(trimmed) ? trimmed : undefined;
}

export function normalizeEditModel(value: unknown): string | undefined {
	const model = normalizeModelId(value);
	if (!model) return undefined;
	if (model.toLowerCase() === "current") return "current";
	const separator = model.indexOf("/");
	return separator > 0 && separator < model.length - 1 ? model : undefined;
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
			ttsModel: normalizeModelId(parsed.ttsModel) ?? DEFAULT_VOICE_CONFIG.ttsModel,
			ttsDtype: normalizeModelDtype(parsed.ttsDtype) ?? DEFAULT_VOICE_CONFIG.ttsDtype,
			sttModel: normalizeModelId(parsed.sttModel) ?? DEFAULT_VOICE_CONFIG.sttModel,
			sttDtype: normalizeModelDtype(parsed.sttDtype) ?? DEFAULT_VOICE_CONFIG.sttDtype,
			sttCandidates: normalizeSttCandidates(parsed.sttCandidates) ?? DEFAULT_VOICE_CONFIG.sttCandidates,
			alignmentModel: normalizeModelId(parsed.alignmentModel) ?? DEFAULT_VOICE_CONFIG.alignmentModel,
			alignmentDtype: normalizeModelDtype(parsed.alignmentDtype) ?? DEFAULT_VOICE_CONFIG.alignmentDtype,
			output: normalizeVoiceOutput(parsed.output) ?? DEFAULT_VOICE_CONFIG.output,
			input: normalizeVoiceInput(parsed.input) ?? DEFAULT_VOICE_CONFIG.input,
			talkShortcut: normalizeTalkShortcut(parsed.talkShortcut) ?? DEFAULT_VOICE_CONFIG.talkShortcut,
			submitMode: isSubmitMode(parsed.submitMode) ? parsed.submitMode : DEFAULT_VOICE_CONFIG.submitMode,
			editMode: isEditMode(parsed.editMode) ? parsed.editMode : DEFAULT_VOICE_CONFIG.editMode,
			editModel: normalizeEditModel(parsed.editModel) ?? DEFAULT_VOICE_CONFIG.editModel,
			playbackHighlight:
				typeof parsed.playbackHighlight === "boolean"
					? parsed.playbackHighlight
					: DEFAULT_VOICE_CONFIG.playbackHighlight,
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
