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

test("canonical remote failure is one episode and same-route reconnect retries the original client before repinning", async t => {
 const { host, worker, lease } = await setup(t);
 await host.command("test Old audio.");
 const utterance = (worker.sent.at(-1) as { utterance: number }).utterance;
 t.mock.method(worker, "cancel", () => 91 as never);
 const terminate = t.mock.method(worker, "terminate", async () => { throw new Error("original handle unavailable"); });
 t.mock.timers.enable({ apis: ["setTimeout"] });
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "Remote playback unconfirmed: write EPIPE", utterance });
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "Remote playback unconfirmed: helper exited", utterance });
 await host.command("stop");
 await host.emit("input", {});
 await host.emit("before_agent_start", {});
 t.mock.timers.tick(1000); await settle();
 assert.equal(host.notices.filter(notice => notice.level === "error").length, 1);
 assert.match(host.notices.find(notice => notice.level === "error")!.message, /EPIPE.*original device.*reconnect/);
 assert.ok(await fs.stat(lease));
 const pins = () => host.entries.filter(entry => entry.type === "custom" && entry.customType === "pi-voice.device-selection").length;
 const before = pins();
 await host.command("reconnect"); await settle();
 assert.equal(pins(), before, "failed retry cannot change the pin");
 assert.ok(host.notices.some(notice => /original handle unavailable/.test(notice.message)), "retry result remains visible");
 const stopped = Promise.withResolvers<void>();
 terminate.mock.mockImplementation(() => stopped.promise);
 const retry = host.command("reconnect"); await settle();
 assert.equal(pins(), before);
 assert.ok(await fs.stat(lease));
 stopped.resolve(); await retry; await settle();
 assert.equal(pins(), before + 1);
 assert.ok(terminate.mock.callCount() >= 3, "same worker client survives failures and retries");
 const errors = host.notices.filter(notice => notice.level === "error").length;
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "Remote playback unconfirmed: new stream failure", utterance: utterance + 1 });
 assert.equal(host.notices.filter(notice => notice.level === "error").length, errors + 1, "a distinct failure is not suppressed");
 assert.match(host.notices.at(-1)!.message, /new stream failure/);
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

for (const phase of ["resolution", "termination"]) test(`Talk waits through ${phase} and complete A-to-B adoption`, async t => {
 const { host, worker, registration } = await setup(t);
 await host.command("test Old audio.");
 await fs.writeFile(path.join(process.env.PI_VOICE_DEVICE_DIR!, "B.json"), JSON.stringify({ ...registration, id: "B", inputEndpoint: "unix:///B-input", audioEndpoint: "unix:///B-output" }));
 const resolved = Promise.withResolvers<{ kind: "device"; id: string }>();
 t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => resolved.promise);
 const stopped = Promise.withResolvers<void>();
 t.mock.method(worker, "terminate", () => stopped.promise);
 const capture = t.mock.method(PhoneInputClient.prototype, "capture", async (endpoint: string) => {
  assert.equal(endpoint, "unix:///B-input");
  assert.ok(host.entries.some(entry => entry.type === "custom" && entry.customType === "pi-voice.device-selection" && entry.data.pin === "B"));
  return { type: "text" as const, data: "" };
 });
 const reconnect = host.command("reconnect"); await settle();
 if (phase === "termination") { resolved.resolve({ kind: "device", id: "B" }); await settle(); }
 await host.command("talk"); await settle();
 assert.equal(capture.mock.callCount(), 0);
 resolved.resolve({ kind: "device", id: "B" }); await settle();
 stopped.resolve(); await reconnect; await settle();
 assert.equal(capture.mock.callCount(), 1);
 await host.command("input");
 assert.ok(host.notices.some(notice => notice.message.includes("B-input")));
});

