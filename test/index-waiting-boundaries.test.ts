import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { DeviceRouter } from "../src/device-router.js";
import { PlaybackHistory } from "../src/playback-history.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant, streamCompletedResponse } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve)); };
const segments = (worker: MockedVoiceWorkerClient) => worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
const notices = (worker: MockedVoiceWorkerClient) => segments(worker).filter(segment => segment.text.includes("requires attention next"));
async function fixture(t: test.TestContext, remote = false, mode: "assistant" | "yield" = "assistant") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-"));
	for (const [key, value] of Object.entries({ PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") })) {
		const old = process.env[key]; process.env[key] = value;
		t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
	}
	if (remote) {
		await fs.mkdir(process.env.PI_VOICE_DEVICE_DIR!, { recursive: true });
		await fs.writeFile(path.join(process.env.PI_VOICE_DEVICE_DIR!, "shared.json"), JSON.stringify({ version: 1, id: "shared", name: "Shared output", platform: "termux", audioEndpoint: "unix:///synthetic/shared", inputEndpoint: "unix:///synthetic/input", connectedAt: 1, lastActive: 1 }));
		t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "shared" }));
	}
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode, output: remote ? "auto" : "local", input: "disabled", timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
	const a = new FakeVoiceHost(path.join(root, "a"), "a"), b = new FakeVoiceHost(path.join(root, "b"), "b");
	const coordinators: SessionCoordinator[] = [];
	const start = SessionCoordinator.prototype.start;
	t.mock.method(SessionCoordinator.prototype, "start", function(this: SessionCoordinator) { coordinators.push(this); start.call(this); });
	await a.start(); const worker = MockedVoiceWorkerClient.instances.at(-1)!;
	await b.start(); const otherWorker = MockedVoiceWorkerClient.instances.at(-1)!;
	t.after(async () => { await a.shutdown(); await b.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
	await streamCompletedResponse(a, "a1", "",  "First sentence. Second sentence."); await settle();
	await streamCompletedResponse(b, "b1", "",  "Waiting answer."); await settle();
	return { a, b, worker, otherWorker, owner: coordinators[0]!, waiting: coordinators[1]! };
}

test("live waiting generation survives eight seconds; whole-message EOF announces before local backlog", async t => {
	const { a, worker, otherWorker, owner, waiting } = await fixture(t);
	const pending = waiting.waitingSessions()[0]!;
	assert.deepEqual(pending.connection, { kind: "intentional_local" });
	const current = segments(worker).at(-1)!;
	await streamCompletedResponse(a, "a2", "a1", "Local backlog."); await settle();
	assert.ok(!segments(worker).some(segment => segment.text === "Local backlog."), "next source stays in the host until A's physical EOF");
	// Real coordinator heartbeats keep the same pending batch alive beyond the old TTL.
	await new Promise(resolve => setTimeout(resolve, 8500));
	assert.equal(owner.waitingSessions()[0]!.generation, pending.generation);
	worker.emit({ type: "idle", utterance: current.utterance }); await settle();
	assert.equal(notices(worker).length, 1);
	assert.equal(segments(worker).at(-1), notices(worker)[0]);
	assert.equal(otherWorker.sent.length, 0, "waiting project never steals owner output");
	assert.equal(waiting.waitingSessions()[0]!.announced, false);
	worker.emit({ type: "idle", utterance: notices(worker)[0]!.utterance }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, true);
	assert.equal(segments(worker).at(-1)!.text, "Local backlog.");
	assert.equal(notices(worker).length, 1);
});

for (const action of ["pause", "stop", "navigate"] as const) test(`${action} waits for original scoped cancellation before one announcement`, async t => {
	const { a, worker, waiting } = await fixture(t);
	const first = segments(worker).find(segment => segment.text === "First sentence.")!;
	worker.emit({ type: "segment-audio", utterance: first.utterance, segmentId: first.segmentId, start: 0, duration: 6, audioIdentity: "cached-pcm", timingQuality: "ctc-refined" });
	worker.emit({ type: "playback", utterance: first.utterance, position: 2.5 });
	let history: PlaybackHistory | undefined;
	const snapshot = PlaybackHistory.prototype.resumeSnapshot;
	t.mock.method(PlaybackHistory.prototype, "resumeSnapshot", function(this: PlaybackHistory, paused = false) { history = this; return snapshot.call(this, paused); });
	t.mock.method(worker, "cancel", () => 71 as never);
	if (action === "navigate") a.addMessage("a2", "a1", assistant("Navigation target."));
	void (action === "pause" ? a.shortcut("f8") : action === "stop" ? a.command("stop") : a.shortcut("f6"));
	await settle();
	assert.equal(notices(worker).length, 0, "pause ACK alone is not native exit proof");
	worker.emit({ type: "idle" }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, false, "unscoped idle is never notification delivery");
	worker.emit({ type: "idle", cancelId: 70 }); await settle();
	assert.equal(notices(worker).length, 0, "wrong cancellation scope cannot admit notification");
	worker.emit({ type: "idle", cancelId: 71 }); await settle();
	assert.equal(notices(worker).length, 1);
	const frozen = history?.status()?.position;
	if (action === "pause") assert.equal(frozen, 2.5);
	worker.emit({ type: "idle", utterance: notices(worker)[0]!.utterance }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, true);
	if (action === "pause") {
		assert.equal(history?.status()?.position, frozen, "untracked completion cannot move paused display");
		assert.match(a.widgetLines()!.join(" "), /Paused/);
		const send = t.mock.method(worker, "sendSegment");
		await a.shortcut("f8"); await settle();
		const resumed = send.mock.calls.find(call => call.arguments[2] === "First sentence.");
		assert.ok(resumed);
		assert.deepEqual((resumed.arguments as unknown[])[4], { seconds: 2.5, audioIdentity: "cached-pcm" });
	}
	if (action === "stop") assert.ok(!a.widgetLines()?.join(" ").includes("Playing"));
});

test("Resume during a paused notice with a checkpoint waits for that notice's scoped stop proof", async t => {
	const { a, worker, waiting } = await fixture(t);
	const first = segments(worker).find(segment => segment.text === "First sentence.")!;
	worker.emit({ ...first, type: "segment-audio", start: 0, duration: 6, audioIdentity: "cached-pcm" });
	worker.emit({ type: "playback", utterance: first.utterance, position: 2.5 });
	await a.shortcut("f8"); await settle();
	const notice = notices(worker).at(-1)!;
	const before = worker.sent.length;
	const cancel = t.mock.method(worker, "cancel", () => 909 as never);
	const send = t.mock.method(worker, "sendSegment");
	await a.shortcut("f8"); await settle();
	assert.ok(cancel.mock.callCount() > 0, "checkpoint Resume requests physical notice cancellation");
	worker.emit({ type: "idle", cancelId: 908 }); await settle();
	assert.equal(worker.sent.length, before);
	assert.equal(waiting.waitingSessions()[0]?.announced, false, "cancelling a notice is not delivery");
	cancel.mock.restore();
	worker.emit({ type: "idle", cancelId: 909 }); await settle();
	assert.deepEqual(segments(worker).slice(before).map(s => s.text), ["First sentence.", "Second sentence."]);
	assert.deepEqual((send.mock.calls[0]!.arguments as unknown[])[4], { seconds: 2.5, audioIdentity: "cached-pcm" });
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	assert.deepEqual(segments(worker).slice(before).map(s => s.text), ["First sentence.", "Second sentence."], "late notice EOF cannot resume twice");
});

for (const action of ["pause", "stop"] as const) test(`${action} keeps its boundary pending across cancel ACK until every original receipt arrives`, async t => {
	const { a, worker, waiting } = await fixture(t, true);
	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	worker.emit({ type: "remote-handle", output: "unix:///synthetic/shared", id, utterance: segments(worker).at(-1)!.utterance });
	t.mock.method(worker, "cancel", () => 81 as never);
	await (action === "pause" ? a.shortcut("f8") : a.command("stop")); await settle();
	worker.emit({ type: "remote-released", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
	worker.emit({ type: "idle", cancelId: 81 }); await settle();
	assert.equal(notices(worker).length, 0, "cancel ACK cannot retire an unmatched physical scope");
	assert.equal(waiting.waitingSessions()[0]!.announced, false);
	worker.emit({ type: "remote-released", id });
	await new Promise(resolve => setTimeout(resolve, 300)); await settle();
	assert.equal(notices(worker).length, 1, "matching late receipt completes the same safe boundary");
	worker.emit({ type: "idle", utterance: notices(worker)[0]!.utterance }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, true);
	if (action === "pause") assert.match(a.widgetLines()!.join(" "), /Paused/);
});

test("old notification completion never acknowledges a replacement generation", async t => {
	const { a, worker, waiting } = await fixture(t);
	for (const utterance of new Set(segments(worker).map(segment => segment.utterance))) worker.emit({ type: "idle", utterance });
	await settle();
	assert.match(a.widgetLines()!.join(" "), /2\/1/, "untracked announcement cannot turn completed Tail into an existing playing entry");
	assert.equal(notices(worker).length, 1);
	const previous = waiting.waitingSessions()[0]!;
	waiting.clearWaiting(); const replacement = waiting.markWaiting({ kind: "intentional_local" });
	assert.notEqual(previous.generation, replacement.generation);
	worker.emit({ type: "idle", utterance: notices(worker)[0]!.utterance }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, false);
	assert.equal(notices(worker).length, 1, "one boundary cannot chain announcements ahead of local work");
});

test("idle third project on another device cannot deliver a local waiting announcement", async t => {
	const { a, worker, waiting } = await fixture(t);
	await fs.mkdir(process.env.PI_VOICE_DEVICE_DIR!, { recursive: true });
	await fs.writeFile(path.join(process.env.PI_VOICE_DEVICE_DIR!, "device-c.json"), JSON.stringify({ version: 1, id: "device-c", name: "Other output", platform: "termux", audioEndpoint: "unix:///synthetic/c", inputEndpoint: "unix:///synthetic/c-input", connectedAt: 1, lastActive: 1 }));
	const config = await fs.readFile(process.env.PI_VOICE_CONFIG!, "utf8");
	await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ ...JSON.parse(config), output: "auto" }));
	t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "device-c" }));
	const third = new FakeVoiceHost(path.join(a.cwd, "third"), "third");
	try {
		await third.start(); const other = MockedVoiceWorkerClient.instances.at(-1)!;
		await fs.writeFile(process.env.PI_VOICE_CONFIG!, config);
		// Stop may deliver once on the original output. A fresh generation then remains for B.
		await a.command("stop"); await settle();
		assert.equal(notices(worker).length, 1);
		worker.emit({ type: "idle", utterance: notices(worker)[0]!.utterance }); await settle();
		waiting.clearWaiting(); waiting.markWaiting({ kind: "intentional_local" });
		await new Promise(resolve => setTimeout(resolve, 350));
		assert.equal(other.sent.length, 0);
		assert.equal(waiting.waitingSessions()[0]!.announced, false);
	} finally { await third.shutdown(); }
});

