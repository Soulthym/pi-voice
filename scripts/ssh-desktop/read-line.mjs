// Leaves the socket open and paused, with bytes after the newline still buffered.
export function readLine(socket, { timeoutMs = 10000, maxBytes = 4096 } = {}) {
 return new Promise((resolve, reject) => {
  let buffered = Buffer.alloc(0);
  const timer = setTimeout(() => finish(new Error('ticket line timeout')), timeoutMs);
  function finish(error, line) {
   socket.pause();
   clearTimeout(timer);
   socket.off('data', onData);
   socket.off('error', onError);
   socket.off('end', onEnd);
   socket.off('close', onEnd);
   if (error) reject(error); else resolve(line);
  }
  function onError(error) { finish(error); }
  function onEnd() { finish(new Error('EOF before ticket newline')); }
  function onData(chunk) {
   const newline = chunk.indexOf(10);
   const length = newline < 0 ? chunk.length : newline + 1;
   if (buffered.length + length > maxBytes) return finish(new Error('ticket line too long'));
   buffered = Buffer.concat([buffered, chunk.subarray(0, length)]);
   if (newline < 0) return;
   socket.pause();
   if (length < chunk.length) socket.unshift(chunk.subarray(length));
   finish(null, buffered.subarray(0, -1).toString('utf8'));
  }
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('end', onEnd);
  socket.on('close', onEnd);
  if (socket.destroyed || socket.readableEnded) onEnd();
  else socket.resume();
 });
}
