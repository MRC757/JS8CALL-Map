'use strict';

const net       = require('net');
const http      = require('http');
const express   = require('express');
const WebSocket = require('ws');
const path      = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────
const JS8CALL_HOST     = '127.0.0.1';
const JS8CALL_PORT     = 2237;
const WEB_PORT         = 8080;
const POLL_INTERVAL    = 30_000;               // ms between activity polls
const MAX_MESSAGES     = 100;                  // messages kept per station
const STATION_TTL      = 4 * 60 * 60 * 1000;  // 4 hours — then station is removed
const CLEANUP_INTERVAL = 60_000;               // run expiry check every minute
const CALLSIGN_RE      = /^[A-Z0-9/]{2,12}$/; // basic sanity check on callsigns

// ─── Station Store ────────────────────────────────────────────────────────────
// Map<callsign, { callsign, grid, snr, freq, offset, utc, lastHeard, firstSeen, messages[] }>
const stations       = new Map();
let   myStation      = { callsign: '', grid: '' };
let   js8callConnected = false;

// ─── HTTP + WebSocket Server ──────────────────────────────────────────────────
const app = express();

// Serve the web UI
app.use(express.static(path.join(__dirname, 'public')));

// Serve Leaflet from node_modules so the app works fully offline
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));

const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer });

