'use strict';

// A stand-in for JS8CALL's TCP API, used by the end-to-end and browser tests.
//
// - Connections that never write are treated as event listeners; emit() sends
//   to them.
// - Query connections get the reply built by replies[type](id), with the _ID
//   echoed the way JS8CALL does.
// - With noiseOnConnect, every connection first receives a live RX.ACTIVITY
//   event, to prove query replies aren't confused with events.

const net = require('net');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function startFakeJS8({ port = 0, replies = {}, noiseOnConnect = false } = {}) {
  const listeners = new Set();
  const sockets   = new Set();
  const queries   = [];
  const sent      = [];   // every command received, in full

  const server = net.createServer(sock => {
    sockets.add(sock);
    listeners.add(sock);
    sock.on('close', () => { listeners.delete(sock); sockets.delete(sock); });
    sock.on('error', () => {});
    if (noiseOnConnect) {
      sock.write(JSON.stringify({ type: 'RX.ACTIVITY', value: 'K1ABC: NOISE',
        params: { FROM: 'K1ABC', TEXT: 'K1ABC: NOISE', UTC: Date.now(), _ID: -1 } }) + '\n');
    }
    let buf = '';
    sock.on('data', d => {
      listeners.delete(sock);   // writers are query connections, not the event listener
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const q = JSON.parse(line);
        queries.push(q.type);
        sent.push(q);
        const make = replies[q.type];
        if (make) setTimeout(() => sock.write(JSON.stringify(make(q.params._ID)) + '\n'), 5);
      }
    });
  });

  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port,
    queries,
    sent,
    emit: obj => { for (const s of listeners) s.write(JSON.stringify(obj) + '\n'); },
    close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  })));
}

module.exports = { startFakeJS8, freePort };
