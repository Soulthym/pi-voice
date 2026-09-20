import * as nativeTui from "@earendil-works/pi-tui";
import { randomBytes } from "node:crypto";
import { Marked } from "marked";
import { extractAnsiCode, getGraphemeSegmenter } from "@earendil-works/pi-tui/dist/utils.js";

type Paint = (text: string) => string;
type Layout = { probe: string; marker: string; paints: Paint[]; prefix: string };
let capture: ((layout: Layout) => void) | undefined;
const paintPrefix = `\x1b_voice-paint-${randomBytes(12).toString("hex")}:`;

/** Consumed synchronously by the transform of the Markdown leaf being rendered. */
export function narrationLayoutCapture(): typeof capture {
	const current = capture;
	capture = undefined;
	return current;
}

export function narrationLayoutPlan(
	marker: string,
	probe: (tag: (paint: Paint, text: string) => string) => string,
): Layout {
	const paints: Paint[] = [];
	const prefix = paintPrefix;
	return { marker, paints, prefix, probe: probe((paint, text) => {
		const id = paints.push(paint) - 1;
		return `${prefix}${id}+\x07${text}${prefix}${id}-\x07`;
	}) };
}

type Glyph = { text: string; start: number; end: number; paints: number[]; prefix: boolean; inherited: string };

/** Native ANSI/grapheme parsing; source offsets remain UTF-16, never columns. */
function layoutGlyphs(lines: string[], layout: Layout, probe: boolean): Glyph[][] {
	const active = new Set<number>();
	return lines.map(line => {
		const glyphs: Glyph[] = [];
		const prefixWidth = nativeTui.visibleWidth(nativeTui.stripTerminalSequences(line).match(/^[ \t]*(?:│[ \t]+)*/u)?.[0] ?? "");
		let column = 0;
		let text = "";
		const states: Array<{ at: number; paints: number[] }> = [];
		const positions: number[] = [];
		const inherited: string[] = [];
		let styles = "";
		let boundary = 0;
		let boundaryStyles = "";
		for (let at = 0; at < line.length;) {
			const ansi = extractAnsiCode(line, at);
			if (ansi) {
				if (probe && ansi.code.startsWith(layout.prefix)) {
					const tag = ansi.code.slice(layout.prefix.length, -1);
					const id = Number(tag.slice(0, -1));
					if (tag.endsWith("+")) active.add(id);
					else active.delete(id);
				}
				if (/^\x1b\[[\d;:]*m$/.test(ansi.code) || ansi.code.startsWith("\x1b]8;")) styles += ansi.code;
				at += ansi.length;
				continue;
			}
			const end = line.indexOf("\x1b", at);
			const part = line.slice(at, end < 0 ? line.length : end);
			states.push({ at: text.length, paints: [...active] });
			for (let i = 0; i < part.length; i++) {
				positions.push(i === 0 ? boundary : at + i);
				inherited.push(i === 0 ? boundaryStyles : styles);
			}
			text += part;
			at += part.length || 1;
			boundary = at;
			boundaryStyles = styles;
		}
		// Segment the complete visible row: ANSI/tag boundaries are not grapheme
		// boundaries (notably for Indic conjuncts, combining marks and emoji ZWJ).
		let state = 0;
		for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
			while (state + 1 < states.length && states[state + 1].at <= index) state++;
			const width = nativeTui.visibleWidth(segment);
			const prefix = column < prefixWidth;
			const paints = new Set(states[state].paints);
			for (let next = state + 1; next < states.length && states[next].at < index + segment.length; next++) {
				for (const id of states[next].paints) paints.add(id);
			}
			glyphs.push({ text: segment, start: positions[index], end: positions[index + segment.length] ?? line.length,
				prefix, inherited: inherited[index], paints: probe && !prefix ? [...paints] : [] });
			column += width;
		}
		return glyphs;
	});
}

