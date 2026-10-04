/**
 * Narration auto-scroll band mathematics.
 *
 * Positions are measured from the top (0% … 100% of visible lines). While
 * narration plays, the active highlight should stay inside the 20–80 % band;
 * whenever it leaves, the view re-anchors it at the 20 % mark. Returns the new
 * absolute scrollTop, or null when no scroll is needed.
 */
export interface ScrollViewportLike {
	scrollTop: number;
	viewportHeight: number;
	contentHeight: number;
}

export function computeAutoScrollTop(viewport: ScrollViewportLike, anchorLine: number, start = false): number | null {
	const { scrollTop, viewportHeight, contentHeight } = viewport;
	if (viewportHeight <= 0 || contentHeight <= 0) return null;
	const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
	if (maxScrollTop === 0) return null;

	const topBand = Math.floor(viewportHeight * 0.2);
	const bottomBand = Math.ceil(viewportHeight * 0.8);
	const relative = anchorLine - scrollTop;
	if (!start && relative >= topBand && relative <= bottomBand) return null;

	const target = anchorLine - topBand;
	return Math.max(0, Math.min(maxScrollTop, target));
}

/** The native frame already contains wrapped glyph rows and their absolute boxes. */
export interface NarrationLayoutBox {
	component?: NarrationComponent;
	rect: { width: number };
	children: NarrationLayoutBox[];
	scrollView?: object;
	scrollContentLines?: string[];
}

export function narrationScrollBox(box: NarrationLayoutBox, view: object): NarrationLayoutBox | undefined {
	if (box.scrollView === view) return box;
	// Do not walk the entire history inside unrelated scroll views.
	if (box.scrollView) return undefined;
	for (const child of box.children) {
		const found = narrationScrollBox(child, view);
		if (found) return found;
	}
	return undefined;
}

type NarrationComponent = { text?: string; cachedLines?: string[]; children?: NarrationComponent[]; child?: NarrationComponent };

/** Missing timing/projection: use the mounted source's current native rows, not a guessed fraction. */
export function narrationSourceLine(box: NarrationLayoutBox, text: string): number | undefined {
	text = text.trim();
	const pending = box.component ? [box.component] : [];
	const visited = new Set<NarrationComponent>();
	while (pending.length) {
		const component = pending.pop()!;
		if (visited.has(component)) continue;
		visited.add(component);
		if (text && component.text?.trim() === text && component.cachedLines?.length) {
			const rows = component.cachedLines;
			const lines = box.scrollContentLines ?? [];
			// ponytail: markerless fallback scans rows; native source maps would remove this conservative lookup.
			const matches = (at: number) => rows.every((row, i) => lines[at + i]?.includes(row));
			const at = lines.findIndex((_, i) => matches(i));
			// Identical repeated sources are ambiguous without the exact word marker.
			if (at >= 0 && !lines.some((_, i) => i > at && matches(i))) return at;
		}
		if (component.children) pending.push(...component.children);
		if (component.child) pending.push(component.child);
	}
	return undefined;
}

/** True when the viewport moved independently from the last automatic anchor. */
export function isManualScrollAway(viewport: ScrollViewportLike, lastAnchoredScrollTop: number): boolean {
	return viewport.scrollTop !== lastAnchoredScrollTop;
}

/**
 * Absolute rendered line of the spoken position within a message whose top
 * sits at `messageTopLine` and that renders as `messageLines` lines.
 */
export function anchorLineForMessage(
	messageTopLine: number,
	messageLines: number,
	fraction: number,
): number {
	const clamped = Math.min(1, Math.max(0, fraction));
	const lines = Math.max(0, messageLines);
	return messageTopLine + Math.floor(clamped * lines);
}
