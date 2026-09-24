import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { DeviceRouter } from "../src/device-router.js";
import { PhoneInputClient, type PhoneCapture } from "../src/phone-input.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const pickerUI = await import("../src/device-picker-ui.js");
// This suite checks routing transactions; mounted native overlay/lifecycle coverage lives separately.
mock.module("../src/device-picker-ui.js", { namedExports: { ...pickerUI,
	selectDeviceOverlay: (ctx: any, labels: string[], signal: AbortSignal, _screen: unknown, initialIndex: number) => {
		assert.match(labels[initialIndex], /current|Local/);
		return ctx.ui.select("Voice device", labels, { signal });
	},
} });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

test("unavailable restored identity keeps its complete stable ID until render-width truncation", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-id-badge-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const old = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "id-badge");
	const id = "same-prefix-1234567890-distinct-device-suffix";
	host.entries.push({ id: "pin", type: "custom", customType: "pi-voice.device-selection", data: { version: 1, selection: id, pin: id }, parentId: null });
	t.after(async () => {
		await host.shutdown();
		keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	await new Promise(resolve => setTimeout(resolve, 100));
	const component = host.widgetComponents.get("pi-voice-progress")!;
	assert.ok(component.render!(160)[0].endsWith(`[🎧:${id}]`));
	assert.match(stripTerminalSequences(component.render!(32)[0]), /\[🎧:.*…\]$/);
	assert.ok(component.render!(160)[0].endsWith(`[🎧:${id}]`), "widening restores the full ID, not a pre-sliced prefix");
	assert.equal(host.modelRequests.length, 0);
});

