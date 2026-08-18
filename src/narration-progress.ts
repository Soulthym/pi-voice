import type {
	CodeLineRange,
	CodeNarrationCue,
	CodeNarrationOperation,
	CodeSpanRange,
} from "./code-narration.js";
import { isTextFenceLanguage } from "./speakable.js";

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
	code?: {
		blockSource: NarrationSourceRange;
		code: string;
		cues: CodeNarrationCue[];
	};
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
	localStart: number;
	localEnd: number;
	time: number;
};

type TrackedSegment = NarrationSegment & {
	audioStart?: number;
	duration?: number;
	words: DisplayWord[];
	aligned: boolean;
	audioAt?: number;
	activeAt?: number;
	renderAt?: number;
	codeCues: Array<CodeNarrationCue & { time: number }>;
	appliedCodeCues: number;
};

type CodeFocusBlock = {
	source: NarrationSourceRange;
	code: string;
	lineGroups: Map<string, CodeLineRange[]>;
	boldGroups: Map<string, CodeSpanRange[]>;
	complete: boolean;
};

const WORD_RE = /[\p{L}\p{N}]+(?:[.'’_-][\p{L}\p{N}]+)*/gu;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

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
			return {
				text: word.text,
				start: mapped.start,
				end: mapped.end,
				localStart: word.start,
				localEnd: word.end,
				time: 0,
			};
		}
		const start = Math.round(source.start + ((source.end - source.start) * index) / spoken.length);
		const end = Math.round(source.start + ((source.end - source.start) * (index + 1)) / spoken.length);
		return {
			text: word.text,
			start,
			end: Math.max(start, end),
			localStart: word.start,
			localEnd: word.end,
			time: 0,
		};
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
	let fence: { marker: string; textLike: boolean } | undefined;
	for (const line of markdown.split(/(?<=\n)/)) {
		const content = line.endsWith("\n") ? line.slice(0, -1) : line;
		const match = FENCE_RE.exec(content);
		if (!fence && match) {
			const language = (match[2] ?? "").trim().toLowerCase().split(/[\s,{]/, 1)[0] ?? "";
			fence = { marker: match[1][0], textLike: isTextFenceLanguage(language) };
			excluded.push({ start: offset, end: offset + content.length });
		} else if (fence) {
			const trimmed = content.trim();
			const closing =
				trimmed.length >= 3 && [...trimmed].every(character => character === fence?.marker);
			if (closing) {
				excluded.push({ start: offset, end: offset + content.length });
				fence = undefined;
			} else if (!fence.textLike) {
				excluded.push({ start: offset, end: offset + content.length });
			}
		}
		offset += line.length;
	}
	for (const pattern of [/\]\((?:\\.|[^)])*\)/g, /<[^>]+>/g]) {
		for (let match = pattern.exec(markdown); match; match = pattern.exec(markdown)) {
			excluded.push({ start: match.index, end: match.index + match[0].length });
		}
	}
	return excluded;
}

function styleNarrationMarkdown(
	markdown: string,
	cursor: number,
	active: NarrationSourceRange | undefined,
	styleUnread: (text: string) => string,
	styleActive: (text: string) => string,
): string {
	const excluded = excludedMarkdownRanges(markdown);
	const ranges = tokenize(markdown).filter(word => {
		const unread = word.end > cursor;
		const speaking = active ? word.end > active.start && word.start < active.end : false;
		return (unread || speaking) && !excluded.some(range => word.start >= range.start && word.end <= range.end);
	});
	if (ranges.length === 0) return markdown;
	let output = "";
	let offset = 0;
	let previousWasActive = false;
	for (const range of ranges) {
		const isActive = active ? range.end > active.start && range.start < active.end : false;
		const gap = markdown.slice(offset, range.start);
		// Keep the sentence background visually continuous without putting ANSI
		// escapes around Markdown punctuation or line-start syntax.
		output += previousWasActive && isActive && /^[ \t]+$/.test(gap) ? styleActive(gap) : gap;
		let styled = markdown.slice(range.start, range.end);
		if (range.end > cursor) styled = styleUnread(styled);
		if (isActive) styled = styleActive(styled);
		output += styled;
		offset = range.end;
		previousWasActive = isActive;
	}
	return output + markdown.slice(offset);
}

const DIM_ON = "\x1b[2m";
const INTENSITY_OFF = "\x1b[22m";
const BOLD_ON = "\x1b[1m";

function mergeSpans(spans: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
	const sorted = spans.filter(span => span.end > span.start).sort((left, right) => left.start - right.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const span of sorted) {
		const previous = merged[merged.length - 1];
		if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
		else merged.push({ ...span });
	}
	return merged;
}

