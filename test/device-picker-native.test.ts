import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mock, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const tuiModule = process.env.PI_VOICE_TEST_TUI_MODULE ?? "@earendil-works/pi-tui";
const native = await import(tuiModule);
if (process.env.PI_VOICE_TEST_TUI_MODULE) mock.module("@earendil-works/pi-tui", { namedExports: { ...native } });
// Resolve the agent beside the selected TUI, not the project's older dev dependency.
const agentModule = process.env.PI_VOICE_TEST_AGENT_MODULE
	?? createRequire(import.meta.resolve(tuiModule)).resolve.paths("@earendil-works/pi-coding-agent")!
		.map(path => join(path, "@earendil-works/pi-coding-agent/dist/index.js")).find(existsSync)!;
const agentURL = agentModule.startsWith("file:") ? agentModule : pathToFileURL(agentModule).href;
const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", agentURL).href);
const { FooterComponent, initTheme } = await import(agentURL);
const themes = await import(new URL("./modes/interactive/theme/theme.js", agentURL).href);
const { getEditorTheme } = themes;
const { deviceProgressComponent, attachDeviceFooter, selectDeviceOverlay } = await import("../src/device-picker-ui.js");
const { deviceProgressLines, deviceFooterText, devicePickerLabels } = await import("../src/status-text.js");
initTheme("dark");

const labels = ["1. Local", "2. 手机 👩‍💻 é"];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const nativeOptions = { skip: !native.MouseRegion && "run with installed PI_VOICE_TEST_TUI_MODULE for fullscreen mouse", timeout: 5000 };

function mounted(t: TestContext, width = 90) {
	const terminal = { columns: width, rows: 24, write() {}, hideCursor() {}, showCursor() {}, stop() {} };
	const tui: any = new native.TuiAltScreen(terminal, false);
	tui.altScreenActive = true;
	// Exercise installed lifecycle methods without constructing a session, loading settings,
	// starting terminal IO, or creating any inference/network-capable runtime.
	const mode: any = Object.create(InteractiveMode.prototype);
	const editor = new native.Editor(tui, getEditorTheme());
	editor.setText("draft 手机");
	Object.assign(mode, { ui: tui, editor, editorContainer: new native.Container(), keybindings: native.getKeybindings() });
	mode.editorContainer.addChild(editor);
	const transcript = new native.ScrollView({ render: () => Array.from({ length: 100 }, (_, i) => `transcript ${i}`), invalidate() {} }, { primary: true, follow: "end" });
	const mount = (component: any) => {
		tui.setLayoutRoot(new native.VStack([
			{ component: transcript, basis: 0, grow: 1 },
			{ component: mode.editorContainer, shrink: 0 },
			{ component, shrink: 0 },
		]));
		tui.doRender();
	};
	tui.setFocus(editor);
	t.after(() => { tui.hideOverlay(); tui.stopSelectionAutoScroll(); tui.stop(); });
	const input = (data: string) => tui.handleTerminalInput(data);
	const click = (x: number, y: number) => {
		input(`\x1b[<0;${x + 1};${y + 1}M`);
		input(`\x1b[<0;${x + 1};${y + 1}m`);
	};
	const screen = (): string[] => {
		tui.doRender();
		return tui.previousScreen.map((line: string) => native.stripTerminalSequences(line));
	};
	const locate = (text: string) => {
		const rows = screen();
		const y = rows.findIndex(line => line.includes(text));
		assert.notEqual(y, -1, `visible on ${width}-column mounted screen: ${text}\n${rows.join("\n")}`);
		return { x: native.visibleWidth(rows[y].slice(0, rows[y].indexOf(text))), y };
	};
	const clickText = (text: string) => { const { x, y } = locate(text); click(x, y); };
	const ctx = { mode: "tui", ui: { theme: themes.theme, onTerminalInput: (handler: any) => tui.addInputListener(handler) } } as any;
	return { tui, mode, editor, transcript, terminal, mount, input, click, screen, locate, clickText, ctx };
}

test("keyboard-only native overlay fallback", async t => {
	const h = mounted(t);
	h.mount(new native.Text("status", 0, 0));
	const controller = new AbortController();
	const result = selectDeviceOverlay(h.ctx, labels, controller.signal, h.tui);
	h.input("\x1b[B");
	h.input("\r");
	assert.equal(await result, labels[1]);
	assert.equal(h.tui.hasOverlay(), false);
	const cancelled = selectDeviceOverlay(h.ctx, labels, controller.signal, h.tui);
	h.input("\x1b");
	assert.equal(await cancelled, undefined);
});