test("picker snapshots unique labels, cancels read-only, revalidates and uses the safe sticky transition", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-picker-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const old = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.mkdir(process.env.PI_VOICE_DEVICE_DIR);
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", audioCache: false, timingPreprocessConcurrency: 0 }));
	const ids = ["same-prefix-123-A", "same-prefix-123-B"];
	const register = async (id: string, name = "手机 [same]") => {
		await fs.writeFile(path.join(root, id), "");
		await fs.writeFile(path.join(process.env.PI_VOICE_DEVICE_DIR!, `${id}.json`), JSON.stringify({ version: 1, id, name, platform: "linux",
			audioEndpoint: `unix://${root}/${id}`, inputEndpoint: `unix://${root}/${id}`, connectedAt: 1, lastActive: 1 }));
	};
	await Promise.all(ids.map(id => register(id)));
	await register("bad", "bad\x1b[31m");
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: ids[0] }));
	const host = new FakeVoiceHost(root, "picker");
	let editor = "Keep my draft";
	host.ctx.ui.getEditorText = () => editor;
	host.ctx.ui.setEditorText = (value: string) => { editor = value; };
	let options: string[] = [];
	let answer = Promise.withResolvers<string | undefined>();
	host.ctx.ui.select = (_title: string, labels: string[]) => { options = labels; return answer.promise; };
	t.after(async () => {
		await host.shutdown();
		keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	await host.start();
	host.addMessage("answer", null, assistant("First sentence. Second sentence."));
	await host.shortcut("f5"); await settle();
	const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	const pins = () => host.entries.filter(entry => entry.customType === "pi-voice.device-selection");
	const before = { pins: pins().length, pauses: worker.pauses.length, sent: worker.sent.length };
	host.scrollView.setDocument(Array.from({ length: 100 }, (_, i) => `${i}`));
	host.scrollView.manualScrollTo(20);
	const beforePicker = host.widgetLines()?.[0];
	let opening = host.shortcut("alt+s");
	assert.equal(host.widgetLines()?.[0], beforePicker, "opening the picker does not present a handoff");
	assert.equal(options.length, 3, "only local and valid available registrations");
	assert.equal(new Set(options).size, 3, "duplicate names and short-ID prefixes remain distinct");
	assert.match(options[1], /current/);
	assert.equal(pins().length, before.pins);
	assert.equal(worker.pauses.length, before.pauses);
	assert.equal(worker.sent.length, before.sent);
	answer.resolve(undefined); await opening;
	assert.equal(host.widgetLines()?.[0], beforePicker, "cancelling the picker preserves playback presentation");
	assert.equal(host.scrollView.scrollTop, 20);
	assert.equal(editor, "Keep my draft");
	assert.equal(worker.pauses.length, before.pauses);
	answer = Promise.withResolvers(); opening = host.shortcut("alt+s");
	const terminateCurrent = t.mock.method(worker, "terminate");
	answer.resolve(options[1]); await opening;
	assert.equal(terminateCurrent.mock.callCount(), 0, "confirming current does not stop audio");
	terminateCurrent.mock.restore();
	assert.equal(worker.pauses.length, before.pauses, "confirming current does not pause");
	assert.equal(pins().at(-1).data.selection, ids[0], "confirming auto current makes the pin manual");
	before.pins = pins().length;
	answer = Promise.withResolvers(); opening = host.command("devices");
	await fs.rm(path.join(root, ids[1]));
	answer.resolve(options[2]); await opening;
	assert.equal(pins().length, before.pins, "expired endpoint cannot commit");
	assert.equal(worker.pauses.length, before.pauses, "expiration before choose is read-only");
	await register(ids[1]);
	answer = Promise.withResolvers(); opening = host.shortcut("alt+s");
	await host.command("device local");
	answer.resolve(options[2]); await opening;
	assert.equal(pins().at(-1).data.pin, "local", "newer explicit control supersedes the picker");
	answer = Promise.withResolvers(); opening = host.shortcut("alt+s");
	const stop = Promise.withResolvers<void>();
	const terminate = t.mock.method(worker, "terminate", () => stop.promise);
	answer.resolve(options[2]); await settle();
	assert.equal(pins().at(-1).data.pin, "local", "selection awaits actual stop proof");
	assert.match(host.widgetLines()![0], /Connecting/);
	assert.doesNotMatch(host.widgetLines()![0], /Paused/, "internal handoff transport pause is not user pause presentation");
	stop.resolve(); await opening;
	terminate.mock.restore();
	assert.equal(pins().at(-1).data.pin, ids[1]);
	assert.equal(pins().at(-1).data.selection, ids[1]);
	assert.equal(editor, "Keep my draft");
	assert.equal(host.scrollView.scrollTop, 20);
	assert.equal(worker.sent.length, before.sent, "choosing stays silent");
	assert.match(host.widgetComponents.get("pi-voice-progress")!.render!(80)[0], /Paused/);
	// A registration can expire while the old player is stopping, not just while choosing.
	answer = Promise.withResolvers(); opening = host.shortcut("alt+s");
	const delayedStop = Promise.withResolvers<void>();
	const delayed = t.mock.method(worker, "terminate", () => delayedStop.promise);
	answer.resolve(options[1]); await settle();
	await fs.rm(path.join(root, ids[0]));
	delayedStop.resolve(); await opening; delayed.mock.restore();
	assert.equal(pins().at(-1).data.pin, ids[1], "post-stop revalidation rejects expired endpoints");
	await register(ids[0]);
	answer = Promise.withResolvers(); opening = host.shortcut("alt+s");
	const failed = t.mock.method(worker, "terminate", async () => { throw new Error("stop unconfirmed"); });
	answer.resolve(options[1]); await opening; failed.mock.restore();
	assert.equal(pins().at(-1).data.pin, ids[1], "failed stop cannot commit picker choice");
	await host.command(`device ${ids[1]}`);
	answer = Promise.withResolvers(); opening = host.shortcut("alt+s");
	const sessionId = host.sessionManager.getSessionId;
	host.sessionManager.getSessionId = () => "replacement";
	answer.resolve(options[0]); await opening;
	assert.equal(pins().at(-1).data.pin, ids[1], "dynamic session replacement fences an old choice");
	host.sessionManager.getSessionId = sessionId;
	await fs.rm(path.join(root, ids[1]));
	answer = Promise.withResolvers(); opening = host.shortcut("alt+s");
	assert.ok(options.every(label => !label.includes("current")), "unavailable current is never advertised");
	assert.match(options[0], /Local/);
	answer.resolve(undefined); await opening;
	await register(ids[1]);
	await host.command("stop"); await settle();
	await host.command("device local"); await settle();
	assert.match(host.widgetLines()![0], /Idle/, "switching an idle session does not create pause intent");
	answer = Promise.withResolvers(); opening = host.shortcut("alt+s");
	const count = pins().length;
	await host.shutdown();
	answer.resolve(options[0]); await opening;
	assert.equal(pins().length, count, "shutdown fences delayed selection");
});

