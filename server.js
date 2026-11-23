'use strict';

const net       = require('net');
const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');

const { loadConfig, HELP }                              = require('./lib/config');
const { createStationStore }                            = require('./lib/station-store');
const { isResponseTo, isAllowedOrigin, LineSplitter }   = require('./lib/net-utils');
const { browserUrl, openBrowser }                       = require('./lib/open-browser');
const { ASSETS, assetPath }                             = require('./lib/assets');

// ─── Configuration ────────────────────────────────────────────────────────────
let config;
try { config = loadConfig(); }
catch (err) { console.error(`\n${err.message}\n\n${HELP}\n`); process.exit(1); }
if (config.help) { console.log(HELP); process.exit(0); }

const POLL_INTERVAL    = config.pollSeconds * 1000;
const CLEANUP_INTERVAL = 60_000;
const QUERY_TIMEOUT    = 5_000;

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
  verifyClient: ({ origin, req }) => isAllowedOrigin(origin, req.headers.host),
});

httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nError: Port ${config.webPort} is already in use.`);
    console.error('Start with a different port, e.g.  js8call-map --port 8282');
    console.error('or put { "webPort": 8282 } in config.json next to the program.\n');
  } else {
    console.error('HTTP server error:', err.message);
  }
  process.exit(1);
});

wss.on('error', err => console.error('WebSocket server error:', err.message));

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ─── Station Store ────────────────────────────────────────────────────────────
const store = createStationStore({
  broadcast,
  ttl:         config.ttlMinutes * 60 * 1000,
  maxMessages: config.maxMessages,
});
let js8callConnected = false;

wss.on('connection', ws => {
  ws.on('error', err => console.error('WebSocket client error:', err.message));
  ws.send(JSON.stringify({ type: 'SNAPSHOT', ...store.snapshot(), connected: js8callConnected }));
});

const cleanupTimer = setInterval(() => {
  for (const cs of store.expire()) console.log(`Expired: ${cs}`);
}, CLEANUP_INTERVAL);

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
        if (isResponseTo(parsed, type, id)) return finish(null, parsed);
      }
    });

    conn.on('error', err => finish(err));
    conn.on('close', () => finish(new Error('closed')));
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
  clearInterval(pollTimer);
  if (socket) { socket.removeAllListeners('close'); socket.destroy(); }
  for (const client of wss.clients) client.terminate();
  wss.close(() => {
    httpServer.close(() => {
      console.log('Shutdown complete.');
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start ────────────────────────────────────────────────────────────────────
// The browser is opened only after listen() succeeds, so it always gets the
// address and port actually in use (and never opens if the port is taken).
httpServer.listen(config.webPort, config.webHost, () => {
  const url = browserUrl(config.webHost, config.webPort);
  console.log(`Web interface → ${url}`);
  if (config.webHost === '0.0.0.0' || config.webHost === '::') console.log('(listening on all network interfaces)');
  if (config.openBrowser) {
    console.log('Opening your web browser… (start with --no-open to skip this)');
    openBrowser(url);
  }
  connectToJS8Call();
});
