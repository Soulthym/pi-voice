import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as net from "node:net";
import { StopRecovery } from "../src/stop-recovery.js";
import * as path from "node:path";
import test, { mock } from "node:test";
import { DeviceRouter } from "../src/device-router.js";
import { PhoneInputClient } from "../src/phone-input.js";
import { SessionCoordinator } from "../src/session-coordinator.js";
import { FakeVoiceHost, MockedVoiceWorkerClient, assistant } from "./helpers/fake-voice-host.js";

mock.module("../src/worker-client.js", { namedExports: { VoiceWorkerClient: MockedVoiceWorkerClient } });
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function setup(t: import("node:test").TestContext, history = false) {
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
 if (history) host.addMessage("history", null, assistant("Historical response."));
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
 assert.equal(host.notices.filter(notice => notice.level === "error").length, 1, "retry joins the retained episode");
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

test("ambiguous reconnect retains both original cleanup clients and pin until matching retries finish", async t => {
 const { host, worker, lease } = await setup(t);
 await host.command("test Old audio.");
 const inputs: PhoneInputClient[] = [];
 const input = Promise.withResolvers<void>();
 const output = Promise.withResolvers<void>();
 let retry = false;
 const cancel = t.mock.method(PhoneInputClient.prototype, "cancel", function(this: PhoneInputClient) {
  inputs.push(this);
  return retry ? input.promise : Promise.reject(new Error("input receipt unavailable"));
 });
 const terminate = t.mock.method(worker, "terminate", () => retry ? output.promise : Promise.reject(new Error("output receipt unavailable")));
 await host.command("stop"); await settle();
 const pins = () => host.entries.filter(entry => entry.type === "custom" && entry.customType === "pi-voice.device-selection").length;
 const before = pins();
 const resolve = t.mock.method(DeviceRouter.prototype, "resolveCurrentConnection", async (): Promise<{ kind: "device"; id: string }> => { throw new Error("ambiguous tmux attachment"); });
 await host.command("reconnect"); await settle();
 assert.equal(pins(), before);
 assert.ok(await fs.stat(lease));
 resolve.mock.mockImplementation(async () => ({ kind: "device" as const, id: "A" }));
 retry = true;
 const reconnect = host.command("reconnect"); await settle();
 assert.ok(cancel.mock.callCount() >= 2 && terminate.mock.callCount() >= 2, "both original resources are retried");
 assert.ok(inputs.every(client => client === inputs[0]), "no replacement input client before proof");
 assert.equal(pins(), before);
 output.resolve(); await settle();
 assert.equal(pins(), before, "output proof alone cannot commit the pin");
 assert.ok(await fs.stat(lease));
 input.resolve(); await reconnect; await settle();
 assert.equal(pins(), before + 1);
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
 const { host, worker, lease } = await setup(t);
 await host.command("test Old audio.");
 const stopped = Promise.withResolvers<void>();
 t.mock.method(worker, "terminate", () => stopped.promise);
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "old remote failure", utterance: 101 });
 await host.command("stop"); await settle();
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "new remote failure", utterance: 102 });
 stopped.resolve(); await settle();
 assert.match(host.widgetLines()!.join("\n"), /Output stop unconfirmed.*new remote failure/);
 assert.doesNotMatch(host.widgetLines()!.join("\n"), /old remote failure/);
 assert.ok(await fs.stat(lease), "older proof cannot release ownership after newer uncertainty");
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

