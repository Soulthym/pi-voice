import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import { NarrationProgress } from "../src/narration-progress.js";
import { PlaybackHistory } from "../src/playback-history.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { assistant, FakeVoiceHost, MockedVoiceWorkerClient } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 120)); };

async function startHost(t: TestContext, completeModel?: FakeVoiceHost["completeModel"]) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "tail-state-"));
	const env = { PI_VOICE_CONFIG: path.join(root, "voice.json"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") };
	const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false, codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0, ...(completeModel ? { codeNarration: "summary" } : {}) }));
	const host = new FakeVoiceHost(root, "tail-state", completeModel);
	t.after(async () => {
		await host.shutdown();
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("older", null, assistant("Older response."));
	await host.start();
	return host;
}

for (const completion of ["finalizing", "unpersisted", "persisted"] as const) for (const check of ["counter", "f9", "f10"] as const) test(`caught-up autoplay ${completion}: ${check}`, async t => {
	const host = await startHost(t);
	const ended = t.mock.method(MockedVoiceWorkerClient.prototype, "endUtterance");
	host.idle = false;
	const message = assistant("Latest sentence. Another sentence. "); delete message.stopReason;
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	const final = { ...message, stopReason: "stop" };
	if (completion === "persisted") host.addMessage("latest", "older", final);
	await host.emit("message_end", { message: final });
	if (completion !== "finalizing") await host.emit("turn_end", { message: final });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	assert.ok(worker, "autoplay, not a fabricated Tail fixture");
	for (const segment of worker.sent as Array<{ utterance: number; segmentId: number }>) worker.emit({ ...segment, type: "segment-audio", start: 0, duration: 2 });
	await settle();
	assert.match(host.widgetLines()![0], / · 2\/2(?: ·|\s)/, "playing latest is an existing entry");
	for (const utterance of new Set(worker.sent.map(segment => (segment as { utterance: number }).utterance))) {
		assert.ok(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === utterance), "only a flushed utterance can report EOF");
		worker.emit({ type: "idle", utterance });
	}
	await settle();
	if (check === "counter") {
		assert.match(host.widgetLines()![0], /● live · 3\/2(?: ·|\s)/, "drained autoplay waits beyond the last eligible entry, even while the model works");
	} else {
		const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
		const cancels = t.mock.method(MockedVoiceWorkerClient.prototype, "cancel");
		const releases = t.mock.method(SessionCoordinator.prototype, "releaseSpeech");
		const acquisitions = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech");
		const sent = worker.sent.length;
		const pauses = [...worker.pauses];
		const lines = host.widgetLines();
		await host.shortcut(check); await settle();
		assert.equal(captures.mock.callCount(), 0, "no cursor replacement/backward replay");
		assert.equal(cancels.mock.callCount(), 0, "no transport cancellation at caught-up Tail");
		assert.equal(releases.mock.callCount(), 0, "no lease release");
		assert.equal(acquisitions.mock.callCount(), 0, "no lease acquisition");
		assert.equal(worker.sent.length, sent, "no synthesis");
		assert.deepEqual(worker.pauses, pauses, "play/pause intent unchanged");
		assert.deepEqual(host.widgetLines(), lines);
	}
	if (completion !== "persisted") {
		host.addMessage("latest", "older", final);
		await host.emit("turn_end", { message: final });
		await host.emit("agent_settled", {}); await settle();
		assert.match(host.widgetLines()![0], /● live · 3\/2(?: ·|\s)/, "canonical adoption must retain the waiting boundary");
	}
	assert.equal(host.modelRequests.length, 0);
});

