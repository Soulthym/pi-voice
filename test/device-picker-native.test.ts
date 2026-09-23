import assert from "node:assert/strict";
import { mock, test } from "node:test";
const native = await import(process.env.PI_VOICE_TEST_TUI_MODULE ?? "@earendil-works/pi-tui");
if (process.env.PI_VOICE_TEST_TUI_MODULE) mock.module("@earendil-works/pi-tui", { namedExports: { ...native } });
const { deviceProgressComponent, attachDeviceFooter } = await import("../src/device-picker-ui.js");
const { deviceProgressLines } = await import("../src/status-text.js");
const { FooterComponent, ExtensionSelectorComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");

test("native SGR input clicks only the existing Unicode badge, preserves rows and opens native selection", t => {
	if (!native.MouseRegion) { t.skip("older dependency: label and Alt+D fallback; run with installed PI_VOICE_TEST_TUI_MODULE for native mouse"); return; }
	const terminal = { columns: 90, rows: 20, write() {}, hideCursor() {} };
	const tui: any = new native.TuiAltScreen(terminal, false);
	tui.altScreenActive = true;
	t.after(() => tui.stopSelectionAutoScroll());
	let opened = 0;
	let chosen: string | undefined;
	const open = () => {
		opened++;
		const selector = new ExtensionSelectorComponent("Voice device", ["1. Local", "2. 手机"], value => { chosen = value; }, () => { chosen = "cancelled"; });
		tui.setFocus(selector);
	};
	const click = (x: number, y: number) => {
		tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}M`);
		tui.handleTerminalInput(`\x1b[<0;${x + 1};${y + 1}m`);
	};
	const transcript = new native.ScrollView({ render: () => Array.from({ length: 100 }, (_, i) => `${i}`), invalidate() {} }, { primary: true, follow: "end" });
	for (const name of ["手机 [a [b]", "👩‍💻 é", "same-prefix-123", ""] ) {
		for (const width of [18, 90]) for (const input of [false, true]) {
			terminal.columns = width;
			const lines = [...(input ? ["🎙 Recording"] : []), "⏯ Paused · sentence", "Word timing: pending"];
			const component = deviceProgressComponent(lines, name, open);
			const rendered = component.render(width);
			assert.deepEqual(rendered, deviceProgressLines(lines, name, width - 2).map(line => ` ${line}`), "mouse adds no rows or styling changes");
			assert.ok(rendered.every(line => native.visibleWidth(line) <= width));
			tui.setLayoutRoot(new native.VStack([{ component: transcript, basis: 0, grow: 1 }, { component, shrink: 0 }]));
			tui.doRender();
			transcript.scrollTo(20, { disableFollow: true }); tui.doRender();
			const top = transcript.scrollTop;
			const before = opened;
			click(0, terminal.rows - rendered.length);
			assert.equal(opened, before, "left padding is not clickable");
			click(native.visibleWidth(rendered[0]) - 1, terminal.rows - rendered.length);
			assert.equal(opened, before + 1, "native terminal dispatcher opens the badge");
			assert.equal(transcript.scrollTop, top, "click does not scroll or classify as manual browse");
			tui.handleTerminalInput("\x1b[B"); tui.handleTerminalInput("\r");
			assert.equal(chosen, "2. 手机", "native arrows and Enter select");
			click(native.visibleWidth(rendered[0]) - 1, terminal.rows - rendered.length);
			tui.handleTerminalInput("\x1b");
			assert.equal(chosen, "cancelled", "native Escape cancels");
		}
	}
	terminal.columns = 150;
	const text = "Voice · ready · Alt+D devices [手机  [name]]";
	const footer = new FooterComponent({ state: {}, sessionManager: { getEntries: () => [], getCwd: () => "/tmp", getSessionName: () => undefined }, getContextUsage: () => undefined } as any,
		{ getGitBranch: () => undefined, getExtensionStatuses: () => new Map([["other", "Other status"], ["pi-voice", text]]), getAvailableProviderCount: () => 0 } as any);
	const root = new native.VStack([{ component: transcript, basis: 0, grow: 1 }, { component: footer, shrink: 0 }]);
	tui.setLayoutRoot(root);
	const baseline = footer.render(terminal.columns);
	const restore = attachDeviceFooter(tui, () => ({ text, badge: "[手机  [name]]" }), open);
	assert.deepEqual(footer.render(terminal.columns), baseline, "built-in footer bytes remain untouched");
	tui.doRender();
	const row = native.stripTerminalSequences(baseline.at(-1)!);
	const count = opened;
	click(native.visibleWidth(row) - 1, terminal.rows - 1);
	assert.equal(opened, count + 1, "real native footer terminal hit path");
	restore();
	click(native.visibleWidth(row) - 1, terminal.rows - 1);
	assert.equal(opened, count + 1, "disposed footer cannot open stale UI");
});
