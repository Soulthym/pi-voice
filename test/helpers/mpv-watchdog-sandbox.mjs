// Run only through test/audio-mpv-sandbox.test.ts in a networkless container.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.env.HOME, '/work/home');
const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const scope = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function until(check) {
 for (let i=0; i<400; i++) { if (check()) return; await delay(20); }
 assert.ok(check(), 'native mpv startup/ACK timed out');
}
async function run(mode) {
 const dir = `/work/${mode}`; fs.mkdirSync(dir);
 const binding = `${dir}/binding`, ipc = `${dir}/ipc`, pcm = `${dir}/pcm`;
 // Synthetic silence only, read from a regular file (no device/audio mounts).
 fs.writeFileSync(pcm, Buffer.alloc(24000 * 4 * (mode === 'eof' ? 0.1 : 90)));
 const child = spawn('mpv', ['--no-config', '--load-scripts=no', '--ao=null', '--no-video',
  '--idle=yes', '--demuxer=rawaudio', '--demuxer-rawaudio-format=floatle',
  '--demuxer-rawaudio-rate=24000', '--demuxer-rawaudio-channels=mono',
  `--input-ipc-server=${ipc}`, '--script=/work/pi-voice-mpv-watchdog.lua'], {
  env: {...process.env, PI_VOICE_SCOPE:scope, PI_VOICE_BOOT:boot, PI_VOICE_BINDING:binding, PI_VOICE_FIFO:pcm},
  stdio:['ignore','pipe','pipe'],
 });
 let log=''; child.stdout.on('data', b=>log+=b); child.stderr.on('data', b=>log+=b);
 const began = performance.now(); const exited = once(child, 'exit');
 let socket;
 const timeout = setTimeout(()=>child.kill('SIGKILL'), 55000);
 try {
  await until(()=>fs.existsSync(binding) && fs.existsSync(ipc));
  const identity=fs.readFileSync(binding,'utf8').trim().split(' ');
  assert.equal(identity[0], scope); assert.equal(identity[1], boot);
  assert.equal(Number(identity[2]), child.pid, 'binding is native PID, not launcher');
  assert.equal(identity[3], fs.readFileSync(`/proc/${child.pid}/stat`,'utf8').replace(/^.*\) /,'').split(' ')[19]);
  socket=net.createConnection(ipc); await once(socket,'connect');
  socket.on('error',()=>{});
  let response=''; socket.on('data',b=>response+=b);
  const send=(...command)=>socket.write(JSON.stringify({command})+'\n');
  if (mode !== 'eof') send('set_property','pause',true);
  send('script-message','pi-voice-start',scope,boot);
  if (mode === 'renewed') {
   await delay(12000);
   send('script-message','pi-voice-renew',scope,boot,'abc123');
   await until(()=>{send('get_property','shared-script-properties/pi-voice-renewed'); return response.includes('abc123');});
   await delay(19000);
   assert.equal(child.exitCode,null,'matching renewal survives original 30s deadline while paused');
  } else if (mode === 'paused') {
   await delay(12000);
   send('script-message','pi-voice-renew','wrong',boot,'def456');
  }
  // Losing the controller/IPC connection must not disable the native timer.
  socket.destroy();
  const [code, signal] = await exited;
  const elapsed=performance.now()-began;
  assert.equal(signal,null,log); assert.equal(code,mode==='eof'?0:1,log);
  if(mode==='eof') assert.equal(fs.readFileSync(binding+'.complete','utf8'),scope);
  else {
   assert.ok(elapsed >= (mode==='renewed'?41000:29000) && elapsed < (mode==='renewed'?50000:38000), `lease elapsed ${elapsed}ms: ${log}`);
   assert.equal(fs.existsSync(binding+'.complete'),false,'expiry is not natural completion');
  }
  console.log(`PASS real mpv --ao=null: ${mode}`);
 } finally { clearTimeout(timeout); socket?.destroy(); if(child.exitCode===null && child.signalCode===null) {child.kill('SIGKILL'); await exited;} }
}
await Promise.all(['eof','paused','renewed'].map(run));