for (const key of ["f9", "f10"]) test(`${key} into Tail, paused/resumed Tail and a later real entry`, async t => {
	const host = await startHost(t);
	await host.shortcut("f5"); await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	await host.command("bottom"); // Viewport arrival alone is not Voice Tail.
	assert.match(host.widgetLines()![0], / · 1\/1(?: ·|\s)/);
	await host.shortcut(key); await settle();
	assert.match(host.widgetLines()![0], /● live · 2\/1(?: ·|\s)/);
	const cancels = t.mock.method(MockedVoiceWorkerClient.prototype, "cancel");
	const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
	const sent = worker.sent.length;
	for (const paused of [true, false]) {
		await host.shortcut("f8"); await settle();
		assert.match(host.widgetLines()![0], paused ? /Paused/ : /● live · 2\/1(?: ·|\s)/);
		const lines = host.widgetLines();
		await host.shortcut("f9"); await host.shortcut("f10"); await settle();
		assert.equal(cancels.mock.callCount(), 0);
		assert.equal(captures.mock.callCount(), 0);
		assert.equal(worker.sent.length, sent);
		assert.deepEqual(host.widgetLines(), lines);
	}
	host.addMessage("later", "older", assistant("Later first sentence. Later second sentence."));
	await host.shortcut(key); await settle();
	assert.ok(worker.sent.length > sent, "new real entries must still be navigable after a Tail boundary");
	assert.equal((worker.sent[sent] as { text: string }).text, "Later first sentence.");
	assert.match(host.widgetLines()![0], / · 2\/2(?: ·|\s)/);
	const beforeSentence = worker.sent.length;
	await host.shortcut("f9"); await settle();
	assert.equal((worker.sent[beforeSentence] as { text: string }).text, "Later second sentence.");
});

test("explicit streaming Tail is inert and retains future deltas through canonicalization", async t => {
	const host = await startHost(t);
	const message = assistant("Streamed first. Streamed last. "); delete message.stopReason;
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	await host.shortcut("f10"); await settle(); // Explicitly skip the prefix, rather than fabricate streaming EOF.
	assert.match(host.widgetLines()![0], /● live · 3\/2(?: ·|\s)/);
	const cancels = t.mock.method(MockedVoiceWorkerClient.prototype, "cancel");
	const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
	const sent = worker.sent.length;
	await host.shortcut("f9"); await host.shortcut("f10"); await settle();
	assert.equal(cancels.mock.callCount(), 0);
	assert.equal(captures.mock.callCount(), 0);
	assert.equal(worker.sent.length, sent);
	const delta = "Future sentence. ";
	const updated = assistant(message.content[0].text + delta); delete updated.stopReason;
	await host.emit("message_update", { message: updated, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } }); await settle();
	assert.deepEqual((worker.sent.slice(sent) as Array<{ text: string }>).map(segment => segment.text), ["Future sentence."]);
	assert.match(host.widgetLines()![0], / · 2\/2(?: ·|\s)/);
	const ended = t.mock.method(MockedVoiceWorkerClient.prototype, "endUtterance");
	const final = { ...updated, stopReason: "stop" };
	host.addMessage("latest", "older", final);
	await host.emit("message_end", { message: final });
	await host.emit("turn_end", { message: final }); await settle();
	const clip = worker.sent.at(-1) as { utterance: number; segmentId: number };
	assert.ok(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === clip.utterance));
	worker.emit({ ...clip, type: "segment-audio", start: 0, duration: 2 });
	worker.emit({ type: "idle", utterance: clip.utterance }); await settle();
	assert.match(host.widgetLines()![0], /● live · 3\/2(?: ·|\s)/);
});

