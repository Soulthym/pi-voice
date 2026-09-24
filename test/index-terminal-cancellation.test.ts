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

for (const stopReason of ["aborted", "error"]) {
	for (const replacement of ["none", "replay", "session"] as const) {
		test(`terminal ${stopReason} returns before transport ack; ${replacement} replacement fences lease release`, async t => {
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
			assert.equal(worker.sent.length, sent, "late source delta cannot restart cancelled speech");
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