for (const change of ["endpoint", "generation"]) test(`same-ID input ${change} change finalizes capture with intentional local output`, async t => {
 const { host, registration, register } = await setup(t);
 await host.command("output local");
 const recording = Promise.withResolvers<any>();
 const capture = t.mock.method(PhoneInputClient.prototype, "capture", () => recording.promise);
 await host.command("talk"); await settle();
 assert.equal(capture.mock.callCount(), 1);
 const stopped = Promise.withResolvers<void>();
 const stop = t.mock.method(PhoneInputClient.prototype, "stop", () => stopped.promise);
 let editor = "";
 host.ctx.ui.getEditorText = () => editor;
 host.ctx.ui.setEditorText = (text: string) => { editor = text; };
 if (change === "endpoint") registration.inputEndpoint = "unix:///replacement-input";
 else registration.connectedAt++;
 await register();
 let adopted = false;
 const reconnect = host.command("reconnect").then(() => { adopted = true; }); await settle();
 assert.ok(stop.mock.callCount(), "input metadata must be compared independently of output");
 assert.equal(adopted, false, "pin adoption awaits capture stop proof");
 stopped.resolve(); recording.resolve({ type: "text", data: "Preserved draft" });
 await reconnect; await settle();
 assert.match(editor, /Preserved draft/, "reconnect finalizes rather than discards capture");
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
 assert.ok(host.notices.some(notice => /Shutdown stop failed; ownership retained/.test(notice.message)));
});

test("failed session_shutdown followed by replacement cannot steal same-PID ownership; reconnect retries cleanup only", async t => {
 const { host, worker, lease } = await setup(t);
 await host.command("test Owned audio.");
 const owner = JSON.parse(await fs.readFile(lease, "utf8")).instanceId;
 const terminate = t.mock.method(worker, "terminate", async () => { throw new Error("unconfirmed remote stop"); });
 await assert.rejects(host.shutdown(), /unconfirmed remote stop/);
 // Pi catches the hook error and constructs a new extension anyway.
 const replacement = new FakeVoiceHost(host.ctx.cwd, "replacement");
 replacement.entries.push(...host.entries); // Reload restores the existing device pin.
 const index = MockedVoiceWorkerClient.instances.length;
 await replacement.start();
 const freshWorker = MockedVoiceWorkerClient.instances[index]!;
 t.after(() => replacement.shutdown());
 const capture = t.mock.method(PhoneInputClient.prototype, "capture", async () => { throw new Error("unexpected capture"); });
 await replacement.command("test Must remain silent.");
 await replacement.command("talk");
 await new Promise(resolve => setTimeout(resolve, 1600)); await settle();
 assert.equal(freshWorker.sent.length, 0);
 assert.equal(capture.mock.callCount(), 0);
 assert.equal(JSON.parse(await fs.readFile(lease, "utf8")).instanceId, owner);
 await replacement.command("reconnect");
 assert.equal(JSON.parse(await fs.readFile(lease, "utf8")).instanceId, owner);
 const oldSent = worker.sent.length;
 terminate.mock.mockImplementation(async () => {});
 await replacement.command("reconnect");
 await assert.rejects(fs.stat(lease), { code: "ENOENT" });
 await replacement.command("test Fresh audio.");
 assert.ok(freshWorker.sent.length > 0);
 assert.equal(worker.sent.length, oldSent, "cleanup never revives retired playback");
 assert.notEqual(JSON.parse(await fs.readFile(lease, "utf8")).instanceId, owner);
});

test("replacement Talk waits for retired cleanup and fresh adoption with a distinct command context", async t => {
 const { host, worker, registration } = await setup(t);
 await host.command("test Old audio.");
 const terminate = t.mock.method(worker, "terminate", async () => { throw new Error("unconfirmed"); });
 await assert.rejects(host.shutdown(), /unconfirmed/);
 const replacement = new FakeVoiceHost(host.ctx.cwd, "replacement");
 replacement.entries.push(...host.entries);
 await replacement.start();
 t.after(() => replacement.shutdown());
 await fs.writeFile(path.join(process.env.PI_VOICE_DEVICE_DIR!, "B.json"), JSON.stringify({ ...registration, id: "B", inputEndpoint: "unix:///B-input" }));
 t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async () => ({ kind: "device" as const, id: "B" }));
 const stopped = Promise.withResolvers<void>();
 terminate.mock.mockImplementation(() => stopped.promise);
 const capture = t.mock.method(PhoneInputClient.prototype, "capture", async (endpoint: string) => {
  assert.equal(endpoint, "unix:///B-input");
  return { type: "text" as const, data: "" };
 });
 // Pi creates a new command context rather than reusing session_start's object.
 const reconnect = replacement.commands.get("voice")!.handler("reconnect", { ...replacement.ctx });
 await settle();
 await replacement.command("talk"); await settle();
 assert.equal(capture.mock.callCount(), 0);
 stopped.resolve(); await reconnect; await settle();
 assert.equal(capture.mock.callCount(), 1);
});