for (const width of [40, 90]) {
	test(`mounted native progress badge and SelectList mouse/keyboard at ${width} columns`, nativeOptions, async t => {
		const h = mounted(t, width);
		let opened = 0;
		let result: Promise<string | undefined> | undefined;
		const controller = new AbortController();
		t.after(() => controller.abort());
		const open = () => { opened++; result = selectDeviceOverlay(h.ctx, labels, controller.signal, h.tui); };
		for (const name of ["手机 [a [b]", "👩‍💻 é", "same-prefix-123", ""]) {
			for (const recording of [false, true]) {
				const lines = [...(recording ? ["🎙 Recording"] : []), "⏯ Paused · sentence", "Word timing: pending"];
				const component = deviceProgressComponent(lines, name, open);
				const rendered = component.render(width);
				assert.deepEqual(rendered, deviceProgressLines(lines, name, width - 2).map(line => ` ${line}`));
				assert.ok(rendered.every(line => native.visibleWidth(line) <= width));
				h.mount(component);
				h.transcript.scrollTo(20, { disableFollow: true });
				h.screen();
				const top = h.transcript.scrollTop;
				const y = h.terminal.rows - rendered.length;
				const before = opened;
				h.click(0, y);
				assert.equal(opened, before, "padding is not a button");
				const badgeX = native.visibleWidth(rendered[0]) - 1;
				h.click(badgeX, y);
				await tick();
				assert.equal(opened, before + 1, "SGR press/release opens exactly once");
				assert.equal(h.transcript.scrollTop, top, "badge click does not browse transcript");
				h.clickText(labels[1]);
				assert.equal(await result, labels[1], "mounted native SelectList option accepts SGR click");
				assert.equal(h.tui.getFocusedComponent(), h.editor);
				assert.equal(h.tui.hasOverlay(), false);
			}
		}
		for (const [keys, expected] of [["\x1b[B\x1b[A\r", labels[0]], ["\x1b[B\r", labels[1]], ["\x1b", undefined]] as const) {
			open();
			await tick();
			h.screen();
			// Send separate terminal key events, not a concatenated synthetic key.
			for (const key of keys.match(/\x1b\[[AB]|\x1b|\r/g)!) h.input(key);
			assert.equal(await result, expected);
			assert.equal(h.tui.getFocusedComponent(), h.editor);
		}
	});

	test(`installed footer keeps Unicode badge visible and clickable at ${width} columns`, nativeOptions, async t => {
		const h = mounted(t, width);
		const name = "手机 👩‍💻 é [name]";
		let opened = 0;
		let result: Promise<string | undefined> | undefined;
		const controller = new AbortController();
		t.after(() => controller.abort());
		let current = deviceFooterText("Voice · ready · af_heart", name, width, "Alt+D devices");
		const status = (available?: number) => {
			if (available !== undefined) current = deviceFooterText("Voice · ready · af_heart", name, available, "Alt+D devices");
			return current;
		};
		const footer = new FooterComponent({ state: {}, sessionManager: { getEntries: () => [], getCwd: () => "/tmp", getSessionName: () => undefined }, getContextUsage: () => undefined } as any,
			{ getGitBranch: () => undefined, getExtensionStatuses: () => new Map([["other", "Other status"], ["pi-voice", status().text]]), getAvailableProviderCount: () => 0 } as any);
		h.mount(footer);
		const restore = attachDeviceFooter(h.tui, status, () => { opened++; result = selectDeviceOverlay(h.ctx, labels, controller.signal, h.tui); });
		t.after(restore);
		h.screen();
		const badge = native.stripTerminalSequences(status().badge).replace(/ +/g, " ");
		assert.match(badge, /手机/);
		const { x, y } = h.locate(badge);
		assert.ok(h.screen().some(line => line.includes("Other status")), "other extension status survives");
		h.click(x + native.visibleWidth(badge) - 1, y);
		await tick();
		assert.equal(opened, 1);
		h.clickText(labels[1]);
		assert.equal(await result, labels[1]);
		assert.equal(h.tui.getFocusedComponent(), h.editor);
		restore();
		h.screen();
		h.click(x, y);
		assert.equal(opened, 1, "disposed footer cannot open stale UI");
	});
}

for (const underlying of ["editor", "prompt", "newer overlay"] as const) {
	for (const pressed of [false, true]) {
		test(`stale picker mouse target cannot steal ${underlying} focus (pressed=${pressed})`, nativeOptions, async t => {
			const h = mounted(t, 40);
			h.mount(new native.Text("status", 0, 0));
			const pending = underlying === "prompt"
				? h.mode.showExtensionSelector("Old prompt", ["Keep", "Other"]) : undefined;
			const controller = new AbortController();
			const result = selectDeviceOverlay(h.ctx, labels, controller.signal, h.tui);
			const { x, y } = h.locate(labels[1]);
			if (pressed) h.input(`\x1b[<0;${x + 1};${y + 1}M`);
			let newerInput = "";
			const newer = { render: () => ["New overlay"], invalidate() {}, handleInput: (data: string) => { newerInput += data; } };
			const handle = underlying === "newer overlay" ? h.tui.showOverlay(newer) : undefined;
			controller.abort();
			// Deliberately no render, tick, or await between abort and stale terminal events.
			if (pressed) h.input(`\x1b[<0;${x + 1};${y + 1}m`);
			else h.click(x, y);
			assert.equal(h.tui.getFocusedComponent(), underlying === "prompt" ? h.mode.extensionSelector : handle ? newer : h.editor);
			h.input("!");
			h.input("\x1b");
			assert.equal(await result, undefined);
			if (pending) {
				assert.equal(await pending, undefined, "Escape still cancels the original prompt");
				assert.equal(h.editor.getText(), "draft 手机");
			} else if (handle) {
				assert.equal(newerInput, "!\x1b");
				handle.hide();
			} else assert.equal(h.editor.getText(), "draft 手机!");
		});
	}
}

for (const name of ["Meeting room laptop speakers", "手机 👩‍💻 é ".repeat(20)]) {
	test(`40-column picker preserves IDs and current owner: ${name.slice(0, 30)}`, nativeOptions, async t => {
		const h = mounted(t, 40);
		h.mount(new native.Text("status", 0, 0));
		const choices = [{ id: "local", name: "Local (host audio)" }, { id: "phone-A", name }, { id: "phone-B", name }];
		const items = devicePickerLabels(choices, "phone-A");
		const result = selectDeviceOverlay(h.ctx, items, new AbortController().signal, h.tui);
		const current = () => {
			const rows = h.screen();
			assert.ok(rows.some(row => row.includes("current (phone-A)")));
			assert.ok(rows.some(row => row.includes("(phone-B)") && !row.includes("current")));
			assert.ok(rows.every(row => native.visibleWidth(row) <= 40));
		};
		current();
		h.input("\x1b[B");
		h.input("\x1b[B"); // Cursor is on B; ownership must stay on A.
		current();
		h.clickText("(phone-B)");
		assert.equal(await result, items[2]);
		const keyboard = selectDeviceOverlay(h.ctx, items, new AbortController().signal, h.tui);
		h.input("\x1b[B");
		h.input("\r");
		assert.equal(await keyboard, items[1]);
	});
}

test("cancelling our overlay never hides a newer overlay", nativeOptions, async t => {
	const h = mounted(t);
	h.mount(new native.Text("status", 0, 0));
	const controller = new AbortController();
	const result = selectDeviceOverlay(h.ctx, labels, controller.signal, h.tui);
	const newer = new native.Text("Other overlay", 0, 0);
	const handle = h.tui.showOverlay(newer);
	controller.abort();
	assert.equal(await result, undefined);
	assert.equal(h.tui.hasOverlay(), true);
	assert.equal(h.tui.getFocusedComponent(), newer);
	handle.hide();
	assert.equal(h.tui.hasOverlay(), false);
	assert.equal(h.tui.getFocusedComponent(), h.editor);
});

test("existing custom overlay is left untouched", nativeOptions, async t => {
	const h = mounted(t);
	h.mount(new native.Text("status", 0, 0));
	let finish!: (value: string) => void;
	const pending = h.mode.showExtensionCustom((_tui: any, _theme: any, _keys: any, done: any) => {
		finish = done;
		return new native.Text("Other extension", 0, 0);
	}, { overlay: true });
	await tick();
	assert.equal(await selectDeviceOverlay(h.ctx, labels, new AbortController().signal, h.tui), undefined);
	finish("finished");
	assert.equal(await pending, "finished");
	assert.equal(h.tui.hasOverlay(), false);
	assert.equal(h.tui.getFocusedComponent(), h.editor);
});

test("newer overlay receives its first input", nativeOptions, async t => {
	const h = mounted(t);
	h.mount(new native.Text("status", 0, 0));
	const result = selectDeviceOverlay(h.ctx, labels, new AbortController().signal, h.tui);
	let input = "";
	const handle = h.tui.showOverlay({ render: () => ["Other overlay"], invalidate() {}, handleInput: (data: string) => { input += data; } });
	await tick(); // Focus loss is resolved before the next terminal event.
	h.input("!");
	assert.equal(await result, undefined);
	assert.equal(input, "!");
	handle.hide();
});

test("height resize cancels instead of selecting an invisible option", nativeOptions, async t => {
	const h = mounted(t);
	h.mount(new native.Text("status", 0, 0));
	const result = selectDeviceOverlay(h.ctx, Array.from({ length: 30 }, (_, i) => `Device ${i}`), new AbortController().signal, h.tui);
	h.terminal.rows = 10;
	h.screen();
	h.input("\x1b[A");
	h.input("\r");
	assert.equal(await result, undefined);
	assert.equal(h.tui.hasOverlay(), false);
});

test("mouse choice revalidates height before a resized screen repaints", nativeOptions, async t => {
	const h = mounted(t);
	h.mount(new native.Text("status", 0, 0));
	const result = selectDeviceOverlay(h.ctx, labels, new AbortController().signal, h.tui);
	const { x, y } = h.locate(labels[1]);
	h.terminal.rows = 10;
	h.click(x, y);
	h.screen();
	assert.equal(await result, undefined);
	assert.equal(h.tui.hasOverlay(), false);
});

test("underlying prompt abort cannot type through the visible picker", nativeOptions, async t => {
	const h = mounted(t);
	h.mount(new native.Text("status", 0, 0));
	const underlying = new AbortController();
	const pending = h.mode.showExtensionSelector("Other prompt", ["Keep"], { signal: underlying.signal });
	const result = selectDeviceOverlay(h.ctx, labels, new AbortController().signal, h.tui);
	underlying.abort();
	// Even input in the same turn must not leak before deferred focus cleanup.
	h.input("!");
	await pending;
	assert.equal(await result, undefined);
	assert.equal(h.tui.hasOverlay(), false);
	assert.equal(h.editor.getText(), "draft 手机");
	assert.equal(h.tui.getFocusedComponent(), h.editor);
});

test("passive overlay cannot allow typing through an expired prompt", nativeOptions, async t => {
	const h = mounted(t);
	h.mount(new native.Text("status", 0, 0));
	const underlying = new AbortController();
	const pending = h.mode.showExtensionSelector("Other prompt", ["Keep"], { signal: underlying.signal });
	const result = selectDeviceOverlay(h.ctx, labels, new AbortController().signal, h.tui);
	const passive = h.tui.showOverlay(new native.Text("Passive", 0, 0), { nonCapturing: true });
	underlying.abort();
	h.input("!");
	await pending;
	assert.equal(await result, undefined);
	assert.equal(h.editor.getText(), "draft 手机");
	passive.hide();
});

test("footer keeps primary activity before optional identity detail and hints", () => {
	for (const activity of ["ready", "blocked", "stopping", "speaking", "listening", "downloading"]) {
		for (const width of [27, 40]) {
			const { text, badge } = deviceFooterText(`Voice · ${activity} · af_heart`, "手机 👩‍💻 é [name]", width, "Alt+D devices");
			assert.ok(native.visibleWidth(text) <= width);
			assert.ok(text.startsWith(`Voice · ${activity}`));
			assert.ok(text.endsWith(badge));
			assert.ok(badge.startsWith("[") && badge.endsWith("]"));
		}
	}
});

for (const kind of ["select", "confirm"] as const) {
	for (const finish of ["click", "escape", "abort"] as const) {
		test(`installed InteractiveMode preserves pending ${kind} when device overlay closes by ${finish}`, nativeOptions, async t => {
			const h = mounted(t, 40);
			const controller = new AbortController();
			const underlyingController = new AbortController();
			t.after(() => { controller.abort(); underlyingController.abort(); });
			let result: Promise<string | undefined> | undefined;
			h.mount(deviceProgressComponent(["⏯ Paused"], "手机", () => { result = selectDeviceOverlay(h.ctx, labels, controller.signal, h.tui); }));
			const pending = kind === "select"
				? h.mode.showExtensionSelector("Underlying selection", ["Keep", "Other"], { signal: underlyingController.signal })
				: h.mode.showExtensionConfirm("Underlying confirmation", "Continue?", { signal: underlyingController.signal });
			let settled = false;
			void pending.then(() => { settled = true; });
			const selector = h.mode.extensionSelector;
			h.clickText("[手机]");
			await tick();
			assert.ok(result, "badge opened production overlay helper");
			assert.equal(h.tui.hasOverlay(), true);
			assert.equal(h.mode.extensionSelector, selector);
			assert.deepEqual(h.mode.editorContainer.children, [selector]);
			assert.equal(settled, false);
			if (finish === "click") h.clickText(labels[1]);
			else if (finish === "escape") h.input("\x1b");
			else controller.abort();
			assert.equal(await result, finish === "click" ? labels[1] : undefined);
			await tick();
			assert.equal(settled, false, "overlay must not resolve or cancel the underlying prompt");
			assert.equal(h.tui.hasOverlay(), false);
			assert.equal(h.tui.getFocusedComponent(), selector, "focus returns to the original prompt");
			assert.deepEqual(h.mode.editorContainer.children, [selector]);
			h.input("\r");
			assert.equal(await pending, kind === "select" ? "Keep" : true);
			assert.equal(h.tui.getFocusedComponent(), h.editor);
			assert.deepEqual(h.mode.editorContainer.children, [h.editor]);
			assert.equal(h.editor.getText(), "draft 手机");
			h.input("!");
			assert.equal(h.editor.getText(), "draft 手机!", "restored editor actually receives terminal input");
		});
	}
}
