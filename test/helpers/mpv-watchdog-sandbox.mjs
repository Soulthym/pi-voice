// Run only through test/audio-mpv-sandbox.test.ts in a networkless container.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {trustedProcSandbox} from './trusted-proc-sandbox.mjs';
import {once} from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.env.HOME, '/work/home');
console.log(spawnSync('/usr/bin/mpv', ['--version'], {encoding:'utf8'}).stdout.split('\n')[0]);
trustedProcSandbox('/work');
const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const scope = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function until(check) {
 for (let i=0; i<400; i++) { if (check()) return; await delay(20); }
 assert.ok(check(), 'native mpv startup/ACK timed out');
}
async function run(mode) {
 const dir = `/work/${mode}`; fs.mkdirSync(dir, {mode:0o700});
 const binding = `${dir}/binding`, ipc = `${dir}/ipc`, pcm = `${dir}/pcm`;
 // Synthetic silence only, read from a regular file (no device/audio mounts).
 fs.writeFileSync(pcm, Buffer.alloc(24000 * 4 * (mode === 'eof' ? 0.1 : 90)));
 const child = spawn('mpv', ['--no-config', '--load-scripts=no', '--ao=null', '--no-video',
  '--idle=yes', '--demuxer=rawaudio', '--demuxer-rawaudio-format=floatle',
  '--demuxer-rawaudio-rate=24000', '--demuxer-rawaudio-channels=mono',
  `--input-ipc-server=${ipc}`, '--script=/work/pi-voice-mpv-watchdog.lua'], {
  env: {...process.env, PI_VOICE_TEST_ANDROID:mode === 'android' ? '1' : '0', PI_VOICE_SCOPE:scope, PI_VOICE_BOOT:boot, PI_VOICE_BINDING:binding, PI_VOICE_FIFO:pcm},
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
  assert.equal(identity[4], String(process.getuid()));
  assert.equal(identity[5], mode === 'android' ? 'unsupported-no-pid' : fs.readlinkSync('/proc/self/ns/pid'));
  assert.equal(identity[6], fs.readlinkSync('/proc/self/ns/mnt'));
  assert.deepEqual(identity.slice(7), ['binding-v3', mode === 'android' ? 'unsupported-pre5.6' : fs.readlinkSync('/proc/self/ns/time')]);
  socket=net.createConnection(ipc); await once(socket,'connect');
  socket.on('error',()=>{});
  let response=''; socket.on('data',b=>response+=b);
  const send=(...command)=>socket.write(JSON.stringify({command})+'\n');
  send('get_property', 'path');
  await until(()=>response.includes('property unavailable'));
  assert.equal(child.exitCode, null, 'native binding precedes loading PCM');
  if (mode !== 'eof') send('set_property','pause',true);
  send('script-message','pi-voice-start',scope,boot);
  if (mode === 'renewed') {
   await delay(12000);
   const nonce='a'.repeat(32);
   send('script-message','pi-voice-renew',scope,boot,nonce);
   await until(()=>fs.existsSync(binding+'.ack') && fs.readFileSync(binding+'.ack','utf8')===nonce);
   fs.unlinkSync(binding+'.ack');
   await delay(19000);
   assert.equal(child.exitCode,null,'matching renewal survives original 30s deadline while paused');
  } else if (mode === 'paused') {
   await delay(12000);
   send('script-message','pi-voice-renew','wrong',boot,'b'.repeat(32));
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
// The player override adds null output and defaults to pause for REAL mpv. Apart from the
// explicit trusted mount-view fixture above, kernel identity/proof remains real.
fs.mkdirSync('/work/bin');
fs.writeFileSync('/work/bin/mpv', '#!/bin/sh\nexec /usr/bin/mpv --ao=null --pause="${PI_VOICE_TEST_PAUSE:-yes}" "$@" --log-file="$PI_VOICE_BINDING.log"\n', {mode:0o755});
async function api(mode) {
 const dir = `/work/${mode}`; fs.mkdirSync(dir);
 const eof = mode === 'api-android-eof';
 const env = {...process.env, PI_VOICE_TEST_PAUSE:eof ? 'no' : 'yes', PI_VOICE_TEST_ANDROID:mode === 'api-android' || eof ? '1' : '0', PATH:`/work/bin:${process.env.PATH}`, XDG_RUNTIME_DIR:dir, XDG_STATE_HOME:dir};
 const children=[];
 function helper(command) {
  const child=spawn('bash', ['/work/pi-voice-audio-session'], {env});
  children.push(child);
  let output='', errors='';
  child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>errors+=b);
  child.stdin.on('error',()=>{});
  const done=once(child,'exit');
  if(command) child.stdin.end(`PI_VOICE_CONTROL${command}\n`);
  return {child,done,output:()=>output,errors:()=>errors};
 }
 const guardian=helper();
 const eofClosed=eof ? once(guardian.child,'close') : undefined;
 try {
  guardian.child.stdin.write('PI_VOICE_CONTROLhello\nPI_VOICE_PREPARE 4\n');
  await until(()=>guardian.output().includes('"type":"prepared"'));
  const events=guardian.output().trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(events[0], {type:'protocol',version:4,native_watchdog:true,lease_seconds:30});
  const prepared=events[1], state=`${dir}/pi-voice/playback/${prepared.id}`;
  guardian.child.stdin.write(`PI_VOICE_COMMIT ${prepared.id} ${prepared.boot_id}\n`);
  await until(()=>guardian.output().includes('"type":"session"'));
  const identity=fs.readFileSync(`${state}/bound`,'utf8').trim().split(' ');
  const pid=Number(identity[2]);
  assert.equal(identity[0],prepared.id); assert.equal(identity[1],boot);
  assert.equal(identity[3],fs.readFileSync(`/proc/${pid}/stat`,'utf8').replace(/^.*\) /,'').split(' ')[19]);
  assert.match(fs.readFileSync(`/proc/${pid}/cmdline`,'utf8'), /\/usr\/bin\/mpv\u0000--ao=null/);
  assert.equal(fs.existsSync(`${state}/exited`),false);
  // PCM is supplied only after the real API confirms native binding/start.
  if(eof) {
   assert.deepEqual(identity.slice(5), ['unsupported-no-pid', fs.readlinkSync('/proc/self/ns/mnt'), 'binding-v3', 'unsupported-pre5.6']);
   guardian.child.stdin.end(Buffer.alloc(24000*4*0.1));
  } else guardian.child.stdin.write(Buffer.alloc(24000*4*90));
  const began=performance.now();
  if(mode==='api-android') {
   assert.deepEqual(identity.slice(5), ['unsupported-no-pid', fs.readlinkSync('/proc/self/ns/mnt'), 'binding-v3', 'unsupported-pre5.6']);
   guardian.child.kill('SIGKILL'); await guardian.done;
   assert.equal(fs.existsSync(`${state}/exited`),false,'synthetic Android guardian death is not native exit');
  }
  if(mode==='api-renew-crash') {
   await delay(12000);
   const renew=helper(`renew ${prepared.id} ${boot}`);
   assert.equal((await renew.done)[0],0,renew.errors()+fs.readFileSync(`${state}/binding.log`,'utf8'));
   assert.deepEqual(JSON.parse(renew.output()),{type:'renewed',id:prepared.id,boot_id:boot});
   await delay(18000);
   assert.ok(fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('/usr/bin/mpv'), 'API renewal survives original deadline');
   guardian.child.kill('SIGKILL'); await guardian.done;
   await delay(500);
   assert.ok(fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('/usr/bin/mpv'), 'native mpv survives guardian crash (not a zombie)');
   assert.equal(fs.existsSync(`${state}/exited`),false,'guardian death is not native exit proof');
  }
  // Container init reaps the orphan: production procfs oracle must see actual
  // absence, not a fixture-written receipt or a zombie mistaken for absence.
  while(fs.existsSync(`/proc/${pid}`) && performance.now()-began<(eof?8000:50000)) await delay(100);
  assert.equal(fs.existsSync(`/proc/${pid}`),false,eof?'native exits on PCM EOF':'native lease expires without renewal');
  const elapsed=performance.now()-began;
  if(eof) {
   assert.equal((await eofClosed)[0],0,guardian.errors());
   assert.equal(fs.readFileSync(`${state}/binding.complete`,'utf8'),prepared.id,'natural EOF, not watchdog expiry');
   assert.deepEqual(guardian.output().trim().split('\n').map(line=>JSON.parse(line)).filter(event=>event.type==='complete'),
    [{type:'complete',id:prepared.id,boot_id:boot}]);
   assert.deepEqual(JSON.parse(fs.readFileSync(`${state}/exited`,'utf8')),{id:prepared.id,boot_id:boot,proof:'native-process-exit'});
  } else assert.ok(elapsed>=(mode==='api-renew-crash'?41000:29000),`early native exit: ${elapsed}ms`);
  if(mode==='api-expiry') assert.equal((await guardian.done)[0],0,guardian.errors());
  const stop=helper(`stop ${prepared.id} ${boot}`);
  assert.equal((await stop.done)[0],0,stop.errors());
  assert.deepEqual(JSON.parse(stop.output()),{type:'stopped',id:prepared.id,boot_id:boot,proof:'native-process-exit'});
  assert.deepEqual(JSON.parse(fs.readFileSync(`${state}/exited`,'utf8')),{id:prepared.id,boot_id:boot,proof:'native-process-exit'});
  console.log(`PASS real mpv --ao=null: ${mode}`);
 } finally {
  for(const child of children) if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
 }
}
await Promise.all([...['eof','paused','renewed','android'].map(run), ...['api-expiry','api-renew-crash','api-android','api-android-eof'].map(api)]);
