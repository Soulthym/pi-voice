import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
const helper = fileURLToPath(new URL("../src/tcp-playback.mjs", import.meta.url));

for (const mode of ["complete", "broken-forward", "old-client", "premature", "lost-ack", "stop", "pause-failure"] as const) {
 test(`TCP proof: ${mode}`, { timeout: 8000 }, async t => {
  const sockets = new Set<net.Socket>();
  let bytes = "";
  const server = net.createServer({ allowHalfOpen: true }, socket => {
   sockets.add(socket); socket.on("error", () => {});
   if (mode === "broken-forward") { socket.end(); return; }
   let negotiated = false;
   socket.on("data", chunk => {
    const text = chunk.toString(); bytes += text;
    if (text.startsWith("PI_VOICE_CONTROLpause")) { socket.resetAndDestroy(); return; }
    if (text.startsWith("PI_VOICE_CONTROLstop")) {
     socket.end(mode === "stop" ? '{"type":"stopped","id":123}\n' : ""); return;
    }
    if (text === "PI_VOICE_CONTROLhello\n") {
     if (mode === "old-client") socket.end();
     else socket.write('{"type":"protocol","version":2}\n');
    } else if (!negotiated && text.startsWith("PI_VOICE_AUDIO\n")) {
     negotiated = true;
     socket.write('{"type":"session","version":2,"id":123}\n');
    }
   });
   socket.on("end", () => {
    if (mode === "stop" || mode === "lost-ack") return;
    socket.end(mode === "complete" ? '{"type":"complete","id":123}\n' : "");
   });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  const child = spawn(process.execPath, [helper, `tcp://127.0.0.1:${port}`, "24000", "1"], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); for (const socket of sockets) socket.destroy(); server.close(); });
  const exit = once(child, "exit");
  let events = ""; child.stdout.on("data", chunk => events += chunk);
  child.stderr.resume();
  const control = child.stdio[3] as net.Socket;
  if (mode === "pause-failure") control.write("pause\n");
  if (mode === "stop" || mode === "lost-ack") {
   control.on("data", chunk => { if (String(chunk).includes("ready")) control.write("stop\n"); });
  } else child.stdin.end(Buffer.alloc(64));
  const [code] = await exit;
  assert.equal(code, mode === "complete" || mode === "stop" ? 0 : 1, events);
  if (mode === "pause-failure") assert.equal(bytes.includes("\0"), false, "failed startup pause must not admit PCM");
  if (mode === "old-client") assert.equal(bytes, "PI_VOICE_CONTROLhello\n", "never send audio or an unknown raw header to v1");
 });
}