test("overlapping identity-only reconnect failures do not fence explicitly local transports", async t => {
 const { host, worker } = await setup(t);
 await host.command("output local");
 await host.command("input local");
 const lookup = Promise.withResolvers<never>();
 t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => lookup.promise);
 const first = host.command("reconnect"); await settle();
 const second = host.command("reconnect"); await settle();
 lookup.reject(new Error("SSH identity unavailable"));
 await Promise.all([first, second]);
 await host.command("test Explicit local audio.");
 assert.ok(worker.sent.length > 0);
 await host.command("stop"); await settle();
 const capture = t.mock.method(PhoneInputClient.prototype, "capture", async (endpoint: string) => {
  assert.equal(endpoint, "local");
  return { type: "text" as const, data: "" };
 });
 await host.command("talk"); await settle();
 assert.equal(capture.mock.callCount(), 1);
});

test("shutdown invalidates queued reconnects before they can await their own retired cleanup", { timeout: 2000 }, async t => {
 const { host } = await setup(t);
 const lookup = Promise.withResolvers<{ kind: "device"; id: string }>();
 t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => lookup.promise);
 const first = host.command("reconnect"); await settle();
 const second = host.command("reconnect"); await settle();
 const shutdown = host.shutdown(); await settle();
 lookup.resolve({ kind: "device", id: "A" });
 await Promise.all([first, second, shutdown]);
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

test("missing cancel ID after worker exit requires fresh termination proof before releasing", async t => {
 const { host, worker, lease } = await setup(t);
 await host.command("test Retained audio.");
 const termination = Promise.withResolvers<void>();
 const terminate = t.mock.method(worker, "terminate", () => termination.promise);
 // The worker clears its child on unexpected exit, so cancel cannot return an ID.
 t.mock.method(worker, "cancel", () => undefined);
 await host.command("stop"); await settle();
 assert.ok(terminate.mock.callCount());
 assert.ok(await fs.stat(lease));
 termination.resolve(); await settle();
 await assert.rejects(fs.stat(lease), { code: "ENOENT" });
});

for (const event of ["before_agent_start", "input"]) test(`${event} cannot release while microphone Stop is unresolved`, async t => {
 const { host, lease } = await setup(t);
 const recording = Promise.withResolvers<any>();
 t.mock.method(PhoneInputClient.prototype, "capture", () => recording.promise);
 await host.command("talk"); await settle();
 assert.ok(await fs.stat(lease));
 const stopped = Promise.withResolvers<void>();
 t.mock.method(PhoneInputClient.prototype, "cancel", () => stopped.promise);
 await host.command("stop"); await settle();
 await host.emit(event, {}); await settle();
 assert.ok(await fs.stat(lease));
 stopped.resolve(); recording.resolve({ type: "text", data: "" }); await settle();
 await assert.rejects(fs.stat(lease), { code: "ENOENT" });
});

test("Stop fences Talk waiting for a successful reconnect", async t => {
 const { host, worker, lease, registration, register } = await setup(t);
 await host.command("test Old audio.");
 registration.connectedAt++; await register();
 const termination = Promise.withResolvers<void>();
 t.mock.method(worker, "terminate", () => termination.promise);
 const capture = t.mock.method(PhoneInputClient.prototype, "capture", async () => { throw new Error("unexpected capture"); });
 const reconnect = host.command("reconnect"); await settle();
 await host.command("talk"); await settle();
 await host.command("stop"); await settle();
 assert.ok(await fs.stat(lease));
 termination.resolve(); await reconnect; await settle();
 assert.equal(capture.mock.callCount(), 0);
 await assert.rejects(fs.stat(lease), { code: "ENOENT" });
});

for (const retry of ["stop", "shutdown", "reload"]) test(`failed transport barrier permits fresh ${retry} proof`, async t => {
 const { host, worker, lease } = await setup(t);
 await host.command("test Old audio.");
 let cancelId = 90;
 t.mock.method(worker, "cancel", () => ++cancelId as never);
 const terminate = t.mock.method(worker, "terminate", async () => { throw new Error("unconfirmed"); });
 t.mock.timers.enable({ apis: ["setTimeout"] });
 await host.command("stop");
 t.mock.timers.tick(1000); await settle();
 assert.ok(terminate.mock.callCount()); assert.ok(await fs.stat(lease));
 if (retry === "stop") {
  await host.command("stop");
  worker.emit({ type: "idle", cancelId }); await settle();
 } else {
  terminate.mock.mockImplementation(async () => {});
  if (retry === "shutdown") await host.shutdown();
  else await host.emit("session_start", {});
 }
 await assert.rejects(fs.stat(lease), { code: "ENOENT" });
 t.mock.timers.reset();
});

for (const retry of ["reconnect", "shutdown", "reload"]) test(`failed rebind permits successful ${retry} termination proof`, async t => {
 const { host, worker, lease, registration, register } = await setup(t);
 await host.command("test Old audio.");
 registration.connectedAt++; await register();
 const terminate = t.mock.method(worker, "terminate", async () => { throw new Error("unconfirmed"); });
 await host.command("reconnect"); await settle();
 assert.ok(await fs.stat(lease));
 const termination = Promise.withResolvers<void>();
 terminate.mock.mockImplementation(() => termination.promise);
 const retried = retry === "shutdown" ? host.shutdown() : retry === "reload" ? host.emit("session_start", {}) : host.command("reconnect");
 await settle(); assert.ok(await fs.stat(lease));
 assert.equal(terminate.mock.callCount(), 2);
 termination.resolve(); await retried; await settle();
 if (retry === "reconnect") { await host.command("stop"); await settle(); }
 await assert.rejects(fs.stat(lease), { code: "ENOENT" });
});

test("Stop during a failed-rebind retry cannot discard the unconfirmed-stop fence", async t => {
 const { host, worker, registration, register, lease } = await setup(t);
 await host.command("test Old audio.");
 registration.connectedAt++; await register();
 t.mock.method(worker, "terminate", async () => { throw new Error("unconfirmed"); });
 await host.command("reconnect");
 const resolved = Promise.withResolvers<{ kind: "device"; id: string }>();
 t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", () => resolved.promise);
 const reconnect = host.command("reconnect"); await settle();
 await host.command("stop"); await settle();
 resolved.resolve({ kind: "device", id: "A" }); await reconnect; await settle();
 const sent = worker.sent.length;
 const capture = t.mock.method(PhoneInputClient.prototype, "capture", async () => { throw new Error("unexpected capture"); });
 await host.command("test Must remain silent.");
 await host.command("talk"); await settle();
 assert.equal(worker.sent.length, sent);
 assert.equal(capture.mock.callCount(), 0);
 assert.ok(await fs.stat(lease));
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

for (const scoped of [false, true]) test(`confirmed Stop resets the matching remote diagnostic (utterance scoped: ${scoped})`, async t => {
 const { host, worker } = await setup(t);
 await host.command("test Old audio.");
 const utterance = scoped ? (worker.sent.at(-1) as { utterance: number }).utterance : undefined;
 const stopped = Promise.withResolvers<void>();
 t.mock.method(worker, "terminate", () => stopped.promise);
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "remote failure", utterance });
 await host.command("stop"); await settle();
 stopped.resolve(); await settle();
 const errors = host.notices.filter(notice => notice.level === "error").length;
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "new remote failure", utterance });
 assert.equal(host.notices.filter(notice => notice.level === "error").length, errors + 1);
});

