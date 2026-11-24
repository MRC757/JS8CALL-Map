'use strict';

const net       = require('net');
const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');

const { loadConfig, configHint, HELP }                  = require('./lib/config');
const { createStationStore }                            = require('./lib/station-store');
const { isResponseTo, isAllowedOrigin, isLoopbackAddress, LineSplitter } = require('./lib/net-utils');
const { browserUrl, openBrowser, hasDesktop, networkUrls } = require('./lib/open-browser');
const { ASSETS, assetPath }                             = require('./lib/assets');
const { createRecorder }                                = require('./lib/recorder');
const { createRecordStore }                             = require('./lib/js8stat/store');
const { createJS8Stat }                                = require('./lib/js8stat');

// ─── Configuration ────────────────────────────────────────────────────────────
let config;
try { config = loadConfig(); }
catch (err) { console.error(`\n${err.message}\n\n${HELP}\n`); process.exit(1); }
if (config.help) { console.log(HELP); process.exit(0); }

const POLL_INTERVAL    = config.pollSeconds * 1000;
const CLEANUP_INTERVAL = 60_000;
const QUERY_TIMEOUT    = 5_000;

// Optional raw-traffic recording (--record <file>) for building test data.
// Created once the web server is listening, so a failed start leaves no file.
let recorder = null;

// ─── HTTP + WebSocket Server ──────────────────────────────────────────────────
const app = express();

// Every browser file is read into memory once at startup (this also works
// inside the pkg bundle, and a missing file fails immediately, not on first use).
for (const [route, rel] of Object.entries(ASSETS)) {
  const body = fs.readFileSync(assetPath(rel));
  const type = route === '/' ? 'html' : path.extname(rel);
  app.get(route, (_req, res) => res.type(type).send(body));
}

const httpServer = http.createServer(app);
const wss = new WebSocket.Server({
  server: httpServer,
  maxPayload: 64 * 1024,   // browsers only send small JS8Stat forms
  verifyClient: ({ origin, req }) => isAllowedOrigin(origin, req.headers.host),
});

httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nError: Port ${config.webPort} is already in use.`);
    console.error('Start with a different port, e.g.  js8call-map --port 8282');
    console.error(`or put { "webPort": 8282 } in ${configHint()}.\n`);
  } else {
    console.error('HTTP server error:', err.message);
  }
  process.exit(1);
});

// The WebSocket server re-emits the HTTP server's listen errors; those are
// already reported (with advice) by the handler above.
wss.on('error', err => {
  if (err.code !== 'EADDRINUSE') console.error('WebSocket server error:', err.message);
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ─── Station Store and JS8Stat ───────────────────────────────────────────────
let js8callConnected = false;
let js8stat = null;   // created below; the station store hands it every message heard

const store = createStationStore({
  broadcast,
  ttl:         config.ttlMinutes * 60 * 1000,
  maxMessages: config.maxMessages,
  onText:      heard => js8stat && js8stat.handleHeard(heard),
});

const records = createRecordStore({
  file:     path.join(config.dataDir, 'js8stat.jsonl'),
  keepDays: config.keepDays,
  broadcast,
});

js8stat = createJS8Stat({
  broadcast,
  records,
  getMyStation:  () => store.myStation,
  lookupStation: cs => store.stations.get(cs),
  sendToJS8,
  queryJS8:      queryJS8Call,
  isConnected:   () => js8callConnected,
  // A station heard without a grid square takes the one from its own report.
  onReportGrid:  (cs, grid, utc) => {
    const s = store.stations.get(cs);
    if (s && !s.grid) store.touchStation(cs, { grid, heardAt: utc });
  },
});

/** May this browser send (and save) JS8Stat traffic? See the --transmit option. */
function clientMayTransmit(req) {
  if (config.transmit === 'lan')   return true;
  if (config.transmit === 'local') return isLoopbackAddress(req.socket.remoteAddress);
  return false;
}

wss.on('connection', (ws, req) => {
  const mayTransmit = clientMayTransmit(req);
  ws.on('error', err => console.error('WebSocket client error:', err.message));
  ws.on('message', data => handleClientMessage(ws, mayTransmit, data));
  ws.send(JSON.stringify({
    type: 'SNAPSHOT', ...store.snapshot(), connected: js8callConnected,
    js8stat: { ...js8stat.snapshot(), mayTransmit, transmitMode: config.transmit, keepDays: config.keepDays },
  }));
});

/** Requests from a browser: JS8Stat forms (preview / save / send) and record deletion. */
async function handleClientMessage(ws, mayTransmit, data) {
  let req;
  try { req = JSON.parse(data); } catch { return; }
  if (!req || typeof req !== 'object') return;
  const reply = payload => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CS_RESULT', reqId: req.reqId, ...payload }));
  };
  try {
    if (req.type === 'CS_SUBMIT') {
      if (req.action !== 'preview' && !mayTransmit) {
        throw new Error(config.transmit === 'off'
          ? 'Transmitting is switched off on the server (transmit setting is "off")'
          : 'Transmitting is only allowed from a browser on the PC running the map');
      }
      const result = await js8stat.submit({ action: req.action, form: req.form, data: req.data || {} });
      if (req.action === 'send') console.log(`Transmitted: ${result.text}`);
      reply({ ok: true, ...result });
    } else if (req.type === 'CS_RESEND') {
      // Send a transmitted record again, unchanged. `preview` only returns its text and airtime.
      if (!req.preview && !mayTransmit) throw new Error('Transmitting is only allowed from a browser on the PC running the map');
      const result = await js8stat.resend(req.id, { speed: req.speed, preview: !!req.preview });
      if (!req.preview) console.log(`Transmitted (resend): ${result.text}`);
      reply({ ok: true, ...result });
    } else if (req.type === 'CS_ROUTES') {
      // Direct path and relay suggestions for a message to a callsign.
      reply({ ok: true, routes: js8stat.routes(String(req.target || '')) });
    } else if (req.type === 'CS_DELETE') {
      if (!mayTransmit) throw new Error('Records can only be deleted from a browser on the PC running the map');
      reply({ ok: records.remove(Number(req.id)) });
    }
  } catch (err) {
    reply({ ok: false, error: err.message });
  }
}

const cleanupTimer = setInterval(() => {
  for (const cs of store.expire()) console.log(`Expired: ${cs}`);
}, CLEANUP_INTERVAL);
const pruneTimer = setInterval(() => records.prune(), 60 * 60 * 1000);

// ─── JS8CALL TCP Client ───────────────────────────────────────────────────────
// The persistent connection is used only as an event stream. Queries use
// short-lived connections: connect → write one command → read the reply → close.

let socket    = null;
let pollTimer = null;
let queryId   = Date.now();

/** Send one command to JS8CALL and resolve with its matching reply. */
function queryJS8Call(type, value = '') {
  return new Promise((resolve, reject) => {
    const id       = ++queryId;
    const conn     = new net.Socket();
    const splitter = new LineSplitter();
    let   settled  = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      conn.removeAllListeners();
      conn.on('error', () => {});
      conn.destroy();
      err ? reject(err) : resolve(result);
    };
    const deadline = setTimeout(() => finish(new Error('timeout')), QUERY_TIMEOUT);

    conn.connect(config.js8Port, config.js8Host, () => {
      conn.write(JSON.stringify({ type, value, params: { _ID: id } }) + '\n');
    });

    conn.on('data', chunk => {
      for (const line of splitter.push(chunk)) {
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        // Live events can arrive on this socket before the reply — skip them.
        if (isResponseTo(parsed, type, id)) {
          if (recorder) recorder.record('reply', line, { query: type });
          return finish(null, parsed);
        }
      }
    });

    conn.on('error', err => finish(err));
    conn.on('close', () => finish(new Error('closed')));
  });
}

/** Send one command that has no reply (e.g. TX.SEND_MESSAGE) on its own short connection. */
function sendToJS8(type, value = '', params = {}) {
  return new Promise((resolve, reject) => {
    const conn = new net.Socket();
    const deadline = setTimeout(() => { conn.destroy(); reject(new Error('JS8CALL did not accept the connection')); }, QUERY_TIMEOUT);
    conn.on('error', err => { clearTimeout(deadline); reject(new Error(`Could not reach JS8CALL: ${err.message}`)); });
    conn.connect(config.js8Port, config.js8Host, () => {
      const line = JSON.stringify({ type, value, params: { ...params, _ID: ++queryId } }) + '\n';
      if (recorder) recorder.record('sent', line.trim());
      conn.end(line, () => { clearTimeout(deadline); resolve(); });
    });
  });
}

async function pollJS8Call() {
  if (!js8callConnected) return;
  const queries = ['STATION.GET_CALLSIGN', 'STATION.GET_GRID', 'RX.GET_CALL_ACTIVITY', 'RX.GET_BAND_ACTIVITY'];
  for (const type of queries) {
    try {
      store.processMessage(await queryJS8Call(type));
    } catch (err) {
      if (err.message !== 'timeout' && err.message !== 'closed') {
        console.debug(`Poll ${type} failed: ${err.message}`);
      }
    }
  }
}

function connectToJS8Call() {
  console.log(`Connecting to JS8CALL at ${config.js8Host}:${config.js8Port}…`);
  socket = new net.Socket();
  const splitter = new LineSplitter();

  const connectTimeout = setTimeout(() => {
    if (!js8callConnected) {
      console.error('JS8CALL connection attempt timed out — retrying…');
      socket.destroy();
    }
  }, 15_000);

  socket.connect(config.js8Port, config.js8Host, () => {
    clearTimeout(connectTimeout);
    console.log('✓  JS8CALL connected');
    js8callConnected = true;
    broadcast({ type: 'CONNECTION_STATUS', connected: true });
    pollJS8Call();
    pollTimer = setInterval(pollJS8Call, POLL_INTERVAL);
  });

  socket.on('data', chunk => {
    for (const line of splitter.push(chunk)) {
      if (recorder) recorder.record('event', line);
      if (!store.processMessage(line) && line.includes('"CLOSE"')) console.log('JS8CALL sent CLOSE');
    }
    if (splitter.overflowed) {
      console.warn('JS8CALL rx buffer exceeded 1 MB — discarded');
      splitter.overflowed = false;
    }
  });

  socket.on('error', err => {
    clearTimeout(connectTimeout);
    console.error('JS8CALL socket error:', err.message);
    socket.destroy();
  });

  socket.on('close', () => {
    clearTimeout(connectTimeout);
    if (js8callConnected) console.log('JS8CALL disconnected – retrying in 5 s…');
    js8callConnected = false;
    clearInterval(pollTimer);
    broadcast({ type: 'CONNECTION_STATUS', connected: false });
    setTimeout(connectToJS8Call, 5_000);
  });
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  clearInterval(cleanupTimer);
  clearInterval(pruneTimer);
  clearInterval(pollTimer);
  if (socket) { socket.removeAllListeners('close'); socket.destroy(); }
  for (const client of wss.clients) client.terminate();
  const flushed = recorder
    ? recorder.close().then(() => console.log(`Recorded ${recorder.count} lines to ${recorder.file}`))
    : Promise.resolve();
  wss.close(() => {
    httpServer.close(() => {
      flushed.then(() => {
        console.log('Shutdown complete.');
        process.exit(0);
      });
    });
  });
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));   // systemctl stop
process.on('SIGHUP',  () => shutdown('SIGHUP'));    // terminal window closed (Linux/macOS)

// ─── Start ────────────────────────────────────────────────────────────────────
// The browser is opened only after listen() succeeds, so it always gets the
// address and port actually in use (and never opens if the port is taken).
httpServer.listen(config.webPort, config.webHost, () => {
  const url = browserUrl(config.webHost, config.webPort);
  console.log(`Web interface → ${url}`);
  if (config.configFilesUsed.length) console.log(`Settings from ${config.configFilesUsed.join(', ')}`);
  console.log(`JS8Stat records: ${records.records.size} kept in ${records.file} (${config.keepDays} days)`);
  console.log(`JS8Stat transmit: ${{ off: 'off', local: 'from this PC only', lan: 'from any device on the network' }[config.transmit]}`);
  if (config.webHost === '0.0.0.0' || config.webHost === '::') {
    const urls = networkUrls(config.webPort);
    console.log('Listening on all network interfaces' + (urls.length ? ' — from other devices use:' : ''));
    for (const u of urls) console.log(`  ${u}`);
  }
  if (config.record) {
    recorder = createRecorder(config.record);
    console.log(`Recording JS8CALL traffic to ${recorder.file} (stop with Ctrl+C)`);
  }
  if (config.openBrowser && !hasDesktop()) {
    console.log('No desktop session found, so no browser was opened. Browse to the address above.');
  } else if (config.openBrowser) {
    console.log('Opening your web browser… (start with --no-open to skip this)');
    openBrowser(url);
  }
  connectToJS8Call();
});