/** Project paint onto immutable native rows, not the probe's potentially different wraps. */
function projectLayout(lines: string[], probe: string[], layout: Layout): Glyph[][] {
	const source = layoutGlyphs(probe, layout, true).flat().filter(glyph => !glyph.prefix && !/^\s+$/u.test(glyph.text));
	const rows = layoutGlyphs(lines, layout, false);
	let index = 0;
	for (const row of rows) for (const glyph of row) {
		if (glyph.prefix || /^\s+$/u.test(glyph.text)) continue;
		const mapped = source[index++];
		// Native constructs (e.g. math) can replace source text. Never discard or
		// shift baseline glyphs on a mapping mismatch.
		if (!mapped || mapped.text !== glyph.text) throw new Error("Narration layout probe changed native glyphs");
		glyph.paints = mapped.paints;
	}
	if (index !== source.length) throw new Error("Narration layout probe added native glyphs");
	for (const row of rows) {
		// Only whitespace between two glyphs of the SAME source span is painted.
		// Continuation indentation, blank rows and trailing padding are excluded.
		for (let i = 0; i < row.length;) {
			if (!/^\s+$/u.test(row[i].text)) { i++; continue; }
			const start = i;
			while (i < row.length && /^\s+$/u.test(row[i].text)) i++;
			const common = (row[start - 1]?.paints ?? []).filter(id => row[i]?.paints.includes(id));
			for (let j = start; j < i; j++) row[j].paints = common;
		}
	}
	return rows;
}

function paintLayout(lines: string[], rows: Glyph[][], layout: Layout): string[] {
	const markerAt = layout.marker ? layout.probe.indexOf(layout.marker) : -1;
	const markerTag = markerAt < 0 ? -1 : layout.probe.indexOf(layout.prefix, markerAt + layout.marker.length);
	const markerId = markerTag < 0 ? -1 : Number.parseInt(layout.probe.slice(markerTag + layout.prefix.length), 10);
	let marked = false;
	return rows.map((row, lineIndex) => {
		const markerIndex = marked || markerId < 0 ? -1 : row.findIndex(glyph => glyph.paints.includes(markerId));
		if (markerIndex >= 0) marked = true;
		const renderRange = (start: number, end: number, depth: number): string => {
			let output = "";
			for (let i = start; i < end;) {
				const id = row[i].paints[depth];
				let next = i + 1;
				while (next < end && row[next].paints[depth] === id && (id !== undefined || next !== markerIndex)) next++;
				if (id !== undefined) output += layout.paints[id](renderRange(i, next, depth + 1));
				else {
					const first = row[i];
					// Slice original UTF-16 bytes at whole-grapheme boundaries. Native
					// column slicing measures ANSI-delimited runs, which can split emoji.
					const text = first.inherited + lines[lineIndex].slice(first.start, row[next - 1].end);
					output += (i === markerIndex ? layout.marker : "") + text;
				}
				i = next;
			}
			return output;
		};
		return renderRange(0, row.length, 0) || lines[lineIndex];
	});
}

/** Shortcut/collapsed reference identity must not include the inserted paint tags. */
function explicitProbeReferences(probe: string, layout: Layout): string {
	const tags = new RegExp(`${layout.prefix}\\d+[+-]\\x07`, "y");
	const positions: number[] = [];
	let clean = "";
	for (let at = 0; at < probe.length;) {
		tags.lastIndex = at;
		const tag = tags.exec(probe);
		if (tag?.index === at) at += tag[0].length;
		else { positions.push(at); clean += probe[at++]; }
	}
	const parser = new Marked();
	const insertions = new Map<number, string>();
	parser.walkTokens(parser.lexer(clean), token => {
		if (token.type !== "link") return;
		const label = `[${token.text}]`;
		if (token.raw !== label && token.raw !== `${label}[]`) return;
		for (let at = clean.indexOf(token.raw); at >= 0; at = clean.indexOf(token.raw, at + token.raw.length)) {
			if (!probe.slice(positions[at], positions[at + token.raw.length - 1] + 1).includes(layout.prefix)) continue;
			insertions.set(positions[at + token.raw.length - 1] + (token.raw === label ? 1 : 0),
				token.raw === label ? label : token.text);
		}
	});
	for (const [at, text] of [...insertions].sort(([a], [b]) => b - a)) {
		probe = probe.slice(0, at) + text + probe.slice(at);
	}
	return probe;
}