test("failed notification stays pending and retries only at a subsequent safe boundary", async t => {
	const { a, worker, waiting } = await fixture(t);
	worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
	const failed = notices(worker)[0]!; assert.ok(failed);
	worker.emit({ type: "error", utterance: failed.utterance, message: "Synthetic notification failure" }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, false);
	worker.emit({ type: "idle", utterance: failed.utterance }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, false, "late failed EOF cannot acknowledge delivery");
	assert.equal(waiting.speechOwner(), undefined, "proven failed output cannot strand an idle lease");
	// An idle Stop must not acquire a lease. Create the next real user-owned boundary.
	await a.shortcut("f5"); await settle();
	await a.command("stop"); await settle();
	assert.equal(notices(worker).length, 2);
	worker.emit({ type: "idle", utterance: notices(worker)[1]!.utterance }); await settle();
	assert.equal(waiting.waitingSessions()[0]!.announced, true);
	await new Promise(resolve => setTimeout(resolve, 350));
	assert.equal(notices(worker).length, 2);
});

for (const mode of ["assistant", "yield"] as const) test(`paused announcement resumes every remaining block of the same completed message (${mode})`, async t => {
	const { a, worker, waiting } = await fixture(t, false, mode);
	waiting.clearWaiting(); worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
	const message = assistant("First block. "); message.content.push({ type: "text", text: "Remaining block. " });
	await a.emit("message_start", { message });
	for (const [contentIndex, block] of message.content.entries()) await a.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex, delta: block.text } });
	a.addMessage("multi", "a1", message); await a.emit("message_end", { message }); await a.emit("turn_end", { message }); await settle();
	const first = segments(worker).find(segment => segment.text === "First block.")!;
	worker.emit({ ...first, type: "segment-audio", start: 0, duration: 4 });
	worker.emit({ type: "playback", utterance: first.utterance, position: 1 });
	waiting.markWaiting({ kind: "intentional_local" });
	await a.shortcut("f8"); await settle();
	worker.emit({ type: "idle", utterance: notices(worker).at(-1)!.utterance }); await settle();
	const before = worker.sent.length;
	await a.shortcut("f8"); await settle();
	worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
	assert.deepEqual(segments(worker).slice(before).map(segment => segment.text), ["First block.", "Remaining block."], "notification cancellation cannot discard unheard blocks");
});

