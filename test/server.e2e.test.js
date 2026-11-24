'use strict';

// Starts the real server.js against a fake JS8CALL TCP API and checks the
// HTTP routes, the WebSocket feed, polling behaviour and the origin check.

const test      = require('node:test');
const assert    = require('node:assert/strict');
const net       = require('net');
const path      = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const fs   = require('fs');
const os   = require('os');

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
  const sent      = [];   // every command received, in full
  const replies = {
    'RIG.GET_FREQ':         id => ({ type: 'RIG.FREQ', value: '', params: { _ID: id, DIAL: 7078000, FREQ: 7079500, OFFSET: 1500 } }),
    'STATION.GET_CALLSIGN': id => ({ type: 'STATION.CALLSIGN', value: 'W1AW', params: { _ID: id } }),
    'STATION.GET_GRID':     id => ({ type: 'STATION.GRID', value: 'FN31PR', params: { _ID: id } }),
    'RX.GET_CALL_ACTIVITY': id => ({ type: 'RX.CALL_ACTIVITY', value: '', params: { _ID: id,
       KN4CRD: { GRID: 'EM73', SNR: -8, UTC: t0 } } }),
    'RX.GET_BAND_ACTIVITY': id => ({ type: 'RX.BAND_ACTIVITY', value: '', params: { _ID: id,
       1500: { DIAL: 7078000, OFFSET: 1500, SNR: -8, TEXT: 'KN4CRD: @ALLCALL CQ CQ ♢', UTC: t0 } } }),
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
        sent.push(q);
        const make = replies[q.type];
        if (make) setTimeout(() => sock.write(JSON.stringify(make(q.params._ID)) + '\n'), 5);
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
  });

  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    server, queries, sent,
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

  const recordDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-rec-'));
  const recordFile = path.join(recordDir, 'session.jsonl');
  t.after(async () => {
    await new Promise(r => setTimeout(r, 300));   // let the killed server release the file (Windows)
    try { fs.rmSync(recordDir, { recursive: true, force: true }); } catch { /* temp dir; harmless */ }
  });

  const proc = spawn(process.execPath,
    ['server.js', '--no-open', '--port', String(webPort), '--js8-port', String(js8Port), '--poll-seconds', '1',
     '--record', recordFile],
    { cwd: ROOT, env: { ...process.env, JS8MAP_HOST: '', JS8MAP_DATA_DIR: recordDir }, stdio: ['ignore', 'pipe', 'pipe'] });
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

  await t.test('serves every asset with the right content type', async () => {
    const { ASSETS } = require('../lib/assets');
    const expected = { '.html': 'text/html', '.js': 'javascript', '.css': 'text/css', '.json': 'json',
                       '.geojson': 'json', '.png': 'image/png', '.woff2': 'font/woff2' };
    for (const [route, rel] of Object.entries(ASSETS)) {
      const r = await fetch(base + route);
      assert.equal(r.status, 200, route);
      // ES modules are refused by browsers unless served with a JavaScript MIME type
      assert.match(r.headers.get('content-type'), new RegExp(expected[path.extname(rel)]), route);
    }
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /<script type="module" src="js\/main\.js">/);
    assert.ok(html.indexOf('grid.js') < html.indexOf('js/main.js'), 'grid.js loads before the modules');
    assert.equal((await fetch(base + '/app.js')).status, 404, 'old single-file app.js is gone');
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

  await t.test('an SNR report addressed to us marks the station as hearing us', async () => {
    const { c } = await snapshot();
    const at = Date.now() - 1000;   // in the past: the server caps future timestamps at its own clock
    js8.emit({ type: 'RX.DIRECTED', value: '', params: { FROM: 'VE3XYZ', TO: 'W1AW',
      TEXT: 'VE3XYZ: W1AW SNR -07 ♢', UTC: at, SNR: -4 } });
    const upd = await c.until(m => m.type === 'STATION_UPDATE' && m.station.callsign === 'VE3XYZ' && m.station.heardMe);
    assert.deepEqual(upd.station.heardMe, { snr: -7, at });
    const msg = await c.until(m => m.type === 'NEW_MESSAGE' && m.callsign === 'VE3XYZ' && /SNR -07/.test(m.message.text));
    assert.equal(msg.message.to, 'W1AW');
    c.ws.close();
  });

  await t.test('JS8Stat: heard reports, acks and the live feed', async () => {
    const { c, snap } = await snapshot();
    assert.equal(snap.js8stat.mayTransmit, true, 'loopback browsers may transmit by default');
    assert.equal(snap.js8stat.transmitMode, 'local');
    assert.equal(snap.js8stat.keepDays, 7);
    assert.deepEqual(snap.js8stat.records, []);

    const at = Date.now() - 2000;
    const text = '@AMRRON ,EM73TU,2,M05,111311111111,BRIDGE OUT,{&%} ♢';
    js8.emit({ type: 'RX.DIRECTED', value: text,
      params: { FROM: 'KN4CRD', TO: '@AMRRON', TEXT: text, UTC: at, DIAL: 7078000, OFFSET: 1500, SNR: -11 } });
    const rec = (await c.until(m => m.type === 'CS_RECORD' && m.record.from === 'KN4CRD')).record;
    assert.deepEqual([rec.kind, rec.target, rec.grid, rec.scope, rec.srId, rec.status, rec.remarks, rec.snr, rec.freq, rec.source],
      ['statrep', '@AMRRON', 'EM73TU', '2', 'M05', '111311111111', 'BRIDGE OUT', -11, 7078000, 'rf']);
    const feed = await c.until(m => m.type === 'CS_FEED' && m.line.from === 'KN4CRD' && /M05/.test(m.line.text));
    assert.equal(feed.line.snr, -11);

    js8.emit({ type: 'RX.ACTIVITY', value: 'VE3XYZ: @AMRRON RRSR KN4CRD,M05',
      params: { UTC: at + 500, SNR: -3, DIAL: 7078000, OFFSET: 900 } });
    const upd = await c.until(m => m.type === 'CS_UPDATE' && m.record.id === rec.id);
    assert.deepEqual(upd.record.acks, ['VE3XYZ']);
    c.ws.close();
  });

  await t.test('JS8Stat: preview, transmit and save through JS8CALL', async () => {
    const { c } = await snapshot();
    let nextReq = 1;
    const req = (payload) => {
      const reqId = nextReq++;
      c.ws.send(JSON.stringify({ ...payload, reqId }));
      return c.until(m => m.type === 'CS_RESULT' && m.reqId === reqId);
    };
    const data = { target: '@AMRRON', text: 'Net at 2100', msgId: 'B10' };

    const preview = await req({ type: 'CS_SUBMIT', action: 'preview', form: 'message', data });
    assert.equal(preview.ok, true);
    assert.equal(preview.text, '@AMRRON MSG ,B10,NET AT 2100,{^%}');
    assert.ok(!js8.sent.some(q => q.type === 'TX.SEND_MESSAGE'), 'a preview sends nothing');

    const bad = await req({ type: 'CS_SUBMIT', action: 'send', form: 'statrep', data: { target: '@AMRRON' } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /grid/i);

    const sentRes = await req({ type: 'CS_SUBMIT', action: 'send', form: 'message', data });
    assert.equal(sentRes.ok, true, sentRes.error);
    for (let i = 0; i < 50 && !js8.sent.some(q => q.type === 'TX.SEND_MESSAGE'); i++) await new Promise(r => setTimeout(r, 50));
    const tx = js8.sent.find(q => q.type === 'TX.SEND_MESSAGE');
    assert.equal(tx.value, '@AMRRON MSG ,B10,NET AT 2100,{^%}');
    assert.equal(sentRes.record.source, 'sent');
    assert.equal(sentRes.record.freq, 7078000);
    await c.until(m => m.type === 'CS_RECORD' && m.record.msgId === 'B10');
    assert.equal(sentRes.record.wire, '@AMRRON MSG ,B10,NET AT 2100,{^%}');

    // Resend: the preview gives the exact text and airtime, and sends nothing
    const again = await req({ type: 'CS_RESEND', id: sentRes.record.id, preview: true });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.text, sentRes.record.wire);
    assert.ok(again.airtime.frames >= 2);
    assert.equal(js8.sent.filter(q => q.type === 'TX.SEND_MESSAGE').length, 1);

    // Relay suggestions: K9RLY hears us, N0FAR hears K9RLY
    js8.emit({ type: 'RX.DIRECTED', value: 'W1AW SNR -08', params: { FROM: 'K9RLY', TO: 'W1AW', TEXT: 'W1AW SNR -08', UTC: Date.now() - 500, SNR: -6 } });
    js8.emit({ type: 'RX.DIRECTED', value: 'K9RLY SNR -11', params: { FROM: 'N0FAR', TO: 'K9RLY', TEXT: 'K9RLY SNR -11', UTC: Date.now() - 500, SNR: -14 } });
    await c.until(m => m.type === 'STATION_UPDATE' && m.station.callsign === 'N0FAR');
    const routes = await req({ type: 'CS_ROUTES', target: 'N0FAR' });
    assert.equal(routes.routes.relays[0].call, 'K9RLY');

    const saved = await req({ type: 'CS_SUBMIT', action: 'save', form: 'alert',
      data: { target: '@AMRRON', color: '2', title: 'Test', message: 'Saved only', alertId: 'B11' } });
    assert.equal(saved.record.source, 'saved');
    assert.equal(js8.sent.filter(q => q.type === 'TX.SEND_MESSAGE').length, 1, 'save does not transmit');

    // Saved to disk, so a restart keeps them
    const file = path.join(recordDir, 'js8stat.jsonl');
    const ops = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
    assert.ok(ops.some(o => o.op === 'add' && o.rec.msgId === 'B10'));
    assert.ok(ops.some(o => o.op === 'ack' && o.call === 'VE3XYZ'));

    const del = await req({ type: 'CS_DELETE', id: saved.record.id });
    assert.equal(del.ok, true);
    await c.until(m => m.type === 'CS_REMOVE' && m.id === saved.record.id);
    c.ws.close();
  });

  await t.test('--record captured events and query replies that replay cleanly', async () => {
    const { parseRecording, replay } = require('../lib/replay');
    await new Promise(r => setTimeout(r, 300));   // let the write stream flush
    const { entries, errors } = parseRecording(fs.readFileSync(recordFile, 'utf8'));
    assert.deepEqual(errors, []);
    assert.ok(entries.some(e => e.src === 'event' && /VE3XYZ/.test(e.line)), 'live events recorded');
    for (const q of ['STATION.GET_CALLSIGN', 'STATION.GET_GRID', 'RX.GET_CALL_ACTIVITY', 'RX.GET_BAND_ACTIVITY']) {
      assert.ok(entries.some(e => e.src === 'reply' && e.query === q), `${q} reply recorded`);
    }
    const { store } = replay(entries);
    assert.deepEqual(store.myStation, { callsign: 'W1AW', grid: 'FN31PR' });
    assert.ok(store.stations.get('KN4CRD'));
    assert.equal(store.stations.get('VE3XYZ').heardMe.snr, -7);
  });
});

