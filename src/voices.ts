export interface VoiceOption {
	id: string;
	label: string;
}

/** Curated high-quality voices from the Kokoro v1.0 model card. */
export const VOICES: readonly VoiceOption[] = [
	{ id: "af_heart", label: "Heart (American female)" },
	{ id: "af_bella", label: "Bella (American female)" },
	{ id: "af_nicole", label: "Nicole (American female)" },
	{ id: "af_aoede", label: "Aoede (American female)" },
	{ id: "af_kore", label: "Kore (American female)" },
	{ id: "af_sarah", label: "Sarah (American female)" },
	{ id: "am_michael", label: "Michael (American male)" },
	{ id: "am_fenrir", label: "Fenrir (American male)" },
	{ id: "am_puck", label: "Puck (American male)" },
	{ id: "bf_emma", label: "Emma (British female)" },
	{ id: "bm_george", label: "George (British male)" },
	{ id: "bm_fable", label: "Fable (British male)" },
] as const;

export function isVoice(value: string): boolean {
	return VOICES.some(voice => voice.id === value);
}
