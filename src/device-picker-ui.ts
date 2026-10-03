import * as tui from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deviceProgressLines } from "./status-text.js";
import type { RankedDevice } from "./device-priorities.js";

type PickerPresentation = { title?: string; footer?: readonly string[] };

/** A capturing overlay leaves Pi's active ExtensionSelector and its promise intact. */
export async function selectDeviceOverlay(ctx: ExtensionContext, labels: string[], signal: AbortSignal, screen?: tui.TUI, initialIndex = 0, presentation: PickerPresentation = {}): Promise<string | undefined> {
	if (signal.aborted) return;
	const title = presentation.title ?? "Voice device · candidates, not audio readiness";
	const footer = presentation.footer ?? ["↑↓ / Enter · click select · Esc cancel"];
	if (ctx.mode !== "tui") {
		// ui.select has no initial-index option; reorder display only, retaining unique values.
		const options = [...labels];
		if (initialIndex > 0 && initialIndex < options.length) options.unshift(...options.splice(initialIndex, 1));
		return ctx.ui.select(presentation.title ?? "Voice device · registered candidates, not audio readiness", options, { signal });
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
		const list = new tui.SelectList(labels.map(value => ({ value, label: value })), Math.max(1, Math.min(labels.length, screen.terminal.rows - 2 - footer.length)), {
			selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
			description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text), noMatch: text => text,
		});
		list.setSelectedIndex(initialIndex);
		list.onSelect = item => done(screen.terminal.rows === rows && screen.terminal.columns === columns ? item.value : undefined);
		list.onCancel = () => done(undefined);
		const cancel = () => done(undefined);
		signal.addEventListener("abort", cancel, { once: true });
		const container = new tui.Container();
		container.addChild({ render: width => [tui.truncateToWidth(title, width)], invalidate() {} });
		container.addChild(list);
		container.addChild({ render: width => footer.map(line => tui.truncateToWidth(line, width)), invalidate() {} });
		const rows = screen.terminal.rows;
		const columns = screen.terminal.columns;
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
				if (screen.terminal.rows !== rows || screen.terminal.columns !== columns) { queueMicrotask(cancel); return []; }
				return render(width);
			},
			handleInput(data: string) { list.handleInput(data); screen.requestRender(); },
		});
		const handle = screen.showOverlay(container, { width: "90%", maxHeight: "100%" });
		const unsubscribe = ctx.ui.onTerminalInput(() => {
			if (!getFocus) return; // Older Pi keeps the keyboard-only overlay fallback.
			const focus = getFocus.call(screen);
			// A prior prompt can time out and focus the editor. Never type through this visible picker.
			if (screen.terminal.rows !== rows || screen.terminal.columns !== columns || (focus !== container && focus !== list)) {
				cancel();
				return { consume: true };
			}
		});
	});
}

export interface DevicePickerSnapshot {
	readonly devices: readonly (RankedDevice & { readonly name: string })[];
	readonly userOrder: readonly string[];
	readonly selectedId?: string;
}
export type DevicePickerAction =
	| { kind: "pin"; id: string | undefined }
	| { kind: "place"; id: string; index: number }
	| { kind: "reset"; id: string };
export interface DevicePickerOptions {
	/** Event-cached immutable snapshot. Replace its identity on ranking/connection changes.
	 * Never enumerate devices or read persistence from this getter. */
	snapshot(): DevicePickerSnapshot;
	/** Optional for selection-only callers. Must fence session/intent and persist before resolving. */
	onAction?(action: DevicePickerAction, snapshot: DevicePickerSnapshot): void | Promise<void>;
}

/** Native SelectLists only: choose a device, then Select / Pin / priority actions.
 * Returns a stable ID, never pins as a side effect of selection. The caller must still
 * revalidate connection generation and prove old-resource stop before switching.
 * Manual selection is temporary: later connection/ranking events may replace it;
 * pinning is the persistent priority-0 override (owned by the caller's pin scope).
 */
