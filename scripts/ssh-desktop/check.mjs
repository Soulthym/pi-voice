import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import {readLine} from './read-line.mjs';
// Ubuntu 24.04's Node 18 lacks this language helper; production decoder is unchanged.
Promise.withResolvers ??= function () { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const {PhoneInputClient} = await import('./src/phone-input.mjs');
const device = JSON.parse(await fs.readFile(`${process.env.HOME}/.cache/pi-voice/devices/${process.env.PI_VOICE_DEVICE_ID}.json`));
assert.equal(device.platform, 'linux');
assert.notEqual(new URL(device.inputEndpoint).port, '8766');
function connect(endpoint) { const u = new URL(endpoint); return net.createConnection({host:u.hostname, port:Number(u.port)}); }
async function request(endpoint, command) {
 const s=connect(endpoint); let data='';
 try { return await new Promise((resolve,reject) => {
  s.setTimeout(10000,()=>reject(new Error('wire timeout')));
  s.on('error',reject); s.on('connect',()=>s.write(command+'\n'));
  s.on('data',b=>{data+=b; if(data.includes('\n')) resolve(data.trim());});
 }); } finally { s.destroy(); }
}
assert.equal(await request(device.audioEndpoint,'PI_VOICE_CONTROLhello'), '{"type":"protocol","version":3}');
// Reserve/cancel over the real SSH tunnel without granting physical output.
const output = connect(device.audioEndpoint);
const hello = readLine(output);
output.once('connect', () => output.write('PI_VOICE_CONTROLhello\n'));
assert.equal(JSON.parse(await hello).version, 3);
const preparedLine = readLine(output);
output.write('PI_VOICE_PREPARE\n');
const prepared = JSON.parse(await preparedLine);
assert.equal(prepared.type, 'prepared');
assert.match(prepared.id, /^[0-9a-f-]{36}$/);
assert.match(prepared.boot_id, /^[0-9a-f-]{36}$/);
assert.deepEqual(JSON.parse(await request(device.audioEndpoint, `PI_VOICE_CONTROLstop ${prepared.id}`)),
 {type:'stopped', id:prepared.id, boot_id:prepared.boot_id});
const outputClosed = new Promise(resolve => output.once('close', resolve));
output.end(`PI_VOICE_COMMIT ${prepared.id} ${prepared.boot_id}\n`);
await outputClosed; // The durable stop tombstone must defeat this late grant.
const mode=process.argv[2];
if(mode==='hold') {
 await fs.writeFile('/work/holding', 'ready');
 while(!await fs.stat('/work/release').catch(()=>false)) await new Promise(r=>setTimeout(r,50));
 process.exit(0);
}
if(mode==='drift') while(!await fs.stat('/work/holding').catch(()=>false)) await new Promise(r=>setTimeout(r,50));
// Ticket cancellation before record on the SAME connection, over the allocated reverse tunnel.
const pending=connect(device.inputEndpoint);
const ticketLine=readLine(pending);
pending.once('connect',()=>pending.write('ticket\n'));
const reply=await ticketLine.catch(error=>{pending.destroy(); throw error;});
assert.match(reply,/^ticket [a-f0-9]{32}\.[1-9][0-9]{0,15} [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const [,ticket,bootId]=reply.split(' ');
assert.ok(Number.isSafeInteger(Number(ticket.split('.')[1])));
const ack=await request(device.inputEndpoint,`stop ${ticket}`);
assert.equal(Buffer.from(ack.slice(3),'base64').toString(),`stopped ${ticket}`);
let late=''; pending.on('data',b=>late+=b);
const closed=new Promise(resolve=>pending.once('close',resolve));
pending.resume();
pending.write(`record ${ticket} ${bootId}\n`); await closed;
assert.equal(late,'','cancelled ticket must not start a recorder');
// A server-local recorder must never be invoked for this registered TCP endpoint.
const client=new PhoneInputClient(); let samples=0, energy=0, action;
const capture=client.capture(mode==='route-gone' ? 'tcp://127.0.0.1:1' : device.inputEndpoint,{onAudio:audio=>{
 for(const x of audio){assert.ok(Number.isFinite(x));energy+=x*x;} samples+=audio.length;
 if(!action && mode==='pulse-stop') action=client.stop();
 if(!action && mode==='pulse-cancel') action=client.cancel();
}});
if(['pulse', 'pulse-stop', 'drift', 'pipewire', 'natural-eof'].includes(mode)) {
 assert.equal((await capture).type,'audio'); assert.ok(samples>1600); assert.ok(energy/samples>0.0001);
 if(mode==='natural-eof') assert.equal(samples,240000, 'all samples must flush on natural EOF');
} else if(mode==='pulse-cancel') {
 await assert.rejects(capture, /cancelled/); assert.ok(samples>0); await action;
} else {
 await assert.rejects(capture, mode==='route-gone' ? /ECONNREFUSED/ : mode==='monitor' ? /No usable default Linux microphone/ : /no decodable audio|No usable default Linux microphone/);
 assert.equal(samples,0);
}
await action;
await client.stop();
assert.equal(await fs.stat('/work/host-capture-called').catch(()=>false), false, 'no server-local capture fallback');
if(mode==='drift') await fs.writeFile('/work/release', 'done');
console.log(`PASS ${process.argv[2]}: real SSH dynamic forwarding, boot-bound ticket cancellation/ACK, playback hello, samples=${samples}`);
