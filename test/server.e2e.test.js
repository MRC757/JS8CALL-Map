'use strict';

// Starts the real server.js against a fake JS8CALL TCP API and checks the
// HTTP routes, the WebSocket feed, polling behaviour and the origin check.

const test      = require('node:test');
const assert    = require('node:assert/strict');
const net       = require('net');
const path      = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/**
 * Fake JS8CALL. Every connection first receives a live RX.ACTIVITY event
 * (to prove query replies aren't confused with events), then any query
 * written to it is answered with its _ID echoed.
 */
function fakeJS8(port) {
  const t0 = Date.now();
  const listeners = new Set();
  const queries   = [];
  const replies = {
    'STATION.GET_CALLSIGN': id => ({ type: 'STATION.CALLSIGN', value: 'W1AW', params: { _ID: id } }),
    'STATION.GET_GRID':     id => ({ type: 'STATION.GRID', value: 'FN31PR', params: { _ID: id } }),
    'RX.GET_CALL_ACTIVITY': id => ({ type: 'RX.CALL_ACTIVITY', value: '', params: { _ID: id,
      CALL_ACTIVITY: { KN4CRD: { GRID: 'EM73', SNR: -8, UTC: t0 } } } }),
    'RX.GET_BAND_ACTIVITY': id => ({ type: 'RX.BAND_ACTIVITY', value: '', params: { _ID: id,
      BAND_ACTIVITY: { 1500: { DIAL: 7078000, OFFSET: 1500, SNR: -8, TEXT: 'KN4CRD: @ALLCALL CQ CQ ♢', UTC: t0 } } } }),
  };

  const server = net.createServer(sock => {
    listeners.add(sock);
    sock.on('close', () => listeners.delete(sock));
    sock.on('error', () => {});
    sock.write(JSON.stringify({ type: 'RX.ACTIVITY', value: 'NOISE TEXT',
      params: { FROM: 'K1ABC', TEXT: 'K1ABC: NOISE', UTC: Date.now(), _ID: -1 } }) + '\n');
    let buf = '';
    sock.on('data', d => {
      listeners.delete(sock);   // writers are query connections, not the event listener
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        const q = JSON.parse(line);
        queries.push(q.type);
        const make = replies[q.type];
        if (make) setTimeout(() => sock.write(JSON.stringify(make(q.params._ID)) + '\n'), 5);
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
  });

  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    server, queries,
    emit: obj => { for (const s of listeners) s.write(JSON.stringify(obj) + '\n'); },
    close: () => new Promise(r => { for (const s of listeners) s.destroy(); server.close(r); }),
  })));
}

