export type NarrationMessageType = "assistant" | "assistant-thinking";

export interface NarrationSourceRange {
	start: number;
	end: number;
}

export interface NarrationSegment {
	id: number;
	utterance: number;
	text: string;
	source: NarrationSourceRange;
	/** Code descriptions reveal their source block only after narration finishes. */
	revealAtEnd?: boolean;
}

export interface AlignmentWord {
	text: string;
	start: number;
	end: number;
}

type SourceBlock = {
	type: NarrationMessageType;
	contentIndex: number;
	text: string;
	start: number;
};

type DisplayWord = {
	text: string;
	start: number;
	end: number;
	time: number;
};

type TrackedSegment = NarrationSegment & {
	audioStart?: number;
	duration?: number;
	words: DisplayWord[];
	aligned: boolean;
};

const WORD_RE = /[\p{L}\p{N}]+(?:[.'’_-][\p{L}\p{N}]+)*/gu;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

function canonicalWord(text: string): string {
	return text.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function tokenize(text: string, offset = 0): Array<{ text: string; start: number; end: number }> {
	const words: Array<{ text: string; start: number; end: number }> = [];
	WORD_RE.lastIndex = 0;
	for (let match = WORD_RE.exec(text); match; match = WORD_RE.exec(text)) {
		words.push({ text: match[0], start: offset + match.index, end: offset + match.index + match[0].length });
	}
	return words;
}

function mapWordsToSource(text: string, source: NarrationSourceRange, raw: string): DisplayWord[] {
	const spoken = tokenize(text);
	if (spoken.length === 0) return [];
	const rawWords = tokenize(raw.slice(source.start, source.end), source.start);
	let rawIndex = 0;
	return spoken.map((word, index) => {
		const canonical = canonicalWord(word.text);
		let match = -1;
		for (let candidate = rawIndex; candidate < rawWords.length; candidate += 1) {
			if (canonicalWord(rawWords[candidate]?.text ?? "") === canonical) {
				match = candidate;
				break;
			}
		}
		if (match >= 0) {
			rawIndex = match + 1;
			const mapped = rawWords[match];
			return { text: word.text, start: mapped.start, end: mapped.end, time: 0 };
		}
		const start = Math.round(source.start + ((source.end - source.start) * index) / spoken.length);
		const end = Math.round(source.start + ((source.end - source.start) * (index + 1)) / spoken.length);
		return { text: word.text, start, end: Math.max(start, end), time: 0 };
	});
}

function estimatedStarts(words: DisplayWord[], text: string, duration: number): number[] {
	if (words.length === 0) return [];
	const weights = words.map(word => {
		const localEnd = Math.max(0, text.indexOf(word.text) + word.text.length);
		const trailing = text.slice(localEnd).match(/^[\s,;:.!?—–…]*/)?.[0] ?? "";
		const pause = /[.!?…]/.test(trailing) ? 2 : /[,;:—–]/.test(trailing) ? 0.8 : 0;
		return Math.max(1, Math.sqrt(word.text.length)) + pause;
	});
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let elapsed = 0;
	return weights.map(weight => {
		const start = (elapsed / total) * duration;
		elapsed += weight;
		return start;
	});
}

function alignedStarts(spoken: DisplayWord[], recognized: AlignmentWord[], duration: number): number[] | undefined {
	if (spoken.length === 0 || recognized.length === 0) return undefined;
	const left = spoken.map(word => canonicalWord(word.text));
	const right = recognized.map(word => canonicalWord(word.text));
	const rows = left.length + 1;
	const columns = right.length + 1;
	const table = Array.from({ length: rows }, () => new Uint16Array(columns));
	for (let i = 1; i < rows; i += 1) {
		for (let j = 1; j < columns; j += 1) {
			table[i][j] = left[i - 1] && left[i - 1] === right[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
		}
	}
	const matches: Array<[number, number]> = [];
	let i = left.length;
	let j = right.length;
	while (i > 0 && j > 0) {
		if (left[i - 1] && left[i - 1] === right[j - 1]) {
			matches.push([i - 1, j - 1]);
			i -= 1;
			j -= 1;
		} else if (table[i - 1][j] >= table[i][j - 1]) i -= 1;
		else j -= 1;
	}
	matches.reverse();
	if (matches.length === 0) return undefined;

	const starts = Array<number | undefined>(spoken.length).fill(undefined);
	for (const [spokenIndex, recognizedIndex] of matches) {
		const value = recognized[recognizedIndex]?.start;
		if (typeof value === "number" && Number.isFinite(value)) starts[spokenIndex] = Math.max(0, Math.min(duration, value));
	}
	const anchors: Array<[number, number]> = [[-1, 0]];
	for (let index = 0; index < starts.length; index += 1) {
		if (starts[index] !== undefined) anchors.push([index, starts[index] as number]);
	}
	anchors.push([spoken.length, duration]);
	for (let anchor = 0; anchor < anchors.length - 1; anchor += 1) {
		const [fromIndex, fromTime] = anchors[anchor];
		const [toIndex, toTime] = anchors[anchor + 1];
		for (let index = fromIndex + 1; index < toIndex; index += 1) {
			const ratio = (index - fromIndex) / (toIndex - fromIndex);
			starts[index] = fromTime + (toTime - fromTime) * ratio;
		}
	}
	let previous = 0;
	return starts.map(value => {
		previous = Math.max(previous, value ?? previous);
		return previous;
	});
}

function excludedMarkdownRanges(markdown: string): NarrationSourceRange[] {
	const excluded: NarrationSourceRange[] = [];
	let offset = 0;
	let fence: string | undefined;
	for (const line of markdown.split(/(?<=\n)/)) {
		const content = line.endsWith("\n") ? line.slice(0, -1) : line;
		const marker = FENCE_RE.exec(content)?.[1];
		if (fence || marker) excluded.push({ start: offset, end: offset + content.length });
		if (!fence && marker) fence = marker[0];
		else if (fence && marker && marker[0] === fence) fence = undefined;
		offset += line.length;
	}
	for (const pattern of [/\]\((?:\\.|[^)])*\)/g, /<[^>]+>/g]) {
		for (let match = pattern.exec(markdown); match; match = pattern.exec(markdown)) {
			excluded.push({ start: match.index, end: match.index + match[0].length });
		}
	}
	return excluded;
}

function styleUnreadMarkdown(markdown: string, cursor: number, style: (text: string) => string): string {
	const excluded = excludedMarkdownRanges(markdown);
	const ranges = tokenize(markdown).filter(word => {
		return word.end > cursor && !excluded.some(range => word.start >= range.start && word.end <= range.end);
	});
	if (ranges.length === 0) return markdown;
	let output = "";
	let offset = 0;
	for (const range of ranges) {
		output += markdown.slice(offset, range.start) + style(markdown.slice(range.start, range.end));
		offset = range.end;
	}
	return output + markdown.slice(offset);
}

/** Tracks synthesized segment timing and transforms the active Markdown block. */
export class NarrationProgress {
	#blocks: SourceBlock[] = [];
	#segments = new Map<number, TrackedSegment>();
	#raw = "";
	#cursor = 0;
	#active = false;
	#playback = new Map<number, number>();
	#onChange: () => void;

	constructor(onChange: () => void = () => {}) {
		this.#onChange = onChange;
	}

	begin(): void {
		this.#blocks = [];
		this.#segments.clear();
		this.#raw = "";
		this.#cursor = 0;
		this.#active = true;
		this.#playback.clear();
	}

	pushDelta(type: NarrationMessageType, contentIndex: number, delta: string): void {
		if (!this.#active || !delta) return;
		let block = this.#blocks[this.#blocks.length - 1];
		if (!block || block.type !== type || block.contentIndex !== contentIndex) {
			block = { type, contentIndex, text: "", start: this.#raw.length };
			this.#blocks.push(block);
		}
		block.text += delta;
		this.#raw += delta;
	}

	setCompletedText(text: string): void {
		this.begin();
		this.pushDelta("assistant", 0, text);
	}

	registerSegment(segment: NarrationSegment): void {
		const words = mapWordsToSource(segment.text, segment.source, this.#raw);
		this.#segments.set(segment.id, { ...segment, words, aligned: false });
	}

	setSegmentAudio(segmentId: number, audioStart: number, duration: number): void {
		const segment = this.#segments.get(segmentId);
		if (!segment) return;
		segment.audioStart = audioStart;
		segment.duration = duration;
		const starts = estimatedStarts(segment.words, segment.text, duration);
		segment.words.forEach((word, index) => {
			word.time = starts[index] ?? 0;
		});
		this.#recompute(segment.utterance);
	}

	setAlignment(segmentId: number, words: AlignmentWord[]): void {
		const segment = this.#segments.get(segmentId);
		if (!segment || segment.duration === undefined || segment.revealAtEnd) return;
		const starts = alignedStarts(segment.words, words, segment.duration);
		if (!starts) return;
		segment.words.forEach((word, index) => {
			word.time = starts[index] ?? word.time;
		});
		segment.aligned = true;
		this.#recompute(segment.utterance);
	}

	setPlayback(utterance: number, position: number): void {
		if (!Number.isFinite(position) || position < 0) return;
		this.#playback.set(utterance, position);
		this.#recompute(utterance);
	}

	finish(): void {
		if (!this.#active) return;
		this.#cursor = this.#raw.length;
		this.#active = false;
		this.#onChange();
	}

	finishUtterance(utterance: number | undefined): void {
		if (utterance !== undefined && ![...this.#segments.values()].some(segment => segment.utterance === utterance)) return;
		this.finish();
	}

	transform(markdown: string, type: NarrationMessageType, style: (text: string) => string): string {
		if (!this.#active || !markdown) return markdown;
		const candidates = this.#blocks.filter(block => block.type === type && block.text.trim() === markdown);
		if (candidates.length === 0) return markdown;
		const block = candidates.find(candidate => this.#cursor <= candidate.start + candidate.text.length) ?? candidates[candidates.length - 1];
		const leading = block.text.length - block.text.trimStart().length;
		const localCursor = this.#cursor - block.start - leading;
		if (localCursor >= markdown.length) return markdown;
		return styleUnreadMarkdown(markdown, Math.max(0, localCursor), style);
	}

	get cursor(): number {
		return this.#cursor;
	}

	#recompute(utterance: number): void {
		const playback = this.#playback.get(utterance);
		if (playback === undefined) return;
		let cursor = this.#cursor;
		const segments = [...this.#segments.values()]
			.filter(segment => segment.utterance === utterance && segment.audioStart !== undefined && segment.duration !== undefined)
			.sort((left, right) => (left.audioStart as number) - (right.audioStart as number));
		for (const segment of segments) {
			const relative = playback - (segment.audioStart as number);
			if (relative < 0) break;
			if (relative >= (segment.duration as number)) {
				cursor = Math.max(cursor, segment.source.end);
				continue;
			}
			cursor = Math.max(cursor, segment.source.start);
			if (!segment.revealAtEnd) {
				for (const word of segment.words) {
					if (word.time > relative) break;
					cursor = Math.max(cursor, word.end);
				}
			}
			break;
		}
		if (cursor === this.#cursor) return;
		this.#cursor = cursor;
		this.#onChange();
	}
}