for (const liveDelta of [false, true]) test(`navigation announcement buffers original deltas and new responses (live delta=${liveDelta})`, async t => {
	const { a, worker, waiting } = await fixture(t);
	waiting.clearWaiting(); worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
	const message = assistant("Original live source. ", "pending");
	await a.emit("message_start", { message });
	await a.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Original live source. " } }); await settle();
	waiting.markWaiting({ kind: "intentional_local" });
	void a.shortcut("f6"); await settle();
	const notification = notices(worker).at(-1)!; assert.ok(notification);
	if (liveDelta) {
		message.content[0]!.text += "Must stay silent. ";
		await a.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Must stay silent. " } }); await settle();
		assert.ok(!segments(worker).some(segment => segment.text === "Must stay silent."), "cancelled original source cannot append PCM to an announcement");
	}
	await streamCompletedResponse(a, "new", "a1", "Arrived during navigation notice."); await settle();
	worker.emit({ type: "idle", utterance: notification.utterance }); await settle();
	assert.equal(segments(worker).at(-1)!.text, "Second sentence.");
	worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
	assert.equal(segments(worker).at(-1)!.text, "Arrived during navigation notice.");
});

for (const completeBeforeEOF of [false, true]) test(`idle fallback announcement drains local arrivals (complete=${completeBeforeEOF})`, async t => {
	const { a, worker, waiting } = await fixture(t);
	await a.command("stop"); await settle();
	worker.emit({ type: "idle", utterance: notices(worker).at(-1)!.utterance }); await settle();
	waiting.clearWaiting(); waiting.markWaiting({ kind: "intentional_local" });
	const idle = new FakeVoiceHost(path.join(a.cwd, "idle"), "idle");
	try {
		await idle.start(); const output = MockedVoiceWorkerClient.instances.at(-1)!;
		await new Promise(resolve => setTimeout(resolve, 300));
		const notification = notices(output)[0]!; assert.ok(notification);
		await idle.shortcut("f5"); // No history target: preserve the existing notification boundary.
		const message = assistant("Local arrival.");
		await idle.emit("message_start", { message });
		const complete = async () => { idle.addMessage("arrival", null, message); await idle.emit("message_end", { message }); await idle.emit("turn_end", { message }); await settle(); };
		if (completeBeforeEOF) await complete();
		output.emit({ type: "idle", utterance: notification.utterance }); await settle();
		if (!completeBeforeEOF) await complete();
		assert.equal(segments(output).at(-1)!.text, "Local arrival.");
	} finally { await idle.shutdown(); }
});