for (const first of ["input", "output"] as const) test(`retained stop rows survive ready/idle and clear only matching ${first} proof`, async t => {
 const { host, worker, registration, register } = await setup(t);
 await host.command("test Old audio.");
 const cancel = t.mock.method(PhoneInputClient.prototype, "cancel", async () => { throw new Error("input receipt missing"); });
 const terminate = t.mock.method(worker, "terminate", async () => { throw new Error("output receipt missing"); });
 await host.command("stop"); await settle();
 const rows = () => host.widgetLines()!.filter(line => /stop unconfirmed/.test(line));
 assert.equal(rows().length, 2);
 const paint = t.mock.method(host.ctx.ui.theme as { fg(name: string, text: string): string }, "fg");
 for (const type of ["ready", "idle"] as const) {
  worker.emit({ type }); await settle();
  assert.equal(rows().length, 2);
 }
 assert.ok(paint.mock.calls.some(call => call.arguments[0] === "warning" && /Input stop unconfirmed/.test(call.arguments[1])));
 assert.ok(paint.mock.calls.some(call => call.arguments[0] === "warning" && /Output stop unconfirmed/.test(call.arguments[1])));
 registration.name = "Replacement label"; await register();
 cancel.mock.mockImplementation(async () => { throw new Error("input retry failed differently"); });
 terminate.mock.mockImplementation(async () => { throw new Error("output retry failed differently"); });
 for (let i = 0; i < 3; i++) { await host.command("reconnect"); await settle(); }
 assert.equal(host.notices.filter(notice => notice.level === "error").length, 2, "reconnect coalesces independently for each retained resource");
 assert.ok(rows().every(line => / · A · /.test(line)), "blocking identity is retained");
 const input = Promise.withResolvers<void>();
 const output = Promise.withResolvers<void>();
 cancel.mock.mockImplementation(() => input.promise);
 terminate.mock.mockImplementation(() => output.promise);
 const reconnect = host.command("reconnect"); await settle();
 ({ input, output })[first].resolve(); await settle();
 const remaining = first === "input" ? "Output" : "Input";
 assert.equal(rows().length, 1);
 assert.match(rows()[0], new RegExp(`${remaining} stop unconfirmed`));
 ({ input, output })[first === "input" ? "output" : "input"].resolve();
 await reconnect; await settle();
 assert.deepEqual(rows(), []);
});

for (const route of ["reconnect", "device local"]) for (const historical of [false, true]) {
 test(`terminal source after ${route} preserves only unrelated history (${historical})`, async t => {
  const { host, worker } = await setup(t, true);
  if (historical) { await host.shortcut("f5"); await settle(); await host.shortcut("f8"); }
  const partial = assistant("Interrupted response.", "pending");
  await host.emit("message_start", { message: partial });
  await host.emit("message_update", { message: partial,
   assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Interrupted response. " } });
  await settle();
  if (!historical) await host.shortcut("f8");
  await host.command(route); await settle();
  const sent = worker.sent.length;
  const before = host.widgetLines();
  const pauses = worker.pauses.length;
  await host.emit("message_end", { message: assistant("Interrupted response.", "aborted") });
  if (historical) assert.deepEqual(host.widgetLines(), before, "unrelated historical selection is preserved");
  await host.shortcut("f8"); await settle();
  if (historical) assert.ok(worker.sent.length > sent || (worker.pauses.length > pauses && worker.pauses.at(-1) === false), "historical paused source remains resumable");
  else assert.equal(worker.sent.length, sent, "F8 cannot revive aborted source after transport reset");
 });
}

test("session restart cannot retire ownership using proof older than a remote episode", async t => {
 const { host, worker, lease } = await setup(t);
 await host.command("test Old audio.");
 const stopped = Promise.withResolvers<void>();
 const terminate = t.mock.method(worker, "terminate", () => stopped.promise);
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "old failure", utterance: 101 });
 const restart = host.emit("session_start", { type: "session_start" });
 const rejected = assert.rejects(restart, /Newer stop remains unconfirmed/);
 await settle();
 worker.emit({ type: "error", code: "REMOTE_PLAYBACK_UNCONFIRMED", message: "new failure", utterance: 102 });
 stopped.resolve(); await rejected;
 assert.ok(await fs.stat(lease));
 terminate.mock.mockImplementation(async () => {});
 await host.command("reconnect"); await settle();
});