test("a remote diagnostic does not hide an independent input stop failure", async t => {
 const { host, worker } = await setup(t);
 await host.command("test Old audio.");
 const stopped = Promise.withResolvers<void>();
 t.mock.method(worker, "terminate", () => stopped.promise);
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "remote failure" });
 t.mock.method(PhoneInputClient.prototype, "cancel", async () => { throw new Error("independent input failure"); });
 await host.command("stop"); await settle();
 assert.equal(host.notices.filter(notice => /independent input failure/.test(notice.message)).length, 1);
 stopped.resolve(); await settle();
});

test("older cleanup cannot reset a newer remote diagnostic", async t => {
 const { host, worker } = await setup(t);
 await host.command("test Old audio.");
 const stopped = Promise.withResolvers<void>();
 t.mock.method(worker, "terminate", () => stopped.promise);
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "old remote failure", utterance: 101 });
 await host.command("stop"); await settle();
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "new remote failure", utterance: 102 });
 stopped.resolve(); await settle();
 const errors = host.notices.filter(notice => notice.level === "error").length;
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "same new cascade", utterance: 102 });
 assert.equal(host.notices.filter(notice => notice.level === "error").length, errors);
});

test("remote failure arriving during Stop coalesces its input/turn cleanup cascade", async t => {
 const { host, worker } = await setup(t);
 await host.command("test Old audio.");
 const stopped = Promise.withResolvers<void>();
 const terminate = t.mock.method(worker, "terminate", () => stopped.promise);
 await host.command("stop"); await settle();
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "late remote failure" });
 await host.emit("input", {});
 await host.emit("before_agent_start", {});
 stopped.reject(new Error("same transport failure")); await settle();
 assert.equal(host.notices.filter(notice => notice.level === "error").length, 1);
 terminate.mock.mockImplementation(async () => {});
 await host.command("stop"); await settle();
 terminate.mock.mockImplementation(async () => { throw new Error("independent output failure"); });
 t.mock.method(worker, "cancel", () => 301 as never);
 t.mock.timers.enable({ apis: ["setTimeout"] });
 await host.command("stop");
 t.mock.timers.tick(1000); await settle();
 assert.equal(host.notices.filter(notice => /independent output failure/.test(notice.message)).length, 1);
 t.mock.timers.reset();
});