function styleCodeLine(line: string, lineNumber: number, block: CodeFocusBlock): string {
	const lineActive = [...block.lineGroups.values()]
		.flat()
		.some(range => lineNumber >= range.startLine && lineNumber <= range.endLine);
	const bold = mergeSpans(
		[...block.boldGroups.values()]
			.flat()
			.filter(range => lineNumber >= range.startLine && lineNumber <= range.endLine)
			.map(range => ({
				start: lineNumber === range.startLine ? Math.max(0, range.startColumn - 1) : 0,
				end: lineNumber === range.endLine ? Math.min(line.length, range.endColumn) : line.length,
			})),
	);
	let output = lineActive ? "" : DIM_ON;
	let offset = 0;
	for (const span of bold) {
		output += line.slice(offset, span.start);
		if (!lineActive) output += INTENSITY_OFF;
		output += BOLD_ON + line.slice(span.start, span.end) + INTENSITY_OFF;
		if (!lineActive && span.end < line.length) output += DIM_ON;
		offset = span.end;
	}
	output += line.slice(offset);
	if (!lineActive && (bold.length === 0 || offset < line.length)) output += INTENSITY_OFF;
	return output;
}

function styleCodeBlock(code: string, block: CodeFocusBlock): string {
	return code
		.split("\n")
		.map((line, index) => styleCodeLine(line, index + 1, block))
		.join("\n");
}

/** Tracks synthesized segment timing and transforms the active Markdown block. */
export class NarrationProgress {
	#blocks: SourceBlock[] = [];
	#segments = new Map<number, TrackedSegment>();
	#codeBlocks = new Map<string, CodeFocusBlock>();
	#raw = "";
	#cursor = 0;
	#active = false;
	#activeSource: NarrationSourceRange | undefined;
	#playback = new Map<number, number>();
	#onChange: () => void;

	constructor(onChange: () => void = () => {}) {
		this.#onChange = onChange;
	}

