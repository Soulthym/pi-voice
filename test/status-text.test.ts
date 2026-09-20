import assert from "node:assert/strict";
import test from "node:test";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { notifyVoice, pendingPlaybackTiming, preprocessingStatus, voiceProgressLines } from "../src/status-text.js";

test("check, recovery and processing counters describe targets, not forced alignment or percent", () => {
	assert.equal(preprocessingStatus({ label: "Checking saved timing", processed: 109, total: 605, unit: "checked" }),
		"↺ Checking saved timing · 109/605 targets checked");
	assert.equal(preprocessingStatus({ label: "Recovering speech timing", processed: 109, total: 605, detail: "decoding cached audio: 2" }),
		"↺ Recovering speech timing · 109/605 targets ready · decoding cached audio: 2");
	assert.equal(preprocessingStatus({ label: "Preparing code descriptions", processed: 2, total: 5, unit: "processed" }),
		"↺ Preparing code descriptions · 2/5 targets processed");
	assert.equal(pendingPlaybackTiming(279, 605), "Playback · message 280/605 · timing pending");
	assert.equal(pendingPlaybackTiming(-1, 605), "Playback · current response · timing pending");
});

test("input, playback, descriptions, timing retain their display precedence", () => {
	const lines = voiceProgressLines("🎙 Input · waiting for speech", "⏯ Paused", [
		{ label: "Preparing code descriptions", processed: 2, total: 5 },
		{ label: "Recovering speech timing", processed: 3, total: 8 },
	]);
	assert.deepEqual(lines.map(line => line.kind), ["input", "playback", "preprocessing", "preprocessing"]);
	assert.match(lines[2].text, /code descriptions/);
	assert.match(lines[3].text, /speech timing/);
	for (const width of [20, 40, 80]) {
		const rendered = new Text(lines.map(line => line.text).join("\n"), 0, 0).render(width);
		assert.ok(rendered.every(line => visibleWidth(line) <= width), `native text wrapping at ${width} columns`);
	}
	const plain = lines.map(line => line.text.replace(/[^\x20-\x7e]/g, "")).join("\n");
	assert.match(plain, /waiting for speech/);
	assert.match(plain, /Paused/);
	assert.match(plain, /Recovering speech timing.*3\/8 targets ready/);
});

test("notices use one Voice label and native Pi severity, without ANSI or duplicate severity icons", () => {
	const notices: unknown[] = [];
	const ctx = { ui: { notify: (message: string, level: string) => notices.push({ message, level }) } } as any;
	for (const level of ["info", "warning", "error"] as const) notifyVoice(ctx, "Voice device unavailable · /voice reconnect to retry", level);
	assert.deepEqual(notices, ["info", "warning", "error"].map(level => ({
		message: "Voice · device unavailable · /voice reconnect to retry", level,
	})));
	notifyVoice(undefined, "Retired context", "error");
	assert.equal(notices.length, 3);
});
