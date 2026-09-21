import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
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
assert.equal(await request(device.audioEndpoint,'PI_VOICE_CONTROLhello'), '{"type":"protocol","version":2}');
const mode=process.argv[2];
if(mode==='hold') {
 await fs.writeFile('/work/holding', 'ready');
 while(!await fs.stat('/work/release').catch(()=>false)) await new Promise(r=>setTimeout(r,50));
 process.exit(0);
}
if(mode==='drift') while(!await fs.stat('/work/holding').catch(()=>false)) await new Promise(r=>setTimeout(r,50));
// Ticket cancellation before record on the SAME connection, over the allocated reverse tunnel.
const pending=connect(device.inputEndpoint);
const ticket=await new Promise((resolve,reject)=>{
 pending.on('error',reject); pending.on('connect',()=>pending.write('ticket\n'));
 pending.once('data',b=>resolve(b.toString().trim().split(' ')[1]));
});
assert.match(ticket,/^[a-f0-9]{32}\.\d+$/);
const ack=await request(device.inputEndpoint,`stop ${ticket}`);
assert.equal(Buffer.from(ack.slice(3),'base64').toString(),`stopped ${ticket}`);
let late=''; pending.on('data',b=>late+=b);
const closed=new Promise(resolve=>pending.once('close',resolve));
pending.write(`record ${ticket}\n`); await closed;
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
console.log(`PASS ${process.argv[2]}: real SSH dynamic forwarding, ticket cancellation/ACK, playback hello, samples=${samples}`);
