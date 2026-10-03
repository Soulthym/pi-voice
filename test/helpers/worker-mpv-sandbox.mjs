// Only run inside worker-mpv-sandbox.test.ts's networkless, audio-null container.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import {mock} from 'node:test';
import {Transform} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {trustedProcSandbox} from './trusted-proc-sandbox.mjs';
import {DEFAULT_VOICE_CONFIG} from './src/config.js';
import {stopRemotePlayback} from './src/remote-playback.mjs';

assert.equal(process.env.HOME, '/work/home');
trustedProcSandbox('/work/fixture');
console.log(spawnSync('/usr/bin/mpv', ['--version'], {encoding:'utf8'}).stdout.split('\n')[0]);
fs.mkdirSync('/work/bin');
fs.writeFileSync('/work/bin/mpv', '#!/bin/sh\nexec /usr/bin/mpv --ao=null "$@"\n', {mode:0o755});
// Fault only the native player's namespace read; shell identity checks stay real.
fs.writeFileSync('/work/bin/readlink', `#!/bin/bash
if [[ $PI_VOICE_TEST_NAMESPACE_FAILURE == 1 && $1 == /proc/[0-9]*/ns/time ]]; then
 target=\${1%/ns/time}
 read -r comm < "$target/comm"
 if [[ $comm == mpv ]]; then exit 1; fi
fi
exec /usr/bin/readlink "$@"
`, {mode:0o755});
process.env.PATH = `/work/bin:${process.env.PATH}`;
// Synthesis/alignment and the trusted mount view are modeled. Worker, sink,
// TCP, shell/Lua validation, FIFO, IPC, remaining kernel identity and mpv are real.
mock.module('node:child_process', {namedExports:{spawn:(command,args,options) =>
 spawn(command, ['--experimental-test-module-mocks', '--import', '/work/fixture/worker-transport-mocks.mjs', ...args], options),
}});
const {VoiceWorkerClient} = await import('./src/worker-client.js');
async function until(check, description) {
 for (let i=0; i<600; i++) { if(check()) return; await delay(20); }
 assert.ok(check(), description);
}
async function property(ipc, name) {
 const socket = net.createConnection(ipc);
 socket.on('error',()=>{});
 try {
  await once(socket,'connect');
  socket.write(JSON.stringify({command:['get_property',name],request_id:42})+'\n');
  let text='';
  for await (const chunk of socket) {
   text+=chunk;
   for (const line of text.split('\n').slice(0,-1)) {
    const response=JSON.parse(line);
    if(response.request_id===42) return response;
   }
   text=text.slice(text.lastIndexOf('\n')+1);
  }
  throw Error('IPC closed without response');
 } finally {socket.destroy();}
}
for (const mode of ['cancel','resume','delayed-startup','namespace-failure','eof-renewal']) {
 const events=[], replies=[], commands=[], children=[], sockets=[], delayed=[];
 const started=performance.now();
 let commitAt, pendingComplete;
 let renewalClosedBeforeComplete=false;
 let pcm=0, sessionPcm;
 const server=net.createServer({allowHalfOpen:true},socket=>{
  sockets.push(socket); socket.on('error',()=>{});
  const child=spawn('bash',['/work/fixture/pi-voice-audio-session'], {
   env:{...process.env,PI_VOICE_TEST_NAMESPACE_FAILURE:mode==='namespace-failure'?'1':'0'},
  });
  children.push(child);
  child.stdin.on('error',()=>{});
  let header='', streaming=false, output='', errors='', renewal=false;
  child.stderr.on('data',b=>errors+=b);
  socket.on('data',b=>{
   if(streaming) { pcm+=b.length; return; }
   header+=b.toString('latin1');
   let end;
   while((end=header.indexOf('\n'))>=0) {
    const line=header.slice(0,end); header=header.slice(end+1); commands.push(line);
    if(line.startsWith('PI_VOICE_CONTROLrenew ')) renewal=true;
    if(line.startsWith('PI_VOICE_COMMIT ')) {commitAt=performance.now(); streaming=true; pcm+=Buffer.byteLength(header,'latin1'); header=''; break;}
   }
  });
  child.stdout.on('data',b=>{
   output+=b;
   let end;
   while((end=output.indexOf('\n'))>=0) {
    const reply=JSON.parse(output.slice(0,end)); output=output.slice(end+1); replies.push(reply);
    if(reply.type==='session') sessionPcm=pcm;
   }
  });
  child.on('close',code=>{
   if(code && errors) console.error(errors);
   if(renewal && pendingComplete) {
    renewalClosedBeforeComplete=true;
    setTimeout(pendingComplete,100);
   }
  });
  // Delay actual bridge sends, not production deadlines or helper responses.
  socket.pipe(new Transform({transform(chunk, encoding, callback) {
   const command=chunk.toString().split('\n')[0];
   if(mode==='delayed-startup' && /^(PI_VOICE_CONTROLhello|PI_VOICE_PREPARE |PI_VOICE_COMMIT )/.test(command)) {
    delayed.push(command.split(' ')[0]);
    setTimeout(()=>callback(null,chunk),1400);
   } else callback(null,chunk);
  }})).pipe(child.stdin);
  child.stdout.pipe(new Transform({transform(chunk, encoding, callback) {
   // Hold real native completion until a real renewal has failed against exited mpv.
   if(mode==='eof-renewal' && chunk.toString().includes('"type":"complete"')) pendingComplete=()=>callback(null,chunk);
   else callback(null,chunk);
  }})).pipe(socket);
  socket.on('close',()=>child.stdin.destroy());
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const output=`tcp://127.0.0.1:${server.address().port}`;
 const worker=new VoiceWorkerClient(event=>{
  events.push(event);
  if(event.type==='remote-handle') {
   if(mode==='delayed-startup') {
    delayed.push('host-grant');
    setTimeout(()=>event.grant(),1400);
   } else event.grant();
  }
 });
 try {
  worker.setPlaybackPaused(true);
  worker.sendSegment(1,1,'Synthetic transport fixture only.',{...DEFAULT_VOICE_CONFIG,output,audioCache:false});
  worker.endUtterance(1);
  if(mode==='namespace-failure') {
   await until(()=>events.some(e=>e.type==='error'),'native namespace failure reaches VoiceWorkerClient');
   assert.ok(performance.now()-commitAt<5000,'native failure does not wait for the binding deadline');
   assert.ok(events.some(e=>e.type==='error' && /namespace-time namespace-read-failed/.test(e.message)),JSON.stringify(events));
   const prepared=replies.find(e=>e.type==='prepared');
   assert.ok(prepared);
   assert.ok(replies.some(e=>e.type==='error' && e.id===prepared.id && e.native_phase==='namespace-time' && e.cause==='namespace-read-failed'));
   assert.equal(pcm,0);
   assert.ok(!replies.some(e=>e.type==='session' || e.type==='complete'));
   // Failure precedes audio admission: retain real sealed-nonadmission proof,
   // not a fabricated native exit receipt. A second stop must still recover it.
   await worker.terminate();
   assert.ok(events.some(e=>e.type==='remote-released' && e.id===prepared.id));
   await stopRemotePlayback({output,id:prepared.id,bootId:prepared.boot_id,nativeWatchdog:true});
   const proof={id:prepared.id,boot_id:prepared.boot_id,proof:'sealed-nonadmission'};
   assert.ok(replies.filter(e=>e.type==='stopped' && e.id===prepared.id && e.proof===proof.proof).length>=2);
   const state=`/work/state/pi-voice/playback/${prepared.id}`;
   assert.equal(fs.existsSync(`${state}/stopped`),true);
   assert.equal(fs.existsSync(`${state}/exited`),false);
   assert.deepEqual(JSON.parse(fs.readFileSync(`${state}/not-admitted`,'utf8')),proof);
   console.log('PASS host Socket -> worker -> real mpv --ao=null: namespace failure, retained stop proof');
   continue;
  }
  await until(()=>replies.some(e=>e.type==='session'),`session readiness must not wait for PCM: ${mode}`);
  if(mode==='delayed-startup') {
   assert.ok(performance.now()-started>5000,'aggregate startup exceeds the old whole-startup deadline');
   assert.deepEqual(delayed,['PI_VOICE_CONTROLhello','PI_VOICE_PREPARE','host-grant','PI_VOICE_COMMIT']);
  }
  const session=replies.find(e=>e.type==='session');
  const state=`/work/state/pi-voice/playback/${session.id}`;
  const ipc=`/work/runtime/pi-voice-mpv-${session.id}.sock`;
  assert.equal(sessionPcm,0,'real FIFO/native session becomes ready before any PCM');
  await until(()=>commands.includes(`PI_VOICE_CONTROLpause ${session.id}`),'host pause reaches real helper');
  for(let i=0; i<100 && (await property(ipc,'pause')).data!==true; i++) await delay(20);
  assert.equal((await property(ipc,'pause')).data,true,'native IPC accepts pause without PCM');
  await delay(200);
  assert.ok(!events.some(e=>e.type==='idle'),'buffered PCM cannot complete while native playback is paused');
  const identity=fs.readFileSync(`${state}/bound`,'utf8').trim().split(' ');
  const pid=Number(identity[2]);
  assert.match(fs.readFileSync(`/proc/${pid}/cmdline`,'utf8'), /\/usr\/bin\/mpv\u0000--ao=null/);
  assert.equal(fs.existsSync(`${state}/exited`),false);
  if(mode==='cancel') {
   const cancelId=worker.cancel();
   await until(()=>events.some(e=>e.type==='idle' && e.cancelId===cancelId),'scoped cancellation reaches client');
   assert.ok(!replies.some(e=>e.type==='complete'),'paused cancellation is not natural completion');
  } else {
   worker.setPlaybackPaused(false);
   await until(()=>events.some(e=>e.type==='idle'),'resume completes through native EOF');
   assert.ok(pcm>0,'resume delivers synthetic PCM');
   assert.ok(replies.some(e=>e.type==='complete'),`real native EOF confirms completion: ${JSON.stringify({events,replies})}`);
  }
  if(mode==='eof-renewal') {
   assert.equal(renewalClosedBeforeComplete,true);
   assert.ok(!replies.some(e=>e.type==='renewed'),'exited native player cannot ACK renewal');
   assert.ok(!commands.some(c=>c.startsWith('PI_VOICE_CONTROLstop ')),'EOF race must not trigger stop recovery');
  }
  assert.deepEqual(events.filter(e=>e.type==='error'),[]);
  assert.ok(events.some(e=>e.type==='remote-released' && e.id===session.id));
  assert.equal(fs.existsSync(`/proc/${pid}`),false,'idle follows native process disappearance');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${state}/exited`,'utf8')),{
   id:session.id,boot_id:session.boot_id,proof:'native-process-exit',
  });
  await worker.terminate();
  console.log(`PASS host Socket -> worker -> real mpv --ao=null: paused ${mode}`);
 } finally {
  await worker.terminate().catch(error=>console.error(error));
  for(const socket of sockets) socket.destroy();
  await new Promise(resolve=>server.close(resolve));
  for(const child of children) if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
 }
}
