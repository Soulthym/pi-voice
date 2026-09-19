import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
 child.exitCode = 1; child.emit("exit", 1);
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
 const rejected = assert.rejects(stopped, /Remote playback stop unconfirmed/);
 t.mock.timers.tick(2000);
 child.emit("close", null, "SIGKILL");
 await rejected;
 await assert.rejects(worker.terminate(), /Remote playback stop unconfirmed/);
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

test("no owned worker means no process group signals", async t => {
 const kill = t.mock.method(process, "kill", () => { throw new Error("unowned signal"); });
 await new VoiceWorkerClient(() => {}).terminate();
 assert.equal(kill.mock.callCount(), 0);
});