/** Native math replaces source glyphs; keep it atomic rather than feeding tags to LaTeX. */
function renderProbe(markdown: nativeTui.Markdown, layout: Layout, width: number): string[] {
	type Token = { type: string; raw?: string; text?: string };
	const native = markdown as unknown as {
		renderInlineTokens(tokens: Token[], context?: unknown): string;
		renderToken(token: Token, ...args: unknown[]): string[];
	};
	const tags = new RegExp(`${layout.prefix}\\d+[+-]\\x07`, "g");
	const math = (token: Token, render: (clean: Token) => string[]): string[] => {
		const codes = [...(token.raw ?? token.text ?? "").matchAll(tags)].map(match => match[0]);
		const lines = render({ ...token, raw: token.raw?.replace(tags, ""), text: token.text?.replace(tags, "") });
		// ponytail: a native formula is one source atom; finer math-word anchors
		// require source maps from Pi's LaTeX renderer, not guessed terminal columns.
		if (lines.length) {
			lines[0] = codes.filter(code => code.endsWith("+\x07")).join("") + lines[0];
			lines[lines.length - 1] += codes.filter(code => code.endsWith("-\x07")).join("");
		}
		return lines;
	};
	const inline = native.renderInlineTokens.bind(native);
	native.renderInlineTokens = (tokens, context) => inline(tokens.map(token => token.type === "latex"
		? { type: "text", text: math(token, clean => [inline([clean], context)]).join("\n") } : token), context);
	const block = native.renderToken.bind(native);
	native.renderToken = (token, ...args) => token.type === "latexBlock"
		? math(token, clean => block(clean, ...args)) : block(token, ...args);
	return markdown.render(width);
}

// These fields are native Markdown's existing render/cache hooks. No parser or
// wrapping fork, prototype patch, or mutation of node_modules is involved.
type MarkdownLeaf = nativeTui.Component & {
	text: string; paddingX: number; paddingY: number;
	theme: nativeTui.MarkdownTheme;
	defaultTextStyle?: ConstructorParameters<typeof nativeTui.Markdown>[4];
	options: NonNullable<ConstructorParameters<typeof nativeTui.Markdown>[5]>;
	cachedText?: string; cachedWidth?: number; cachedLines?: string[];
};
const wrapped = new WeakSet<object>();
// Two recent leaves: mounted target plus reusable offscreen lookup, not history.
const baselineCaches = new Map<MarkdownLeaf, { text: string; width: number; lines: string[];
	projection?: { probe: string; rows?: Glyph[][] } }>();

/** Attach post-wrap narration paint to a native Markdown instance. */
export function withNarrationLayout<T extends nativeTui.Component>(component: T): T {
	if (wrapped.has(component)) return component;
	const leaf = component as unknown as MarkdownLeaf;
	if (typeof leaf.text !== "string" || !leaf.options || typeof leaf.paddingX !== "number") return component;
	wrapped.add(component);
	const render = leaf.render.bind(leaf);
	const invalidate = leaf.invalidate.bind(leaf);
	leaf.invalidate = () => {
		baselineCaches.delete(leaf);
		invalidate();
	};
	leaf.render = width => {
		if (leaf.cachedLines && leaf.cachedText === leaf.text && leaf.cachedWidth === width) return leaf.cachedLines;
		const transform = leaf.options.transform;
		if (!transform) return render(width);
		let layout: Layout | undefined;
		const previous = capture;
		capture = value => { layout = value; };
		let text: string;
		try { text = transform(leaf.text, Math.max(1, width - leaf.paddingX * 2)); }
		finally { capture = previous; }
		let lines: string[];
		let baselineCache = baselineCaches.get(leaf);
		try {
			leaf.options.transform = () => text;
			if (layout && baselineCache && baselineCache.text === text && baselineCache.width === width) {
				lines = baselineCache.lines;
			} else {
				lines = render(width);
				if (layout) baselineCache = { text, width, lines };
			}
		} finally { leaf.options.transform = transform; }
		if (layout && baselineCache) {
			baselineCaches.delete(leaf);
			baselineCaches.set(leaf, baselineCache);
			if (baselineCaches.size > 2) baselineCaches.delete(baselineCaches.keys().next().value!);
			// Reached words keep stable source tags; only their paint callbacks and
			// the timed-word tag change. Do not reparse native Markdown on every tick.
			const probeText = layout.marker ? layout.probe.replace(layout.marker, "") : layout.probe;
			let projection = baselineCache?.projection;
			if (!projection || projection.probe !== probeText) {
				projection = { probe: probeText };
				try {
					const NativeMarkdown = leaf.constructor as typeof nativeTui.Markdown;
					const probe = renderProbe(new NativeMarkdown(explicitProbeReferences(probeText, layout), leaf.paddingX, leaf.paddingY,
						{ ...leaf.theme, highlightCode: code => code.split("\n") },
						leaf.defaultTextStyle, { ...leaf.options, transform: undefined }), layout, width);
					projection.rows = projectLayout(lines, probe, layout);
				} catch {
					// Unknown native replacements/grammar must never abort a transcript.
					// Cache the failed projection too; preserve every baseline byte.
				}
				baselineCache.projection = projection;
			}
			if (projection.rows) lines = paintLayout(lines, projection.rows, layout);
		}
		leaf.cachedText = leaf.text;
		leaf.cachedWidth = width;
		leaf.cachedLines = lines;
		return lines;
	};
	return component;
}

