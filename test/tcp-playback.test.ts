import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as net from "node:net";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const helper = fileURLToPath(new URL("../src/tcp-playback.mjs", import.meta.url));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const deviceId = "test-device-A";

for (const scenario of ["delayed-stop", "delayed-startup-stop", "silent-stop", "trickle-stop", "complete", "broken-pipe", "broken-forward", "old-client", "v2", "v3", "no-watchdog", "wrong-lease", "prepared-no-watchdog", "prepared-wrong-lease", "prepared-v3", "session-v3", "premature", "lost-ack", "stop", "startup-stop", "ack-reset", "pause-failure", "numeric", "malformed", "forged-stop", "forged-complete", "no-grant", "wrong-boot", "null-boot", "fenced", "false-fenced", "invalid-fenced", "missing-device", "invalid-device", "dash-device"] as const) {
 test(`TCP prepare/commit proof: ${scenario}`, { timeout: 25_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-tcp-v4-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mode = scenario === "delayed-startup-stop" ? "startup-stop" : ["delayed-stop", "silent-stop", "trickle-stop"].includes(scenario) ? "stop" : scenario;
  const timers: NodeJS.Timeout[] = [];
  t.after(() => { for (const timer of timers) clearInterval(timer); });
  const boot_id = mode === "null-boot" ? null : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const device_id = mode === "missing-device" ? null : mode === "invalid-device" ? "bad id" : mode === "dash-device" ? "-" : deviceId;
  const preparedDevice = device_id === null || device_id === "bad id" ? ":" : device_id;
  const boot_fenced = ["fenced", "null-boot", "missing-device", "invalid-device", "dash-device"].includes(mode) ? true : mode === "false-fenced" ? false : mode === "invalid-fenced" ? "true" : undefined;
  const completes = ["complete", "fenced", "false-fenced", "invalid-fenced", "missing-device", "invalid-device", "dash-device"].includes(mode);
  const sockets = new Set<net.Socket>();
  let bytes = "", committed = false;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
   sockets.add(socket); socket.on("error", () => {});
   const send = (event: object) => socket.write(JSON.stringify(event) + "\n");
   if (mode === "broken-forward") { socket.end(); return; }
   socket.on("data", chunk => {
    const text = chunk.toString(); bytes += text;
    if (text.startsWith("PI_VOICE_CONTROLpause")) { socket.resetAndDestroy(); return; }
    if (text.startsWith("PI_VOICE_CONTROLstop")) {
     if (mode === "lost-ack") { socket.end(); return; }
     if (scenario === "silent-stop") return;
     if (scenario === "trickle-stop") { timers.push(setInterval(() => send({ type: "stopped", id: "wrong", boot_id }), 100)); return; }
     if (["delayed-stop", "delayed-startup-stop"].includes(scenario)) {
      timers.push(setTimeout(() => { send({ type: "stopped", id, boot_id, proof: "native-process-exit" }); socket.end(); }, scenario === "delayed-stop" ? 1800 : 6000));
      return;
     }
     send({ type: "stopped", id: mode === "forged-stop" ? "wrong" : id, boot_id, proof: "native-process-exit" });
     if (mode === "ack-reset") setTimeout(() => socket.resetAndDestroy(), 10);
     else socket.end();
     return;
    }
    if (text === "PI_VOICE_CONTROLhello\n") {
     if (mode === "old-client") socket.end();
     else send({ type: "protocol", version: mode === "v2" ? 2 : mode === "v3" ? 3 : 4, native_watchdog: mode !== "no-watchdog", lease_seconds: mode === "wrong-lease" ? 31 : 30 });
    } else if (text === "PI_VOICE_PREPARE 4\n") {
     send({ type: "prepared", version: mode === "prepared-v3" ? 3 : 4, native_watchdog: mode !== "prepared-no-watchdog", lease_seconds: mode === "prepared-wrong-lease" ? 10 : 30, id: mode === "numeric" ? 123 : mode === "malformed" ? "../../receipt" : id, boot_id, boot_fenced, device_id });
    } else if (text.startsWith("PI_VOICE_COMMIT")) {
     assert.equal(text, `PI_VOICE_COMMIT ${id} ${boot_id}\n`);
     committed = true;
     send({ type: "session", version: mode === "session-v3" ? 3 : 4, id, boot_id });
    } else if (mode === "broken-pipe") socket.resetAndDestroy();
   });
   socket.on("end", () => {
    if (["stop", "startup-stop", "ack-reset", "lost-ack", "forged-stop"].includes(mode)) return;
    if (completes || mode === "forged-complete") send({ type: "complete", id, boot_id: mode === "forged-complete" ? id : boot_id });
    socket.end();
   });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const child = spawn(process.execPath, [helper, `tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`, "24000", "1"], { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root, PI_CODING_AGENT_DIR: root } });
  t.after(() => { child.kill("SIGKILL"); for (const socket of sockets) socket.destroy(); server.close(); });
  const exit = once(child, "exit");
  let events = "", feedback = "";
  child.stdout.on("data", chunk => events += chunk); child.stderr.resume();
  const control = child.stdio[3] as net.Socket;
  control.on("data", chunk => {
   feedback += chunk;
   for (const line of String(chunk).trim().split("\n")) {
    if (line.startsWith("prepared ") && !["no-grant", "startup-stop"].includes(mode)) {
     assert.equal(line, `prepared ${id} ${boot_id} ${boot_fenced === true ? "fenced" : "unfenced"} ${preparedDevice} native-watchdog`);
     assert.equal(committed, false, "prepare cannot dispatch without the host ACK");
     control.write(`grant ${id} ${mode === "wrong-boot" ? id : boot_id}\n`);
    }
    if (line === "ready" && ["stop", "ack-reset", "lost-ack", "forged-stop"].includes(mode)) control.write("stop\n");
   }
  });
  if (mode === "pause-failure") control.write("pause\n");
  if (mode === "startup-stop") control.write("stop\n");
  if (!["stop", "ack-reset", "lost-ack", "forged-stop"].includes(mode)) child.stdin.end(Buffer.alloc(64));
  const [code] = await exit;
  const nonadmitted = ["broken-forward", "old-client", "v2", "v3", "no-watchdog", "wrong-lease", "prepared-no-watchdog", "prepared-wrong-lease", "prepared-v3", "null-boot", "numeric", "malformed", "no-grant", "wrong-boot"].includes(mode);
  if (["silent-stop", "trickle-stop"].includes(scenario)) {
   assert.equal(code, 1, events);
   assert.match(events, /control timed out after 20000ms/);
   assert.doesNotMatch(events, /remote-released/);
   return;
  }
  assert.equal(code, completes || ["stop", "startup-stop", "ack-reset"].includes(mode) ? 0 : nonadmitted ? 2 : 1, events);
  if (nonadmitted || mode === "startup-stop") {
   assert.equal(committed, false);
   assert.equal(bytes.includes("\0"), false);
  }
  if (mode === "pause-failure") {
   assert.equal(bytes.includes("\0"), false);
   assert.match(events, /REMOTE_PLAYBACK_UNCONFIRMED/, "a committed player still needs exit proof even without PCM");
  }
  if (["old-client", "v2", "v3", "no-watchdog", "wrong-lease"].includes(mode)) assert.equal(bytes, "PI_VOICE_CONTROLhello\n");
  if (completes) {
   assert.equal(committed, true);
   assert.ok(bytes.includes("\0"), "granted scope delivers PCM");
   assert.match(events, /remote-released/);
  }
  if (mode === "no-grant") assert.match(feedback, /no-audio/);
 });
}