for (const explicit of [false, true]) for (const paused of [false, true]) for (const key of ["f9", "f10"]) test(`open streaming catch-up uses playback progress, not EOF: explicit=${explicit}, paused=${paused}, ${key}`, async t => {
	const host = await startHost(t);
	const ended = t.mock.method(MockedVoiceWorkerClient.prototype, "endUtterance");
	const prefix = "Initial sentence. ";
	const message = assistant(prefix, "pending");
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: prefix } });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	if (explicit) { await host.shortcut("f10"); await settle(); }
	const text = prefix + "Latest audible sentence. ";
	const updated = assistant(text, "pending");
	await host.emit("message_update", { message: updated, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Latest audible sentence. " } });
	await settle();
	const clip = worker.sent.at(-1) as { utterance: number; segmentId: number; text: string };
	assert.equal(clip.text, "Latest audible sentence.");
	const clips = (worker.sent as Array<typeof clip>).filter(s => s.utterance === clip.utterance);
	for (const [i, segment] of clips.entries()) worker.emit({ ...segment, type: "segment-audio", start: i * 2, duration: 2 });
	// Only closed project prefixes get EOF; the current streaming utterance stays OPEN.
	for (const utterance of new Set((worker.sent as Array<typeof clip>).filter(s => s.utterance < clip.utterance).map(s => s.utterance))) {
		if (!explicit) {
			assert.ok(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === utterance));
			worker.emit({ type: "idle", utterance });
		}
	}
	const statuses = t.mock.method(PlaybackHistory.prototype, "status");
	worker.emit({ type: "playback", utterance: clip.utterance, position: clips.length * 2 }); await settle();
	if (paused) {
		await host.shortcut("f8"); await settle();
		assert.match(host.widgetLines()![0], /Paused/);
	}
	// Arrive after Pause: F8 is a valid attention boundary, caught-up navigation is not.
	const waiting = new SessionCoordinator(path.join(host.cwd, "waiting"), "waiting");
	waiting.start(); waiting.markWaiting({ kind: "intentional_local" });
	t.after(() => waiting.shutdown());
	assert.equal(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === clip.utterance), false, "no invented streaming EOF");
	const history = statuses.mock.calls.at(-1)!.this as PlaybackHistory;
	const cursor = history.resumeSnapshot(paused);
	assert.ok(cursor && cursor.position >= 2, "fixture has a real caught-up cursor, not position zero");
	const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
	const cancels = t.mock.method(MockedVoiceWorkerClient.prototype, "cancel");
	const releases = t.mock.method(SessionCoordinator.prototype, "releaseSpeech");
	const acquisitions = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech");
	const sent = worker.sent.length;
	const pauses = [...worker.pauses];
	const lines = host.widgetLines();
	const rendered = host.render(text);
	await host.shortcut(key); await settle();
	assert.deepEqual(history.resumeSnapshot(paused), cursor, "caught-up navigation must preserve position and source cursor");
	assert.equal(cancels.mock.callCount(), 0, "caught-up navigation must not cancel an OPEN transport");
	assert.equal(captures.mock.callCount(), 0, "no new playback request/cursor");
	assert.equal(releases.mock.callCount(), 0);
	assert.equal(acquisitions.mock.callCount(), 0);
	assert.equal(worker.sent.length, sent, "no narration or attention announcement");
	assert.deepEqual(worker.pauses, pauses);
	assert.deepEqual(host.widgetLines(), lines);
	assert.equal(host.render(text), rendered);
	assert.equal(waiting.waitingSessions()[0]?.announced, false, "catch-up is not an attention completion boundary");
	assert.equal(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === clip.utterance), false);
	waiting.clearWaiting();
	// New real units unfreeze forward navigation, including while still paused.
	const delta = "Current new sentence. Later real sentence. ";
	await host.emit("message_update", { message: assistant(text + delta, "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } }); await settle();
	const current = worker.sent[sent] as typeof clip;
	assert.equal(current.text, "Current new sentence.");
	if (!paused) {
		worker.emit({ ...current, type: "segment-audio", start: clips.length * 2, duration: 2 });
		worker.emit({ type: "playback", utterance: current.utterance, position: clips.length * 2 + 0.2 }); await settle();
	}
	if (key === "f10") {
		const later = assistant(text + delta, "pending");
		later.content.push({ type: "text", text: "Later real message. " });
		await host.emit("message_update", { message: later, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Later real message. " } }); await settle();
	}
	const before = worker.sent.length;
	const cancel = t.mock.method(worker, "cancel", () => 701 as never);
	const next = host.shortcut(key); await settle();
	assert.equal(cancel.mock.callCount(), 1, "a real later target still cancels the old transport");
	assert.equal(worker.sent.length, before, "catch-up is not stop proof for a later target");
	worker.emit({ type: "idle", cancelId: 700 }); await settle();
	assert.equal(worker.sent.length, before, "an unrelated ACK cannot admit the later target");
	worker.emit({ type: "idle", cancelId: 701 }); await next; await settle();
	cancel.mock.restore();
	assert.equal((worker.sent[before] as typeof clip)?.text,
		key === "f10" ? "Later real message." : paused ? "Current new sentence." : "Later real sentence.",
		`${key} must still reach a real later target (paused=${paused})`);
	assert.equal(host.modelRequests.length, 0);
});

for (const caughtUp of [false, true]) for (const key of ["f9", "f10"]) test(`paused final streaming word is not audio completion: caughtUp=${caughtUp}, ${key}`, async t => {
	const host = await startHost(t);
	const ended = t.mock.method(MockedVoiceWorkerClient.prototype, "endUtterance");
	const text = "Final audible word\n";
	const message = assistant(text, "pending");
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const clip = worker.sent.at(-1) as { utterance: number; segmentId: number; text: string };
	assert.equal(clip.text, text.trim());
	for (const utterance of new Set((worker.sent as Array<typeof clip>).filter(s => s.utterance < clip.utterance).map(s => s.utterance))) {
		assert.ok(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === utterance));
		worker.emit({ type: "idle", utterance });
	}
	worker.emit({ ...clip, type: "segment-audio", start: 0, duration: 3 });
	worker.emit({ type: "alignment", segmentId: clip.segmentId, quality: "ctc-refined", words: [
		{ text: "Final", start: 0, end: 1 }, { text: "audible", start: 1, end: 2 }, { text: "word", start: 2, end: 3 },
	] });
	const progress = t.mock.method(NarrationProgress.prototype, "setPlayback");
	const statuses = t.mock.method(PlaybackHistory.prototype, "status");
	worker.emit({ type: "playback", utterance: clip.utterance, position: caughtUp ? 3 : 2.2 }); await settle();
	const narration = progress.mock.calls.at(-1)!.this as NarrationProgress;
	assert.equal(narration.sourceEnd, text.trim().length);
	assert.equal(narration.consumedSourceEnd, narration.sourceEnd, "last-word highlighting reaches source end before audio ends");
	const history = statuses.mock.calls.at(-1)!.this as PlaybackHistory;
	assert.equal(history.status()!.position, caughtUp ? 3 : 2.2);
	assert.equal(history.status()!.duration, 3);
	await host.shortcut("f8"); await settle();
	assert.match(host.widgetLines()![0], /Paused/);
	assert.equal(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === clip.utterance), false, "stream remains open");
	const cancels = t.mock.method(worker, "cancel", () => 702 as never);
	const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
	const cursor = history.resumeSnapshot(true);
	const pauses = [...worker.pauses];
	const lines = host.widgetLines();
	const sent = worker.sent.length;
	const next = host.shortcut(key); await settle();
	assert.equal(cancels.mock.callCount(), caughtUp ? 0 : 1, "only real audio catch-up makes forward navigation inert");
	assert.equal(worker.sent.length, sent, "no synthesis before stop proof or at caught-up Tail");
	if (caughtUp) {
		assert.equal(captures.mock.callCount(), 0);
		assert.deepEqual(history.resumeSnapshot(true), cursor);
		assert.deepEqual(worker.pauses, pauses);
		assert.deepEqual(host.widgetLines(), lines);
	} else {
		worker.emit({ type: "idle", cancelId: 702 });
	}
	await next; await settle();
	cancels.mock.restore();
	assert.equal(host.modelRequests.length, 0);
});

for (const scenario of ["unheard", "estimated", "caught-up", "same-during", "same-after", "block-during", "block-after", "markup", "silent-block"] as const) for (const key of ["f9", "f10"]) test(`paused notice retains streaming catch-up: ${scenario}, ${key}`, async t => {
	const host = await startHost(t);
	const text = "Final audible word\n";
	const message = assistant(text, "pending");
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	const clip = worker.sent.at(-1) as { utterance: number; segmentId: number; text: string };
	for (const utterance of new Set((worker.sent as Array<typeof clip>).filter(s => s.utterance < clip.utterance).map(s => s.utterance))) worker.emit({ type: "idle", utterance });
	worker.emit({ ...clip, type: "segment-audio", start: 0, duration: 3 });
	worker.emit({ type: "alignment", segmentId: clip.segmentId, quality: "ctc-refined", words: [
		{ text: "Final", start: 0, end: 1 }, { text: "audible", start: 1, end: 2 }, { text: "word", start: 2, end: 3 },
	] });
	const statuses = t.mock.method(PlaybackHistory.prototype, "status");
	worker.emit({ type: "playback", utterance: clip.utterance, position: scenario === "unheard" ? 2.2 : 3, estimated: scenario === "estimated" }); await settle();
	const history = statuses.mock.calls.at(-1)!.this as PlaybackHistory;
	const waiting = new SessionCoordinator(path.join(host.cwd, "waiting"), "waiting");
	waiting.start(); waiting.markWaiting({ kind: "intentional_local" });
	t.after(() => waiting.shutdown());
	const ended = t.mock.method(worker, "endUtterance");
	await host.shortcut("f8"); await settle();
	const notice = worker.sent.at(-1) as typeof clip;
	assert.match(notice.text, /requires attention next/);
	assert.match(host.widgetLines()![0], /Paused/);
	const append = async () => {
		const delta = scenario === "markup" || scenario === "silent-block" ? "\n---\n***\n" : "Buffered B sentence. ";
		const updated = assistant(text + delta, "pending");
		const contentIndex = scenario.startsWith("block") || scenario === "silent-block" ? 1 : 0;
		if (contentIndex) { updated.content[0].text = text; updated.content.push({ type: "text", text: delta }); }
		await host.emit("message_update", { message: updated, assistantMessageEvent: { type: "text_delta", contentIndex, delta } });
		await settle();
	};
	const growth = scenario.includes("during") || scenario.includes("after") || scenario === "markup" || scenario === "silent-block";
	if (growth && !scenario.endsWith("after")) await append();
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	if (scenario.endsWith("after")) await append();
	assert.equal(waiting.waitingSessions()[0]?.announced, true);
	assert.equal(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === clip.utterance), false,
		"Pause, notice completion and buffered source growth are not whole-message EOF");
	const cursor = history.resumeSnapshot(true);
	const cancels = t.mock.method(worker, "cancel");
	const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
	const releases = t.mock.method(SessionCoordinator.prototype, "releaseSpeech");
	const acquisitions = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech");
	const sent = worker.sent.length;
	const pauses = [...worker.pauses];
	const lines = host.widgetLines();
	await host.shortcut(key); await settle();
	const caughtUp = scenario === "caught-up" || scenario === "markup" || scenario === "silent-block";
	if (caughtUp) {
		assert.equal(cancels.mock.callCount(), 0, "truly caught-up navigation stays inert after an untracked notice");
		assert.equal(captures.mock.callCount(), 0);
		assert.equal(releases.mock.callCount(), 0);
		assert.equal(acquisitions.mock.callCount(), 0);
		assert.equal(worker.sent.length, sent);
		assert.deepEqual(history.resumeSnapshot(true), cursor);
		assert.deepEqual(worker.pauses, pauses);
		assert.deepEqual(host.widgetLines(), lines);
	} else {
		assert.ok(cancels.mock.callCount() > 0, "unheard audio or buffered eligible text must unfreeze forward navigation");
		if (scenario.startsWith("block") || (scenario.startsWith("same") && key === "f9")) {
			assert.equal((worker.sent[sent] as typeof clip)?.text, "Buffered B sentence.");
		}
	}
	assert.equal(host.modelRequests.length, 0);
});

