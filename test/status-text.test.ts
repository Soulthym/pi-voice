import assert from "node:assert/strict";
import test from "node:test";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { deviceBadge, deviceFooterText, deviceProgressLines, notifyVoice, pendingPlaybackTiming, playbackTimingStatus, preprocessingStatus, voiceProgressLines } from "../src/status-text.js";

test("check, recovery and processing counters describe targets, not forced alignment or percent", () => {
	assert.equal(preprocessingStatus({ label: "Checking saved timing", processed: 109, total: 605, unit: "checked" }),
		"↺ Checking saved timing · 109/605 targets checked");
	assert.equal(preprocessingStatus({ label: "Recovering speech timing", processed: 109, total: 605, detail: "decoding cached audio: 2" }),
		"↺ Recovering speech timing · 109/605 targets ready · decoding cached audio: 2");
	assert.equal(preprocessingStatus({ label: "Preparing code descriptions", processed: 2, total: 5, unit: "processed" }),
		"↺ Preparing code descriptions · 2/5 targets processed");
	assert.equal(pendingPlaybackTiming(279, 605), "message 280/605 · timing pending");
	assert.equal(pendingPlaybackTiming(-1, 605), "current response · timing pending");
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

test("native word timing rows keep their height as four-digit counts refine", () => {
	for (const [width, expectedRows, pendingRows] of [[20, 3, 2], [32, 2, 1], [40, 1, 1]]) {
		for (const total of [1000, 9999]) {
			for (const estimated of [total, 999, 10, 1, 0]) {
				const text = playbackTimingStatus({ estimated, total });
				assert.equal(text.replace(/\u00a0/g, ""), `Word timing: ${estimated}/${total} estimated`);
				const rendered = new Text(text, 1, 0).render(width);
				assert.equal(rendered.length, expectedRows, `${estimated}/${total} at ${width} columns`);
				assert.ok(rendered.every(line => visibleWidth(line) <= width));
				assert.ok(rendered.join("\n").includes(`${estimated}/${total}`), "exact counts remain readable");
			}
		}
		const pending = playbackTimingStatus(undefined);
		assert.equal(pending, "Word timing: unknown/pending");
		assert.equal(new Text(pending, 1, 0).render(width).length, pendingRows);
	}
});

test("device badge ends only the first native row in every progress precedence, without adding rows", () => {
	const lines = voiceProgressLines("🎙 Input · waiting for speech", "⏯ Paused", [
		{ label: "Preparing code descriptions", processed: 2, total: 5 },
		{ label: "Recovering speech timing", processed: 3, total: 8 },
	], "Word timing: unknown/pending").map(line => line.text);
	for (let offset = 0; offset < lines.length; offset++) {
		for (const width of [20, 28, 40, 80, 160]) {
			const plain = deviceProgressLines(lines.slice(offset), "Linux Mint PC", width);
			assert.match(plain[0], /\[🎧:[^\]]+\]$/);
			assert.equal(visibleWidth(plain[0]), width, "badge reaches the rightmost column");
			assert.equal(plain.slice(1).some(line => line.includes("[")), false);
			assert.ok(plain.every(line => visibleWidth(line) <= width));
			const wide = deviceProgressLines(lines.slice(offset), "雪📱".repeat(64), width);
			assert.equal(wide.length, plain.length, "name width cannot change widget height");
			assert.ok(wide.every(line => visibleWidth(line) <= width));
		}
	}
	assert.deepEqual(deviceProgressLines([], "local", 80), [], "no invented progress work");
	assert.deepEqual(deviceProgressLines(["⏯ Paused"], "Local", 160), ["⏯ Paused" + " ".repeat(160 - visibleWidth("⏯ Paused[🎧:Local]")) + "[🎧:Local]"], "no picker hint even with spare room");
});

test("badge budget preserves graphemes and closed brackets even on tiny terminals", () => {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	for (const name of ["手机", "👩‍💻é🇩🇪", "id-123456789012345678901234567890", ""]) {
		const identity = name || "no device";
		const prefixes = new Set(["", ...Array.from(segmenter.segment(identity), part => identity.slice(0, part.index + part.segment.length))]);
		for (let width = 0; width <= 80; width++) {
			const { text, badge } = deviceFooterText("🎙 Input · long status and hints ".repeat(4), name, width);
			assert.equal(visibleWidth(text), width);
			assert.equal(badge, deviceBadge(name, width));
			if (width < 6) { assert.equal(badge, ""); continue; }
			assert.ok(text.endsWith(badge));
			assert.ok(badge.startsWith("[🎧:") && badge.endsWith("]"));
			assert.ok(prefixes.has(stripTerminalSequences(badge).slice("[🎧:".length, -1).replace(/…$/, "")), "only whole identity graphemes survive");
			if (visibleWidth(`[🎧:${identity}]`) <= width) assert.equal(badge, `[🎧:${identity}]`);
		}
	}
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
