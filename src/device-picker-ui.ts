import * as tui from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deviceBadge, deviceProgressLines } from "./status-text.js";

/** A capturing overlay leaves Pi's active ExtensionSelector and its promise intact. */
export async function selectDeviceOverlay(ctx: ExtensionContext, labels: string[], signal: AbortSignal, screen?: tui.TUI, initialIndex = 0): Promise<string | undefined> {
	if (signal.aborted) return;
	if (ctx.mode !== "tui") {
		// ui.select has no initial-index option; reorder display only, retaining unique values.
		const options = [...labels];
		if (initialIndex > 0 && initialIndex < options.length) options.unshift(...options.splice(initialIndex, 1));
		return ctx.ui.select("Voice device · registered candidates, not audio readiness", options, { signal });
	}
	// Pi custom overlays close the topmost entry, so never stack above somebody else's overlay.
	if (!screen || screen.hasOverlay()) return;
	const theme = ctx.ui.theme;
	return new Promise(resolve => {
		let closed = false;
		const done = (value: string | undefined) => {
			if (closed) return;
			closed = true;
			// Native mouse layouts (and an in-flight press target) survive hide until paint.
			// Retire both targets without requesting focus, even when a stale SGR click arrives.
			Object.assign(container, { handleMouse: () => ({ handled: true }) });
			Object.assign(list, { handleMouse: () => ({ handled: true }) });
			handle.hide(); // Hide this overlay, never Pi custom()'s topmost overlay.
			signal.removeEventListener("abort", cancel);
			unsubscribe();
			resolve(value);
		};
		const list = new tui.SelectList(labels.map(value => ({ value, label: value })), Math.max(1, Math.min(labels.length, screen.terminal.rows - 3)), {
			selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
			description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text), noMatch: text => text,
		});
		list.setSelectedIndex(initialIndex);
		list.onSelect = item => done(screen.terminal.rows === rows ? item.value : undefined);
		list.onCancel = () => done(undefined);
		const cancel = () => done(undefined);
		signal.addEventListener("abort", cancel, { once: true });
		const container = new tui.Container();
		container.addChild({ render: width => [tui.truncateToWidth("Voice device · candidates, not audio readiness", width)], invalidate() {} });
		container.addChild(list);
		container.addChild({ render: width => [tui.truncateToWidth("↑↓ / Enter · click select · Esc cancel", width)], invalidate() {} });
		const rows = screen.terminal.rows;
		const getFocus = (screen as tui.TUI & { getFocusedComponent?: () => tui.Component | null }).getFocusedComponent;
		let focused = false;
		Object.defineProperty(container, "focused", {
			get: () => focused,
			set(value: boolean) {
				focused = value;
				if (!value) queueMicrotask(() => {
					const target = getFocus?.call(screen);
					if (target !== container && target !== list) cancel();
				});
			},
		});
		const render = container.render.bind(container);
		// Keep the real container so native layout discovers the SelectList mouse target.
		Object.assign(container, {
			render(width: number) {
				// Reopen after height changes rather than allowing Enter on an offscreen item.
				if (screen.terminal.rows !== rows) { queueMicrotask(cancel); return []; }
				return render(width);
			},
			handleInput(data: string) { list.handleInput(data); screen.requestRender(); },
		});
		const handle = screen.showOverlay(container, { width: "90%", maxHeight: "100%" });
		const unsubscribe = ctx.ui.onTerminalInput(() => {
			if (!getFocus) return; // Older Pi keeps the keyboard-only overlay fallback.
			const focus = getFocus.call(screen);
			// A prior prompt can time out and focus the editor. Never type through this visible picker.
			if (screen.terminal.rows !== rows || (focus !== container && focus !== list)) {
				cancel();
				return { consume: true };
			}
		});
	});
}

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

export function deviceProgressComponent(lines: string[], name: string, open: () => void) {
	const component = badgeRegion({
		render: width => deviceProgressLines(lines, name, Math.max(0, width - 1)).map(line => ` ${line}`),
		invalidate() {},
	}, (rows, width) => {
		const row = tui.stripTerminalSequences(rows[0] ?? "");
		const badge = tui.stripTerminalSequences(deviceBadge(name, Math.max(0, width - 1)));
		const end = tui.visibleWidth(row);
		return !badge || !row.endsWith(badge) ? undefined : { row: 0, start: end - tui.visibleWidth(badge), end };
	}, open);
	return Object.assign(component, { update(nextLines: string[], nextName: string) {
		lines = nextLines;
		name = nextName;
		component.invalidate();
	} });
}

/** Preserve Pi's built-in footer and other extensions' statuses; add only native mouse handling.
 * Custom/older footers without the standard mounted component keep the keyboard fallback.
 */
export function attachDeviceFooter(tuiRoot: unknown, status: (width?: number) => { text: string; badge: string } | undefined, open: () => void): () => void {
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
		let current: ReturnType<typeof status>;
		const region = badgeRegion({ render: width => {
			current = status();
			if (current) {
				const text = tui.stripTerminalSequences(current.text).replace(/ +/g, " ").trim();
				const row = render.call(node, 10000).map(tui.stripTerminalSequences).find(line => line.includes(text));
				if (row) current = status(Math.max(2, width - tui.visibleWidth(row) + tui.visibleWidth(text)));
			}
			return render.call(node, width);
		}, invalidate() {} }, lines => {
			if (!current?.badge) return;
			// Pi's standard footer collapses spaces in extension statuses.
			const text = tui.stripTerminalSequences(current.text).replace(/ +/g, " ").trim();
			const badge = tui.stripTerminalSequences(current.badge).replace(/ +/g, " ");
			for (let row = 0; row < lines.length; row++) {
				const plain = tui.stripTerminalSequences(lines[row]);
				const at = plain.indexOf(text);
				const badgeAt = text.indexOf(badge);
				if (at >= 0 && badgeAt >= 0) return { row, start: tui.visibleWidth(plain.slice(0, at + badgeAt)), end: tui.visibleWidth(plain.slice(0, at + badgeAt + badge.length)) };
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