/** Collects every WebSocket message; `until(pred)` waits for a matching one. */
function openWS(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const msgs = [];
    const waiters = [];
    ws.on('message', d => {
      const m = JSON.parse(d);
      msgs.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    });
    ws.on('open', () => resolve({
      ws, msgs,
      until: (pred, ms = 8000) => {
        const hit = msgs.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const w = { pred, resolve: m => { clearTimeout(timer); res(m); } };
          const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timed out waiting for message')); }, ms);
          waiters.push(w);
        });
      },
    }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

test('server end-to-end against a fake JS8CALL', async (t) => {
  const js8Port = await freePort();
  const webPort = await freePort();
  const js8     = await fakeJS8(js8Port);

  const proc = spawn(process.execPath,
    ['server.js', '--no-open', '--port', String(webPort), '--js8-port', String(js8Port), '--poll-seconds', '1'],
    { cwd: ROOT, env: { ...process.env, JS8MAP_HOST: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });

  t.after(async () => {
    proc.kill();
    await js8.close();
  });

  // Wait for the HTTP server
  const base = `http://127.0.0.1:${webPort}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + '/'); break; }
    catch { if (i > 100) throw new Error('server did not start:\n' + log); await new Promise(r => setTimeout(r, 100)); }
  }

  await t.test('serves UI, shared grid module and data files', async () => {
    for (const [route, type] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/grid.js', 'javascript'],
                                 ['/style.css', 'text/css'], ['/data/county_names.json', 'json'],
                                 ['/leaflet/leaflet.js', 'javascript'], ['/topojson/topojson-client.min.js', 'javascript'],
                                 ['/world-atlas/countries-110m.json', 'json'], ['/us-atlas/counties-10m.json', 'json']]) {
      const r = await fetch(base + route);
      assert.equal(r.status, 200, route);
      assert.match(r.headers.get('content-type'), new RegExp(type), route);
    }
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.indexOf('grid.js') < html.indexOf('app.js'), 'grid.js loads before app.js');
  });

  await t.test('only listens on loopback by default, and does not open a browser from source', async (st) => {
    assert.match(log, new RegExp(`Web interface → http://localhost:${webPort}/`));
    assert.doesNotMatch(log, /Opening your web browser/);

    const lanIp = Object.values(require('os').networkInterfaces()).flat()
      .find(a => a && a.family === 'IPv4' && !a.internal)?.address;
    if (!lanIp) return st.skip('no LAN interface on this machine');
    await assert.rejects(fetch(`http://${lanIp}:${webPort}/`, { signal: AbortSignal.timeout(2000) }),
      `not reachable via ${lanIp}`);
  });

  await t.test('rejects WebSocket connections from other websites', async () => {
    await assert.rejects(openWS(`ws://127.0.0.1:${webPort}`, { Origin: 'https://evil.example' }), /HTTP 401/);
  });

  /** Open a client and return its snapshot. */
  const snapshot = async () => {
    const c = await openWS(`ws://127.0.0.1:${webPort}`, { Origin: `http://localhost:${webPort}` });
    const snap = await c.until(m => m.type === 'SNAPSHOT');
    return { c, snap };
  };

  await t.test('first poll fills in my station and activity (reply not confused with noise)', async () => {
    let snap;
    for (let i = 0; i < 50; i++) {
      const r = await snapshot();
      r.c.ws.close();
      snap = r.snap;
      if (snap.connected && snap.myStation.grid && snap.stations.some(s => s.callsign === 'KN4CRD' && s.messages.length)) break;
      await new Promise(res => setTimeout(res, 200));
    }
    assert.equal(snap.connected, true);
    assert.deepEqual(snap.myStation, { callsign: 'W1AW', grid: 'FN31PR' });
    const kn = snap.stations.find(s => s.callsign === 'KN4CRD');
    assert.equal(kn.grid, 'EM73');
    assert.equal(kn.freq, 7078000);
    assert.equal(kn.messages.length, 1);
    assert.equal(kn.messages[0].kind, 'band');
    assert.ok(js8.queries.includes('STATION.GET_CALLSIGN'));
  });

  await t.test('repeated polls send nothing new; live events still arrive', async () => {
    const { c } = await snapshot();
    const pollsBefore = js8.queries.filter(q => q === 'RX.GET_BAND_ACTIVITY').length;

    js8.emit({ type: 'RX.DIRECTED', value: '', params: { FROM: 'VE3XYZ', TO: 'W1AW',
      TEXT: 'VE3XYZ: W1AW GRID FN25', UTC: Date.now(), DIAL: 7078000, OFFSET: 1200, SNR: -2 } });
    const ve3 = await c.until(m => m.type === 'STATION_UPDATE' && m.station.callsign === 'VE3XYZ');
    assert.equal(ve3.station.grid, 'FN25');
    const ve3msg = await c.until(m => m.type === 'NEW_MESSAGE' && m.callsign === 'VE3XYZ');
    assert.equal(ve3msg.message.kind, 'directed');
    assert.equal(ve3msg.message.to, 'W1AW');

    await new Promise(r => setTimeout(r, 3500));   // several 1-second polls
    assert.ok(js8.queries.filter(q => q === 'RX.GET_BAND_ACTIVITY').length >= pollsBefore + 2, 'kept polling');

    const repeats = c.msgs.filter(m => ['NEW_MESSAGE', 'STATION_UPDATE', 'MY_STATION'].includes(m.type)
                                       && (m.callsign === 'KN4CRD' || m.station?.callsign === 'KN4CRD' || m.type === 'MY_STATION'));
    assert.deepEqual(repeats, [], 'no re-broadcast of unchanged polled data');
    c.ws.close();

    const { c: c2, snap } = await snapshot();
    assert.equal(snap.stations.find(s => s.callsign === 'KN4CRD').messages.length, 1);
    assert.equal(snap.stations.find(s => s.callsign === 'VE3XYZ').messages.length, 1);
    assert.ok(!snap.stations.some(s => s.callsign === 'K1ABC' && snap.myStation.callsign === 'K1ABC'));
    c2.ws.close();
  });
});

test('server reports a clear error for a bad option', async () => {
  const proc = spawn(process.execPath, ['server.js', '--port', 'nope'], { cwd: ROOT });
  let out = '';
  proc.stderr.on('data', d => { out += d; });
  const code = await new Promise(r => proc.on('exit', r));
  assert.equal(code, 1);
  assert.match(out, /invalid webPort/);
  assert.match(out, /Usage:/);
});
