import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { mock } from "node:test";
import { DeviceRouter } from "../src/device-router.js";
import { PhoneInputClient } from "../src/phone-input.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function setup(t: import("node:test").TestContext) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-stop-proof-"));
 const env = { PI_VOICE_CONFIG: path.join(root, "config"), PI_VOICE_DEVICE_DIR: path.join(root, "devices"), PI_VOICE_COORDINATOR_DIR: path.join(root, "coordinator") };
 const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
 Object.assign(process.env, env);
 await fs.mkdir(env.PI_VOICE_DEVICE_DIR);
 const registration = { version: 1, id: "A", name: "A", platform: "termux", audioEndpoint: "unix:///old-output", inputEndpoint: "unix:///old-input", connectedAt: 1, lastActive: 1 };
 const register = () => fs.writeFile(path.join(env.PI_VOICE_DEVICE_DIR, "A.json"), JSON.stringify(registration));
 await register();
 await fs.writeFile(env.PI_VOICE_CONFIG, JSON.stringify({ enabled: true, mode: "all", audioCache: false, timingPreprocessConcurrency: 0, codeDescriptionPreprocessConcurrency: 0 }));
 t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "A" }));
 const host = new FakeVoiceHost(root, "proof");
 const index = MockedVoiceWorkerClient.instances.length;
 await host.start();
 const worker = MockedVoiceWorkerClient.instances[index]!;
 const lease = path.join(env.PI_VOICE_COORDINATOR_DIR, "speech.lock", "lease.json");
 t.after(async () => {
  t.mock.restoreAll();
  await host.shutdown().catch(() => {});
  for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await fs.rm(root, { recursive: true, force: true });
 });
 return { host, worker, lease, registration, register };
}

test("timeout awaits termination proof; failed termination retains lease and blocks microphone/audio", async t => {
 const { host, worker, lease } = await setup(t);
 await host.command("test Old audio.");
 const sent = worker.sent.length;
 t.mock.method(worker, "cancel", () => 91 as never);
 const termination = Promise.withResolvers<void>();
 const terminate = t.mock.method(worker, "terminate", () => termination.promise);
 const capture = t.mock.method(PhoneInputClient.prototype, "capture", async () => { throw new Error("unexpected capture"); });
 t.mock.timers.enable({ apis: ["setTimeout"] });
 await host.emit("message_end", { message: assistant("Old audio.", "aborted") });
 // Test speech is replay-purpose; Stop must also be nonblocking.
 await host.command("stop");
 await host.emit("input", {});
 await host.emit("before_agent_start", {});
 t.mock.timers.tick(1000); await settle();
 assert.ok(terminate.mock.callCount());
 assert.ok(await fs.stat(lease));
 const talk = host.command("talk");
 await settle(); assert.equal(capture.mock.callCount(), 0);
 termination.reject(new Error("remote stop unconfirmed"));
 await talk; await settle();
 await host.command("test Must remain silent.");
 assert.equal(worker.sent.length, sent);
 assert.equal(capture.mock.callCount(), 0);
 assert.ok(await fs.stat(lease));
 assert.ok(host.notices.some(notice => /ownership retained/.test(notice.message)));
 t.mock.timers.reset();
});

test("same-ID changed endpoint/generation rebuild waits for proof and gates deltas, turn cleanup and talk", async t => {
 const { host, worker, lease, registration, register } = await setup(t);
 const partial = assistant("First. ", "pending");
 await host.emit("message_start", { message: partial });
 await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First. " } });
 await host.shortcut("f8");
 registration.audioEndpoint = "unix:///new-output"; registration.inputEndpoint = "unix:///new-input"; registration.connectedAt++;
 await register();
 const termination = Promise.withResolvers<void>();
 const terminate = t.mock.method(worker, "terminate", () => termination.promise);
 const capture = t.mock.method(PhoneInputClient.prototype, "capture", async () => { throw new Error("fixture capture"); });
 const reconnect = host.command("reconnect"); await settle();
 assert.equal(terminate.mock.callCount(), 1);
 const count = worker.sent.length;
 await host.emit("message_update", { message: assistant("First. Retained. ", "pending"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Retained. " } });
 await host.emit("before_agent_start", {});
 const talk = host.command("talk"); await settle();
 assert.equal(worker.sent.length, count); assert.equal(capture.mock.callCount(), 0);
 assert.ok(await fs.stat(lease));
 termination.resolve(); await reconnect; await talk; await settle();
 assert.equal(capture.mock.callCount(), 1);
});

test("failed rebind keeps its barrier and lease through later playback and shutdown", async t => {
 const { host, worker, lease, registration, register } = await setup(t);
 await host.command("test Owned audio.");
 const count = worker.sent.length;
 registration.connectedAt++; await register();
 t.mock.method(worker, "terminate", async () => { throw new Error("unconfirmed remote stop"); });
 await host.command("reconnect");
 await host.command("test Must not play.");
 assert.equal(worker.sent.length, count);
 assert.ok(await fs.stat(lease));
 await assert.rejects(host.shutdown(), /unconfirmed remote stop/);
 assert.ok(await fs.stat(lease));
 assert.ok(host.notices.some(notice => /shutdown stop failed; ownership retained/.test(notice.message)));
});

test("recording stop uses captured endpoint even after registry disappears", async t => {
 const { host, registration } = await setup(t);
 const captured = Promise.withResolvers<any>();
 t.mock.method(PhoneInputClient.prototype, "capture", () => captured.promise);
 const stop = t.mock.method(PhoneInputClient.prototype, "stop", async (endpoint: string) => { assert.equal(endpoint, registration.inputEndpoint); captured.resolve({ type: "text", data: "" }); });
 const recording = host.command("talk"); await settle();
 await fs.rm(path.join(process.env.PI_VOICE_DEVICE_DIR!, "A.json"));
 await host.command("talk"); await recording; await settle();
 assert.equal(stop.mock.callCount(), 1);
});

test("voice test rechecks cancellation after ownership activation before any prefix or segment", async t => {
 const { host, worker } = await setup(t);
 const acquire = SessionCoordinator.prototype.forceAcquireSpeech;
 t.mock.method(SessionCoordinator.prototype, "forceAcquireSpeech", async function(this: SessionCoordinator) {
  const result = await acquire.call(this);
  // Queue Stop after the acquisition continuation, before its caller resumes.
  queueMicrotask(() => queueMicrotask(() => { void host.command("stop"); }));
  return result;
 });
 await host.command("test Obsolete speech."); await settle();
 assert.equal(worker.sent.length, 0);
});
