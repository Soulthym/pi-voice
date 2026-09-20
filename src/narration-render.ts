import * as nativeTui from "@earendil-works/pi-tui";
import { randomBytes } from "node:crypto";
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

type Glyph = { text: string; start: number; end: number; paints: number[]; prefix: boolean; controls: string[] };

/** Native ANSI/grapheme parsing; source offsets remain UTF-16, never columns. */
function layoutGlyphs(lines: string[], layout: Layout, probe: boolean): Glyph[][] {
	const active = new Set<number>();
	return lines.map(line => {
		const glyphs: Glyph[] = [];
		const prefixWidth = nativeTui.visibleWidth(nativeTui.stripTerminalSequences(line).match(/^[ \t]*(?:│[ \t]+)*/u)?.[0] ?? "");
		let column = 0;
		let controls: string[] = [];
		for (let at = 0; at < line.length;) {
			const ansi = extractAnsiCode(line, at);
			if (ansi) {
				if (probe && ansi.code.startsWith(layout.prefix)) {
					const tag = ansi.code.slice(layout.prefix.length, -1);
					const id = Number(tag.slice(0, -1));
					if (tag.endsWith("+")) active.add(id);
					else active.delete(id);
				}
				if (!probe && ansi.code[1] !== "[" && !ansi.code.startsWith("\x1b]8;")) controls.push(ansi.code);
				at += ansi.length;
				continue;
			}
			const end = line.indexOf("\x1b", at);
			const text = line.slice(at, end < 0 ? line.length : end);
			for (const { segment } of getGraphemeSegmenter().segment(text)) {
				const width = nativeTui.visibleWidth(segment);
				if (width) {
					const prefix = column < prefixWidth;
					glyphs.push({ text: segment, start: column, end: column + width, prefix, controls,
						paints: probe && !prefix ? [...active] : [] });
					controls = [];
				}
				column += width;
			}
			at += text.length || 1;
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
		const inheritedControls: string[] = [];
		let scannedGlyph = 0;
		const renderRange = (start: number, end: number, depth: number): string => {
			let output = "";
			for (let i = start; i < end;) {
				const id = row[i].paints[depth];
				let next = i + 1;
				while (next < end && row[next].paints[depth] === id && (id !== undefined || next !== markerIndex)) next++;
				if (id !== undefined) output += layout.paints[id](renderRange(i, next, depth + 1));
				else {
					const first = row[i];
					const length = row[next - 1].end - first.start;
					let text = nativeTui.sliceByColumn(lines[lineIndex], first.start, length);
					// Native slices inherit all earlier escapes. Inherit styles/links,
					// not copied APCs or other one-shot controls from previous glyphs.
					while (scannedGlyph < i) inheritedControls.push(...row[scannedGlyph++].controls);
					for (const code of inheritedControls) text = text.replace(code, "");
					output += (i === markerIndex ? layout.marker : "") + text;
				}
				i = next;
			}
			return output;
		};
		return renderRange(0, row.length, 0) || lines[lineIndex];
	});
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
// One current target only: never keep a second rendered copy of transcript history.
let baselineCache: { leaf: MarkdownLeaf; text: string; width: number; lines: string[];
	projection?: { probe: string; rows: Glyph[][] } } | undefined;

/** Attach post-wrap narration paint to a native Markdown instance. */
export function withNarrationLayout<T extends nativeTui.Component>(component: T): T {
	if (wrapped.has(component)) return component;
	const leaf = component as unknown as MarkdownLeaf;
	if (typeof leaf.text !== "string" || !leaf.options || typeof leaf.paddingX !== "number") return component;
	wrapped.add(component);
	const render = leaf.render.bind(leaf);
	const invalidate = leaf.invalidate.bind(leaf);
	leaf.invalidate = () => {
		if (baselineCache?.leaf === leaf) baselineCache = undefined;
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
		try {
			leaf.options.transform = () => text;
			if (layout && baselineCache?.leaf === leaf && baselineCache.text === text && baselineCache.width === width) {
				lines = baselineCache.lines;
			} else {
				lines = render(width);
				if (layout) baselineCache = { leaf, text, width, lines };
			}
		} finally { leaf.options.transform = transform; }
		if (layout) {
			// Reached words keep stable source tags; only their paint callbacks and
			// the timed-word tag change. Do not reparse native Markdown on every tick.
			const probeText = layout.marker ? layout.probe.replace(layout.marker, "") : layout.probe;
			let projection = baselineCache?.projection;
			if (!projection || projection.probe !== probeText) {
				const NativeMarkdown = leaf.constructor as typeof nativeTui.Markdown;
				const probe = renderProbe(new NativeMarkdown(probeText, leaf.paddingX, leaf.paddingY,
					{ ...leaf.theme, highlightCode: code => code.split("\n") },
					leaf.defaultTextStyle, { ...leaf.options, transform: undefined }), layout, width);
				projection = { probe: probeText, rows: projectLayout(lines, probe, layout) };
				if (baselineCache) baselineCache.projection = projection;
			}
			lines = paintLayout(lines, projection.rows, layout);
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
			const baseline = baselineCache;
			node.invalidate?.();
			baselineCache = baseline;
		}
	}
	return true;
}
