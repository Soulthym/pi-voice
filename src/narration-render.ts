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
