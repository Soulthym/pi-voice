import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import test from "node:test";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const boot = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const mode of ["paused-gap", "stop-pending", "disconnect-pending", "wrong-scope", "wrong-boot", "missing-ack", "silent", "expired-ack", "eof-race", "eof-wrong-scope", "eof-wrong-boot", "stop-receipt"] as const) {
 test(`v4 native renewal: ${mode}`, { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-renew-"));
  const socketPath = path.join(root, "audio.sock");
  const clock = path.join(root, "clock");
  fs.writeFileSync(clock, "0");
  const sockets = new Set<net.Socket>();
  let stream: net.Socket;
  let renewals = 0, pcm = 0, pauses = 0;
  let latePeer: net.Socket | undefined;
  const renewed = Promise.withResolvers<void>();
  const server = net.createServer({ allowHalfOpen: true }, peer => {
   sockets.add(peer); peer.on("error", () => {});
   const send = (value: object) => peer.write(JSON.stringify(value) + "\n");
   peer.on("data", bytes => {
    const command = String(bytes);
    if (command === "PI_VOICE_CONTROLhello\n") {
     stream = peer;
     send({ type: "protocol", version: 4, native_watchdog: true, lease_seconds: 30 });
    } else if (command === "PI_VOICE_PREPARE 4\n") {
     send({ type: "prepared", version: 4, id, boot_id: boot, native_watchdog: true, lease_seconds: 30 });
    } else if (command === `PI_VOICE_COMMIT ${id} ${boot}\n`) {
     send({ type: "session", version: 4, id, boot_id: boot });
    } else if (command.startsWith("PI_VOICE_CONTROLrenew")) {
     assert.notEqual(peer, stream, "renewal must not share the blocked PCM transport");
     assert.equal(command, `PI_VOICE_CONTROLrenew ${id} ${boot}\n`);
     renewals++;
     if (["stop-pending", "disconnect-pending", "silent"].includes(mode)) latePeer = peer;
     else {
      if (mode === "expired-ack") fs.writeFileSync(clock, "31000");
      if (mode.startsWith("eof-") || mode === "stop-receipt") {
       if (mode === "stop-receipt") send({ type: "stopped", id, boot_id: boot, proof: "native-process-exit" });
       // Native EOF removes the IPC socket before the owner publishes completion.
       // A renewal connection can close first, while the PCM stream is still open.
       setTimeout(() => {
        stream.write(JSON.stringify(mode === "stop-receipt"
         ? { type: "stopped", id, boot_id: boot, proof: "native-process-exit" }
         : { type: "complete", id: mode === "eof-wrong-scope" ? boot : id, boot_id: mode === "eof-wrong-boot" ? id : boot }) + "\n");
        if (mode === "eof-race") setTimeout(() => stream.end(), 50);
       }, 100);
      } else if (mode !== "missing-ack") send({ type: "renewed", id: mode === "wrong-scope" ? boot : id, boot_id: mode === "wrong-boot" ? id : boot });
      peer.end();
     }
     renewed.resolve();
    } else if (command === `PI_VOICE_CONTROLpause ${id}\n`) {
     pauses++; peer.end();
    } else if (command === `PI_VOICE_CONTROLstop ${id}\n`) {
     // A late successful renewal after stop cannot resurrect scheduling.
     latePeer?.end(JSON.stringify({ type: "renewed", id, boot_id: boot }) + "\n");
     send({ type: "stopped", id, boot_id: boot, proof: "native-process-exit" }); peer.end();
    } else pcm += bytes.length;
   });
  });
  server.listen(socketPath); await once(server, "listening");
  // Advance only this synthetic helper's monotonic clock: no production lease override.
  const clockMock = `import { readFileSync } from 'node:fs'; const now = performance.now.bind(performance); performance.now = () => now() + Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(clockMock)}`, new URL("../src/tcp-playback.mjs", import.meta.url).pathname, `unix://${socketPath}`, "24000", "1"], {
   stdio: ["pipe", "pipe", "pipe", "pipe"],
   env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root, PI_CODING_AGENT_DIR: root },
  });
  t.after(() => { child.kill("SIGKILL"); for (const peer of sockets) peer.destroy(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const exited = once(child, "exit");
  let events = "", feedback = "";
  child.stdout.on("data", bytes => events += bytes); child.stderr.resume();
  const control = child.stdio[3] as net.Socket;
  control.on("error", () => {});
  control.on("data", bytes => {
   feedback += bytes;
   if (String(bytes).startsWith("prepared ")) control.write(`grant ${id} ${boot}\n`);
  });
  control.write("pause\n");
  await renewed.promise;
  assert.equal(pcm, 0, "renewal does not require generated PCM");
  assert.equal(pauses, 1);
  assert.match(feedback, /ready/);
  if (mode === "paused-gap") {
   await wait(31_000);
   assert.equal(renewals, 7, "paused output renews beyond the original lease during a generation gap");
   control.write("stop\n");
  } else if (mode === "stop-pending") control.write("stop\n");
  else if (mode === "disconnect-pending") {
   stream!.destroy();
   latePeer?.end(JSON.stringify({ type: "renewed", id, boot_id: boot }) + "\n");
  }
  const [code] = await exited;
  assert.equal(code, ["paused-gap", "stop-pending", "eof-race"].includes(mode) ? 0 : 1, events);
  assert.equal(renewals, mode === "paused-gap" ? 7 : 1);
  if (!["paused-gap", "stop-pending", "eof-race"].includes(mode)) {
   assert.match(events, /REMOTE_PLAYBACK_UNCONFIRMED/);
   if (mode === "expired-ack") assert.match(events, /lease expired/);
   assert.doesNotMatch(events, /remote-released/);
  } else {
   assert.doesNotMatch(events, /"type":"error"/);
   assert.equal(events.split("\n").filter(line => line.includes('"type":"remote-released"')).length, 1);
  }
 });
}
