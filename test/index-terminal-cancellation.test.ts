import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", {
	namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient },
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const paused of [false, true]) for (const stopReason of ["aborted", "error"]) {
	for (const replacement of ["none", "replay", "session"] as const) {
		test(`terminal ${stopReason} (paused: ${paused}) returns before transport ack; ${replacement} replacement fences lease release`, async t => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-terminal-cancellation-"));
			const env = {
				PI_VOICE_CONFIG: path.join(root, "voice.json"),
				PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"),
				PI_VOICE_DEVICE_DIR: path.join(root, "devices"),
			};
			const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
			await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({
				enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false,
				timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0,
			}));
			Object.assign(process.env, env);
			const host = new FakeVoiceHost(path.join(root, "project"), "terminal");
			t.after(async () => {
				await host.shutdown();
				for (const [key, value] of Object.entries(previous)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				await fs.rm(root, { recursive: true, force: true });
			});
			host.addMessage("history", null, assistant("A historical response to replay."));
			const workerIndex = MockedVoiceWorkerClient.instances.length;
			await host.start();
			const worker = MockedVoiceWorkerClient.instances[workerIndex];
			assert.ok(worker);
			const partial = assistant("An interrupted response.", "pending");
			await host.emit("message_start", { type: "message_start", message: partial });
			await host.emit("message_update", {
				type: "message_update", message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "An interrupted response. ", partial },
			});
			for (let i = 0; i < 16; i++) await tick();
			const segment = worker.sent.at(-1) as { utterance: number; segmentId: number };
			worker.emit({ type: "idle", utterance: segment.utterance });
			await new Promise(resolve => setTimeout(resolve, 100));
			assert.match(host.widgetLines()![0]!, /Queued.*\[[●━]/, "IDLE between chunks retains the queued live transport");
			if (paused) {
				await host.shortcut("f8");
				await host.emit("message_update", {
					message: partial,
					assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Another block while paused. " },
				});
				assert.match(host.widgetLines()![0]!, /Paused/);
			}
			const leasePath = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
			const originalLease = await fs.readFile(leasePath, "utf8");
			const cancelId = 71;
			const cancel = t.mock.method(worker, "cancel", () => cancelId);
			let ended = false;
			const ending = host.emit("message_end", {
				type: "message_end", message: assistant("An interrupted response.", stopReason),
			}).then(() => { ended = true; });
			await tick();
			assert.equal(cancel.mock.callCount(), 1, "terminal message must cancel the transport");
			assert.equal(ended, true, "message_end must settle without waiting for transport acknowledgement");
			await ending;
			assert.match(host.widgetLines()![0]!, /Idle/, "logical cancellation repaints before ACK");
			const sent = worker.sent.length;
			await host.emit("message_update", {
				message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Late cancelled sentence. " },
			});
			for (const event of [
				{ type: "speaking" }, { type: "playback", utterance: segment.utterance, position: 2 },
				{ type: "idle", utterance: segment.utterance }, { type: "ready" },
			] as const) {
				worker.emit(event);
				await new Promise(resolve => setTimeout(resolve, 90));
				assert.match(host.widgetLines()![0]!, /Idle/, "late events cannot revive cancelled playback");
			}
			await host.shortcut("f8");
			assert.equal(worker.sent.length, sent, "F8 and late source deltas cannot restart cancelled speech");
			assert.equal(await fs.readFile(leasePath, "utf8"), originalLease, "retain ownership until cancellation is acknowledged");
			cancel.mock.restore();

			// An unrelated ack must not complete the pending cancellation.
			worker.emit({ type: "idle", cancelId: cancelId - 1 });
			await tick();
			assert.equal(await fs.readFile(leasePath, "utf8"), originalLease);

			if (replacement === "replay") {
				await host.shortcut("f5");
				await tick();
				assert.ok(!worker.sent.some(segment => (segment as { text: string }).text.includes("historical response")), "replacement waits for stop proof");
				worker.emit({ type: "idle", cancelId });
				for (let i = 0; i < 10; i++) await tick();
				assert.ok(worker.sent.some(segment => (segment as { text: string }).text.includes("historical response")));
			} else if (replacement === "session") {
				await host.shutdown();
				host.sessionManager.getSessionId = () => "replacement-session";
				await host.emit("session_start", { type: "session_start" });
				await host.emit("message_start", { type: "message_start", message: partial });
			}
			const currentLease = await fs.readFile(leasePath, "utf8");
			worker.emit({ type: "idle", cancelId });
			await tick();
			if (replacement === "none") {
				await assert.rejects(fs.stat(leasePath), { code: "ENOENT" });
				worker.emit({ type: "speaking" });
				worker.emit({ type: "playback", utterance: segment.utterance, position: 3 });
				await new Promise(resolve => setTimeout(resolve, 90));
				assert.match(host.widgetLines()![0]!, /Idle/, "ACK must not revive the cancelled source");
			} else {
				assert.equal(await fs.readFile(leasePath, "utf8"), currentLease, "late terminal ack must not release replacement ownership");
				// The replacement really owns speech, rather than leaving an orphan lock.
				const replay = worker.sent.at(-1) as { utterance: number };
				if (replacement === "replay") worker.emit({ type: "idle", utterance: replay.utterance });
				else await host.emit("message_end", { type: "message_end", message: assistant("", stopReason) });
				await tick();
				await assert.rejects(fs.stat(leasePath), { code: "ENOENT" });
			}
		});
	}
}