	begin(): void {
		this.#blocks = [];
		this.#segments.clear();
		this.#codeBlocks.clear();
		this.#raw = "";
		this.#cursor = 0;
		this.#active = true;
		this.#activeSource = undefined;
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
		this.#segments.set(segment.id, {
			...segment,
			words,
			aligned: false,
			codeCues: (segment.code?.cues ?? []).map(cue => ({ ...cue, time: 0 })),
			appliedCodeCues: 0,
		});
		if (segment.code) {
			const key = this.#codeKey(segment.code.blockSource);
			if (!this.#codeBlocks.has(key)) {
				this.#codeBlocks.set(key, {
					source: segment.code.blockSource,
					code: segment.code.code,
					lineGroups: new Map(),
					boldGroups: new Map(),
					complete: false,
				});
				this.#onChange();
			}
		}
	}

	setSegmentAudio(segmentId: number, audioStart: number, duration: number): void {
		const segment = this.#segments.get(segmentId);
		if (!segment) return;
		segment.audioStart = audioStart;
		segment.duration = duration;
		segment.audioAt = performance.now();
		const starts = estimatedStarts(segment.words, segment.text, duration);
		segment.words.forEach((word, index) => {
			word.time = starts[index] ?? 0;
		});
		this.#setCueTimes(segment);
		this.#recompute(segment.utterance);
	}

	setAlignment(segmentId: number, words: AlignmentWord[]): void {
		const segment = this.#segments.get(segmentId);
		if (!segment || segment.duration === undefined) return;
		const starts = alignedStarts(segment.words, words, segment.duration);
		if (!starts) return;
		segment.words.forEach((word, index) => {
			word.time = starts[index] ?? word.time;
		});
		this.#setCueTimes(segment);
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
		this.#activeSource = undefined;
		for (const block of this.#codeBlocks.values()) block.complete = true;
		this.#onChange();
	}

	finishUtterance(utterance: number | undefined): void {
		if (utterance !== undefined && ![...this.#segments.values()].some(segment => segment.utterance === utterance)) return;
		this.finish();
	}

	transform(
		markdown: string,
		type: NarrationMessageType,
		styleUnread: (text: string) => string,
		styleActive: (text: string) => string = text => text,
	): string {
		if (!this.#active || !markdown) return markdown;
		const candidates = this.#blocks.filter(block => block.type === type && block.text.trim() === markdown);
		if (candidates.length === 0) return markdown;
		const block =
			candidates.find(candidate => this.#cursor <= candidate.start + candidate.text.length) ?? candidates[candidates.length - 1];
		const leading = block.text.length - block.text.trimStart().length;
		const blockStart = block.start + leading;
		const localCursor = this.#cursor - blockStart;
		const active = this.#activeSource
			? { start: this.#activeSource.start - blockStart, end: this.#activeSource.end - blockStart }
			: undefined;
		const hasCodeFocus = [...this.#codeBlocks.values()].some(block => !block.complete);
		if (localCursor >= markdown.length && (!active || active.start >= markdown.length || active.end <= 0) && !hasCodeFocus) {
			return markdown;
		}
		if (this.#activeSource && active && active.start < markdown.length && active.end > 0) {
			const segment = [...this.#segments.values()].find(
				candidate =>
					candidate.activeAt !== undefined &&
					candidate.source.start === this.#activeSource?.start &&
					candidate.source.end === this.#activeSource.end,
			);
			if (segment) segment.renderAt ??= performance.now();
		}
		let transformed = styleNarrationMarkdown(markdown, Math.max(0, localCursor), active, styleUnread, styleActive);
		const focused = [...this.#codeBlocks.values()]
			.filter(codeBlock => !codeBlock.complete)
			.sort((left, right) => left.source.start - right.source.start);
		let searchFrom = 0;
		for (const codeBlock of focused) {
			const codeAt = transformed.indexOf(codeBlock.code, searchFrom);
			if (codeAt < 0) continue;
			const styled = styleCodeBlock(codeBlock.code, codeBlock);
			transformed = transformed.slice(0, codeAt) + styled + transformed.slice(codeAt + codeBlock.code.length);
			searchFrom = codeAt + styled.length;
		}
		return transformed;
	}

	get cursor(): number {
		return this.#cursor;
	}

	timingSummary(): string {
		const rows = [...this.#segments.values()]
			.filter(segment => segment.audioAt !== undefined)
			.map(segment => {
				const active = segment.activeAt === undefined ? "n/a" : `${Math.round(segment.activeAt - (segment.audioAt as number))}ms`;
				const render =
					segment.renderAt === undefined || segment.activeAt === undefined
						? "n/a"
						: `${Math.round(segment.renderAt - segment.activeAt)}ms`;
				return `segment ${segment.id}: audio→active=${active}, active→render=${render}, duration=${segment.duration?.toFixed(2) ?? "?"}s`;
			});
		return rows.length > 0 ? rows.join("; ") : "No narrated segment timing is available";
	}

	#codeKey(source: NarrationSourceRange): string {
		return `${source.start}:${source.end}`;
	}

	#setCueTimes(segment: TrackedSegment): void {
		if (segment.duration === undefined) return;
		for (const cue of segment.codeCues) {
			if (cue.offset <= 0) {
				cue.time = 0;
				continue;
			}
			const word = segment.words.find(candidate => candidate.localStart >= cue.offset);
			cue.time = word?.time ?? segment.duration;
		}
		segment.codeCues.sort((left, right) => left.time - right.time || left.offset - right.offset);
	}

	#applyCodeCues(segment: TrackedSegment, relative: number): boolean {
		let changed = false;
		while (
			segment.appliedCodeCues < segment.codeCues.length &&
			(segment.codeCues[segment.appliedCodeCues]?.time ?? Number.POSITIVE_INFINITY) <= relative
		) {
			const cue = segment.codeCues[segment.appliedCodeCues];
			segment.appliedCodeCues += 1;
			const blockSource = segment.code?.blockSource;
			if (!blockSource) continue;
			const block = this.#codeBlocks.get(this.#codeKey(blockSource));
			if (!block || block.complete) continue;
			for (const operation of cue.operations) {
				this.#applyCodeOperation(block, operation);
				changed = true;
			}
		}
		return changed;
	}

	#applyCodeOperation(block: CodeFocusBlock, operation: CodeNarrationOperation): void {
		switch (operation.kind) {
			case "line-add":
				block.lineGroups.set(operation.id, [...(block.lineGroups.get(operation.id) ?? []), operation.range]);
				break;
			case "line-remove":
				block.lineGroups.delete(operation.id);
				break;
			case "bold-add":
				block.boldGroups.set(operation.id, [...(block.boldGroups.get(operation.id) ?? []), operation.range]);
				break;
			case "bold-remove":
				block.boldGroups.delete(operation.id);
				break;
			case "reset":
				block.lineGroups.clear();
				block.boldGroups.clear();
				block.complete = true;
		}
	}

	#recompute(utterance: number): void {
		const playback = this.#playback.get(utterance);
		if (playback === undefined) return;
		let cursor = this.#cursor;
		let activeSource: NarrationSourceRange | undefined;
		let codeChanged = false;
		const segments = [...this.#segments.values()]
			.filter(segment => segment.utterance === utterance && segment.audioStart !== undefined && segment.duration !== undefined)
			.sort((left, right) => (left.audioStart as number) - (right.audioStart as number));
		for (const segment of segments) {
			const relative = playback - (segment.audioStart as number);
			if (relative < 0) break;
			if (relative >= (segment.duration as number)) {
				cursor = Math.max(cursor, segment.source.end);
				codeChanged = this.#applyCodeCues(segment, Number.POSITIVE_INFINITY) || codeChanged;
				continue;
			}
			cursor = Math.max(cursor, segment.source.start);
			codeChanged = this.#applyCodeCues(segment, relative) || codeChanged;
			if (segment.source.end > segment.source.start) {
				activeSource = segment.source;
				segment.activeAt ??= performance.now();
			}
			if (!segment.revealAtEnd) {
				for (const word of segment.words) {
					if (word.time > relative) break;
					cursor = Math.max(cursor, word.end);
				}
			}
			break;
		}
		const activeChanged =
			activeSource?.start !== this.#activeSource?.start || activeSource?.end !== this.#activeSource?.end;
		if (cursor === this.#cursor && !activeChanged && !codeChanged) return;
		this.#cursor = cursor;
		this.#activeSource = activeSource;
		this.#onChange();
	}
}
