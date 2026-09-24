import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";

const fake = () => Object.assign(new EventEmitter(), {
 pid: 23456, exitCode: null as number | null, signalCode: null as string | null,
 stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
});
let child = fake();
mock.module("node:child_process", { namedExports: { spawn: () => child } });
const { VoiceWorkerClient } = await import("../src/worker-client.js");

test("unexpected worker exit retains and cleans only its owned detached group", async t => {
 child = fake();
 const calls: unknown[] = [];
 t.mock.method(process, "kill", (pid: number, signal: unknown) => {
  calls.push([pid, signal]);
  if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  return true;
 });
 const worker = new VoiceWorkerClient(() => {});
 worker.sendSegment(1, 1, "No inference", DEFAULT_VOICE_CONFIG);
 child.exitCode = 1; child.emit("exit", 1); child.emit("close", 1);
 await worker.terminate();
 assert.deepEqual(calls, [[-23456, "SIGKILL"], [-23456, 0]]);
 await worker.terminate();
 assert.equal(calls.length, 2, "never signal a retired group again");
});

test("forced host kill is not remote stop proof; termination rejects and replacement remains fenced", async t => {
 child = fake();
 t.mock.timers.enable({ apis: ["setTimeout"] });
 t.mock.method(process, "kill", (_pid: number, signal: unknown) => {
  if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  return true;
 });
 const events: any[] = [];
 const worker = new VoiceWorkerClient(event => events.push(event));
 worker.sendSegment(1, 1, "No inference", { ...DEFAULT_VOICE_CONFIG, output: "tcp://127.0.0.1:9999" });
 const cancelId = worker.cancel();
 worker.sendSegment(2, 1, "New remote playback", { ...DEFAULT_VOICE_CONFIG, output: "tcp://127.0.0.1:9999" });
 child.stdout.write(`${JSON.stringify({ type: "idle", cancelId })}\n`);
 const stopped = worker.terminate();
 child.stdout.write('{"type":"idle"}\n'); // A stale internal cancel is not scoped shutdown proof.
 const rejected = assert.rejects(stopped, /Remote playback unconfirmed/);
 t.mock.timers.tick(2000);
 child.emit("close", null, "SIGKILL");
 await rejected;
 await assert.rejects(worker.terminate(), /Remote playback unconfirmed/);
 worker.sendSegment(2, 1, "Still fenced", DEFAULT_VOICE_CONFIG);
 assert.match(events.at(-1).message, /cleanup is unconfirmed/);
 assert.deepEqual(events.filter(event => event.type === "idle"), [{ type: "idle", cancelId }], "old cancellation cannot confirm newer remote playback");
});

test("owned cleanup timeout retains its handle and retry only observes, never re-signals", async t => {
 child = fake();
 t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
 let groupExists = true;
 const calls: unknown[] = [];
 t.mock.method(process, "kill", (pid: number, signal: unknown) => {
  calls.push([pid, signal]);
  if (signal === 0 && !groupExists) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  return true;
 });
 const worker = new VoiceWorkerClient(() => {});
 worker.sendSegment(1, 1, "No inference", DEFAULT_VOICE_CONFIG);
 const stopped = worker.terminate();
 const rejected = assert.rejects(stopped, /group cleanup unconfirmed/);
 t.mock.timers.tick(2000);
 child.exitCode = 1; child.emit("close", 1);
 await Promise.resolve();
 t.mock.timers.tick(2001);
 await rejected;
 groupExists = false;
 await worker.terminate();
 assert.equal(calls.filter((call: any) => call[1] === "SIGKILL").length, 1);
});

test("scoped graceful shutdown confirms remote stop", async t => {
 child = fake();
 t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
 child.stdin.on("data", bytes => {
  const message = JSON.parse(String(bytes));
  if (message.type === "shutdown") queueMicrotask(() => {
   child.stdout.write(`${JSON.stringify({ type: "idle", cancelId: message.cancelId })}\n`);
   child.exitCode = 0; child.emit("close", 0);
  });
 });
 const worker = new VoiceWorkerClient(() => {});
 worker.sendSegment(1, 1, "No inference", { ...DEFAULT_VOICE_CONFIG, output: "tcp://127.0.0.1:9999" });
 await worker.terminate();
});

