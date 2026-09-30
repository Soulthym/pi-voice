import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

async function until(check: () => boolean) {
 for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
 assert.ok(check(), "timed out");
}

for (const directory of ["client", "termux"]) {
 test(`${directory}: prebinding guardian loss seals only marked, ungranted scopes`, { timeout: 25_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-admission-"));
  const script = path.resolve(directory, "pi-voice-audio-session");
  const source = fs.readFileSync(script, "utf8");
  // Replacement must never inspect or signal the active file's historical PID.
  const replacement = source.slice(source.indexOf("old_id="), source.indexOf("# ponytail: retain receipts"));
  assert.doesNotMatch(replacement, /kill|\/proc\//);
  assert.match(replacement, /UNIX-CONNECT:.*old_id/);
  fs.mkdirSync(`${root}/bin`);
  // Synthetic native player: no binding yet, no audio without start, an internal
  // deadline even after its guardian dies. Ignore quit to exercise that deadline.
  fs.writeFileSync(`${root}/bin/mpv`, `#!${process.execPath}
const fs = require('fs'), net = require('net');
const server = net.createServer(peer => peer.on('data', data => {
 if (data.toString().includes('pi-voice-start')) fs.writeFileSync(process.env.HOME + '/admitted', '');
}));
server.listen(process.argv.find(a => a.startsWith('--input-ipc-server=')).split('=')[1], () => {
 fs.writeFileSync(process.env.HOME + '/spawned', String(process.pid));
});
setTimeout(() => { fs.writeFileSync(process.env.HOME + '/expired', ''); process.exit(0); }, 1500);
`, { mode: 0o755 });
  fs.writeFileSync(`${root}/bin/socat`, `#!${process.execPath}
const socket = require('net').createConnection(process.argv.at(-1).replace('UNIX-CONNECT:', ''));
socket.on('error', () => process.exit(1));
socket.on('connect', () => process.stdin.pipe(socket));
setTimeout(() => process.exit(0), 100);
`, { mode: 0o755 });
  const env = { ...process.env, HOME: root, XDG_RUNTIME_DIR: root, XDG_STATE_HOME: `${root}/state`, PATH: `${root}/bin:${process.env.PATH}` };
  const guardian = spawn("bash", [script], { env, detached: true });
  const closed = once(guardian, "close");
  guardian.stdin.on("error", () => {});
  guardian.stderr.resume();
  let output = "";
  guardian.stdout.on("data", chunk => output += chunk);
  try {
   guardian.stdin.write("PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE 4\n");
   await until(() => output.includes('"prepared"'));
   const scope = output.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "prepared");
   const state = `${root}/state/pi-voice/playback/${scope.id}`;
   guardian.stdin.write(`PI_VOICE_COMMIT ${scope.id} ${scope.boot_id}\n`);
   await until(() => fs.existsSync(`${root}/spawned`));
   guardian.kill("SIGKILL");
   await closed;
   assert.ok(fs.existsSync(`${state}/committed`));
   assert.equal(fs.existsSync(`${state}/bound`), false);
   assert.equal(fs.existsSync(`${state}/admission-intent`), false);
   const stop = () => spawnSync("bash", [script], { env, input: `PI_VOICE_CONTROLstop ${scope.id} ${scope.boot_id}\n`, encoding: "utf8", timeout: 8000 });
   const expected = { type: "stopped", id: scope.id, boot_id: scope.boot_id, proof: "sealed-nonadmission" };
   assert.deepEqual(JSON.parse(stop().stdout), expected);
   assert.ok(fs.existsSync(`${state}/stopped`));
   assert.equal(fs.existsSync(`${state}/exited`), false);
   assert.deepEqual(JSON.parse(stop().stdout), expected, "lost receipt retry");
   await until(() => fs.existsSync(`${root}/expired`));
   assert.equal(fs.existsSync(`${root}/admitted`), false, "orphan expires without opening audio");
   // No fabricated exit; metadata missing/unknown and durable possible admission
   // must never be promoted based on committed, absent binding, or missing socket.
   fs.unlinkSync(`${state}/not-admitted`);
   fs.writeFileSync(`${state}/admission-intent`, "");
   assert.equal(stop().stdout, "", "possible grant remains fenced");
   fs.unlinkSync(`${state}/admission-intent`);
   fs.unlinkSync(`${state}/admission-protocol`);
   assert.equal(stop().stdout, "", "legacy committed scope remains fenced");
   assert.equal(fs.existsSync(`${state}/not-admitted`), false);
  } finally {
   try { process.kill(-guardian.pid!, "SIGKILL"); } catch { /* isolated process group already exited */ }
   await closed;
   fs.rmSync(root, { recursive: true, force: true });
  }
 });
}