test("host journals original route after registration loss, retires receipts and fences late cleanup", async t => {
 const { host, worker, lease, registration, register } = await setup(t);
 await host.command("test Original transport.");
 const owner = JSON.parse(await fs.readFile(lease, "utf8"));
 const journal = path.join(path.dirname(path.dirname(lease)), "stop-recovery", `${owner.instanceId}.json`);
 const saved = async () => JSON.parse(await fs.readFile(journal, "utf8"));
 registration.audioEndpoint = "unix:///replacement";
 await register();
 const handle = { type: "remote-handle" as const, output: "unix:///old-output", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", utterance: 1 };
 worker.emit(handle);
 assert.equal((await saved()).output.handles[0].endpoint, "unix:///old-output");
 assert.equal((await saved()).output.handles[0].selection, "A");
 worker.emit({ type: "remote-released", id: handle.id });
 assert.equal((await saved()).output.handles.length, 0);
 const termination = Promise.withResolvers<void>();
 const terminate = t.mock.method(worker, "terminate", () => termination.promise);
 const reconnect = host.command("reconnect");
 await settle();
 assert.ok(terminate.mock.callCount());
 const newer = { ...handle, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
 worker.emit(newer);
 termination.resolve();
 await reconnect; await settle();
 assert.equal((await saved()).output.handles[0].id, newer.id, "older cleanup cannot erase newer journal generation");
 worker.emit({ type: "remote-not-admitted", id: newer.id });
 assert.equal((await saved()).output, undefined, "matching late receipt completes the acknowledged episode");
});


for (const late of [false, true]) for (const released of [false, true]) test(`cancel ACK clears only matching remote receipts (late admission: ${late}, released: ${released})`, async t => {
 const { host, worker, lease } = await setup(t);
 await host.command("test Original transport.");
 const owner = JSON.parse(await fs.readFile(lease, "utf8"));
 const journal = () => new StopRecovery(path.dirname(path.dirname(lease)), owner.instanceId);
 const handle = { type: "remote-handle" as const, output: "unix:///old-output", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", utterance: 1 };
 t.mock.method(worker, "cancel", () => 901 as never);
 if (!late) worker.emit(handle);
 await host.command("stop"); await settle();
 if (late) worker.emit(handle);
 worker.emit({ type: "remote-released", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
 assert.equal(journal().episode("output")!.handles[0].id, handle.id, "unrelated receipt cannot retire the scope");
 if (released) worker.emit({ type: "remote-released", id: handle.id });
 worker.emit({ type: "idle", cancelId: 901 }); await settle();
 if (released) {
  assert.equal(journal().episode("output"), undefined);
  await assert.rejects(fs.stat(lease), { code: "ENOENT" });
  assert.doesNotMatch(host.widgetLines()!.join("\n"), /Output stop unconfirmed/);
 } else {
  assert.equal(journal().episode("output")!.handles[0].id, handle.id, "ACK cannot globally clear retained handles");
  assert.ok(await fs.stat(lease));
  assert.match(host.widgetLines()!.join("\n"), /Output stop unconfirmed/);
  worker.emit({ type: "remote-released", id: handle.id });
  await host.command("stop");
  worker.emit({ type: "idle", cancelId: 901 }); await settle();
  await assert.rejects(fs.stat(lease), { code: "ENOENT" });
 }
});

for (const released of [false, true]) test(`preemption ACK requires matching late remote receipt (released: ${released})`, async t => {
 t.mock.timers.enable({ apis: ["setInterval"] });
 const { host, worker, lease } = await setup(t);
 await host.command("test Original transport.");
 const owner = JSON.parse(await fs.readFile(lease, "utf8"));
 const journal = () => new StopRecovery(path.dirname(path.dirname(lease)), owner.instanceId);
 const cancel = t.mock.method(worker, "cancel", () => 901 as never);
 const preempt = t.mock.method(SessionCoordinator.prototype, "consumeSpeechPreemptionRequest", () => true);
 t.mock.timers.tick(200); await settle();
 preempt.mock.mockImplementation(() => false);
 assert.ok(cancel.mock.callCount(), "preemption started cleanup");
 const handle = { type: "remote-handle" as const, output: "unix:///old-output", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", utterance: 1 };
 worker.emit(handle);
 worker.emit({ type: "remote-released", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
 if (released) worker.emit({ type: "remote-released", id: handle.id });
 worker.emit({ type: "idle", cancelId: 901 }); await settle();
 if (!released) {
  assert.equal(JSON.parse(await fs.readFile(lease, "utf8")).instanceId, owner.instanceId);
  assert.equal(journal().episode("output")!.handles[0].id, handle.id);
  assert.match(host.widgetLines()!.join("\n"), /Output stop unconfirmed/);
  await host.emit("before_agent_start", {}); await settle();
  assert.ok(await fs.stat(lease), "other ownership-release paths retain the fence");
  worker.emit({ type: "remote-released", id: handle.id });
  await host.command("stop");
  worker.emit({ type: "idle", cancelId: 901 }); await settle();
 }
 assert.equal(journal().episode("output"), undefined);
 await assert.rejects(fs.stat(lease), { code: "ENOENT" });
 t.mock.timers.reset();
});

for (const proof of ["late-receipt", "reconnect", "no-ack", "input-pending", "reentry", "failed-retry"] as const) test(`live preemption retains lease and history until both proofs: ${proof}`, async t => {
 t.mock.timers.enable({ apis: ["setInterval"] });
 const { host, worker, lease } = await setup(t);
 const recording = Promise.withResolvers<any>();
 if (proof === "input-pending") {
  t.mock.method(PhoneInputClient.prototype, "capture", () => recording.promise);
  await host.command("talk"); await settle();
 }
 const partial = assistant("Original sentence. ", "pending");
 await host.emit("message_start", { message: partial });
 await host.emit("message_update", { message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Original sentence. " } });
 await settle();
 const releaseSpeech = SessionCoordinator.prototype.releaseSpeech;
 const releases = t.mock.method(SessionCoordinator.prototype, "releaseSpeech");
 const waiting = t.mock.method(SessionCoordinator.prototype, "markWaiting");
 const input = Promise.withResolvers<void>();
 if (proof === "input-pending") t.mock.method(PhoneInputClient.prototype, "cancel", () => input.promise);
 t.mock.method(worker, "cancel", () => 901 as never);
 const handle = { type: "remote-handle" as const, output: "unix:///old-output", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", utterance: 1 };
 worker.emit(handle);
 const preempt = t.mock.method(SessionCoordinator.prototype, "consumeSpeechPreemptionRequest", () => true);
 t.mock.timers.tick(200); await settle();
 preempt.mock.mockImplementation(() => false);
 if (proof !== "no-ack") worker.emit({ type: "idle", cancelId: 901 });
 await settle();
 const sent = worker.sent.length;
 const continued = assistant("Original sentence. Retained sentence. ", "pending");
 await host.emit("message_update", { message: continued, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Retained sentence. " } });
 await settle();
 assert.equal(worker.sent.length, sent, "retained turn ownership never admits new audio");
 assert.ok(await fs.stat(lease));
 const before = releases.mock.callCount();
 const failedRetry = proof === "failed-retry" ? t.mock.method(worker, "terminate", async () => { throw new Error("new cancellation unconfirmed"); }) : undefined;
 if (failedRetry) { await host.command("reconnect"); await settle(); }
 if (proof === "reconnect") {
  const terminate = t.mock.method(worker, "terminate", async () => {});
  await host.command("reconnect"); await settle();
  assert.ok(terminate.mock.callCount(), "unchanged route retries original client despite settled ACK barrier");
  assert.ok(await fs.stat(lease), "successful termination without retained receipt cannot release");
 }
 if (proof === "reentry") {
  releases.mock.mockImplementation(function(this: SessionCoordinator) {
   releaseSpeech.call(this);
   releases.mock.mockImplementation(releaseSpeech);
   void host.command("stop");
  });
 }
 worker.emit({ type: "remote-released", id: handle.id }); await settle();
 if (failedRetry) {
  assert.match(host.widgetLines()!.join("\n"), /Output stop unconfirmed/, "old ACK cannot cover a failed newer cleanup");
  assert.ok(await fs.stat(lease));
  failedRetry.mock.mockImplementation(async () => {});
  await host.command("reconnect"); await settle();
 }
 if (proof === "reconnect") { await host.command("reconnect"); await settle(); }
 if (proof === "no-ack" || proof === "input-pending") {
  assert.ok(await fs.stat(lease), "one resource receipt is not both-resource cancellation proof");
  assert.equal(releases.mock.callCount(), before);
  if (proof === "no-ack") worker.emit({ type: "idle", cancelId: 901 });
  else { input.resolve(); recording.resolve({ type: "text", data: "" }); }
  await settle();
 }
 await assert.rejects(fs.stat(lease), { code: "ENOENT" });
 assert.equal(releases.mock.callCount(), before + 1, "deferred preemption finishes exactly once");
 worker.emit({ type: "remote-released", id: handle.id });
 worker.emit({ type: "idle", cancelId: 901 }); await settle();
 assert.equal(releases.mock.callCount(), before + 1);
 assert.equal(worker.sent.length, sent, "cleanup never implicitly resumes captured speech");
 if (proof === "reentry") assert.equal(waiting.mock.callCount(), 0, "newer Stop cannot restore displaced attention intent");
 const final = assistant("Original sentence. Retained sentence.");
 host.addMessage("retained-turn", null, final);
 await host.emit("message_end", { message: final });
 await host.command("reconnect"); await settle();
 await host.shortcut("f5"); await settle();
 assert.ok(worker.sent.some(item => /Retained sentence/.test((item as { text?: string }).text ?? "")), "explicit replay retains the completed source");
 t.mock.timers.reset();
});

test("normal microphone receipt retires config A before recovery retries config B", async t => {
 const { host, lease } = await setup(t);
 const ticket = `${"a".repeat(32)}.1`;
 let stopped = Promise.withResolvers<void>();
 const originalStop = PhoneInputClient.prototype.stop;
 t.mock.method(PhoneInputClient.prototype, "stop", async function(this: PhoneInputClient, endpoint?: string) {
  await originalStop.call(this, endpoint);
  stopped.resolve();
 });
 let active: net.Socket | undefined;
 let recorded = Promise.withResolvers<void>();
 const server = net.createServer(socket => {
  socket.on("error", () => {});
  socket.on("data", raw => {
   const command = String(raw).trim();
   if (command === "ticket") socket.write(`ticket ${ticket}\n`);
   else if (command.startsWith("record ")) { active = socket; recorded.resolve(); }
   else socket.end(`ok ${Buffer.from(`stopped ${ticket}`).toString("base64")}\n`);
  });
 });
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
 t.after(async () => { active?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
 const address = server.address() as net.AddressInfo;
 const a = `tcp://127.0.0.1:${address.port}`;
 const b = `tcp://localhost:${address.port}`;
 await host.command(`input ${a}`);
 const first = host.command("talk");
 await recorded.promise;
 const owner = JSON.parse(await fs.readFile(lease, "utf8"));
 const root = path.dirname(path.dirname(lease));
 const journal = () => new StopRecovery(root, owner.instanceId);
 assert.equal(journal().episode("input")!.handles[0].configured, a);
 await host.command("talk");
 await stopped.promise;
 assert.deepEqual(journal().episode("input")!.handles, [], "normal stop persists retirement before capture completion");
 active!.end("ok \n");
 await first; await settle();
 await host.command(`input ${b}`);
 recorded = Promise.withResolvers<void>();
 stopped = Promise.withResolvers<void>();
 const second = host.command("talk");
 await recorded.promise;
 const retry = t.mock.method(PhoneInputClient, "retryStop", async () => {});
 await journal().retry("input", new DeviceRouter(), b);
 assert.deepEqual(retry.mock.calls.map(call => call.arguments), [[{ endpoint: b, ticket }]], "obsolete A cannot block current B recovery");
 await host.command("talk");
 await stopped.promise;
 active!.end("ok \n");
 await second; await settle();
});