test("failed notification preserves and drains local backlog after stop proof", async t => {
	const { a, worker, waiting } = await fixture(t);
	await streamCompletedResponse(a, "queued", "a1", "Unheard local backlog."); await settle();
	worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
	const notification = notices(worker)[0]!; assert.ok(notification);
	assert.match(a.widgetLines()!.join(" "), /1\/2/, "untracked notice must preserve the tracked message counter");
	worker.emit({ type: "error", utterance: notification.utterance, message: "Synthetic failure" }); await settle();
	assert.equal(segments(worker).at(-1)!.text, "Unheard local backlog.");
	assert.equal(waiting.waitingSessions()[0]!.announced, false);
});

test("Stop notice remains stopped while preserving newly completed text for explicit navigation", async t => {
	const { a, worker } = await fixture(t);
	await a.command("stop"); await settle();
	const notice = notices(worker)[0]!;
	await streamCompletedResponse(a, "new", "a1", "Preserved after Stop."); await settle();
	assert.match(a.widgetLines()!.join(" "), /Idle/, "new output during the notice cannot clear Stop suppression");
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	assert.equal(segments(worker).at(-1)!.utterance, notice.utterance, "Stop cannot automatically play newly queued work");
	await a.shortcut("f10"); await settle();
	assert.equal(segments(worker).at(-1)!.text, "Preserved after Stop.");
});