for (const first of ["input", "output"] as const) test(`independent Stop failures notify as each settles (${first} first)`, async t => {
 const { host, worker, lease } = await setup(t);
 await host.command("test Old audio.");
 const input = Promise.withResolvers<void>();
 const output = Promise.withResolvers<void>();
 t.mock.method(PhoneInputClient.prototype, "cancel", () => input.promise);
 t.mock.method(worker, "terminate", () => output.promise);
 await host.command("stop"); await settle();
 await host.command("stop"); await settle(); // Join the same in-flight microphone proof.
 const stops = { input, output };
 stops[first].reject(new Error(`${first} root failure`)); await settle();
 assert.equal(host.notices.filter(notice => /root failure/.test(notice.message)).length, 1);
 stops[first === "input" ? "output" : "input"].reject(new Error(`${first === "input" ? "output" : "input"} root failure`)); await settle();
 assert.equal(host.notices.filter(notice => /input root failure/.test(notice.message)).length, 1);
 assert.equal(host.notices.filter(notice => /output root failure/.test(notice.message)).length, 1);
 assert.ok(await fs.stat(lease));
});

for (const first of ["input", "output"] as const) test(`late first remote notice clears only output after successful proof (${first} first)`, async t => {
 const { host, worker, lease } = await setup(t);
 await host.command("test Old audio.");
 const input = Promise.withResolvers<void>();
 const output = Promise.withResolvers<void>();
 const cancel = t.mock.method(PhoneInputClient.prototype, "cancel", () => input.promise);
 const terminate = t.mock.method(worker, "terminate", () => output.promise);
 await host.command("stop"); await settle();
 await host.command("stop"); await settle();
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "late remote failure" });
 if (first === "input") input.reject(new Error("unresolved microphone"));
 else output.resolve();
 await settle();
 if (first === "output") input.reject(new Error("unresolved microphone"));
 else output.resolve();
 await settle();
 assert.ok(await fs.stat(lease), "output proof cannot release the unresolved microphone lease");
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "new unscoped failure" });
 assert.equal(host.notices.filter(notice => /new unscoped failure/.test(notice.message)).length, 1);
 cancel.mock.mockImplementation(async () => { throw new Error("unresolved microphone"); });
 terminate.mock.mockImplementation(async () => {});
 await host.command("stop"); await settle();
 assert.equal(host.notices.filter(notice => /unresolved microphone/.test(notice.message)).length, 1, "output success must not reset the input episode");
 cancel.mock.mockImplementation(async () => {});
 await host.command("stop"); await settle();
 await assert.rejects(fs.stat(lease), { code: "ENOENT" });
 cancel.mock.mockImplementation(async () => { throw new Error("unresolved microphone"); });
 await host.command("stop"); await settle();
 assert.equal(host.notices.filter(notice => /unresolved microphone/.test(notice.message)).length, 2, "input proof resets only the resolved input episode");
});
