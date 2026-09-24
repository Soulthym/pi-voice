import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant, streamCompletedResponse } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test("sticky pause queues new responses; settings preserve ownership and dirty assets require one explicit resume", async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-ownership-"));
	const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
	process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
	process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
	await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local", audioCache: false }));
	const host = new FakeVoiceHost(root, "owner");
	const observer = new SessionCoordinator(path.join(root, "other"), "other"); observer.start();
	t.after(async () => {
		await host.shutdown(); observer.shutdown();
		keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
		await fs.rm(root, { recursive: true, force: true });
	});
	host.addMessage("first", null, assistant("First sentence. Second sentence."));
	const workerIndex = MockedVoiceWorkerClient.instances.length;
	await host.start();
	assert.equal(observer.tryAcquireSpeech(), true);
	const replay = host.shortcut("f5");
	await settle();
	assert.match(host.widgetLines()![0], /Queued/, "actual acquisition waits on the other project's lease");
	MockedVoiceWorkerClient.instances[workerIndex]!.emit({ type: "playback-phase", utterance: 999, segmentId: 999, phase: "loading" });
	await settle();
	assert.match(host.widgetLines()![0], /Queued/, "unrelated worker loading cannot replace ownership wait");
	assert.ok(!host.widgetOperations.some(operation => operation.value?.lines?.some(line => /Describing/.test(line))), "context preparation without API work is never Describing");
	assert.ok(host.widgetOperations.some(operation => operation.value?.lines?.some(line => /Connecting/.test(line))), "device handoff is Connecting");
	observer.releaseSpeech();
	await replay;
	await new Promise(resolve => setTimeout(resolve, 150)); await settle();
	const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
	const segments = worker.sent as Array<{ text: string; utterance: number; segmentId: number }>;
	const first = segments.find(segment => segment.text === "First sentence.")!;
	const ownerId = observer.speechOwner()!.instanceId;
	for (const earlier of segments) if (earlier.utterance < first.utterance) worker.emit({ type: "idle", utterance: earlier.utterance });
	worker.emit({ type: "playback-phase", utterance: first.utterance, segmentId: first.segmentId, phase: "playing" });
	worker.emit({ type: "speaking" });
	for (const command of ["highlight off", "autoscroll off", "input local", "stt-model test/mic", "stt-dtype q8", "edit-model other/model"]) {
		const pauses = worker.pauses.length;
		await host.command(command);
		assert.match(host.widgetLines()![0], /Playing/, command);
		assert.equal(worker.pauses.length, pauses, command);
		assert.equal(observer.speechOwner()?.instanceId, ownerId, command);
	}
	await host.shortcut("f8");
	assert.equal(worker.pauses.at(-1), true);
	const before = segments.length;
	observer.markWaiting();
	await streamCompletedResponse(host, "second", "first", "Queued response.");
	assert.equal(segments.length, before, "incoming response stays silent while paused");
	assert.equal(worker.pauses.at(-1), true);
	assert.match(host.widgetLines()?.join(" ") ?? "", /⏯ Paused.*message 1\/2/);
	assert.equal(observer.speechOwner()?.instanceId, ownerId);
	await host.shortcut("f8");
	assert.equal(worker.pauses.at(-1), false);
	worker.emit({ type: "idle", utterance: first.utterance }); await settle();
	assert.equal(segments.at(-1)?.text, "Queued response.", "resume drains queued project responses before announcements");
	assert.equal(segments.some(segment => segment.text.includes("requires attention next")), false);
	worker.emit({ type: "idle", utterance: segments.at(-1)!.utterance }); await settle();
	assert.ok(segments.at(-1)?.text.includes("requires attention next"));

	await host.shortcut("f5"); await settle();
	for (const command of ["voice af_bella", "speed 1.2", "tts-model test/tts", "tts-dtype fp32"]) {
		worker.emit({ type: "speaking" });
		const count = segments.length;
		const pending = host.command(command);
		assert.equal(worker.pauses.at(-1), true, `dirty pause must precede config persistence: ${command}`);
		await pending; await settle();
		assert.equal(segments.length, count, "new assets must not auto-restart playback");
		assert.equal(observer.speechOwner()?.instanceId, ownerId);
		await host.shortcut("f8"); await settle();
		assert.equal(worker.pauses.at(-1), false, "one resume recreates an unpaused sink");
		assert.ok(segments.length > count);
	}
	await host.shortcut("f8");
	await host.shortcut("f6"); await settle();
	assert.equal(worker.pauses.at(-1), true, "message navigation retains pause");
	await host.shortcut("f9"); await settle();
	assert.equal(worker.pauses.at(-1), true, "sentence navigation retains pause");
	await host.shortcut("f5"); await settle();
	assert.equal(worker.pauses.at(-1), false, "explicit replay exits tail/paused state");
	observer.clearWaiting();
	await host.shortcut("f10"); await settle();
	worker.emit({ type: "idle", utterance: segments.at(-1)!.utterance }); await settle();
	await host.shortcut("f10");
	const completed = segments.length;
	await host.shortcut("f8"); await settle();
	assert.equal(segments.length, completed, "F8 pauses completed live intent without recreating playback");
	assert.match(host.widgetLines()![0], /Paused/);
	await host.shortcut("f5"); await settle(); // Explicit replay recreates transport for the lease test below.
	assert.equal(worker.pauses.at(-1), false);

	// Resume before the incoming response has finished: keep the lease between
	// the old transport draining and the new response becoming playable.
	await host.shortcut("f8");
	const oldUtterance = segments.at(-1)!.utterance;
	const late = assistant("Late queued response.");
	await host.emit("before_agent_start", {});
	await host.emit("message_start", { message: late });
	await host.shortcut("f8");
	worker.emit({ type: "idle", utterance: oldUtterance }); await settle();
	assert.equal(observer.speechOwner()?.instanceId, ownerId);
	host.addMessage("late", "second", late);
	await host.emit("message_end", { message: late });
	await host.emit("turn_end", { message: late }); await settle();
	assert.equal(segments.at(-1)!.text, "Late queued response.");

	// Dirty a live asset before message_end; its eventual completed text must
	// remain resumable without either auto-starting or queueing a duplicate.
	const dirty = assistant("Live dirty response.");
	// Missing cancellation IDs now require asynchronous termination proof.
	await host.emit("before_agent_start", {}); await settle();
	await host.emit("message_start", { message: dirty });
	await host.emit("message_update", { message: dirty, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Live dirty response." } });
	await host.command("speed 1.3");
	const dirtyCount = segments.length;
	host.addMessage("dirty", "late", dirty);
	await host.emit("message_end", { message: dirty });
	await host.emit("turn_end", { message: dirty }); await settle();
	assert.equal(segments.length, dirtyCount);
	assert.equal(worker.pauses.at(-1), true);
	await host.shortcut("f8"); await settle();
	assert.equal(worker.pauses.at(-1), false);
	assert.equal(segments.at(-1)!.text, "Live dirty response.");
	worker.emit({ type: "idle", utterance: segments.at(-1)!.utterance }); await settle();
	assert.equal(segments.length, dirtyCount + 1, "the dirty message must not replay a second copy");
});

for (const paused of [false, true]) {
	test(paused ? "paused multi-block code persisted after message_end resumes with assistant context" : "independent delayed block descriptions retain the lease until the last idle", async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-block-ownership-"));
		const keys = ["PI_VOICE_CONFIG", "PI_VOICE_COORDINATOR_DIR", "PI_VOICE_DEVICE_DIR"];
		const previous = keys.map(key => process.env[key]);
		process.env.PI_VOICE_CONFIG = path.join(root, "config.json");
		process.env.PI_VOICE_COORDINATOR_DIR = path.join(root, "coordinator");
		process.env.PI_VOICE_DEVICE_DIR = path.join(root, "devices");
		await fs.writeFile(process.env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, input: "disabled", output: "local", audioCache: false,
			codeNarration: "summary", codeDescriptionContext: "conversation", codeDescriptionPreprocessConcurrency: 0, timingPreprocessConcurrency: 0 }));
		const descriptions = [Promise.withResolvers<any>(), Promise.withResolvers<any>()];
		const host = new FakeVoiceHost(root, "blocks", request => descriptions[JSON.stringify(request.context.messages.at(-2)).includes("secondAction") ? 1 : 0]!.promise);
		const observer = new SessionCoordinator(path.join(root, "other"), "other"); observer.start();
		t.after(async () => {
			descriptions.forEach(response => response.resolve(assistant("Cleanup description.")));
			await host.shutdown(); observer.shutdown();
			keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
			await fs.rm(root, { recursive: true, force: true });
		});
		if (paused) host.addMessage("initial", null, assistant("Initial response."));
		const workerIndex = MockedVoiceWorkerClient.instances.length;
		await host.start();
		const worker = MockedVoiceWorkerClient.instances[workerIndex]!;
		const segments = worker.sent as Array<{ text: string; utterance: number }>;
		if (paused) { await host.shortcut("f5"); await settle(); await host.shortcut("f8"); }
		const oldUtterance = segments.at(-1)?.utterance;
		const message = assistant("");
		message.content = ["firstAction", "secondAction"].map(name => ({ type: "text", text: `\`\`\`ts\n${name}();\n\`\`\`` }));
		await host.emit("before_agent_start", {});
		await host.emit("message_start", { message });
		for (const [contentIndex, block] of message.content.entries()) {
			await host.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex, delta: block.text } });
		}
		await host.emit("message_end", { message });
		// Pi persists the assistant only after extension message_end handlers return.
		host.addMessage("answer", paused ? "initial" : null, message);
		await host.emit("turn_end", { message });
		await new Promise(resolve => setTimeout(resolve, 50));
		await settle();
		const ownerId = observer.speechOwner()?.instanceId;
		assert.ok(ownerId);
		if (paused) {
			assert.equal(host.modelRequests.length, 0);
			await host.shortcut("f8");
			worker.emit({ type: "idle", utterance: oldUtterance! }); await settle();
		} else assert.equal(host.modelRequests.length, 2, "both block descriptions start independently");
		// The project announcement precedes foreground descriptions on a fresh turn.
		if (!paused) for (const segment of segments) worker.emit({ type: "idle", utterance: segment.utterance });
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.match(host.widgetLines()![0], /Describing/, "foreground awaits its actual description");
		descriptions[0]!.resolve(assistant("First code description.")); await settle();
		const first = segments.find(segment => segment.text === "First code description.");
		assert.ok(first);
		worker.emit({ type: "idle", utterance: first.utterance }); await settle();
		assert.equal(observer.speechOwner()?.instanceId, ownerId, "first idle cannot release the pending second block's lease");
		assert.equal(host.modelRequests.length, 2);
		for (const [index, request] of host.modelRequests.entries()) {
			const concerned = request.context.messages.at(-2) as any;
			assert.equal(concerned.role, "assistant");
			assert.match(JSON.stringify(concerned), new RegExp(index === 0 ? "firstAction" : "secondAction"));
		}
		descriptions[1]!.resolve(assistant("Second code description.")); await settle();
		const second = segments.find(segment => segment.text === "Second code description.");
		assert.ok(second);
		assert.notEqual(second.utterance, first.utterance);
		worker.emit({ type: "idle", utterance: second.utterance }); await settle();
		assert.equal(observer.speechOwner(), undefined, "last idle releases the lease");
		assert.equal(segments.filter(segment => segment.text.endsWith("code description.")).length, 2);
	});
}
