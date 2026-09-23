import * as tui from "@earendil-works/pi-tui";
import { deviceBadge, deviceProgressLines } from "./status-text.js";

type MouseEvent = { type: string; button: string; x: number; y: number };
type MouseComponent = tui.Component & { handleMouse?: (event: MouseEvent) => { handled?: boolean } | undefined };
const MouseRegion = (tui as unknown as { MouseRegion?: new (child: tui.Component,
	handler: (event: MouseEvent) => { handled: boolean } | undefined) => MouseComponent }).MouseRegion;

/** Hit-test the complete rendered badge, in terminal columns, never UTF-16 offsets. */
function badgeRegion(child: tui.Component, locate: (lines: string[], width: number) => { row: number; start: number; end: number } | undefined, open: () => void): MouseComponent {
	let hit: ReturnType<typeof locate>;
	const content = {
		render(width: number) { const lines = child.render(width); hit = locate(lines, width); return lines; },
		invalidate() { hit = undefined; child.invalidate(); },
	};
	return MouseRegion ? new MouseRegion(content, event => {
		if (!hit || event.button !== "left" || event.y !== hit.row || event.x < hit.start || event.x >= hit.end) return;
		// Consume the press too: it is a button, not the start of transcript selection.
		if (event.type === "click") open();
		if (["press", "release", "click"].includes(event.type)) return { handled: true };
	}) : content;
}

export function deviceProgressComponent(lines: string[], name: string, open: () => void, hint = ""): tui.Component {
	return badgeRegion({
		render: width => deviceProgressLines(lines, name, Math.max(0, width - 2), hint).map(line => ` ${line}`),
		invalidate() {},
	}, (rows, width) => {
		const row = tui.stripTerminalSequences(rows[0] ?? "");
		const badge = tui.stripTerminalSequences(deviceBadge(name, Math.max(0, width - 2)));
		const end = tui.visibleWidth(row);
		return !row.endsWith(badge) ? undefined : { row: 0, start: end - tui.visibleWidth(badge), end };
	}, open);
}

/** Preserve Pi's built-in footer and other extensions' statuses; add only native mouse handling.
 * Custom/older footers without the standard mounted component keep the keyboard fallback.
 */
export function attachDeviceFooter(tuiRoot: unknown, status: () => { text: string; badge: string } | undefined, open: () => void): () => void {
	if (!MouseRegion) return () => {};
	const root = tuiRoot as { getMountedRoots?: () => unknown[]; children?: unknown[] };
	const pending = [...(root.getMountedRoots?.() ?? root.children ?? [])];
	const seen = new Set<unknown>();
	while (pending.length) {
		const node = pending.pop() as MouseComponent & { children?: unknown[]; child?: unknown };
		if (!node || seen.has(node)) continue;
		seen.add(node);
		if (node.children) pending.push(...node.children);
		if (node.child) pending.push(node.child);
		// ponytail: built-in footer only; use a public footer decorator if Pi adds one.
		if (node.constructor.name !== "FooterComponent") continue;
		const render = node.render;
		const mouse = node.handleMouse;
		const region = badgeRegion({ render: width => render.call(node, width), invalidate() {} }, lines => {
			const current = status();
			if (!current) return;
			// Pi's standard footer collapses spaces in extension statuses.
			const text = tui.stripTerminalSequences(current.text).replace(/ +/g, " ").trim();
			const badge = tui.stripTerminalSequences(current.badge).replace(/ +/g, " ");
			for (let row = 0; row < lines.length; row++) {
				const plain = tui.stripTerminalSequences(lines[row]);
				const at = plain.indexOf(text);
				if (at >= 0) return { row, start: tui.visibleWidth(plain.slice(0, at + text.length - badge.length)), end: tui.visibleWidth(plain.slice(0, at + text.length)) };
			}
		}, open);
		const wrappedRender = (width: number) => region.render(width);
		const wrappedMouse = (event: MouseEvent) => region.handleMouse?.(event) ?? mouse?.call(node, event);
		node.render = wrappedRender;
		node.handleMouse = wrappedMouse;
		return () => {
			if (node.render === wrappedRender) node.render = render;
			if (node.handleMouse === wrappedMouse) node.handleMouse = mouse;
		};
	}
	return () => {};
}