for (const kind of ["omitted", "unknown", "pending"] as const)
for (const timing of kind === "omitted" ? ["before", "during", "after"] : kind === "pending" ? ["before"] : ["during", "after"])
for (const progress of kind === "omitted" ? ["confirmed", "unheard", "estimated"] : ["confirmed"])
for (const key of ["f9", "f10"]) test(`separate silent tail: ${kind}, ${timing}, ${progress}, ${key}`, async t => {
	let finishDescription: (() => void) | undefined;
	t.after(() => finishDescription?.());
	const host = await startHost(t, async request => {
		if (JSON.stringify(request.context.messages).includes("pendingCode")) await new Promise<void>(resolve => { finishDescription = resolve; });
		return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "" }] };
	});
	// Resolve a real terminal omission before the prose, without synthesizing fake content.
	const omitted = "```ts\nomitMe();\n```\n";
	const text = omitted + "Final audible word\n";
	const message = assistant(text, "pending");
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	type Clip = { utterance: number; segmentId: number; text: string };
	const clip = worker.sent.at(-1) as Clip;
	assert.equal(clip.text, "Final audible word");
	for (const utterance of new Set((worker.sent as Clip[]).filter(s => s.utterance < clip.utterance).map(s => s.utterance))) worker.emit({ type: "idle", utterance });
	worker.emit({ ...clip, type: "segment-audio", start: 0, duration: 3 });
	worker.emit({ type: "alignment", segmentId: clip.segmentId, quality: "ctc-refined", words: [
		{ text: "Final", start: 0, end: 1 }, { text: "audible", start: 1, end: 2 }, { text: "word", start: 2, end: 3 },
	] });
	const statuses = t.mock.method(PlaybackHistory.prototype, "status");
	worker.emit({ type: "playback", utterance: clip.utterance, position: progress === "unheard" ? 2.2 : 3, estimated: progress === "estimated" });
	await settle();
	const history = statuses.mock.calls.at(-1)!.this as PlaybackHistory;
	const proseId = history.selected()!.id;
	const requests = host.modelRequests.length;
	assert.ok(requests > 0, "omission came from the real mocked description failure path");
	const append = async () => {
		const delta = kind === "omitted" ? omitted : `\`\`\`ts\n${kind}Code();\n\`\`\`\n`;
		const updated = assistant(text, "pending");
		updated.content.push({ type: "text", text: delta });
		await host.emit("message_update", { message: updated, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta } });
		await settle();
	};
	const beforeAppend = worker.sent.length;
	if (timing === "before") {
		await append();
		assert.equal(worker.sent.length, beforeAppend, "silent/pending block has no manufactured audio to discard or confirm");
		if (progress !== "unheard") assert.notEqual(history.selected()!.id, proseId, "silent trailing capture changes selection");
	}
	const waiting = new SessionCoordinator(path.join(host.cwd, "waiting"), "waiting");
	waiting.start(); waiting.markWaiting({ kind: "intentional_local" });
	t.after(() => waiting.shutdown());
	await host.shortcut("f8"); await settle();
	const notice = worker.sent.at(-1) as Clip;
	assert.match(notice.text, /requires attention next/);
	const duringNotice = worker.sent.length;
	if (timing === "during") await append();
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	if (timing === "after") await append();
	assert.equal(worker.sent.length, duringNotice, "buffered terminal blocks cannot manufacture a confirmed checkpoint");
	assert.equal(host.modelRequests.length, requests + (kind === "pending" ? 1 : 0));
	assert.equal(!!finishDescription, kind === "pending", "pending case really started an unresolved description");
	// A second project arrives AFTER Pause and its notice, not at an attention boundary.
	waiting.clearWaiting();
	if (kind === "omitted" && progress === "confirmed") {
		waiting.markWaiting({ kind: "intentional_local" });
		assert.equal(waiting.waitingSessions()[0]?.announced, false);
	}
	assert.match(host.widgetLines()![0], /Paused/);
	const cursor = history.resumeSnapshot(true);
	const lines = host.widgetLines();
	const pauses = [...worker.pauses];
	const cancels = t.mock.method(worker, "cancel");
	const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
	const releases = t.mock.method(SessionCoordinator.prototype, "releaseSpeech");
	const acquisitions = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech");
	const next = host.shortcut(key); await settle();
	if (kind === "omitted" && progress === "confirmed") {
		assert.equal(cancels.mock.callCount(), 0, "terminal silent blocks must retain earlier confirmed catch-up");
		assert.equal(captures.mock.callCount(), 0);
		assert.equal(releases.mock.callCount(), 0);
		assert.equal(acquisitions.mock.callCount(), 0);
		assert.equal(worker.sent.length, duringNotice, "no new synthesis or attention announcement");
		assert.equal(host.modelRequests.length, requests);
		assert.deepEqual(history.resumeSnapshot(true), cursor);
		assert.deepEqual(host.widgetLines(), lines);
		assert.deepEqual(worker.pauses, pauses);
		assert.equal(waiting.waitingSessions()[0]?.announced, false, "caught-up F9/F10 is not an attention boundary");
	} else assert.ok(cancels.mock.callCount() > 0 || (kind === "pending" && host.notices.some(notice => /Waiting for code-description/.test(notice.message))),
		"no worker is not proof: unheard prose and unknown/pending code remain available");
	finishDescription?.();
	await next;
});

