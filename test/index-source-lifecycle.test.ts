import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import { PlaybackHistory } from "../src/playback-history.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve)); };
const segments = (worker: MockedVoiceWorkerClient) => worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;

async function fixture(t: TestContext, text = "First sentence. Old second sentence. ") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-life-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", output: "local", input: "disabled", codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
	const host = new FakeVoiceHost(root, "source-life");
	t.after(async () => {
		await host.shutdown();
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("older", null, assistant("Earlier history."));
	await host.start();
	const message = assistant(text, "pending");
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const clips = segments(worker).filter(s => !s.text.startsWith("Project "));
	for (const [i, clip] of clips.entries()) worker.emit({ ...clip, type: "segment-audio", start: i * 10, duration: 10, audioIdentity: `pcm-${clip.segmentId}` });
	worker.emit({ type: "playback", utterance: clips[0]!.utterance, position: 1 });
	return { host, worker, message };
}

for (const change of ["shortened", "replacement", "append"] as const) test(`F9 validates source after gated preparation: ${change}`, async t => {
	const { host, worker, message } = await fixture(t);
	const immediate = globalThis.setImmediate;
	let release: (() => void) | undefined;
	let clock = 0;
	const now = t.mock.method(performance, "now", () => clock += 9);
	const gate = t.mock.method(globalThis, "setImmediate", ((callback: () => void, ...args: unknown[]) => {
		if (new Error().stack?.includes("preparePlaybackMessages")) { release = callback; return immediate(() => {}); }
		return immediate(() => Reflect.apply(callback, undefined, args));
	}) as typeof setImmediate);
	try {
		const before = worker.sent.length;
		const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
		const send = t.mock.method(worker, "sendSegment");
		const navigation = host.shortcut("f9"); await settle();
		assert.ok(release, "gate preparation, not transport cancellation");
		assert.equal(captures.mock.calls.at(-1)!.arguments[4], 16, "F9 selected the old second sentence");
		assert.equal(worker.sent.length, before);
		const text = change === "shortened" ? "New first." : change === "replacement" ? "New first. New second." : message.content[0].text + "New third.";
		const final = assistant(text);
		host.addMessage("canonical", "older", final);
		await host.emit("message_end", { message: final });
		await host.emit("turn_end", { message: final });
		now.mock.restore(); gate.mock.restore(); release(); await navigation; await settle();
		assert.deepEqual(segments(worker).slice(before).map(s => s.text), change === "append" ? ["Old second sentence.", "New third."] : change === "replacement" ? ["New first.", "New second."] : ["New first."]);
		for (const call of send.mock.calls) assert.equal((call.arguments as unknown[])[4], undefined, "no stale cached-PCM offset after final-source validation");
		assert.equal(captures.mock.calls.at(-1)!.arguments[4], change === "append" ? 16 : 0);
		assert.equal(host.modelRequests.length, 0);
	} finally { now.mock.restore(); gate.mock.restore(); release?.(); }
});

for (const barrier of ["preparation", "cancellation"] as const) for (const change of ["replacement", "append"] as const) test(`Tail prefix validation after ${barrier}: ${change}`, async t => {
	const { host, worker, message } = await fixture(t, "First sentence. Old unfinished");
	const immediate = globalThis.setImmediate;
	let release: (() => void) | undefined;
	let clock = 0;
	const now = barrier === "preparation" ? t.mock.method(performance, "now", () => clock += 9) : undefined;
	const gate = barrier === "preparation" ? t.mock.method(globalThis, "setImmediate", ((callback: () => void, ...args: unknown[]) => {
		if (new Error().stack?.includes("preparePlaybackMessages")) { release = callback; return immediate(() => {}); }
		return immediate(() => Reflect.apply(callback, undefined, args));
	}) as typeof setImmediate) : undefined;
	const cancel = barrier === "cancellation" ? t.mock.method(worker, "cancel", () => 903 as never) : undefined;
	try {
		const before = worker.sent.length;
		await host.shortcut("f10"); await settle();
		if (barrier === "preparation") assert.ok(release);
		else assert.equal(cancel!.mock.callCount(), 1);
		assert.equal(worker.sent.length, before);
		const final = assistant(change === "replacement" ? "New first." : message.content[0].text + " becomes complete.");
		host.addMessage("canonical", "older", final);
		await host.emit("message_end", { message: final });
		await host.emit("turn_end", { message: final });
		now?.mock.restore(); gate?.mock.restore(); cancel?.mock.restore();
		if (barrier === "preparation") release!();
		else worker.emit({ type: "idle", cancelId: 903 });
		await settle();
		assert.deepEqual(segments(worker).slice(before).map(s => s.text), change === "replacement" ? ["New first."] : ["Old unfinished becomes complete."], "Tail cannot seed removed source or discard replacement text");
		assert.equal(host.modelRequests.length, 0);
	} finally { now?.mock.restore(); gate?.mock.restore(); cancel?.mock.restore(); release?.(); }
});

for (const continuation of ["allocated", "queued", "pause", "pause-notice", "pause-notice-resume", "pause-notice-arrival", "pause-notice-pause-again", "pause-notice-failure", "pause-notice-stop", "pause-notice-session", "pause-notice-replay", "pause-notice-route", "notice-stop", "notice-session", "notice-replay", "stop", "session"] as const) test(`ordinary F5 retires removed A but preserves B: ${continuation}`, async t => {
	const ended = t.mock.method(MockedVoiceWorkerClient.prototype, "endUtterance");
	const { host, worker, message } = await fixture(t);
	const observer = new SessionCoordinator(host.cwd, "observer");
	const b = "Remaining B block.";
	if (continuation !== "queued") {
		const updated = structuredClone(message);
		updated.content.push({ type: "text", text: b + " " });
		await host.emit("message_update", { message: updated, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: b + " " } });
		await settle();
		assert.ok(segments(worker).some(s => s.text === b), "B already has a worker block and live ID");
	}
	const a = segments(worker).find(s => s.text === "First sentence.")!;
	worker.emit({ type: "playback", utterance: a.utterance, position: 2 });
	const before = worker.sent.length;
	const cancel = t.mock.method(worker, "cancel", () => 902 as never);
	const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
	await host.shortcut("f5"); await settle();
	assert.equal(cancel.mock.callCount(), 1, "ordinary live F5 is waiting for cancellation without a paused notice");
	assert.equal(worker.sent.length, before);
	const final = { ...assistant(""), content: [
		{ type: "toolCall", id: "call", name: "read", arguments: {} }, { type: "text", text: b },
	] };
	await host.emit("message_end", { message: final });
	await host.emit("turn_end", { message: final }); await settle();
	assert.equal(worker.sent.length, before, "finalization cannot dispatch before stop proof");
	const capture = captures.mock.calls.at(-1)!;
	assert.equal((capture.this as PlaybackHistory).resumeSnapshot(true, capture.arguments[0]), undefined, "removed A has no checkpoint to retain");
	let replaced: Promise<void> | undefined;
	let waiting: SessionCoordinator | undefined;
	if (continuation.includes("notice")) {
		waiting = new SessionCoordinator(path.join(host.cwd, "waiting"), "waiting");
		waiting.start(); waiting.markWaiting({ kind: "intentional_local" });
		t.after(() => waiting!.shutdown());
	}
	if (continuation === "pause" || waiting) await host.shortcut("f8");
	worker.emit({ type: "idle", cancelId: 901 }); await settle();
	assert.equal(worker.sent.length, before, "Pause/notice and wrong ACK cannot admit audio before original cancellation");
	if (continuation.startsWith("notice-")) waiting!.clearWaiting(); // Supersede the old boundary, not create a second notice.
	if (continuation === "stop" || continuation === "notice-stop") await host.command("stop");
	if (continuation === "session" || continuation === "notice-session") replaced = host.emit("session_start", {});
	if (continuation === "notice-replay") replaced = host.shortcut("f5");
	cancel.mock.restore();
	worker.emit({ type: "idle", cancelId: 902 }); await replaced; await settle();
	if (continuation === "stop" || continuation === "session" || continuation.startsWith("notice-")) {
		assert.deepEqual(segments(worker).slice(before).map(s => s.text), continuation === "notice-replay" ? ["Earlier history."] : [],
			"newer user/session intent fences the old continuation and its retained B");
		if (continuation === "notice-replay") {
			worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
			assert.deepEqual(segments(worker).slice(before).map(s => s.text), ["Earlier history."], "old B cannot drain after the new explicit source");
		}
	} else {
		let contentStart = before;
		if (continuation.startsWith("pause-notice")) {
			const notice = segments(worker).at(-1)!;
			assert.match(notice.text, /requires attention next/);
			assert.ok(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === notice.utterance), "notice is flushed before EOF");
			contentStart = worker.sent.length;
			if (continuation !== "pause-notice") {
				await host.shortcut("f8"); await settle();
				assert.deepEqual(segments(worker).slice(before).map(s => s.text), [notice.text], "Resume must await notice EOF or scoped stop proof");
				worker.emit({ type: "idle" });
				worker.emit({ type: "idle", utterance: a.utterance }); await settle();
				assert.equal(worker.sent.length, contentStart, "unscoped or old A EOF cannot drain B");
			}
			if (continuation === "pause-notice-arrival") {
				const newer = assistant("Independent queued first. Independent queued second.");
				await host.emit("message_start", { message: newer });
				await host.emit("message_update", { message: newer, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: newer.content[0].text } });
				host.addMessage("newer", "older", newer);
				await host.emit("message_end", { message: newer }); await host.emit("turn_end", { message: newer }); await settle();
				assert.deepEqual(segments(worker).slice(before).map(s => s.text), [notice.text], "new independent source also waits behind notice proof");
			}
			if (continuation === "pause-notice-pause-again") {
				await host.shortcut("f8");
				assert.equal(worker.pauses.at(-1), false, "Pause revokes source Resume, not the notice's physical completion");
			}
			const superseded = ["pause-notice-stop", "pause-notice-session", "pause-notice-replay", "pause-notice-route"].includes(continuation);
			if (superseded) {
				waiting!.clearWaiting();
				if (continuation === "pause-notice-stop") await host.command("stop");
				if (continuation === "pause-notice-session") await host.emit("session_start", {});
				if (continuation === "pause-notice-replay") await host.shortcut("f5");
				if (continuation === "pause-notice-route") await host.command("reconnect");
				await settle();
			}
			if (continuation === "pause-notice-failure") {
				const failedStop = t.mock.method(worker, "cancel", () => 904 as never);
				worker.emit({ type: "error", utterance: notice.utterance, message: "Synthetic notice failure" }); await settle();
				worker.emit({ type: "idle", utterance: notice.utterance });
				worker.emit({ type: "idle", cancelId: 903 }); await settle();
				assert.deepEqual(segments(worker).slice(before).map(s => s.text), [notice.text], "failed EOF/wrong ACK cannot drain B");
				assert.equal(waiting!.waitingSessions()[0]?.announced, false);
				failedStop.mock.restore();
				worker.emit({ type: "idle", cancelId: 904 }); await settle();
			} else { worker.emit({ type: "idle", utterance: notice.utterance }); await settle(); }
			if (superseded) {
				if (continuation === "pause-notice-route") {
					assert.equal(worker.sent.length, contentStart, "route adoption fences the old notice Resume");
					assert.equal(observer.speechOwner(), undefined, "a notification-only route change returns its lease");
					await host.command("stop"); await settle();
				}
				if (continuation !== "pause-notice-replay") {
					assert.deepEqual(segments(worker).slice(contentStart).map(s => s.text), [], "Stop/session drops the old queue");
					const newer = assistant("Independent new source.");
					await host.emit("message_start", { message: newer });
					await host.emit("message_update", { message: newer, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: newer.content[0].text } });
					host.addMessage("newer", "older", newer);
					await host.emit("message_end", { message: newer }); await host.emit("turn_end", { message: newer }); await settle();
				}
				const expected = continuation === "pause-notice-replay" ? ["Earlier history."] : ["Independent new source."];
				assert.deepEqual(segments(worker).slice(contentStart).filter(s => !s.text.startsWith("Project ")).map(s => s.text), expected);
				for (const utterance of new Set(segments(worker).slice(contentStart).map(s => s.utterance))) {
					assert.ok(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === utterance));
					worker.emit({ type: "idle", utterance });
				}
				await settle();
				assert.deepEqual(segments(worker).slice(contentStart).filter(s => !s.text.startsWith("Project ")).map(s => s.text), expected, "late notice EOF cannot revive B or discard independent work");
				assert.equal(observer.speechOwner(), undefined);
				assert.equal(host.modelRequests.length, 0);
				return;
			}
			assert.equal(waiting!.waitingSessions()[0]?.announced, continuation !== "pause-notice-failure");
			if (continuation === "pause-notice-failure") waiting!.clearWaiting();
			if (continuation === "pause-notice" || continuation === "pause-notice-pause-again") assert.deepEqual(segments(worker).slice(before).map(s => s.text), [notice.text], "without current Resume intent notice EOF stays paused");
		}
		if (continuation === "pause" || continuation === "pause-notice" || continuation === "pause-notice-pause-again") {
			assert.equal(worker.sent.length, contentStart);
			assert.match(host.widgetLines()!.join(" "), /Paused/);
			await host.shortcut("f8"); await settle();
		}
		assert.deepEqual(segments(worker).slice(contentStart).map(s => s.text), [b], "remaining eligible audio plays exactly once, not removed A");
		assert.ok(observer.speechOwner(), "B retains ownership until its own completion");
		worker.emit({ type: "idle", utterance: a.utterance }); await settle();
		assert.ok(observer.speechOwner(), "old A completion cannot release B's lease");
		const remaining = segments(worker).at(-1)!;
		assert.ok(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === remaining.utterance));
		worker.emit({ type: "idle", utterance: remaining.utterance }); await settle();
		const expected = continuation === "pause-notice-arrival" ? [b, "Independent queued first.", "Independent queued second."] : [b];
		assert.deepEqual(segments(worker).slice(contentStart).map(s => s.text), expected, "full queue retains exact text and order");
		if (continuation === "pause-notice-arrival") {
			const newer = segments(worker).at(-1)!;
			assert.ok(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === newer.utterance));
			worker.emit({ type: "idle", utterance: newer.utterance }); await settle();
			assert.deepEqual(segments(worker).slice(contentStart).map(s => s.text), expected);
		}
	}
	assert.equal(observer.speechOwner(), undefined, "completion/supersession leaves no leaked speech lease");
	assert.equal(host.modelRequests.length, 0);
});