test("lost helper and ACK retain the original handle until reconnect gets its exact receipt", async t => {
 child = fake();
 t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
 const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 const foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 let receipt = "";
 const commands: string[] = [];
 const server = net.createServer(socket => {
  socket.on("error", () => {});
  socket.on("data", bytes => {
   commands.push(String(bytes));
   socket.end(receipt ? JSON.stringify({ type: "stopped", id: receipt }) + "\n" : "");
  });
 });
 server.listen(0, "127.0.0.1"); await once(server, "listening");
 const port = (server.address() as net.AddressInfo).port;
 t.after(() => server.close());
 const events: any[] = [];
 const worker = new VoiceWorkerClient(event => events.push(event));
 worker.sendSegment(1, 1, "Mock remote PCM", { ...DEFAULT_VOICE_CONFIG, output: `tcp://127.0.0.1:${port}` });
 child.stdout.write(JSON.stringify({ type: "remote-handle", output: `tcp://127.0.0.1:${port}`, id, utterance: 1 }) + "\n");
 child.stdout.write(JSON.stringify({ type: "remote-released", id: foreign }) + "\n");
 for (const event of [{ type: "ready" }, { type: "idle" }, { type: "idle", utterance: 1 }]) {
  child.stdout.write(JSON.stringify(event) + "\n");
 }
 child.exitCode = 1; child.emit("exit", 1); child.emit("close", 1);
 await assert.rejects(worker.terminate(), { code: "REMOTE_PLAYBACK_UNCONFIRMED" });
 assert.ok(events.some(event => event.type === "error" && event.code === "REMOTE_PLAYBACK_UNCONFIRMED"));
 receipt = foreign;
 await assert.rejects(worker.terminate(), /missing scoped/);
 await new Promise<void>(resolve => server.close(() => resolve()));
 await assert.rejects(worker.terminate(), { code: "REMOTE_PLAYBACK_UNCONFIRMED" });
 worker.sendSegment(2, 1, "No replacement while disconnected", DEFAULT_VOICE_CONFIG);
 assert.match(events.at(-1).message, /cleanup is unconfirmed/);
 server.listen(port, "127.0.0.1"); await once(server, "listening");
 receipt = id;
 await worker.terminate();
 assert.deepEqual(commands, Array(3).fill(`PI_VOICE_CONTROLstop ${id}\n`));
 child = fake();
 const writes: string[] = [];
 child.stdin.on("data", bytes => writes.push(String(bytes)));
 worker.sendSegment(3, 1, "New transport after receipt", DEFAULT_VOICE_CONFIG);
 await new Promise(resolve => setImmediate(resolve));
 const written = writes.join("");
 assert.ok(written?.includes('"utterance":3'), JSON.stringify({ events, written }));
 child.exitCode = 0; child.emit("close", 0);
 await worker.terminate();
});

test("a confirmed release clears the failure latch even if the helper dies before idle", async t => {
 child = fake();
 t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
 const worker = new VoiceWorkerClient(() => {});
 const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 worker.sendSegment(1, 1, "Mock", { ...DEFAULT_VOICE_CONFIG, output: "tcp://127.0.0.1:9999" });
 child.stdout.write(JSON.stringify({ type: "remote-handle", output: "tcp://127.0.0.1:9999", id, utterance: 1 }) + "\n");
 child.stdout.write(JSON.stringify({ type: "remote-released", id }) + "\n");
 child.exitCode = 1; child.emit("close", 1);
 await worker.terminate();
});

test("old receipt cannot clear newer playback; exit waits for late stdout handles", async t => {
 child = fake();
 t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
 const worker = new VoiceWorkerClient(() => {});
 const output = `unix:///tmp/pi-voice-missing-test-${process.pid}.sock`;
 const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 const next = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 worker.sendSegment(1, 1, "A", { ...DEFAULT_VOICE_CONFIG, output });
 child.stdout.write(JSON.stringify({ type: "remote-handle", output, id, utterance: 1 }) + "\n");
 worker.sendSegment(2, 1, "B", { ...DEFAULT_VOICE_CONFIG, output });
 child.stdout.write(JSON.stringify({ type: "remote-released", id }) + "\n");
 child.exitCode = 1; child.emit("exit", 1);
 const stopped = worker.terminate();
 let settled = false;
 void stopped.then(() => { settled = true; }, () => { settled = true; });
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(settled, false, "exit alone must not outrun pipe drain");
 child.stdout.write(JSON.stringify({ type: "remote-handle", output, id: next, utterance: 2 }) + "\n");
 child.emit("close", 1);
 await assert.rejects(stopped, { code: "REMOTE_PLAYBACK_UNCONFIRMED" });
});

test("no owned worker means no process group signals", async t => {
 const kill = t.mock.method(process, "kill", () => { throw new Error("unowned signal"); });
 await new VoiceWorkerClient(() => {}).terminate();
 assert.equal(kill.mock.callCount(), 0);
});
