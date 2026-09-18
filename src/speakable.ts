/**
 * Adapted from Oh My Pi's MIT-licensed Kokoro vocalizer.
 * Copyright (c) 2025 Mario Zechner and 2025-2026 Can Bölük.
 * See ../THIRD_PARTY_NOTICES.md.
 *
 * Streaming markdown → speakable-segment transform for assistant speech.
 *
 * Sits between the assistant's raw streaming text deltas and the TTS engine,
 * deciding both *what* is worth speaking and *when* a piece of text is ready
 * to synthesize. Three passes:
 *
 * 1. Block pass (per character, stateful): emits fenced code blocks as
 *    description jobs, reads text-like fences and table cells as prose,
 *    strips heading/bullet/blockquote markers (numbered-list markers are spoken
 *    as "1, …"), and retains literal newline/block boundaries.
 * 2. Segmentation (stateful): emits a segment the moment a sentence boundary
 *    appears — no next-sentence confirmation, which is what made the previous
 *    engine-side splitter stall a full sentence behind generation. Clauses and
 *    long unfinished sentences stay buffered; the audio worker handles native
 *    model windows without exposing sentence fragments.
 * 3. Inline normalization (per segment): markdown links speak their label,
 *    bare URLs speak their host, inline-code ticks and emphasis markers are
 *    stripped, multi-directory file paths collapse to their basename, HTML
 *    tags are dropped, and whitespace is collapsed. Segments with no letters
 *    or digits left are not spoken at all.
 *
 * Pure and synchronous — the vocalizer owns timers (idle flush) and the
 * session lifecycle, so this class stays trivially unit-testable.
 */

/** Sentence-ending punctuation, optional closers, then whitespace. */
const SENTENCE_BOUNDARY_RE = /[.!?…]+[)\]"'»”’]*\s/g;
/** Abbreviations whose trailing dot is not a sentence boundary. */
const ABBREVIATION_RE = /(?:^|\s)(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|No)\.$/i;

/** Line-start prefixes that may still grow into a block marker. */
const UNDECIDED_PREFIX_RE = /^(?:#{1,6}|[-*+]|-{2,}|\*{2,}|_{2,}|\d{1,3}|\d{1,3}[.)]|>+|`{1,2}|~{1,2})$/;
/** A whole line that is a horizontal rule (or setext underline) — silence. */
const HR_LINE_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

const IMAGE_RE = /!\[([^\]]*)\]\(([^()]*)\)/g;
const LINK_RE = /\[([^\]]+)\]\(([^()]*)\)/g;
const AUTOLINK_RE = /<(https?:\/\/[^\s>]+)>/g;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()"'\]]+|\bwww\.[\w-]+(?:\.[\w-]+)+[^\s<>()"'\]]*/g;
const INLINE_CODE_RE = /`{1,2}([^`]+)`{1,2}/g;
const BOLD_STRIKE_RE = /\*\*|__|~~/g;
const EMPHASIS_ASTERISK_RE = /\*(?=\S)|(?<=\S)\*/g;
const EMPHASIS_UNDERSCORE_RE = /(^|\s)_+|_+(?=\s|$)/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^<>]*>/g;
const HR_INLINE_RE = /(^|\s)[-*_]{3,}(?=\s|$)/g;
const PATH_RE = /(^|[\s("'`])((?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+){2,}\/?)/g;
const HAS_SPEAKABLE_RE = /[\p{L}\p{N}]/u;
const TEXT_FENCE_LANGUAGES = new Set(["text", "txt", "plain", "plaintext", "md", "markdown", "mdown"]);

export function isTextFenceLanguage(language: string): boolean {
	return TEXT_FENCE_LANGUAGES.has(language.trim().toLowerCase());
}

export interface SpeakableSourceRange {
	start: number;
	end: number;
}

export interface FencedCodeBlock {
	language: string;
	code: string;
}

export type SpeakableItem =
	| { kind: "speech"; text: string; source: SpeakableSourceRange }
	| { kind: "code"; block: FencedCodeBlock; source: SpeakableSourceRange };

