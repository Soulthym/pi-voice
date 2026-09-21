import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { test, type TestContext } from 'node:test';

const { readLine } = await import(new URL('../scripts/ssh-desktop/read-line.mjs', import.meta.url).href);

async function sockets(t: TestContext) {
 const server = net.createServer();
 t.after(() => { server.close(); });
 server.listen(0, '127.0.0.1');
 await once(server, 'listening');
 const accepted = once(server, 'connection');
 const client = net.createConnection({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port });
 t.after(() => client.destroy());
 const [peer] = await accepted as [net.Socket];
 t.after(() => peer.destroy());
 const events = ['data', 'error', 'end', 'close'];
 const listeners = events.map(event => client.listeners(event));
 return { client, peer, assertClean() {
  for (const [index, event] of events.entries()) assert.deepEqual(client.listeners(event), listeners[index], event);
 } };
}

test('desktop ticket reader waits for fragmented newline and preserves the socket and surplus bytes', { timeout: 5000 }, async t => {
 const { client, peer, assertClean } = await sockets(t);
 const ticket = `${'a'.repeat(32)}.123`;
 let settled = false;
 const line = readLine(client).then((value: string) => { settled = true; return value; });
 // Wait for delivery before sending the next fragment: these cannot be coalesced.
 for (const fragment of ['tick', `et ${ticket}`, '\r']) {
  const delivered = once(client, 'data');
  peer.write(fragment);
  await delivered;
  assert.equal(settled, false);
 }
 const extra = Buffer.from([0, 255, 10, 128]);
 peer.write(Buffer.concat([Buffer.from('\n'), extra]));
 assert.equal(await line, `ticket ${ticket}\r`);
 assertClean();
 assert.equal(client.destroyed, false);
 assert.equal(client.isPaused(), true);
 assert.deepEqual(client.read(extra.length), extra);
 const command = once(peer, 'data');
 client.write(`record ${ticket}\n`);
 assert.equal((await command)[0].toString(), `record ${ticket}\n`);
 const reply = once(client, 'data');
 client.resume();
 peer.write('still open');
 assert.equal((await reply)[0].toString(), 'still open');
});

for (const failure of ['timeout', 'EOF', 'close', 'oversize', 'error']) {
 test(`desktop ticket reader rejects ${failure} and removes its listeners`, { timeout: 5000 }, async t => {
  const { client, peer, assertClean } = await sockets(t);
  const line = readLine(client, { timeoutMs: failure === 'timeout' ? 30 : 1000, maxBytes: 16 });
  const rejected = assert.rejects(line, failure === 'timeout' ? /timeout/ : failure === 'oversize' ? /too long/ : failure === 'error' ? /broken/ : /EOF/);
  if (failure === 'EOF') peer.end('partial');
  else if (failure === 'close') client.destroy();
  else if (failure === 'oversize') peer.write('x'.repeat(17));
  else if (failure === 'error') client.destroy(new Error('broken'));
  else peer.write('partial');
  await rejected;
  assertClean();
 });
}
