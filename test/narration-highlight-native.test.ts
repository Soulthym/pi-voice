import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAnsiCode } from "@earendil-works/pi-tui/dist/utils.js";
import { invalidateNarrationMarkdown } from "../src/narration-render.js";
import { NarrationProgress } from "../src/narration-progress.js";
import { PlaybackHistory } from "../src/playback-history.js";

const native = await import(process.env.PI_VOICE_TEST_TUI_MODULE ?? "@earendil-works/pi-tui");
const { AssistantMessageComponent, getMarkdownTheme, initTheme } = await import(
	process.env.PI_VOICE_TEST_AGENT_MODULE ?? "@earendil-works/pi-coding-agent");
initTheme("dark");

// Observe terminal state at visible characters, not just the presence of an
// opening escape which a subsequent native reset may immediately cancel.
function cells(line: string) {
	let dim = false, bold = false, fg = "", bg = "";
	const result: Array<{ char: string; dim: boolean; bold: boolean; fg: string; bg: string }> = [];
	for (let at = 0; at < line.length;) {
		const ansi = extractAnsiCode(line, at);
		if (ansi) {
			if (/^\x1b\[[\d;]*m$/.test(ansi.code)) {
				const codes = ansi.code.slice(2, -1).split(";").map(Number);
				for (let i = 0; i < codes.length; i++) {
					const code = codes[i];
					if (code === 0) { dim = bold = false; fg = bg = ""; }
					else if (code === 1) bold = true;
					else if (code === 2) dim = true;
					else if (code === 22) dim = bold = false;
					else if (code === 39) fg = "";
					else if (code === 49) bg = "";
					else if (code === 38 || code === 48) {
						const size = codes[i + 1] === 2 ? 4 : 2;
						const color = codes.slice(i, i + size + 1).join(";");
						if (code === 38) fg = color; else bg = color;
						i += size;
					} else if (code >= 30 && code <= 37) fg = String(code);
				}
			}
			at += ansi.length;
		} else {
			result.push({ char: line[at++], dim, bold, fg, bg });
		}
	}
	return result;
}

const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const active = (text: string) => `\x1b[48;5;236m${text}\x1b[49m`;

for (const reset of ["\x1b[22m", "\x1b[0m"]) test(`native assistant keeps effective code dimming across ${JSON.stringify(reset)} and child recreation`, () => {
	const code = "// Alpha bravo charlie delta echo foxtrot golf hotel india juliet.\nconst value = 1;";
	const source = `\`\`\`ts\n${code}\n\`\`\``;
	const progress = new NarrationProgress();
	progress.setCompletedText(source);
	progress.registerSegment({ id: 1, utterance: 1, text: "Select value.", source: { start: 0, end: 0 },
		code: { blockSource: { start: 0, end: source.length }, code, language: "ts", cues: [{ offset: 0, operations: [
			{ kind: "line-add", id: "line", range: { startLine: 2, endLine: 2 } },
			{ kind: "bold-add", id: "name", range: { startLine: 2, endLine: 2, startColumn: 7, endColumn: 11 } },
		] }] } });
	progress.setSegmentAudio(1, 0, 10);
	progress.setPlayback(1, 0);
	// Model the native highlighter's initial intensity reset, preserving its
	// syntax foreground. A multiline comment wraps into continuation rows.
	const syntax = (text: string) => text.split("\n").map(line => `${reset}\x1b[32m${line}\x1b[39m`);
	const theme = { ...getMarkdownTheme(), highlightCode: syntax };
	const transform = (text: string) => progress.transform(text, "assistant", dim, active, undefined, true, syntax, progress.activeMarker);
	const assistant = new AssistantMessageComponent(message(source), false, theme, "Thinking...", 1, [transform]);
	const baseline = new AssistantMessageComponent(message(source), false, theme).render(28);
	invalidateNarrationMarkdown({ children: [assistant] }, new Set(progress.sourceTexts));
	const marker = progress.activeMarker;
	for (const phase of ["initial", "streaming", "final", "invalidate"] as const) {
		if (phase === "streaming") assistant.updateContent(message(source), true);
		if (phase === "final") assistant.updateContent(message(source), false);
		if (phase === "invalidate") assistant.invalidate();
		const lines: string[] = assistant.render(28);
		assert.deepEqual(lines.map(native.stripTerminalSequences), baseline.map(native.stripTerminalSequences), phase);
		assert.equal(progress.activeMarker, marker, "native finalization must not reset playback selection");
		const comments = lines.filter(line => /Alpha|echo|juliet/.test(native.stripTerminalSequences(line)));
		assert.ok(comments.length >= 3, "first and continuation comment rows are exercised");
		for (const line of comments) {
			const letters = cells(line).filter(cell => /[A-Za-z]/.test(cell.char));
			assert.ok(letters.every(cell => cell.dim), `${phase}: first/continuation comment must remain dim`);
			assert.ok(letters.every(cell => cell.fg === "32"), "syntax foreground is unchanged");
		}
		const selected = cells(lines.find(line => native.stripTerminalSequences(line).includes("const value"))!);
		const wordAt = selected.map(cell => cell.char).join("").indexOf("value");
		assert.ok(selected.slice(wordAt, wordAt + 5).every(cell => cell.bold && !cell.dim), "selected code word stays bold, not dim");
	}
});

test("native streaming and canonical final prose retain active audio paint without another tick or scroll", () => {
	const progress = new NarrationProgress();
	const history = new PlaybackHistory();
	let source = "Alpha **bravo** charlie delta echo foxtrot golf hotel. Unread sentence continues here.";
	history.beginCapture("live:1", source);
	progress.begin();
	progress.pushDelta("assistant", 0, source);
	progress.registerSegment({ id: 1, utterance: 1, text: source.split(". ")[0] + ".", source: { start: 0, end: source.indexOf(".") + 1 } });
	progress.setSegmentAudio(1, 0, 20);
	progress.setPlayback(1, 0);
	const transform = (text: string) => progress.transform(text, "assistant", dim, active, undefined, true, undefined, progress.activeMarker);
	const theme = { ...getMarkdownTheme(), bold: (text: string) => `\x1b[1m${text}\x1b[0m` };
	const assistant = new AssistantMessageComponent(message(source), false, theme, "Thinking...", 1, [transform]);
	const view = new native.ScrollView(assistant, { primary: true, follow: "end", scrollbar: "hidden" });
	invalidateNarrationMarkdown({ children: [view] }, new Set(progress.sourceTexts));
	const marker = progress.activeMarker;
	view.updateLayout(100, 10, () => {});
	view.scrollTo(30, { disableFollow: true });
	for (const phase of ["streaming", "delta", "final"]) {
		if (phase === "delta") {
			const delta = " More unread words.";
			source += delta;
			progress.pushDelta("assistant", 0, delta);
		}
		if (phase === "final") {
			history.rename("live:1", { id: "persisted-message", text: source });
			assert.equal(history.selected()?.id, "persisted-message");
		}
		assistant.updateContent(message(source), phase !== "final");
		const lines: string[] = assistant.render(28);
		const baseline = new AssistantMessageComponent(message(source), false, theme).render(28);
		assert.deepEqual(lines.map(line => native.stripTerminalSequences(line.replaceAll(marker, ""))), baseline.map(native.stripTerminalSequences));
		assert.equal(view.scrollTop, 30, "manual viewport is untouched by recreation");
		assert.equal(progress.activeMarker, marker);
		assert.equal(lines.filter(line => line.includes(marker)).length, 1);
		for (const word of ["Alpha", "echo"]) {
			const painted = cells(lines.find(line => native.stripTerminalSequences(line).includes(word))!);
			assert.ok(painted.filter(cell => /[A-Za-z]/.test(cell.char)).every(cell => cell.bg === "48;5;236"),
				`${phase}: first and continuation active rows survive native reset 0`);
		}
		const unread = cells(lines.find(line => native.stripTerminalSequences(line).includes("Unread"))!);
		const start = unread.map(cell => cell.char).join("").indexOf("Unread");
		assert.ok(unread.slice(start, start + 6).every(cell => cell.dim));
	}
});
