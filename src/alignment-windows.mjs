// PCM is transient. One active and one waiting unit are allowed in the child.
export const MAX_ALIGNMENT_BYTES = 16 * 1024 * 1024;
export const MAX_ALIGNMENT_TEXT = 32_768;
export const WINDOW_SECONDS = 30;
export const WINDOW_STRIDE = 24;

export function sourceWords(text) {
	return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().match(/[A-Z]+(?:'[A-Z]+)*/g) ?? [];
}

export function estimatedWords(text, duration) {
	const words = sourceWords(text);
	const weight = words.reduce((sum, word) => sum + word.length, 0);
	let offset = 0;
	return words.map(text => {
		const start = offset / weight * duration;
		offset += text.length;
		return { text, start, end: offset / weight * duration, quality: "estimated" };
	});
}

export function* alignmentWindows(duration) {
	for (let start = 0; start < duration; start += WINDOW_STRIDE) {
		const end = Math.min(duration, start + WINDOW_SECONDS);
		yield { start, end };
		if (end === duration) break;
	}
}

// Require a unique three-word source match. Drop clipped edge words and retain
// estimates when recognition disagrees; never guess which repeated phrase won.
export function mergeWindow(words, recognized, window, duration) {
	const phrases = new Map();
	for (let j = 1; j + 1 < words.length; j++) {
		const phrase = words.slice(j - 1, j + 2).map(word => word.text).join(" ");
		phrases.set(phrase, phrases.has(phrase) ? -1 : j);
	}
	for (let i = 1; i + 1 < recognized.length; i++) {
		const phrase = recognized.slice(i - 1, i + 2).map(word => word.text).join(" ");
		const match = phrases.get(phrase);
		if (match === undefined || match < 0 || words[match].quality !== "estimated") continue;
		const start = window.start + recognized[i].start;
		const end = window.start + recognized[i].end;
		// A window owns its central stride; overlap is context, not duplicate output.
		if (window.start > 0 && start < window.start + 3) continue;
		if (window.end < duration && end > window.end - 3) continue;
		// Conservative source-order fence, including still-estimated neighbours.
		if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
			start < words[match - 1].end || end > words[match + 1].start) continue;
		words[match] = { text: words[match].text, start, end, quality: "ctc-refined" };
	}
	return words;
}