// Friendly error if the port is already taken
httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nError: Port ${WEB_PORT} is already in use.`);
    console.error(`Edit WEB_PORT at the top of server.js to use a different port.\n`);
  } else {
    console.error('HTTP server error:', err.message);
  }
  process.exit(1);
});

// Prevent unhandled WebSocket server errors from crashing the process
wss.on('error', err => console.error('WebSocket server error:', err.message));

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// Send a full state snapshot to each new browser tab
wss.on('connection', ws => {
  ws.on('error', err => console.error('WebSocket client error:', err.message));

  ws.send(JSON.stringify({
    type:        'SNAPSHOT',
    stations:    [...stations.values()],
    myStation,
    connected:   js8callConnected,
    maxMessages: MAX_MESSAGES,
  }));
});

// ─── Station Expiry ───────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - STATION_TTL;
  for (const [callsign, station] of stations) {
    if ((station.lastHeard || station.firstSeen || 0) < cutoff) {
      stations.delete(callsign);
      broadcast({ type: 'STATION_EXPIRED', callsign });
      console.log(`Expired: ${callsign}`);
    }
  }
}, CLEANUP_INTERVAL);

// ─── JS8CALL TCP Client ───────────────────────────────────────────────────────
let socket    = null;
let rxBuffer  = '';
let pollTimer = null;

function sendCmd(type, value = '', extra = {}) {
  if (!socket || !js8callConnected) return;
  const packet = JSON.stringify({ type, value, params: { _ID: Date.now(), ...extra } });
  try { socket.write(packet + '\n'); } catch (e) {
    console.error('JS8CALL write error:', e.message);
  }
}

function pollJS8Call() {
  sendCmd('STATION.GET_CALLSIGN');
  sendCmd('STATION.GET_GRID');
  sendCmd('RX.GET_CALL_ACTIVITY');
  sendCmd('RX.GET_BAND_ACTIVITY');
}

// ─── Message Processing ───────────────────────────────────────────────────────
function processMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) {
    console.debug('JS8CALL parse error:', e.message, '| raw:', raw.slice(0, 80));
    return;
  }

  const { type, value = '', params = {} } = msg;

  switch (type) {

    case 'STATION.CALLSIGN':
      myStation.callsign = value.trim().toUpperCase();
      broadcast({ type: 'MY_STATION', myStation });
      break;

    case 'STATION.GRID':
      myStation.grid = value.trim().toUpperCase();
      broadcast({ type: 'MY_STATION', myStation });
      break;

    case 'RX.SPOT': {
      const callsign = clean(params.FROM || params.CALLSIGN);
      if (!callsign) break;
      touchStation(callsign, stationUpdate(params));
      break;
    }

    case 'RX.DIRECTED': {
      const from = clean(params.FROM);
      if (!from) break;
      touchStation(from, stationUpdate(params));
      const text = (params.TEXT || value || '').trim();
      if (text) pushMessage(from, {
        from, to: clean(params.TO),
        text, utc: params.UTC ?? Date.now(), kind: 'directed',
      });
      break;
    }

    case 'RX.ACTIVITY': {
      const from = clean(params.FROM || params.CALLSIGN);
      if (!from) break;
      touchStation(from, stationUpdate(params));
      const text = (params.TEXT || value || '').trim();
      if (text) pushMessage(from, {
        from, to: clean(params.TO),
        text, utc: params.UTC ?? Date.now(), kind: 'activity',
      });
      break;
    }

    case 'RX.CALL_ACTIVITY': {
      const activity = params.CALL_ACTIVITY || {};
      for (const [cs, info] of Object.entries(activity)) {
        const callsign = clean(cs);
        if (!callsign) continue;
        touchStation(callsign, {
          grid:   clean(info.GRID),
          snr:    toNum(info.SNR),
          freq:   toNum(info.DIAL ?? info.FREQ),
          offset: toNum(info.OFFSET),
          utc:    info.UTC ?? Date.now(),
        });
        const text = (info.TEXT || '').trim();
        if (text) pushMessage(callsign, {
          from: callsign, to: '', text, utc: info.UTC ?? Date.now(), kind: 'activity',
        });
      }
      break;
    }

    case 'RX.BAND_ACTIVITY': {
      const activity = params.BAND_ACTIVITY || {};
      for (const info of Object.values(activity)) {
        if (!info.TEXT) continue;
        const m = info.TEXT.match(/^([A-Z0-9/]{2,12})\s/);
        if (!m) continue;
        const cs = m[1];
        touchStation(cs, {
          snr:  toNum(info.SNR),
          freq: toNum(info.DIAL ?? info.FREQ),
          utc:  info.UTC ?? Date.now(),
        });
        pushMessage(cs, {
          from: cs, to: '', text: info.TEXT.trim(),
          utc: info.UTC ?? Date.now(), kind: 'band',
        });
      }
      break;
    }

    case 'CLOSE':
      console.log('JS8CALL sent CLOSE');
      break;
  }
}

function clean(v) {
  return String(v || '').trim().toUpperCase();
}

function toNum(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

/** Build a station-update object from a raw JS8CALL params block. */
function stationUpdate(params) {
  return {
    grid:   clean(params.GRID),
    snr:    toNum(params.SNR),
    freq:   toNum(params.DIAL ?? params.FREQ),
    offset: toNum(params.OFFSET),
    utc:    params.UTC ?? Date.now(),
  };
}

function touchStation(callsign, update) {
  // Reject blank or malformed callsigns before they enter the store
  if (!callsign || !CALLSIGN_RE.test(callsign)) return;

  const prev = stations.get(callsign) || { callsign, messages: [], firstSeen: Date.now() };
  const next = { ...prev, lastHeard: Date.now() };

  if (update.grid)               next.grid   = update.grid;
  if (update.snr  !== undefined) next.snr    = update.snr;
  if (update.freq !== undefined) next.freq   = update.freq;
  if (update.offset !== undefined) next.offset = update.offset;
  if (update.utc)                next.utc    = update.utc;

  stations.set(callsign, next);

  // Broadcast station data without the messages array (keeps payloads small)
  const { messages: _msgs, ...stationData } = next;
  broadcast({ type: 'STATION_UPDATE', station: stationData });
}

function pushMessage(callsign, msg) {
  if (!callsign || !CALLSIGN_RE.test(callsign)) return;
  const station = stations.get(callsign);
  if (!station) return;
  station.messages = station.messages || [];
  station.messages.unshift(msg);
  if (station.messages.length > MAX_MESSAGES) station.messages.length = MAX_MESSAGES;
  broadcast({ type: 'NEW_MESSAGE', callsign, message: msg });
}

// ─── TCP Connection Management ────────────────────────────────────────────────
function connectToJS8Call() {
  console.log(`Connecting to JS8CALL at ${JS8CALL_HOST}:${JS8CALL_PORT}…`);
  socket   = new net.Socket();
  rxBuffer = '';

  // Abort the attempt if JS8CALL doesn't respond within 15 seconds
  const connectTimeout = setTimeout(() => {
    if (!js8callConnected) {
      console.error('JS8CALL connection attempt timed out — retrying…');
      socket.destroy();
    }
  }, 15_000);

  socket.connect(JS8CALL_PORT, JS8CALL_HOST, () => {
    clearTimeout(connectTimeout);
    console.log('✓  JS8CALL connected');
    js8callConnected = true;
    broadcast({ type: 'CONNECTION_STATUS', connected: true });
    pollJS8Call();
    pollTimer = setInterval(pollJS8Call, POLL_INTERVAL);
  });

  socket.on('data', chunk => {
    rxBuffer += chunk.toString('utf8');

    // Guard against memory exhaustion if JS8CALL sends data without newlines
    if (rxBuffer.length > 1_000_000) {
      console.warn('JS8CALL rx buffer exceeded 1 MB — discarding to prevent memory leak');
      rxBuffer = '';
      return;
    }

    const lines = rxBuffer.split(/\r?\n/);
    rxBuffer = lines.pop();   // keep incomplete trailing fragment
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) processMessage(trimmed);
    }
  });

  socket.on('error', err => {
    clearTimeout(connectTimeout);
    console.error('JS8CALL socket error:', err.message);
    // Destroy the socket so the 'close' event fires and triggers reconnection
    socket.destroy();
  });

  socket.on('close', () => {
    clearTimeout(connectTimeout);
    if (js8callConnected) {
      console.log('JS8CALL disconnected – retrying in 5 s…');
    }
    js8callConnected = false;
    clearInterval(pollTimer);
    broadcast({ type: 'CONNECTION_STATUS', connected: false });
    setTimeout(connectToJS8Call, 5_000);
  });
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  clearInterval(pollTimer);
  if (socket) socket.destroy();
  wss.close(() => {
    httpServer.close(() => {
      console.log('Shutdown complete.');
      process.exit(0);
    });
  });
  // Force exit after 3 s if graceful close stalls
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(WEB_PORT, () => {
  console.log(`Web interface → http://localhost:${WEB_PORT}`);
  connectToJS8Call();
});