for (const nextNotice of [false, true]) test(`new navigation retires the completed paused announcement snapshot (notice=${nextNotice})`, async t => {
	const { a, worker, waiting } = await fixture(t);
	await a.shortcut("f8"); await settle();
	worker.emit({ type: "idle", utterance: notices(worker)[0]!.utterance }); await settle();
	assert.match(a.widgetLines()!.join(" "), /Paused/);
	a.addMessage("new-target", "a1", assistant("New navigation target."));
	if (nextNotice) { waiting.clearWaiting(); waiting.markWaiting({ kind: "intentional_local" }); }
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
		await a.shortcut("f10"); await settle();
		if (!nextNotice) assert.ok(release, "new target preparation is actually gated");
		else assert.equal(notices(worker).length, 2, "new navigation's notice is pending");
		await a.shortcut("f8"); await settle();
		if (nextNotice) { worker.emit({ type: "idle", utterance: notices(worker).at(-1)!.utterance }); await settle(); }
		now.mock.restore(); gate.mock.restore(); release?.(); await settle();
		const resumed = segments(worker).slice(before).filter(segment => !segment.text.includes("requires attention next"));
		assert.ok(resumed.length > 0, "new navigation completes");
		assert.deepEqual(resumed.map(segment => segment.text), ["New navigation target."], "F8 must not revive the previous paused source");
	} finally { now.mock.restore(); gate.mock.restore(); release?.(); }
});

for (const newerIntent of ["response", "play", "submission"] as const) test(`Stop notice discards stale continuations but preserves newer ${newerIntent}`, async t => {
	const { a, worker, waiting } = await fixture(t);
	await a.command("stop"); await settle();
	const notice = notices(worker)[0]!;
	await streamCompletedResponse(a, "stopped", "a1", "Stopped queued response."); await settle();
	if (newerIntent !== "response") waiting.clearWaiting(); // No second legitimate notice hides the new intent.
	if (newerIntent === "play") {
		a.addMessage("chosen", "stopped", assistant("New explicit target."));
		await a.shortcut("f10"); await settle();
		await a.shortcut("f10"); await settle();
	} else if (newerIntent === "submission") {
		await a.emit("input", { text: "New user intent", source: "interactive" });
		await settle();
	}
	worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
	const before = worker.sent.length;
	if (newerIntent !== "play") await streamCompletedResponse(a, "fresh", "stopped", "Truly new response.");
	await settle();
	const current = segments(worker).at(-1)!;
	assert.equal(current.text, newerIntent === "play" ? "New explicit target." : "Truly new response.");
	worker.emit({ type: "idle", utterance: current.utterance }); await settle();
	assert.ok(!segments(worker).slice(before).some(segment => segment.text === "Stopped queued response."), "later EOF cannot drain stopped responses");
	assert.equal(segments(worker).at(-1)!.utterance, current.utterance, "stale notice completion cannot revive or replace newer intent");
});

test("failed announcement waits through cancel ACK for its own original receipt", async t => {
	const { a, worker, waiting } = await fixture(t, true);
	await streamCompletedResponse(a, "queued", "a1", "After failed notification."); await settle();
	worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
	const notice = notices(worker)[0]!;
	const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
	worker.emit({ type: "remote-handle", output: "unix:///synthetic/shared", id, utterance: notice.utterance });
	t.mock.method(worker, "cancel", () => 91 as never);
	worker.emit({ type: "error", utterance: notice.utterance, message: "Synthetic failure" });
	worker.emit({ type: "idle", cancelId: 91 }); await settle();
	assert.equal(segments(worker).at(-1)!.utterance, notice.utterance);
	worker.emit({ type: "idle", utterance: notice.utterance });
	assert.equal(waiting.waitingSessions()[0]!.announced, false);
	worker.emit({ type: "remote-released", id }); await new Promise(resolve => setTimeout(resolve, 300)); await settle();
	assert.equal(segments(worker).at(-1)!.text, "After failed notification.");
});

for (const action of ["pause", "reconnect"] as const) test(`idle-only notification releases after ${action} with no history target`, async t => {
	const { a, worker, waiting } = await fixture(t);
	await a.command("stop"); await settle();
	worker.emit({ type: "idle", utterance: notices(worker).at(-1)!.utterance }); await settle();
	waiting.clearWaiting(); waiting.markWaiting({ kind: "intentional_local" });
	const idle = new FakeVoiceHost(path.join(a.cwd, "idle-only"), "idle-only");
	try {
		await idle.start(); const output = MockedVoiceWorkerClient.instances.at(-1)!;
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.equal(notices(output).length, 1);
		if (action === "pause") {
			await idle.shortcut("f8"); output.emit({ type: "idle", utterance: notices(output)[0]!.utterance }); await settle();
			await idle.shortcut("f8");
		} else await idle.command("reconnect");
		await settle(); assert.equal(waiting.speechOwner(), undefined, "notification-only completion cannot strand an idle lease");
	} finally { await idle.shutdown(); }
});

