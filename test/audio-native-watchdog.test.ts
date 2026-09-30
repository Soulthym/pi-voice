import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
 for (let i = 0; i < 1000; i++) { if (check()) return; await delay(20); }
 assert.ok(check(), "timed out");
}
const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture() {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-native-"));
 const bin = path.join(root, "bin"); fs.mkdirSync(bin);
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_") && !key.startsWith("XDG_")));
 Object.assign(env, { HOME: root, XDG_CONFIG_HOME: `${root}/config`, XDG_STATE_HOME: `${root}/state`, XDG_CACHE_HOME: `${root}/cache`, XDG_RUNTIME_DIR: root, TMPDIR: root, PATH: `${bin}:${process.env.PATH}` });
 return { root, bin, env };
}

for (const directory of ["client", "termux"]) test(`${directory}: native watchdog monotonic deadline and scoped renewal`, () => {
 const { root, env } = fixture();
 try {
  const lua = spawnSync("lua", ["-e", `
local now, commands, callbacks = 100, {}, {}
local mp = {
 get_time=function() return now end,
 add_periodic_timer=function(_, cb) callbacks.timer=cb; return {} end,
 commandv=function(...) commands[#commands+1]={...}; return true end,
 register_script_message=function(name, cb) callbacks[name]=cb end,
 register_event=function(name, cb) callbacks[name]=cb end,
}
package.preload['mp']=function() return mp end
package.preload['mp.utils']=function() return {
 subprocess=function(args)
 local name=args.args[2]:match('/ns/(%w+)$')
 return {status=0,stdout=name..':[123]\\n'}
end} end
dofile('${path.resolve(directory, "pi-voice-mpv-watchdog.lua")}')
assert(#commands==0)
callbacks['pi-voice-start']('wrong', '${boot}')
assert(#commands==0)
callbacks['pi-voice-start']('${id}', '${boot}')
assert(commands[1][1]=='loadfile')
now=129
callbacks['pi-voice-renew']('wrong','${boot}',string.rep('a',32))
callbacks['pi-voice-renew']('${id}','wrong',string.rep('a',32))
callbacks['pi-voice-renew']('${id}','${boot}','aa')
callbacks['pi-voice-renew']('${id}','${boot}','not-a-nonce')
assert(io.open('${root}/binding.ack')==nil)
local nonce=string.rep('a',32)
callbacks['pi-voice-renew']('${id}','${boot}',nonce)
local function ack()
 local f=assert(io.open('${root}/binding.ack')); local value=f:read('*a'); f:close(); return value
end
assert(ack()==nonce)
now=158.9; callbacks.timer(); assert(#commands==1)
-- Pause and missing guardian/transport cannot suppress a native timer.
now=159; callbacks.timer(); assert(commands[2][1]=='quit' and commands[2][2]=='1')
callbacks['pi-voice-renew']('${id}','${boot}',string.rep('b',32))
assert(ack()==nonce, 'an expired lease must never be resurrected')
`], { env: { ...env, PI_VOICE_SCOPE: id, PI_VOICE_BOOT: boot, PI_VOICE_BINDING: `${root}/binding`, PI_VOICE_FIFO: `${root}/pcm` }, encoding: "utf8" });
  assert.equal(lua.status, 0, lua.stderr);
  const binding = fs.readFileSync(`${root}/binding`, "utf8").trim().split(" ");
  assert.equal(binding[0], id); assert.equal(binding[1], boot);
  assert.match(binding[2], /^[1-9][0-9]*$/); assert.match(binding[3], /^[0-9]+$/);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const directory of ["client", "termux"]) test(`${directory}: native capability and callback failures attempt stop and quit`, () => {
 for (const mode of ['setup-clock', 'setup-timer', 'setup-utils', 'setup-message', 'setup-event', 'setup-open', 'setup-write', 'setup-close', 'setup-rename', 'clock', 'open', 'write', 'close', 'rename', 'loadfile', 'load-return', 'end-file', 'complete', 'quit']) {
  const { root, env } = fixture();
  try {
   const lua = spawnSync('lua', ['test/helpers/native-watchdog-failure.lua', path.resolve(directory, 'pi-voice-mpv-watchdog.lua'), mode], {
    env: { ...env, PI_VOICE_SCOPE: id, PI_VOICE_BOOT: boot, PI_VOICE_BINDING: `${root}/binding`, PI_VOICE_FIFO: `${root}/pcm` }, encoding: 'utf8',
   });
   assert.equal(lua.status, 0, `${mode}: ${lua.stderr}`);
   assert.match(lua.stderr, /Pi Voice watchdog:/, 'native failures are reported');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
 }
});

for (const directory of ["client", "termux"]) test(`${directory}: bind before PCM, orphan native proof, and legacy fail-closed`, async () => {
 const { root, bin, env } = fixture();
 const children: ChildProcess[] = [];
 const script = path.resolve(directory, "pi-voice-audio-session");
 const fake = (name: string, source: string) => fs.writeFileSync(`${bin}/${name}`, `#!${process.execPath}\n${source}`, { mode: 0o755 });
 fake("mpv", `
const fs=require('fs'), net=require('net');
const ipc=process.argv.find(v=>v.startsWith('--input-ipc-server=')).split('=')[1];
const binding=process.env.PI_VOICE_BINDING, id=process.env.PI_VOICE_SCOPE;
const ticks=fs.readFileSync('/proc/self/stat','utf8').replace(/^.*\\) /,'').split(' ')[19];
fs.writeFileSync(binding, [id,process.env.PI_VOICE_BOOT,process.pid,ticks,process.getuid(),fs.readlinkSync('/proc/self/ns/pid'),fs.readlinkSync('/proc/self/ns/mnt')].join(' ')+'\\n');

net.createServer(s=>{let text='';s.on('data',b=>{text+=b;let p;while((p=text.indexOf('\\n'))>=0){
 const c=JSON.parse(text.slice(0,p)).command;text=text.slice(p+1);
 if(c[0]==='quit' && !fs.existsSync(process.env.HOME+'/hold')) process.exit(0);
 if(c[1]==='pi-voice-start') {
  if(!fs.existsSync(binding.replace(/binding$/,'bound')) || !fs.existsSync(binding.replace(/binding$/,'admission-intent'))) process.exit(99);
  fs.writeFileSync(process.env.HOME+'/started',String(process.pid));
 }
 if(c[1]==='pi-voice-renew') {
  const mode=fs.existsSync(process.env.HOME+'/ack-mode') ? fs.readFileSync(process.env.HOME+'/ack-mode','utf8') : 'exact';
  if(mode!=='missing') {
   fs.writeFileSync(binding+'.ack.tmp', mode==='exact'?c[4]:mode==='newline'?c[4]+'\\n':mode==='substring'?'prefix'+c[4]+'suffix':'stale', {mode:0o600});
   fs.renameSync(binding+'.ack.tmp',binding+'.ack');
  }
 }
 if(c[1]==='shared-script-properties') process.exit(98);
 s.write(JSON.stringify({data:0})+'\\n');
}});s.on('end',()=>s.end());}).listen(ipc);
`);
 fake("socat", `
const net=require('net');const s=net.createConnection(process.argv.at(-1).replace('UNIX-CONNECT:',''));
s.on('error',()=>process.exit(1));s.on('connect',()=>process.stdin.pipe(s));s.pipe(process.stdout);
setTimeout(()=>{s.destroy();process.exit(0)},100);
`);
 function start(file = script) {
  const child = spawn("bash", [file], { env, detached: true }); children.push(child);
  let output = "", error = "";
  child.stdout.on("data", b => output += b); child.stderr.on("data", b => error += b); child.stdin.on("error", () => {});
  return { child, output: () => output, error: () => error };
 }
 async function control(command: string, file = script) {
  const c = start(file); c.child.stdin.end(`PI_VOICE_CONTROL${command}\n`);
  await until(() => c.child.exitCode !== null);
  return c.output();
 }
 try {
  for (const header of ["PI_VOICE_PREPARE", "PI_VOICE_AUDIO"]) {
   const old = start(); old.child.stdin.end(`PI_VOICE_CONTROLhello\n${header}\n`);
   await until(() => old.child.exitCode !== null);
   assert.match(old.output(), /upgrade host/); assert.equal(fs.existsSync(`${root}/started`), false);
  }
  const session = start(); session.child.stdin.write("PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE 4\n");
  await until(() => session.output().includes('"prepared"'));
  const prepared = session.output().trim().split("\n").map(v => JSON.parse(v)).find(v => v.type === "prepared");
  assert.equal(prepared.version, 4); assert.equal(prepared.native_watchdog, true); assert.equal(prepared.lease_seconds, 30);
  assert.equal(fs.existsSync(`${root}/started`), false);
  session.child.stdin.write(`PI_VOICE_COMMIT ${prepared.id} ${prepared.boot_id}\n`);
  await until(() => session.output().includes('"session"'));
  await until(() => fs.existsSync(`${root}/started`));
  const state = `${root}/state/pi-voice/playback/${prepared.id}`;
  const bound = fs.readFileSync(`${state}/bound`, "utf8").trim().split(" ");
  assert.equal(bound[2], fs.readFileSync(`${root}/started`, "utf8"));
  assert.match(await control(`renew ${prepared.id} ${boot}`), /"renewed"/);
  assert.equal(fs.existsSync(`${state}/binding.ack`), false, 'ACK is ephemeral');
  for (const mode of ['missing', 'newline', 'substring', 'stale']) {
   fs.writeFileSync(`${root}/ack-mode`, mode);
   fs.writeFileSync(`${state}/binding.ack`, 'stale');
   assert.equal(await control(`renew ${prepared.id} ${boot}`), '', mode);
   assert.equal(fs.existsSync(`${state}/binding.ack`), false, 'failed ACK is removed');
  }
  fs.unlinkSync(`${root}/ack-mode`);
  assert.equal(await control(`renew ${prepared.id} ${id}`), "");
  fs.writeFileSync(`${root}/hold`, "");
  session.child.kill("SIGKILL"); await until(() => session.child.signalCode !== null);
  // Native process remains alive after guardian death; no receipt can be invented.
  assert.equal(await control(`stop ${prepared.id}`), "");
  assert.equal(fs.existsSync(`${state}/exited`), false);
  process.kill(Number(bound[2]), "SIGTERM");
  // Reap the synthetic orphan through its actual process group cleanup where available.
  await delay(150);
  // A deterministic reused PID identity is equally valid exit evidence for the OLD native process.
  const selfTicks = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[19];
  bound[2] = String(process.pid); bound[3] = String(BigInt(selfTicks) + 1n);
  fs.writeFileSync(`${state}/bound`, bound.join(" ")+"\n");
  // Permission/listing failure and namespace changes must remain fenced.
  const source = fs.readFileSync(script, "utf8");
  const injected = `${root}/pi-voice-audio-session`;
  fs.writeFileSync(injected, source.replace('listing=$(LC_ALL=C QUOTING_STYLE=literal ls -1 -- /proc)', 'listing=$(false)'));
  assert.equal(await control(`stop ${prepared.id}`, injected), "");
  assert.equal(fs.existsSync(`${state}/exited`), false);
  const stopped = JSON.parse(await control(`stop ${prepared.id}`));
  assert.equal(stopped.proof, "native-process-exit"); assert.equal(stopped.boot_id, boot);
  assert.deepEqual(JSON.parse(await control(`stop ${prepared.id}`)), stopped, "durable retry");
  // A committed v3/unbound scope is never promoted by absence or a guessed PID.
  fs.unlinkSync(`${state}/bound`); fs.unlinkSync(`${state}/exited`);
  assert.equal(await control(`stop ${prepared.id}`), "");
 } finally {
  for (const child of children) {
   try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
   child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  }
  fs.rmSync(root, { recursive: true, force: true });
 }
});