/** Native fullscreen click region; regular/older Pi keeps the existing shortcut. */
export function narrationJumpButton(style: (text: string) => string, jump: () => void): nativeTui.Component {
	let columns = 0;
	const label = "[ Jump to voice location ]";
	const child: nativeTui.Component = {
		render(width) {
			columns = Math.min(width, nativeTui.visibleWidth(label));
			return [style(nativeTui.truncateToWidth(label, width))];
		},
		invalidate() {},
	};
	// MouseRegion was added after the minimum supported Pi version. Do not
	// capture raw terminal input or replace the editor to emulate it there.
	const MouseRegion = (nativeTui as unknown as { MouseRegion?: new (
		child: nativeTui.Component,
		handler: (event: { type: string; button: string; x: number; y: number }) => { handled: boolean } | undefined,
	) => nativeTui.Component }).MouseRegion;
	return MouseRegion ? new MouseRegion(child, event => {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0 || event.x < 0 || event.x >= columns) return;
		jump();
		return { handled: true };
	}) : child;
}

/** Playing may follow a clamped tail; a paused narration anchor must stay fixed. */
export function frameNarrationViewport(view: {
	contentHeight?: number;
	viewportHeight: number;
	scrollTo(top: number, options?: { disableFollow?: boolean }): void;
}, top: number, followAtTail = true): void {
	const end = Math.max(0, (view.contentHeight ?? Infinity) - view.viewportHeight);
	view.scrollTo(top, { disableFollow: !followAtTail || top < end });
}

/** Invalidate changed Markdown leaves, not Pi's entire transcript/layout tree. */
export function invalidateNarrationMarkdown(
	tui: unknown,
	sources: ReadonlySet<string>,
	changedCode: ReadonlySet<string> = new Set(),
): boolean {
	const root = tui as { getMountedRoots?: () => unknown[]; children?: unknown[] } | null;
	const roots = root?.getMountedRoots?.() ?? root?.children;
	if (!Array.isArray(roots)) return false; // Older/custom TUIs retain the full-invalidation fallback.
	const pending = [...roots];
	const codes = [...changedCode];
	// Pi joins consecutive thinking blocks with blank lines into one Markdown leaf.
	const blocks = [...sources].filter(Boolean).map(source => `\n\n${source}\n\n`);
	const visited = new Set<unknown>();
	while (pending.length) {
		const value = pending.pop();
		if (!value || typeof value !== "object" || visited.has(value)) continue;
		visited.add(value);
		const node = value as { children?: unknown[]; child?: unknown; text?: unknown; invalidate?: () => void; setText?: unknown };
		if (Array.isArray(node.children)) pending.push(...node.children);
		if (node.child) pending.push(node.child); // Pi wraps expanded thinking in MouseRegion.
		// Pi Markdown stores its source in `text`; Container.invalidate() would also rebuild siblings.
		const text = node.text;
		if (typeof text === "string" && typeof node.setText === "function" &&
			(sources.has(text.trim()) || blocks.some(block => `\n\n${text.trim()}\n\n`.includes(block)) ||
				codes.some(code => text.includes(code)))) {
			withNarrationLayout(node as nativeTui.Component);
			// A narration tick changes paint, not native layout. Other invalidations
			// (theme, resize, source changes) still clear the baseline normally.
			const leaf = node as MarkdownLeaf;
			const baseline = baselineCaches.get(leaf);
			node.invalidate?.();
			if (baseline) baselineCaches.set(leaf, baseline);
		}
	}
	return true;
}
