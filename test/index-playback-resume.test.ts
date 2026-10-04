import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { PlaybackHistory } from "../src/playback-history.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant, streamBlockedResponse, streamCompletedResponse } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve)); };

for (const finalText of ["First sentence.", "Replacement words must all be spoken.", "First sentence. Second sentence. ", "First sentence. Second sentence. Third sentence."]) {
	test(`paused announcement canonicalization resumes without skipping words: ${finalText}`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-resume-"));
		for (const [key, value] of Object.entries({ PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") })) {
			const old = process.env[key]; process.env[key] = value;
			t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
		}
		await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode: "assistant", output: "local", input: "disabled", codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
		const owner = new FakeVoiceHost(path.join(root, "owner"), "owner");
		const waiting = new FakeVoiceHost(path.join(root, "waiting"), "waiting");
		t.after(async () => { await owner.shutdown(); await waiting.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
		const coordinators: SessionCoordinator[] = [];
		const start = SessionCoordinator.prototype.start;
		t.mock.method(SessionCoordinator.prototype, "start", function(this: SessionCoordinator) { coordinators.push(this); start.call(this); });
		let history: PlaybackHistory | undefined;
		const snapshot = PlaybackHistory.prototype.resumeSnapshot;
		t.mock.method(PlaybackHistory.prototype, "resumeSnapshot", function(this: PlaybackHistory, ...args: Parameters<typeof snapshot>) { history = this; return snapshot.apply(this, args); });
		await owner.start(); const worker = MockedVoiceWorkerClient.instances.at(-1)!;
		await waiting.start();
		const message = assistant("First sentence. Second sentence. ", "pending");
		await owner.emit("message_start", { message });
		await owner.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message.content[0].text } });
		await settle();
		const segments = () => worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
		const second = segments().find(segment => segment.text === "Second sentence.")!;
		assert.ok(second);
		for (const segment of segments()) worker.emit({ ...segment, type: "segment-audio", start: segment === second ? 10 : 0, duration: 10, audioIdentity: `pcm-${segment.segmentId}` });
		worker.emit({ type: "playback", utterance: second.utterance, position: 12.5 });
		await streamCompletedResponse(waiting, "waiting-answer", "", "Waiting answer.");
		await owner.shortcut("f8"); await settle();
		const notice = segments().find(segment => segment.text.includes("requires attention next"))!;
		assert.ok(notice);
		worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
		assert.equal(coordinators[1]!.waitingSessions()[0]!.announced, true);
		const before = worker.sent.length;
		const complete = assistant(finalText);
		owner.addMessage("canonical", null, complete);
		await owner.emit("message_end", { message: complete });
		await owner.emit("turn_end", { message: complete });
		await owner.emit("agent_settled", {}); await settle();
		assert.equal(worker.sent.length, before, "finalization never autoplays paused content");
		assert.match(owner.widgetLines()!.join(" "), /Paused/);
		assert.equal(history?.selected()?.id, "canonical");
		const send = t.mock.method(worker, "sendSegment");
		await owner.shortcut("f8"); await settle();
		const appendOnly = finalText.startsWith(message.content[0].text);
		assert.deepEqual(segments().slice(before).map(segment => segment.text), appendOnly
			? ["Second sentence.", ...(finalText.includes("Third") ? ["Third sentence."] : [])] : [finalText]);
		const resumed = send.mock.calls[0]!;
		assert.ok(resumed, "shortened final text must not turn Resume into an empty suffix");
		assert.deepEqual((resumed.arguments as unknown[])[4], appendOnly ? { seconds: 2.5, audioIdentity: `pcm-${second.segmentId}` } : undefined);
		assert.equal(history?.selected()?.id, "canonical");
		assert.equal(owner.modelRequests.length + waiting.modelRequests.length, 0);
	});
}

