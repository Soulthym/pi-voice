import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { DeviceRouter } from "../src/device-router.js";
import { FakeVoiceHost } from "./helpers/fake-voice-host.js";

test("setter queries reflect live settings, automatic routing and reload-only shortcuts without mutations", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-setting-queries-"));
	const env = {
		PI_VOICE_CONFIG: path.join(root, "voice.json"),
		PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"),
		PI_VOICE_DEVICE_DIR: path.join(root, "devices"),
	};
	const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ speed: 99, codeDescriptionPreprocessBudget: 3 }));
	const cp = await import("node:child_process");
	mock.module("node:child_process", { namedExports: { ...cp, spawn: () => assert.fail("no processes should start") } });
	const device = {
		version: 1 as const, id: "phone", name: "Phone", platform: "termux" as const,
		audioEndpoint: "unix:///test/audio", inputEndpoint: "unix:///test/input", connectedAt: 1, lastActive: 1,
	};
	await fs.mkdir(env.PI_VOICE_DEVICE_DIR);
	await fs.writeFile(path.join(env.PI_VOICE_DEVICE_DIR, "phone.json"), JSON.stringify(device));
	mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "phone" }));
	mock.method(DeviceRouter.prototype, "connected", () => [device]);
	const claim = mock.method(DeviceRouter.prototype, "claim", () => device);
	const host = new FakeVoiceHost(path.join(root, "project"), "queries");
	t.after(async () => {
		await host.shutdown();
		mock.reset();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	mock.method(host.ctx.ui, "select", async () => assert.fail("queries must not open dialogs"));
	const query = async (command: string, expected: string) => {
		const before = await fs.readFile(env.PI_VOICE_CONFIG, "utf8");
		const stat = await fs.stat(env.PI_VOICE_CONFIG);
		const entries = JSON.stringify(host.entries);
		const widgets = host.widgetOperations.length;
		const claims = claim.mock.callCount();
		await host.command(command);
		assert.deepEqual(host.notices.at(-1), { message: `Voice · ${expected}`, level: "info" });
		assert.equal(await fs.readFile(env.PI_VOICE_CONFIG, "utf8"), before);
		assert.equal((await fs.stat(env.PI_VOICE_CONFIG)).mtimeMs, stat.mtimeMs);
		assert.equal(JSON.stringify(host.entries), entries);
		assert.equal(host.widgetOperations.length, widgets);
		assert.equal(claim.mock.callCount(), claims);
		assert.equal(host.modelRequests.length, 0);
	};
	await query("speed", "speed: 1"); // Invalid persisted value falls back before queries.
	await query("device", "device: auto → phone (Phone)");
	await query("output", "output: auto → unix:///test/audio");
	await query("input", "input: auto → unix:///test/input");
	const setters = [
		["mode", "yield", "yield"], ["voice", "af_bella", "af_bella"], ["speed", "1.5", "1.5"],
		["tts-model", "test/tts", "test/tts"], ["tts-dtype", "q4", "q4"],
		["stt-model", "test/stt", "test/stt"], ["stt-dtype", "q8", "q8"], ["stt-candidates", "5", "5"],
		["alignment-model", "test/alignment", "test/alignment"], ["alignment-dtype", "fp32", "fp32"],
		["edit-model", "test/model", "test/model → test/model"],
		["highlight", "off", "off"], ["autoscroll", "off", "off"], ["code-narration", "summary", "summary"],
		["code-preprocess", "2", "2"], ["timing workers", "2", "2 → 2"],
		["audio-cache", "off", "off"], ["audio-bitrate", "64", "64 kbps"],
		["output", "tcp://example.invalid:1234", "tcp://example.invalid:1234 (explicit)"],
		["input", "disabled", "disabled (explicit)"],
		["shortcut", "disabled", "alt+m (also f4); configured=disabled (run /reload to apply)"],
		["submit", "auto", "auto"], ["edit", "append", "append"],
		["device", "local", "local → local"],
	];
	for (const [command, value, expected] of setters) {
		await host.command(`${command} ${value}`);
		assert.equal(host.notices.at(-1)?.level, "info", `${command} setter`);
		await query(command, `${command}: ${expected}`);
	}
	for (const value of ["0", "9", "1.5", "NaN", "2 extra", "auto extra", "1e0", "0x2", "+2", "02"]) {
		const before = await fs.readFile(env.PI_VOICE_CONFIG, "utf8");
		const widgets = host.widgetOperations.length;
		await host.command(`timing workers ${value}`);
		assert.equal(host.notices.at(-1)?.level, "error", value);
		assert.equal(await fs.readFile(env.PI_VOICE_CONFIG, "utf8"), before);
		assert.equal(host.widgetOperations.length, widgets);
	}
	for (const value of ["1", "8", "auto"]) {
		await host.command(`timing workers ${value}`);
		assert.equal(host.notices.at(-1)?.level, "info");
		const saved = JSON.parse(await fs.readFile(env.PI_VOICE_CONFIG, "utf8"));
		assert.equal(saved.timingPreprocessConcurrency, value === "auto" ? "auto" : Number(value));
		assert.equal("timingWorkers" in saved, false, "no config migration");
	}
	for (const command of ["timing-preprocess", "timing-preprocess 2", "timing unknown", "timing workers auto extra"]) {
		const before = await fs.readFile(env.PI_VOICE_CONFIG, "utf8");
		await host.command(command);
		assert.equal(host.notices.at(-1)?.level, "error", command);
		assert.equal(await fs.readFile(env.PI_VOICE_CONFIG, "utf8"), before);
	}
	const unchanged = await fs.readFile(env.PI_VOICE_CONFIG, "utf8");
	const widgetsBeforeReports = host.widgetOperations.length;
	for (const command of ["help", "status", "timing"]) {
		await host.command(command);
		const notice = host.notices.at(-1)!;
		assert.equal(notice.level, "info");
		assert.ok(notice.message.startsWith("Voice · "));
		assert.ok(!notice.message.includes("\x1b"), "reports remain plain text without a theme");
		if (command === "help") {
			assert.match(notice.message, /↺ F5 replay this project/);
			assert.match(notice.message, /⏯ F8 pause\/resume/);
			assert.match(notice.message, /⏮\/⏭ F6\/F10 previous\/next message/);
			assert.match(notice.message, /alt\+v: follow narrated position/);
			assert.match(notice.message, /alt\+t: transcript tail/);
		}
		if (command === "status") assert.match(notice.message, /measures audio; new word timing is estimated/);
		if (command === "timing") assert.match(notice.message, /Timing workers: auto → [1-4]/);
		assert.ok(!notice.message.includes("timing-preprocess"));
	}
	assert.equal(await fs.readFile(env.PI_VOICE_CONFIG, "utf8"), unchanged);
	assert.equal(host.widgetOperations.length, widgetsBeforeReports);
	assert.equal(host.modelRequests.length, 0);
	await host.command("speed invalid");
	assert.equal(host.notices.at(-1)?.level, "error");
	assert.equal(host.notices.at(-1)?.message, "Voice · Usage: /voice speed <0.5..2>");
	const footer: Array<string | undefined> = [];
	mock.method(host.ctx.ui, "setStatus", (_key: string, text: string | undefined) => { footer.push(text); });
	await host.command("on");
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.match(host.widgetLines()![0], /Voice · ready/);
	assert.equal(footer.at(-1), undefined, "idle identity is rendered in the widget, not collapsed by the native footer");
	await host.command("off");
	assert.equal(footer.at(-1), undefined);
	await host.command("code-budget 7");
	for (let i = 0; i < 2; i++) {
		await query("code-budget", "code-budget: scope=since-compaction; budget=7; used=0; set /voice code-budget <0..n|unlimited> for this session");
	}
	assert.equal(JSON.parse(await fs.readFile(env.PI_VOICE_CONFIG, "utf8")).codeDescriptionPreprocessBudget, 3);
	await host.command("edit-model current");
	host.ctx.model = undefined;
	await query("edit-model", "edit-model: current → unavailable");
	host.ctx.model = { ...host.model, id: "changed" };
	await query("edit-model", "edit-model: current → test/changed");

	for (const [settings, expected, microphoneKeys] of [
		[{}, "alt+m (also f4)", ["alt+m", "f4"]],
		[{ talkShortcut: "ctrl+shift+m" }, "ctrl+shift+m (also f4)", ["ctrl+shift+m", "f4"]],
		[{ talkShortcut: "f11" }, "f11 (also f4)", ["f11", "f4"]],
		[{ talkShortcut: "alt+s" }, "alt+s (also f4)", ["alt+s", "f4"]],
		[{ scrollToShortcut: "alt+s" }, "alt+m (also f4)", ["alt+m", "f4"]],
		[{ scrollBottomShortcut: "alt+s" }, "alt+m (also f4)", ["alt+m", "f4"]],
		[{ talkShortcut: "f5" }, "f5 (also f4)", ["f5", "f4"]],
		[{ talkShortcut: "alt+t" }, "f4", ["f4"]],
		[{ talkShortcut: "f4" }, "f4", ["f4"]],
		[{ talkShortcut: "alt+m", scrollToShortcut: "f4" }, "alt+m", ["alt+m"]],
		[{ talkShortcut: "f4", scrollBottomShortcut: "f4" }, "none", []],
		[{ talkShortcut: "alt+t", scrollToShortcut: "f4" }, "none", []],
		[{ talkShortcut: "disabled" }, "disabled", []],
	] as Array<[Record<string, string>, string, string[]]>) {
		await t.test(`shortcut collisions: ${JSON.stringify(settings)}`, async () => {
			await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, ...settings }));
			const collisionHost = new FakeVoiceHost(path.join(root, "project"), "collisions");
			const registrations = mock.method(collisionHost.api, "registerShortcut");
			try {
				await collisionHost.start();
				assert.equal(collisionHost.shortcuts.has("alt+d"), false, "native forward-delete-word is not registered by Voice");
				assert.equal(registrations.mock.calls.filter((call: { arguments: unknown[] }) => call.arguments[0] === "alt+s").length, 1,
					"picker never overwrites an existing voice control");
				assert.equal(collisionHost.notices.some(notice => notice.message.includes("Alt+S device picker not bound")),
					Object.values(settings).includes("alt+s"));
				assert.equal(registrations.mock.calls.filter((call: { arguments: unknown[] }) => call.arguments[0] === "f4").length,
					settings.talkShortcut === "disabled" ? 0 : settings.scrollToShortcut === "f4" || settings.scrollBottomShortcut === "f4" ? 2 : 1);
				assert.equal(collisionHost.shortcuts.has("f11"), settings.talkShortcut === "f11");
				if (settings.talkShortcut !== "f5") {
					await collisionHost.shortcut("f5");
					assert.match(collisionHost.notices.at(-1)!.message, /Replay unavailable/);
				}
				// Inspect the final host map, not merely the configured registration requests.
				assert.deepEqual([...collisionHost.shortcuts].filter(([, shortcut]) =>
					(shortcut as { description?: string }).description === "🎙 Start or stop dictation",
				).map(([key]) => key), microphoneKeys);
				await collisionHost.command("shortcut");
				assert.deepEqual(collisionHost.notices.at(-1), { message: `Voice · shortcut: ${expected}`, level: "info" });
				await collisionHost.command("shortcut alt+x");
				await collisionHost.command("shortcut");
				assert.deepEqual(collisionHost.notices.at(-1), {
					message: `Voice · shortcut: ${expected}; configured=alt+x (run /reload to apply)`, level: "info",
				});
			} finally {
				await collisionHost.shutdown();
			}
		});
	}
});
