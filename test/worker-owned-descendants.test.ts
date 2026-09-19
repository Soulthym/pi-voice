import assert from "node:assert/strict";
import { spawn as realSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { DEFAULT_VOICE_CONFIG } from "../src/config.js";

test("unexpected exit kills actual owned local descendants before any successful completion", { skip: process.platform !== "linux", timeout: 8000 }, async t => {
 let owned!: ChildProcessWithoutNullStreams;
 mock.module("node:child_process", { namedExports: { spawn: () => {
  owned = realSpawn(process.execPath, ["-e", `
   const {spawn} = require('node:child_process');
   const player = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
   console.log(JSON.stringify({type:'test-player',pid:player.pid}));
   process.stdin.resume();
   setInterval(()=>{},1000);
  `], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  return owned;
 } } });
 t.after(() => mock.reset());
 const { VoiceWorkerClient } = await import("../src/worker-client.js");
 const { promise: playerStarted, resolve } = Promise.withResolvers<number>();
 const worker = new VoiceWorkerClient(event => { if ((event as any).type === "test-player") resolve((event as any).pid); });
 worker.sendSegment(1, 1, "Owned fakes only", DEFAULT_VOICE_CONFIG);
 const pid = await playerStarted;
 const running = () => {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]![0] !== "Z"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
 };
 assert.equal(running(), true);
 const exited = new Promise<void>(resolve => owned.once("exit", () => resolve()));
 owned.kill("SIGKILL");
 await exited;
 // An orphan zombie may await init reaping. In that case retaining the lease is correct.
 try { await worker.terminate(); }
 catch (error) { assert.match(String(error), /cleanup unconfirmed/); }
 assert.equal(running(), false, "the surviving fake player must actually have been killed");
 owned.stdin.destroy(); owned.stdout.destroy(); owned.stderr.destroy();
});
