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

export function computeAutoScrollTop(viewport: ScrollViewportLike, anchorLine: number): number | null {
	const { scrollTop, viewportHeight, contentHeight } = viewport;
	if (viewportHeight <= 0 || contentHeight <= 0) return null;
	const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
	if (maxScrollTop === 0) return null;

	const topBand = Math.floor(viewportHeight * 0.2);
	const bottomBand = Math.ceil(viewportHeight * 0.8);
	const relative = anchorLine - scrollTop;
	if (relative >= topBand && relative <= bottomBand) return null;

	const target = anchorLine - topBand;
	return Math.max(0, Math.min(maxScrollTop, target));
}

/** True when a manual scroll should suspend automatic re-anchoring. */
export function isManualScrollAway(viewport: ScrollViewportLike, lastAnchoredScrollTop: number): boolean {
	return Math.abs(viewport.scrollTop - lastAnchoredScrollTop) > 1;
}