for (const gatedStop of [false, true, "pause"] as const) for (const finalKind of ["shortened", "replacement", "empty", "removed", "removed-only"] as const) {
	if (gatedStop === "pause" && finalKind !== "removed") continue;
	test(`detached resume follows ${finalKind} final source before session insertion (gated stop=${gatedStop})`, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-resume-final-"));
		for (const [key, value] of Object.entries({ PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"), PI_VOICE_DEVICE_DIR: path.join(root, "devices") })) {
			const old = process.env[key]; process.env[key] = value;
			t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
		}
		await fs.writeFile(process.env.PI_VOICE_CONFIG!, JSON.stringify({ enabled: true, mode: "assistant", output: "local", input: "disabled", codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
		const owner = new FakeVoiceHost(path.join(root, "owner"), "owner");
		const waiting = new FakeVoiceHost(path.join(root, "waiting"), "waiting");
		t.after(async () => { await owner.shutdown(); await waiting.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
		await owner.start(); const worker = MockedVoiceWorkerClient.instances.at(-1)!;
		await waiting.start();
		const earlier = assistant("Earlier transcript stays.");
		owner.addMessage("earlier", null, earlier);
		const first = "First sentence. Obsolete second sentence. ";
		const remaining = "Remaining block must survive. ";
		const partial = { ...assistant("", "pending"), content: [{ type: "text", text: first }] };
		await owner.emit("message_start", { message: partial });
		await owner.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: first } });
		if (finalKind !== "removed-only") {
			partial.content.push({ type: "text", text: remaining });
			await owner.emit("message_update", { message: structuredClone(partial), assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: remaining } });
		}
		await settle();
		const segments = () => worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
		const second = segments().find(segment => segment.text === "Obsolete second sentence.")!;
		assert.ok(second);
		for (const segment of segments()) worker.emit({ ...segment, type: "segment-audio", start: segment === second ? 10 : 0, duration: 10, audioIdentity: `pcm-${segment.segmentId}` });
		worker.emit({ type: "playback", utterance: second.utterance, position: 12.5 });
		await streamCompletedResponse(waiting, "waiting-answer", "", "Waiting answer.");
		await owner.shortcut("f8"); await settle();
		const notice = segments().find(segment => segment.text.includes("requires attention next"))!;
		assert.ok(notice);
		worker.emit({ type: "idle", utterance: notice.utterance }); await settle();
		const before = worker.sent.length;
		const send = t.mock.method(worker, "sendSegment");
		const cancel = gatedStop ? t.mock.method(worker, "cancel", () => 901 as never) : undefined;
		if (gatedStop) {
			await owner.shortcut("f8"); await settle();
			assert.equal(cancel!.mock.callCount(), 1, "Resume is waiting for the old sink's receipt");
			assert.equal(worker.sent.length, before);
		}
		const finalText = finalKind === "shortened" ? "First sentence." : finalKind === "replacement" ? "Replacement words must all be spoken." : "";
		const finalRemaining = "Final remaining block must survive.";
		const complete = { ...assistant(""), content: finalKind === "removed-only" ? [] : [
			finalKind === "removed" ? { type: "toolCall", id: "call", name: "read", arguments: {} } : { type: "text", text: finalText },
			{ type: "text", text: finalRemaining },
		] };
		await owner.emit("message_end", { message: complete });
		await owner.emit("turn_end", { message: complete });
		await owner.emit("agent_settled", {}); await settle();
		assert.equal(worker.sent.length, before, "source finalization does not autoplay");
		if (!gatedStop) assert.match(owner.widgetLines()!.join(" "), /Paused/);
		if (finalKind !== "removed-only") {
			if (gatedStop) {
				// Another assistant/tool response, not a new user intent cancelling replay.
				await streamBlockedResponse(owner, "Newer response must survive.");
				owner.addMessage("newer", null, assistant("Newer response must survive."));
				await settle();
			} else await streamCompletedResponse(owner, "newer", "", "Newer response must survive.");
		}
		assert.equal(worker.sent.length, before, "newer queued messages do not autoplay either");
		if (gatedStop === "pause") await owner.shortcut("f8");
		if (gatedStop) {
			cancel!.mock.restore();
			worker.emit({ type: "idle", cancelId: 901 });
		} else await owner.shortcut("f8");
		await settle();
		if (gatedStop === "pause") {
			assert.equal(worker.sent.length, before, "retirement preserves a newer Pause intent");
			assert.match(owner.widgetLines()!.join(" "), /Paused/);
			await owner.shortcut("f8"); await settle();
		}
		assert.deepEqual(segments().slice(before).map(segment => segment.text), gatedStop && finalText ? [finalText, finalRemaining] : finalText ? [finalText]
			: finalKind === "removed-only" ? [] : [finalRemaining], "Resume must use the final source even without a persisted canonical entry");
		if (finalText && !gatedStop) { worker.emit({ type: "idle", utterance: segments().at(-1)!.utterance }); await settle(); }
		if (finalKind !== "removed-only") {
			assert.equal(segments().at(-1)!.text, finalRemaining);
			worker.emit({ type: "idle", utterance: segments().at(-1)!.utterance }); await settle();
			assert.deepEqual(segments().slice(before).map(segment => segment.text), [
				...(finalText ? [finalText] : []), finalRemaining, "Newer response must survive.",
			], "remaining blocks and newer messages retain their queue order");
		}
		for (const call of send.mock.calls) assert.equal((call.arguments as unknown[])[4], undefined, "destructive finalization retires old audio offsets");
		owner.addMessage("canonical", null, complete);
		await settle();
		assert.equal(owner.entries.find(entry => entry.id === "canonical")?.message, complete, "final transcript stays intact");
		assert.equal(owner.entries.find(entry => entry.id === "earlier")?.message, earlier, "retirement preserves unrelated transcript");
		if (finalKind !== "removed-only") assert.equal(owner.entries.find(entry => entry.id === "newer")?.message.content[0].text, "Newer response must survive.");
		assert.equal(owner.modelRequests.length + waiting.modelRequests.length, 0);
	});
}