test('port already in use: one clear error, and no recording file left behind', async () => {
  const net     = require('net');
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => blocker.once('listening', r));
  const port = blocker.address().port;
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-busy-'));
  const rec  = path.join(dir, 'never.jsonl');
  try {
    const proc = spawn(process.execPath, ['server.js', '--no-open', '--port', String(port), '--record', rec, '--data-dir', dir], { cwd: ROOT });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    const code = await new Promise(r => proc.on('exit', r));
    assert.equal(code, 1);
    assert.match(out, new RegExp(`Port ${port} is already in use`));
    assert.doesNotMatch(out, /WebSocket server error/);
    assert.equal(fs.existsSync(rec), false, 'no recording file created');
  } finally {
    blocker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with --transmit off nothing can be sent or saved', async (t) => {
  const js8Port = await freePort();
  const webPort = await freePort();
  const js8     = await fakeJS8(js8Port);
  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-off-'));
  const proc = spawn(process.execPath,
    ['server.js', '--no-open', '--port', String(webPort), '--js8-port', String(js8Port), '--transmit', 'off', '--data-dir', dir],
    { cwd: ROOT, stdio: 'ignore' });
  t.after(async () => {
    proc.kill();
    await js8.close();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  });
  let c;
  for (let i = 0; !c; i++) {
    try { c = await openWS(`ws://127.0.0.1:${webPort}`); }
    catch (err) { if (i > 100) throw err; await new Promise(r => setTimeout(r, 100)); }
  }
  const snap = await c.until(m => m.type === 'SNAPSHOT');
  assert.equal(snap.js8stat.mayTransmit, false);
  assert.equal(snap.js8stat.transmitMode, 'off');
  for (const action of ['send', 'save']) {
    c.ws.send(JSON.stringify({ type: 'CS_SUBMIT', reqId: action, action, form: 'message', data: { target: '@AMRRON', text: 'hi' } }));
    const res = await c.until(m => m.type === 'CS_RESULT' && m.reqId === action);
    assert.equal(res.ok, false);
    assert.match(res.error, /switched off/);
  }
  c.ws.send(JSON.stringify({ type: 'CS_RESEND', reqId: 'resend', id: 1 }));
  const resend = await c.until(m => m.type === 'CS_RESULT' && m.reqId === 'resend');
  assert.equal(resend.ok, false);
  assert.ok(!js8.sent.some(q => q.type === 'TX.SEND_MESSAGE'));
  c.ws.close();
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