test("empty streaming header reserves identity, not an eligible counter entry", async t => {
	const host = await startHost(t);
	await host.shortcut("f10"); await settle();
	assert.match(host.widgetLines()![0], /● live · 2\/1(?: ·|\s)/);
	const empty = assistant(""); delete empty.stopReason;
	await host.emit("message_start", { message: empty }); await settle();
	assert.match(host.widgetLines()![0], /● live · 2\/1(?: ·|\s)/, "empty source reservation does not increment total");
	const message = assistant("Eligible streaming sentence. "); delete message.stopReason;
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
	await settle();
	assert.match(host.widgetLines()![0], / · 2\/2(?: ·|\s)/, "first eligible content creates exactly one real entry");
});

for (const scenario of ["consumed", "estimated", "partial", "first-chunk", "new-prose", "new-code", "omitted-after-prose", "omitted-after-code"] as const) for (const key of ["f9", "f10"]) test(`paused notice retains actual code-description catch-up: ${scenario}, ${key}`, async t => {
	const host = await startHost(t, async request => ({ role: "assistant", stopReason: "stop", content: [{ type: "text",
		text: JSON.stringify(request.context.messages).includes("omitMe") ? "" : "Defines a value. Uses that value." }] }));
	const code = "```ts\nconst value = 1;\n```\n";
	const omitted = "```ts\nomitMe();\n```\n";
	const text = scenario === "omitted-after-prose" ? "Final prose.\n" + omitted
		: code + (scenario === "omitted-after-code" ? omitted : "");
	const registered = t.mock.method(PlaybackHistory.prototype, "registerSegment");
	const ended = t.mock.method(MockedVoiceWorkerClient.prototype, "endUtterance");
	const message = assistant(text, "pending");
	await host.emit("message_start", { message });
	await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
	await settle();
	const worker = MockedVoiceWorkerClient.instances.findLast(worker => worker.sent.length)!;
	type Clip = { utterance: number; segmentId: number; text: string };
	const last = worker.sent.at(-1) as Clip;
	const clips = (worker.sent as Clip[]).filter(clip => clip.utterance === last.utterance);
	assert.deepEqual(clips.map(clip => clip.text), scenario === "omitted-after-prose" ? ["Final prose."] : ["Defines a value.", "Uses that value."]);
	if (scenario !== "omitted-after-prose") {
		const segment = registered.mock.calls.at(-1)!.arguments[0];
		assert.equal(segment.source.start, segment.source.end, "real code-description segments have zero-width source ranges");
		assert.ok(segment.codeDescription && segment.codeDescription.offset > 0, "the final description chunk carries provenance");
	}
	for (const utterance of new Set((worker.sent as Clip[]).filter(clip => clip.utterance < last.utterance).map(clip => clip.utterance))) worker.emit({ type: "idle", utterance });
	for (const [i, clip] of clips.entries()) {
		if (scenario !== "first-chunk" || i === 0) worker.emit({ ...clip, type: "segment-audio", start: i * 2, duration: 2 });
	}
	const history = registered.mock.calls.at(-1)!.this as PlaybackHistory;
	worker.emit({ type: "playback", utterance: last.utterance,
		position: scenario === "first-chunk" ? 2 : clips.length * 2 - (scenario === "partial" ? 0.2 : 0), estimated: scenario === "estimated" });
	await settle();
	const waiting = new SessionCoordinator(path.join(host.cwd, "waiting"), "waiting");
	waiting.start(); waiting.markWaiting({ kind: "intentional_local" });
	t.after(() => waiting.shutdown());
	await host.shortcut("f8"); await settle();
	const notice = worker.sent.at(-1) as Clip;
	assert.match(notice.text, /requires attention next/);
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	if (scenario.startsWith("new-")) {
		const delta = scenario === "new-prose" ? "New available prose.\n" : "```ts\nnewCode();\n```\n";
		await host.emit("message_update", { message: assistant(text + delta, "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
		await settle();
	}
	assert.equal(ended.mock.calls.some(call => (call.arguments as unknown[])[0] === last.utterance), false, "description source stream remains OPEN");
	assert.match(host.widgetLines()![0], /Paused/);
	const cursor = history.resumeSnapshot(true);
	const lines = host.widgetLines();
	const pauses = [...worker.pauses];
	const sent = worker.sent.length;
	const requests = host.modelRequests.length;
	const cancels = t.mock.method(worker, "cancel");
	const captures = t.mock.method(PlaybackHistory.prototype, "beginCapture");
	const releases = t.mock.method(SessionCoordinator.prototype, "releaseSpeech");
	const acquisitions = t.mock.method(SessionCoordinator.prototype, "tryAcquireSpeech");
	await host.shortcut(key); await settle();
	if (scenario === "consumed" || scenario.startsWith("omitted-")) {
		assert.equal(cancels.mock.callCount(), 0, "confirmed final description/prose with no eligible suffix stays inert after the notice");
		assert.equal(captures.mock.callCount(), 0);
		assert.equal(releases.mock.callCount(), 0);
		assert.equal(acquisitions.mock.callCount(), 0);
		assert.equal(worker.sent.length, sent);
		assert.deepEqual(history.resumeSnapshot(true), cursor);
		assert.deepEqual(host.widgetLines(), lines);
		assert.deepEqual(worker.pauses, pauses);
	} else assert.ok(cancels.mock.callCount() > 0, "estimated, unconsumed chunks and new available source cannot prove catch-up");
	assert.equal(host.modelRequests.length, requests + (scenario === "new-code" && key === "f9" ? 1 : 0),
		"only navigating into new code may request a mocked description");
	assert.ok(requests > 0, "fixture exercised mocked description generation, not fabricated history segments");
});