export async function selectPriorityDeviceOverlay(ctx: ExtensionContext, options: DevicePickerOptions, signal: AbortSignal, screen?: tui.TUI): Promise<string | undefined> {
	let focusId = options.snapshot().selectedId;
	const getFocus = (screen as (tui.TUI & { getFocusedComponent?: () => tui.Component | null }) | undefined)?.getFocusedComponent;
	const apply = async (action: DevicePickerAction, snapshot: DevicePickerSnapshot) => {
		const previous = getFocus?.call(screen);
		await options.onAction?.(action, snapshot);
		// The menu has closed while persistence runs. Never reclaim an expired prompt's focus.
		return !signal.aborted && previous === getFocus?.call(screen);
	};
	while (!signal.aborted) {
		const snapshot = options.snapshot();
		const labels = snapshot.devices.map((device, index) => `${index + 1}. ${device.priority}${device.id === snapshot.selectedId ? "S" : ""}${device.pinned ? "P" : ""}${device.available ? "" : "!"} (${tui.truncateToWidth(device.id, 12)}) ${device.name}`);
		const choice = await selectDeviceOverlay(ctx, labels, signal, screen,
			Math.max(0, snapshot.devices.findIndex(device => device.id === focusId)), {
				title: "Devices · ! offline",
				footer: ["Enter/click: actions · Esc: close", "S selected · P pinned", "-1 local fallback"],
			});
		if (signal.aborted || choice === undefined) return;
		if (options.snapshot() !== snapshot) continue; // A stale click cannot select/reorder a replacement row.
		const device = snapshot.devices[labels.indexOf(choice)];
		if (!device) return;
		focusId = device.id;
		const actions: { label: string; action?: DevicePickerAction; select?: true; priority?: true }[] = [];
		if (device.available) actions.push({ label: "Select (temporary)", select: true });
		if (options.onAction) {
			actions.push({ label: device.pinned ? "Unpin" : "Pin (priority 0)", action: { kind: "pin", id: device.pinned ? undefined : device.id } });
			const index = snapshot.userOrder.indexOf(device.id);
			if (index > 0 || index < 0) actions.push({ label: index < 0 ? "Promote to manual order" : "Move up", action: { kind: "place", id: device.id, index: index < 0 ? snapshot.userOrder.length : index - 1 } });
			if (index >= 0 && index < snapshot.userOrder.length - 1) actions.push({ label: "Move down", action: { kind: "place", id: device.id, index: index + 1 } });
			actions.push({ label: "Set priority…", priority: true });
			if (device.manual) actions.push({ label: "Reset priority to automatic", action: { kind: "reset", id: device.id } });
		}
		actions.push({ label: "Back" });
		const selected = await selectDeviceOverlay(ctx, actions.map(action => action.label), signal, screen, 0, {
			title: `${device.id}${device.available ? "" : " · offline (cannot select)"}`,
			footer: ["Select is temporary; pin persists", "Reset: automatic; pin unchanged"],
		});
		if (signal.aborted || selected === undefined) return;
		if (options.snapshot() !== snapshot) continue;
		const action = actions.find(action => action.label === selected);
		if (action?.select) return device.id;
		if (action?.priority) {
			// Explicit slots are the manual prefix; automatic devices always follow it.
			const count = snapshot.userOrder.length + (device.manual ? 0 : 1);
			const positions = Array.from({ length: count }, (_, index) => `Priority ${index + 1}`);
			const position = await selectDeviceOverlay(ctx, positions, signal, screen,
				Math.max(0, snapshot.userOrder.indexOf(device.id)), {
					title: `Priority · ${device.id}`,
					footer: ["Manual prefix, then automatic", "↑↓ / Enter · click · Esc close"],
				});
			if (signal.aborted || position === undefined) return;
			if (options.snapshot() !== snapshot) continue;
			if (!await apply({ kind: "place", id: device.id, index: positions.indexOf(position) }, snapshot)) return;
		} else if (action?.action && !await apply(action.action, snapshot)) return;
	}
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
	}, rows => {
		const row = tui.stripTerminalSequences(rows[0] ?? "");
		const at = row.indexOf("[🎧:");
		return at < 0 || !row.endsWith("]") ? undefined : { row: 0, start: tui.visibleWidth(row.slice(0, at)), end: tui.visibleWidth(row) };
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
