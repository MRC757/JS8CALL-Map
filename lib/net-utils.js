'use strict';

// Reply type JS8CALL sends for each query we make.
const RESPONSE_TYPES = {
  'STATION.GET_CALLSIGN': 'STATION.CALLSIGN',
  'STATION.GET_GRID':     'STATION.GRID',
  'RX.GET_CALL_ACTIVITY': 'RX.CALL_ACTIVITY',
  'RX.GET_BAND_ACTIVITY': 'RX.BAND_ACTIVITY',
  'RIG.GET_FREQ':         'RIG.FREQ',
  'MODE.GET_SPEED':       'MODE.SPEED',
};

/**
 * Is `msg` the reply to the query we sent with `id`? JS8CALL echoes the _ID
 * param, so check that when it's present, and the reply type when it isn't.
 * Live events (RX.ACTIVITY etc.) that arrive on the same socket are rejected.
 */
function isResponseTo(msg, queryType, id) {
  if (!msg || typeof msg !== 'object') return false;
  const expected = RESPONSE_TYPES[queryType];
  const echoed   = msg.params && msg.params._ID;
  if (echoed !== undefined && echoed !== null && echoed !== '') {
    return String(echoed) === String(id) && (!expected || msg.type === expected);
  }
  return !!expected && msg.type === expected;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * WebSocket origin check (blocks other websites from reading the feed through
 * the user's browser). Allows non-browser clients (no Origin), loopback pages,
 * and pages served by this server under whatever address the user typed.
 */
function isAllowedOrigin(origin, hostHeader) {
  if (!origin) return true;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (LOOPBACK.has(url.hostname)) return true;
  return !!hostHeader && url.host.toLowerCase() === String(hostHeader).toLowerCase();
}

/** Is a socket's remote address this machine? (IPv4, IPv6 and IPv4-mapped forms) */
function isLoopbackAddress(addr) {
  const a = String(addr || '').toLowerCase();
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

/** Accumulates a TCP byte stream and yields complete, non-empty lines. */
class LineSplitter {
  constructor(maxBuffer = 1_000_000) {
    this.buf = '';
    this.maxBuffer = maxBuffer;
    this.overflowed = false;
  }

  push(chunk) {
    this.buf += chunk.toString('utf8');
    if (this.buf.length > this.maxBuffer) {
      this.buf = '';
      this.overflowed = true;
      return [];
    }
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop();
    return lines.map(l => l.trim()).filter(Boolean);
  }
}

module.exports = { RESPONSE_TYPES, isResponseTo, isAllowedOrigin, isLoopbackAddress, LineSplitter };