test("reconnect retires a cancelled notification rather than leaving F8 on a dead utterance", async t => {
	const { a, worker, waiting } = await fixture(t, true);
	await a.shortcut("f8"); await settle();
	assert.equal(notices(worker).length, 1);
	await a.command("reconnect"); await settle();
	const before = worker.sent.length;
	await a.shortcut("f8"); await settle();
	assert.ok(worker.sent.length > before);
	assert.equal(segments(worker).at(-1)!.text, "Second sentence.");
	assert.equal(waiting.waitingSessions()[0]!.announced, false);
});

for (const dismiss of [true, false]) test(`Pause continuation superseded before stop proof: dismiss=${dismiss}`, async t => {
	const { a, worker, waiting } = await fixture(t);
	t.mock.method(worker, "cancel", () => 91 as never);
	await a.shortcut("f8"); await settle();
	if (dismiss) waiting.clearWaiting();
	else await a.command("stop");
	worker.emit({ type: "idle", cancelId: 91 }); await settle();
	assert.equal(notices(worker).length, dismiss ? 0 : 1, "only the latest authorized boundary can announce");
	if (!dismiss) {
		worker.emit({ type: "idle", utterance: notices(worker)[0]!.utterance }); await settle();
		const count = worker.sent.length;
		await a.shortcut("f8"); await settle();
		assert.equal(worker.sent.length, count, "Stop discards the old Resume snapshot");
	}
});

test("content-block EOF and model turn end without final physical EOF are not safe boundaries", async t => {
	const { a, worker, waiting } = await fixture(t);
	// Retire the fixture response, then start an independent live message.
	waiting.clearWaiting();
	worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
	const partial = assistant("First block. ", "pending");
	await a.emit("message_start", { message: partial });
	await a.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First block. " } }); await settle();
	const first = segments(worker).at(-1)!;
	waiting.markWaiting({ kind: "intentional_local" });
	worker.emit({ type: "idle", utterance: first.utterance }); await settle();
	assert.equal(notices(worker).length, 0, "streaming underrun cannot announce");
	partial.content.push({ type: "text", text: "Second block. " });
	await a.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Second block. " } }); await settle();
	const second = segments(worker).at(-1)!;
	const complete = { ...partial, stopReason: "stop" };
	a.addMessage("blocks", "a1", complete);
	await a.emit("message_end", { message: complete }); await a.emit("turn_end", { message: complete });
	assert.equal(notices(worker).length, 0, "model completion cannot announce over audio");
	worker.emit({ type: "idle", utterance: second.utterance }); await settle();
	assert.equal(notices(worker).length, 1);
});

for (const estimated of [false, true]) test(`paused notification preserves new local queues and confirmed-only offset (estimated=${estimated})`, async t => {
	const { a, worker } = await fixture(t);
	const first = segments(worker).find(segment => segment.text === "First sentence.")!;
	worker.emit({ ...first, type: "segment-audio", start: 0, duration: 6, audioIdentity: "matching-cache" });
	worker.emit({ type: "playback", utterance: first.utterance, position: 2, estimated });
	await a.shortcut("f8"); await settle();
	const notification = notices(worker)[0]!; assert.ok(notification);
	await streamCompletedResponse(a, "queued", "a1", "Queued during announcement."); await settle();
	const count = worker.sent.length;
	worker.emit({ type: "idle", utterance: notification.utterance }); await settle();
	assert.equal(worker.sent.length, count, "a paused message stays paused after the announcement");
	const send = t.mock.method(worker, "sendSegment");
	await a.shortcut("f8"); await settle();
	const resumed = send.mock.calls.find(call => call.arguments[2] === "First sentence.")!;
	assert.ok(resumed);
	assert.deepEqual((resumed.arguments as unknown[])[4], estimated ? undefined : { seconds: 2, audioIdentity: "matching-cache" });
	worker.emit({ type: "idle", utterance: segments(worker).at(-1)!.utterance }); await settle();
	assert.equal(segments(worker).at(-1)!.text, "Queued during announcement.", "no mutable snapshot may overwrite new queue entries");
});
