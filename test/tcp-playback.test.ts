import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
const helper = fileURLToPath(new URL("../src/tcp-playback.mjs", import.meta.url));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const boot_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

for (const mode of ["complete", "broken-pipe", "broken-forward", "old-client", "v2", "premature", "lost-ack", "stop", "startup-stop", "ack-reset", "pause-failure", "numeric", "malformed", "forged-stop", "forged-complete", "no-grant", "wrong-boot"] as const) {
 test(`TCP prepare/commit proof: ${mode}`, { timeout: 8000 }, async t => {
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
     send({ type: "stopped", id: mode === "forged-stop" ? "wrong" : id, boot_id });
     if (mode === "ack-reset") setTimeout(() => socket.resetAndDestroy(), 10);
     else socket.end();
     return;
    }
    if (text === "PI_VOICE_CONTROLhello\n") {
     if (mode === "old-client") socket.end();
     else send({ type: "protocol", version: mode === "v2" ? 2 : 3 });
    } else if (text === "PI_VOICE_PREPARE\n") {
     send({ type: "prepared", version: 3, id: mode === "numeric" ? 123 : mode === "malformed" ? "../../receipt" : id, boot_id });
    } else if (text.startsWith("PI_VOICE_COMMIT")) {
     assert.equal(text, `PI_VOICE_COMMIT ${id} ${boot_id}\n`);
     committed = true;
     send({ type: "session", version: 3, id, boot_id });
    } else if (mode === "broken-pipe") socket.resetAndDestroy();
   });
   socket.on("end", () => {
    if (["stop", "startup-stop", "ack-reset", "lost-ack", "forged-stop"].includes(mode)) return;
    if (mode === "complete" || mode === "forged-complete") send({ type: "complete", id, boot_id: mode === "forged-complete" ? id : boot_id });
    socket.end();
   });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const child = spawn(process.execPath, [helper, `tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`, "24000", "1"], { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  t.after(() => { child.kill("SIGKILL"); for (const socket of sockets) socket.destroy(); server.close(); });
  const exit = once(child, "exit");
  let events = "", feedback = "";
  child.stdout.on("data", chunk => events += chunk); child.stderr.resume();
  const control = child.stdio[3] as net.Socket;
  control.on("data", chunk => {
   feedback += chunk;
   for (const line of String(chunk).trim().split("\n")) {
    if (line.startsWith("prepared ") && !["no-grant", "startup-stop"].includes(mode)) {
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
  const nonadmitted = ["broken-forward", "old-client", "v2", "numeric", "malformed", "no-grant", "wrong-boot"].includes(mode);
  assert.equal(code, ["complete", "stop", "startup-stop", "ack-reset"].includes(mode) ? 0 : nonadmitted ? 2 : 1, events);
  if (nonadmitted || mode === "startup-stop") {
   assert.equal(committed, false);
   assert.equal(bytes.includes("\0"), false);
  }
  if (mode === "pause-failure") {
   assert.equal(bytes.includes("\0"), false);
   assert.match(events, /REMOTE_PLAYBACK_UNCONFIRMED/, "a committed player still needs exit proof even without PCM");
  }
  if (["old-client", "v2"].includes(mode)) assert.equal(bytes, "PI_VOICE_CONTROLhello\n");
  if (mode === "complete") assert.match(events, /remote-released/);
  if (mode === "no-grant") assert.match(feedback, /no-audio/);
 });
}