for (const scenario of ["first queued failure", "unrelated paused abort", "unrelated paused error"] as const) {
	test(scenario, async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-voice-queue-failure-"));
		const env = {
			PI_VOICE_CONFIG: path.join(root, "voice.json"),
			PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator"),
			PI_VOICE_DEVICE_DIR: path.join(root, "devices"),
		};
		const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
		await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({
			enabled: true, mode: "assistant", input: "disabled", output: "local", audioCache: false,
			timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0,
		}));
		Object.assign(process.env, env);
		const host = new FakeVoiceHost(path.join(root, "project"), "queue-failure");
		t.after(async () => {
			await host.shutdown();
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await fs.rm(root, { recursive: true, force: true });
		});
		host.addMessage("history", null, assistant("A historical response to preserve."));
		const workerIndex = MockedVoiceWorkerClient.instances.length;
		await host.start();
		const worker = MockedVoiceWorkerClient.instances[workerIndex];
		const leasePath = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
		if (scenario !== "first queued failure") {
			await host.shortcut("f5");
			await host.shortcut("f8");
		}
		const partial = assistant("First queued sentence.", "pending");
		await host.emit("message_start", { message: partial });
		await host.emit("message_update", {
			message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First queued sentence. " },
		});
		for (let i = 0; i < 16; i++) await tick();
		const lease = await fs.readFile(leasePath, "utf8");
		if (scenario !== "first queued failure") {
			const before = host.widgetLines();
			const sent = worker.sent.length;
			const pauses = worker.pauses.length;
			const cancel = t.mock.method(worker, "cancel");
			const message = assistant("First queued sentence.", scenario.endsWith("error") ? "error" : "aborted");
			host.addMessage("cancelled", "history", message);
			await host.emit("message_end", { message });
			await host.emit("turn_end", { message });
			assert.equal(cancel.mock.callCount(), 0);
			assert.equal(worker.sent.length, sent);
			assert.equal(worker.pauses.length, pauses);
			assert.deepEqual(host.widgetLines(), before, "unrelated historical position stays paused");
			assert.equal(await fs.readFile(leasePath, "utf8"), lease);
			assert.ok(host.entries.some(entry => entry.id === "cancelled"), "saved transcript survives cancellation");
			await host.shortcut("f8");
			assert.equal(worker.pauses.at(-1), false, "historical playback remains resumable");
			return;
		}
		const first = worker.sent.at(-1) as { utterance: number };
		await host.emit("message_update", {
			message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Second queued sentence. " },
		});
		for (let i = 0; i < 16; i++) await tick();
		const second = worker.sent.at(-1) as { utterance: number };
		assert.notEqual(first.utterance, second.utterance, "two current utterances must be queued");
		const cancelId = 91;
		const cancel = t.mock.method(worker, "cancel", () => cancelId);
		worker.emit({ type: "error", utterance: first.utterance, message: "first synthesis failed" });
		assert.equal(cancel.mock.callCount(), 1, "failure of the first, not latest, cancels the whole queue");
		await new Promise(resolve => setTimeout(resolve, 90));
		assert.doesNotMatch(host.widgetLines()![0]!, /Playing|Paused|Queued|Synthesizing|Loading|live/);
		const sent = worker.sent.length;
		await host.shortcut("f8");
		assert.equal(worker.sent.length, sent);
		assert.equal(await fs.readFile(leasePath, "utf8"), lease, "withheld ACK retains the lease");
		const notices = host.notices.length;
		worker.emit({ type: "error", utterance: second.utterance, message: "retired ordinary failure" });
		assert.equal(host.notices.length, notices, "ordinary retired errors are ignored");
		worker.emit({ type: "error", utterance: second.utterance, code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "retired remote stop uncertain" });
		assert.equal(host.notices.length, notices + 1, "retired remote uncertainty must not be discarded");
		worker.emit({ type: "error", utterance: second.utterance, message: "another retired ordinary failure" });
		assert.equal(host.notices.length, notices + 1);
		worker.emit({ type: "idle", cancelId: cancelId - 1 });
		await tick();
		assert.equal(await fs.readFile(leasePath, "utf8"), lease, "unrelated ACK is not proof");
		worker.emit({ type: "idle", cancelId });
		await tick();
		await assert.rejects(fs.stat(leasePath), { code: "ENOENT" });
		cancel.mock.restore();
		await host.shortcut("f8");
		assert.equal(worker.sent.length, sent, "F8 cannot revive the failed queue after proof either");
	});
}