for (const scenario of ["playback", "recording", "endpoint", "generation", "unknown", "unavailable", "failed cleanup"]) {
	test(`fresh restored manual pin: current confirmation during ${scenario}`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-picker-restore-"));
		const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
		const old = keys.map(key => process.env[key]);
		process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
		process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
		process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
		await fs.mkdir(process.env.PI_VOICE_DEVICE_DIR);
		await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "auto", audioCache: false, timingPreprocessConcurrency: 0 }));
		const endpoint = `unix://${root}/audio`;
		await fs.writeFile(path.join(root, "audio"), "");
		await fs.writeFile(path.join(root, "replacement"), "");
		const registration = { version: 1, id: "A", name: "Restored device", platform: "linux", audioEndpoint: endpoint, inputEndpoint: endpoint, connectedAt: 1, lastActive: 1 };
		const file = path.join(process.env.PI_VOICE_DEVICE_DIR, "A.json");
		const register = () => fs.writeFile(file, JSON.stringify(registration));
		if (scenario !== "unknown") await register();
		const lookup = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => { throw new Error("must retain restored pin"); });
		const capture = Promise.withResolvers<PhoneCapture>();
		const record = t.mock.method(PhoneInputClient.prototype, "capture", () => capture.promise);
		const stop = t.mock.method(PhoneInputClient.prototype, "stop", async () => { capture.resolve({ type: "text", data: "" }); });
		const cancel = t.mock.method(PhoneInputClient.prototype, "cancel", async () => { if (record.mock.callCount()) capture.resolve({ type: "text", data: "" }); });
		// A new extension closure, not session_start on an already initialized host.
		const host = new FakeVoiceHost(root, `restore-${scenario}`);
		host.entries.push({ type: "custom", customType: "pi-voice.device-selection", data: { version: 1, selection: "A", pin: "A" } });
		let labels: string[] = [];
		const answer = Promise.withResolvers<string | undefined>();
		host.ctx.ui.select = (_title: string, options: string[]) => { labels = options; return answer.promise; };
		t.after(async () => {
			await host.shutdown();
			keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
			await fs.rm(root, { recursive: true, force: true });
		});
		await host.start();
		const worker = MockedVoiceWorkerClient.instances.at(-1)!;
		assert.equal(worker.sent.length, 0, "restore performs no playback");
		assert.equal(record.mock.callCount(), 0, "restore performs no capture");
		assert.equal(lookup.mock.callCount(), 0, "restore does not adopt attachment identity");
		if (scenario === "unknown") await register();
		let recording: Promise<void> | undefined;
		if (scenario === "recording") {
			recording = host.shortcut("f4"); await settle();
			assert.equal(record.mock.callCount(), 1);
		} else {
			host.addMessage("answer", null, assistant("First sentence. Second sentence."));
			await host.shortcut("f5"); await settle();
			assert.ok(worker.sent.length, "playback started");
		}
		if (scenario === "endpoint") registration.inputEndpoint = `unix://${root}/replacement`;
		if (scenario === "generation") registration.connectedAt++;
		await register();
		if (scenario === "failed cleanup") {
			const failed = t.mock.method(worker, "terminate", async () => { throw new Error("unconfirmed stop"); });
			await host.command("device local");
			failed.mock.restore();
		}
		if (scenario === "unavailable") await fs.rm(file);
		const terminate = t.mock.method(worker, "terminate");
		const pauses = worker.pauses.length;
		const cancellations = cancel.mock.callCount();
		const opening = host.shortcut("alt+s");
		if (scenario === "unavailable") {
			assert.ok(labels.every(label => !label.includes("current")), "unavailable pin cannot be confirmed");
			answer.resolve(labels[0]);
		} else {
			assert.match(labels[1], /current/);
			answer.resolve(labels[1]);
		}
		await opening;
		if (scenario === "playback" || scenario === "recording") {
			assert.equal(terminate.mock.callCount(), 0, "same restored route does not interrupt playback");
			assert.equal(worker.pauses.length, pauses, "same restored route does not pause");
			assert.equal(stop.mock.callCount(), 0, "same restored route does not finalize recording");
			assert.equal(cancel.mock.callCount(), cancellations, "same restored route does not cancel recording");
		} else {
			assert.ok(terminate.mock.callCount() > 0, "unknown/changed route or failed cleanup requires stop proof");
		}
		terminate.mock.restore();
		if (recording) { await host.command("stop"); await recording; }
	});
}
