import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { StopRecovery } from "../src/stop-recovery.js";
import { DeviceRouter } from "../src/device-router.js";

for (const directory of ["client", "termux"]) for (const crash of [true, false]) {
 test(`${directory}: journal-before-commit recovery seals reservation (${crash ? "crashed" : "late commit"})`, { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-reservation-"));
  const script = path.resolve(directory, "pi-voice-audio-session");
  fs.mkdirSync(`${root}/bin`);
  fs.writeFileSync(`${root}/bin/mpv`, '#!/bin/sh\ntouch "$HOME/unexpected-player"\nexit 1\n', { mode: 0o755 });
  const env = { PATH: `${root}/bin:${process.env.PATH}`, HOME: root, TMPDIR: root, XDG_RUNTIME_DIR: root, XDG_STATE_HOME: `${root}/state`, XDG_CONFIG_HOME: `${root}/config` };
  const session = spawn("bash", [script], { env });
  const closed = once(session, "close");
  session.stdin.on("error", () => {});
  let output = "";
  session.stdout.on("data", chunk => output += chunk);
  const receipts: object[] = [];
  const server = net.createServer({ allowHalfOpen: true }, peer => {
   const control = spawn("bash", [script], { env });
   let receipt = "";
   peer.pipe(control.stdin);
   control.stdout.on("data", chunk => receipt += chunk);
   control.on("close", () => { if (receipt) receipts.push(JSON.parse(receipt)); peer.end(receipt); });
  });
  try {
   server.listen(`${root}/control.sock`);
   await once(server, "listening");
   session.stdin.write("PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE 4\n");
   for (let i = 0; !output.includes('"prepared"') && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 20));
   const prepared = output.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "prepared");
   assert.ok(prepared, output);
   const state = `${root}/state/pi-voice/playback/${prepared.id}`;
   const endpoint = `unix://${root}/control.sock`;
   const journal = new StopRecovery(root, "dead-owner");
   journal.initialize();
   journal.beforeIO("output", true);
   journal.retain("output", { endpoint, id: prepared.id, bootId: prepared.boot_id, nativeWatchdog: true, selection: "custom", configured: endpoint }, "Device");
   assert.equal(fs.existsSync(`${state}/committed`), false);
   // The durable host journal exists, but no commit/grant has been sent.
   if (crash) { session.kill("SIGKILL"); await closed; }
   const recovered = new StopRecovery(root, "dead-owner");
   await recovered.retry("output", new DeviceRouter(`${root}/devices`, "replacement", {}), endpoint);
   assert.equal(new StopRecovery(root, "dead-owner").isIdle("output"), true);
   const expected = { type: "stopped", id: prepared.id, boot_id: prepared.boot_id, proof: "sealed-nonadmission" };
   assert.deepEqual(receipts, [expected]);
   assert.equal(fs.existsSync(`${state}/stopped`), true);
   assert.equal(fs.existsSync(`${state}/exited`), false, "nonadmission is never native exit evidence");
   const control = (command: string) => spawnSync("bash", [script], { env, input: `PI_VOICE_CONTROL${command}\n`, encoding: "utf8", timeout: 3000 });
   assert.deepEqual(JSON.parse(control(`stop ${prepared.id}`).stdout), expected, "lost ACK retry is durable");
   if (!crash) {
    session.stdin.end(`PI_VOICE_COMMIT ${prepared.id} ${prepared.boot_id}\n`);
    await closed;
    assert.equal(session.exitCode, 1, "a late commit cannot cross the seal");
   }
   assert.equal(control(`renew ${prepared.id} ${prepared.boot_id}`).stdout, "", "sealed reservations cannot obtain grants");
   assert.equal(fs.existsSync(`${state}/committed`), false);
   assert.equal(fs.existsSync(`${state}/bound`), false);
   assert.equal(fs.existsSync(`${root}/unexpected-player`), false);
   assert.equal(fs.existsSync(`${state}/exited`), false);
   fs.writeFileSync(`${state}/prepared`, '"invalid"\n');
   assert.equal(control(`stop ${prepared.id}`).stdout, "", "invalid preparation identity cannot attest nonadmission");
  } finally {
   session.kill("SIGKILL"); await closed;
   await new Promise<void>(resolve => server.close(() => resolve()));
   fs.rmSync(root, { recursive: true, force: true });
  }
 });
}