/** "https://github.com/foo/bar?x#y" → "github.com". */
function speakableUrl(url: string): string {
	return url
		.replace(/^[a-z][\w+.-]*:\/\//i, "")
		.replace(/^www\./i, "")
		.replace(/[/?#].*$/, "");
}

/**
 * Collapse one raw segment to its speakable form; empty string when nothing
 * in it is worth vocalizing (pure markup, URLs-only, whitespace).
 */
function normalizeSpeakable(raw: string): string {
	const spoken = raw
		.replace(IMAGE_RE, "$1")
		.replace(LINK_RE, "$1")
		.replace(AUTOLINK_RE, (_match, url: string) => speakableUrl(url))
		.replace(BARE_URL_RE, match => speakableUrl(match))
		.replace(INLINE_CODE_RE, "$1")
		.replace(/\s*\|\s*/g, ". ")
		.replace(BOLD_STRIKE_RE, "")
		.replace(EMPHASIS_ASTERISK_RE, "")
		.replace(EMPHASIS_UNDERSCORE_RE, "$1")
		.replace(HTML_TAG_RE, " ")
		.replace(HR_INLINE_RE, "$1")
		.replace(PATH_RE, (_match, lead: string, path: string) => {
			// "packages/coding-agent/src/tts/vocalizer.ts" → "vocalizer.ts".
			const parts = path.split("/").filter(part => part.length > 0);
			return lead + (parts[parts.length - 1] ?? path);
		})
		.replace(/\s+/g, " ")
		.trim();
	return HAS_SPEAKABLE_RE.test(spoken) ? spoken : "";
}

/**
 * Earliest sentence boundary at or past `min` chars; -1 when none. Skips cuts
 * that would strand an unclosed inline-code span or split an abbreviation.
 */
export function findSentenceCut(text: string, min = 0): number {
	SENTENCE_BOUNDARY_RE.lastIndex = 0;
	for (let match = SENTENCE_BOUNDARY_RE.exec(text); match; match = SENTENCE_BOUNDARY_RE.exec(text)) {
		const cut = match.index + match[0].length;
		if (cut < min) continue;
		const head = text.slice(0, cut);
		if (ABBREVIATION_RE.test(head.trimEnd())) continue;
		if ((head.match(/`/g)?.length ?? 0) % 2 !== 0) continue;
		return cut;
	}
	return -1;
}

/** How a line-start prefix resolved. */
type PrefixDecision =
	| { kind: "undecided" }
	| { kind: "prose"; text: string }
	| { kind: "marker"; spoken: string }
	| { kind: "fence"; fence: string };

function classifyPrefix(prefix: string): PrefixDecision {
	if (/^(?:`{3}|~{3})/.test(prefix)) return { kind: "fence", fence: prefix.slice(0, 3) };
	if (/^#{1,6}[ \t]/.test(prefix)) return { kind: "marker", spoken: "" };
	if (/^[-*+][ \t]/.test(prefix)) return { kind: "marker", spoken: "" };
	const numbered = /^(\d{1,3})[.)][ \t]/.exec(prefix);
	if (numbered) return { kind: "marker", spoken: `${numbered[1]}, ` };
	if (/^>+/.test(prefix) && !/^>+$/.test(prefix)) {
		return { kind: "prose", text: prefix.replace(/^>+[ \t]?/, "") };
	}
	if (UNDECIDED_PREFIX_RE.test(prefix)) return { kind: "undecided" };
	return { kind: "prose", text: prefix };
}

/** Block-pass state: where the current character lands. */
type BlockMode = "linestart" | "prose" | "fence-open" | "fence-body";

/**
 * One per utterance. Feed raw assistant deltas through {@link push}; each call
 * returns the segments that became ready to speak. {@link flush} drains the
 * remainder at message end; {@link flushIdle} never forces a mid-sentence cut.
 */
export class SpeakableStream {
	#mode: BlockMode = "linestart";
	/** Pending line-start characters while the block marker is still ambiguous. */
	#prefix = "";
	/** Opening fence marker (``` or ~~~), info string, and streamed body state. */
	#fence = "";
	#fenceInfo = "";
	#fenceLanguage = "";
	#fenceLine = "";
	#fenceLinePositions: number[] = [];
	#fenceBody = "";
	#fenceStart = 0;
	#textFence = false;
	/** Prose accumulator the segmenter cuts from. */
	#buf = "";
	/** Source offset for every transformed character in #buf. */
	#bufPositions: number[] = [];
	#prefixStart = 0;
	#offset = 0;

	/** Consume a raw delta; returns segments now ready to speak, in order. */
	push(delta: string): SpeakableItem[] {
		const out: SpeakableItem[] = [];
		for (const ch of delta) {
			this.#consume(ch, this.#offset, out);
			this.#offset += ch.length;
		}
		this.#extract(out);
		return out;
	}

	/** Message end: drain everything left, including a trailing partial sentence. */
	flush(): SpeakableItem[] {
		const out: SpeakableItem[] = [];
		if (this.#mode === "linestart" && this.#prefix.length > 0 && !HR_LINE_RE.test(this.#prefix)) {
			this.#appendSequential(this.#prefix, this.#prefixStart);
		} else if (this.#mode === "fence-body") {
			if (this.#isClosingFence(this.#fenceLine)) this.#finishFence(out, this.#offset);
			else {
				this.#consumeFenceLine(this.#fenceLine, this.#fenceLinePositions, false, out);
				if (!this.#textFence) this.#finishFence(out, this.#offset);
			}
		}
		this.#prefix = "";
		this.#mode = "linestart";
		this.#drain(out);
		return out;
	}

	/** A stall is not a sentence boundary: leave unfinished prose buffered. */
	flushIdle(): SpeakableItem[] {
		const out: SpeakableItem[] = [];
		this.#extract(out);
		return out;
	}

	#consume(ch: string, offset: number, out: SpeakableItem[]): void {
		switch (this.#mode) {
			case "linestart":
				this.#consumeLineStart(ch, offset, out);
				return;
			case "prose":
				if (ch === "\n") this.#hardBreak(out);
				else this.#append(ch, offset);
				return;
			case "fence-open":
				if (ch === "\n") this.#openFenceBody();
				else this.#fenceInfo += ch;
				return;
			case "fence-body":
				this.#consumeFenceBody(ch, offset, out);
				return;
		}
	}

	#consumeLineStart(ch: string, offset: number, out: SpeakableItem[]): void {
		if (ch === "\n") {
			// The whole line fit in the prefix: an hr/blank line is silence; a
			// short undecided prefix ("Hi.", "OK") was prose all along.
			const line = this.#prefix;
			this.#prefix = "";
			if (line.length > 0 && !HR_LINE_RE.test(line)) this.#appendSequential(line, this.#prefixStart);
			this.#hardBreak(out);
			return;
		}
		if (this.#prefix.length === 0) this.#prefixStart = offset;
		this.#prefix += ch;
		const prefix = this.#prefix;
		const decision = classifyPrefix(prefix);
		if (decision.kind === "undecided") {
			if (prefix.length > 8) {
				this.#appendSequential(prefix, this.#prefixStart);
				this.#prefix = "";
				this.#mode = "prose";
			}
			return;
		}
		this.#prefix = "";
		switch (decision.kind) {
			case "prose": {
				const relative = prefix.lastIndexOf(decision.text);
				this.#appendSequential(decision.text, this.#prefixStart + Math.max(0, relative));
				this.#mode = "prose";
				return;
			}
			case "marker":
				this.#appendSynthetic(decision.spoken, this.#prefixStart, offset + 1);
				this.#mode = "prose";
				return;
			case "fence":
				this.#fence = decision.fence;
				this.#fenceInfo = "";
				this.#fenceStart = this.#prefixStart;
				this.#mode = "fence-open";
				return;
		}
	}

	#openFenceBody(): void {
		this.#fenceLanguage = this.#fenceInfo.trim().toLowerCase().split(/[\s,{]/, 1)[0] ?? "";
		this.#textFence = isTextFenceLanguage(this.#fenceLanguage);
		this.#fenceLine = "";
		this.#fenceLinePositions = [];
		this.#fenceBody = "";
		this.#mode = "fence-body";
	}

	#consumeFenceBody(ch: string, offset: number, out: SpeakableItem[]): void {
		if (ch !== "\n") {
			this.#fenceLine += ch;
			for (let index = 0; index < ch.length; index++) this.#fenceLinePositions.push(offset + index);
			return;
		}
		if (this.#isClosingFence(this.#fenceLine)) this.#finishFence(out, offset + 1);
		else this.#consumeFenceLine(this.#fenceLine, this.#fenceLinePositions, true, out);
		this.#fenceLine = "";
		this.#fenceLinePositions = [];
	}

	#consumeFenceLine(line: string, positions: number[], newline: boolean, out: SpeakableItem[]): void {
		if (this.#textFence) {
			this.#appendWithPositions(line, positions);
			if (newline) this.#drain(out);
		} else {
			this.#fenceBody += line + (newline ? "\n" : "");
		}
	}

	#isClosingFence(line: string): boolean {
		const trimmed = line.trim();
		return trimmed.length >= 3 && [...trimmed].every(character => character === this.#fence[0]);
	}

	#finishFence(out: SpeakableItem[], end: number): void {
		if (!this.#textFence) {
			const code = this.#fenceBody.replace(/\n$/, "");
			if (code.trim()) {
				out.push({
					kind: "code",
					block: { language: this.#fenceLanguage, code },
					source: { start: this.#fenceStart, end },
				});
			}
		}
		this.#fence = "";
		this.#fenceInfo = "";
		this.#fenceLanguage = "";
		this.#fenceLine = "";
		this.#fenceLinePositions = [];
		this.#fenceBody = "";
		this.#textFence = false;
		this.#mode = "linestart";
	}

	/** Confirmed Markdown block boundary: emit buffered prose as one unit. */
	#hardBreak(out: SpeakableItem[]): void {
		this.#mode = "linestart";
		this.#drain(out);
	}

	/** Finish a real newline/message boundary, including its final unterminated unit. */
	#drain(out: SpeakableItem[]): void {
		this.#extract(out);
		const text = this.#buf;
		const positions = this.#bufPositions;
		this.#buf = "";
		this.#bufPositions = [];
		this.#emit(text, positions, out);
	}

	/** Cut ready segments off the front of the buffer (streaming path). */
	#extract(out: SpeakableItem[]): void {
		for (;;) {
			const sentence = findSentenceCut(this.#buf, 0);
			if (sentence === -1) return;
			this.#cut(sentence, out);
		}
	}

	#cut(at: number, out: SpeakableItem[]): void {
		const head = this.#buf.slice(0, at);
		const positions = this.#bufPositions.slice(0, at);
		this.#buf = this.#buf.slice(at);
		this.#bufPositions = this.#bufPositions.slice(at);
		this.#emit(head, positions, out);
	}

	#emit(raw: string, positions: number[], out: SpeakableItem[]): void {
		const spoken = normalizeSpeakable(raw);
		if (!spoken || positions.length === 0) return;
		out.push({
			kind: "speech",
			text: spoken,
			source: { start: positions[0], end: positions[positions.length - 1] + 1 },
		});
	}

	#append(text: string, offset: number): void {
		this.#buf += text;
		for (let index = 0; index < text.length; index += 1) this.#bufPositions.push(offset + index);
	}

	#appendSequential(text: string, offset: number): void {
		this.#append(text, offset);
	}

	#appendSynthetic(text: string, start: number, end: number): void {
		this.#buf += text;
		const span = Math.max(1, end - start);
		for (let index = 0; index < text.length; index += 1) {
			this.#bufPositions.push(start + Math.min(span - 1, Math.floor((index * span) / Math.max(1, text.length))));
		}
	}

	#appendWithPositions(text: string, positions: number[]): void {
		this.#buf += text;
		this.#bufPositions.push(...positions.slice(0, text.length));
	}
}
