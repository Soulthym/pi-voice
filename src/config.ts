import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";

export type VoiceMode = "all" | "assistant" | "yield";
export type VoiceSubmitMode = "auto" | "review";
export type VoiceEditMode = "append" | "smart";
export type VoiceCodeNarration = "guided" | "summary";
export type VoiceModelDtype = "fp32" | "q8" | "q4";
export type VoicePreprocessConcurrency = "auto" | number;

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
	/** `auto`, `local`, or a TCP/Unix endpoint reached through an SSH reverse tunnel. */
	output: string;
	/** `auto`, `local`, `disabled`, or a TCP/Unix microphone-control endpoint. */
	input: string;
	/** Pi key identifier used to start/stop microphone recording, or `disabled`. */
	talkShortcut: KeyId | "disabled";
	/** Submit recognized speech immediately, or leave it in the editor for review. */
	submitMode: VoiceSubmitMode;
	/** Append resolved dictation, or let the resolver also apply spoken edits. */
	editMode: VoiceEditMode;
	/** `current`, or a `provider/model-id` resolved through Pi's model registry. */
	editModel: string;
	/** Dim unread assistant prose and reveal it as phone playback advances. */
	playbackHighlight: boolean;
	/** Narrate code with synchronized focus groups, or use a plain summary. */
	codeNarration: VoiceCodeNarration;
	/** Parallel model requests used to fill missing written code descriptions. */
	codeDescriptionPreprocessConcurrency: number;
	/** Parallel CPU Kokoro workers used to fill missing playback timings. */
	timingPreprocessConcurrency: VoicePreprocessConcurrency;
	/** Persist synthesized speech as local Opus segment files for reuse. */
	audioCache: boolean;
	/** Target Opus bitrate in kilobits per second. */
	audioCacheBitrate: number;
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
	output: "auto",
	input: "auto",
	talkShortcut: "alt+m",
	submitMode: "review",
	editMode: "smart",
	editModel: "current",
	playbackHighlight: true,
	codeNarration: "guided",
	codeDescriptionPreprocessConcurrency: 4,
	timingPreprocessConcurrency: "auto",
	audioCache: true,
	audioCacheBitrate: 32,
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

function isCodeNarration(value: unknown): value is VoiceCodeNarration {
	return value === "guided" || value === "summary";
}

export function normalizeModelDtype(value: unknown): VoiceModelDtype | undefined {
	return value === "fp32" || value === "q8" || value === "q4" ? value : undefined;
}

export function normalizeSttCandidates(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8 ? value : undefined;
}

export function normalizeWorkerCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8 ? value : undefined;
}

export function normalizeAudioCacheBitrate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 12 && value <= 128 ? value : undefined;
}

export function normalizePreprocessConcurrency(value: unknown): VoicePreprocessConcurrency | undefined {
	if (typeof value === "string" && value.toLowerCase() === "auto") return "auto";
	return normalizeWorkerCount(value);
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

export function normalizeDeviceEndpoint(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol === "unix:") {
			if (url.hostname || url.username || url.password || url.search || url.hash || !url.pathname.startsWith("/")) return undefined;
			return `unix://${url.pathname}`;
		}
	} catch {
		return undefined;
	}
	return normalizeTcpEndpoint(value);
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
	return value === "auto" || value === "local" ? value : normalizeDeviceEndpoint(value);
}

export function normalizeVoiceInput(value: unknown): string | undefined {
	return value === "auto" || value === "local" || value === "disabled" ? value : normalizeDeviceEndpoint(value);
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
			codeNarration: isCodeNarration(parsed.codeNarration)
				? parsed.codeNarration
				: DEFAULT_VOICE_CONFIG.codeNarration,
			codeDescriptionPreprocessConcurrency:
				normalizeWorkerCount(parsed.codeDescriptionPreprocessConcurrency) ??
				DEFAULT_VOICE_CONFIG.codeDescriptionPreprocessConcurrency,
			timingPreprocessConcurrency:
				normalizePreprocessConcurrency(parsed.timingPreprocessConcurrency) ??
				DEFAULT_VOICE_CONFIG.timingPreprocessConcurrency,
			audioCache: typeof parsed.audioCache === "boolean" ? parsed.audioCache : DEFAULT_VOICE_CONFIG.audioCache,
			audioCacheBitrate:
				normalizeAudioCacheBitrate(parsed.audioCacheBitrate) ?? DEFAULT_VOICE_CONFIG.audioCacheBitrate,
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
