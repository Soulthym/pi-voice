import * as nativeTui from "@earendil-works/pi-tui";

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
			node.invalidate?.();
		}
	}
	return true;
}
