'use strict';

const { isValidGrid } = require('../public/grid');

// Callsigns: 2–12 chars of A–Z, 0–9 and '/', and at least one digit
// (every amateur callsign has one; this rejects words like "CQ" or "GRID").
const CALLSIGN_RE = /^[A-Z0-9/]{2,12}$/;

function isValidCallsign(cs) {
  return typeof cs === 'string' && CALLSIGN_RE.test(cs) && /\d/.test(cs);
}

function clean(v) {
  return String(v || '').trim().toUpperCase();
}

function cleanGrid(v) {
  const g = clean(v);
  return isValidGrid(g) ? g : undefined;
}

/** Extract "GRID FM16" / "GRID FM16RS" from free text; null if absent. */
function gridFromText(text) {
  const m = String(text || '').match(/\bGRID\s+([A-R]{2}[0-9]{2}(?:[A-X]{2})?)\b/i);
  return m ? m[1].toUpperCase() : null;
}

function toNum(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Dial frequency in Hz, limited to the HF range 1–30 MHz. */
function toFreq(v) {
  const n = toNum(v);
  return (n !== undefined && n >= 1_000_000 && n <= 30_000_000) ? n : undefined;
}

/** Audio offset within a ~3 kHz SSB passband. */
function toOffset(v) {
  const n = toNum(v);
  return (n !== undefined && n >= 0 && n <= 4_000) ? n : undefined;
}

/**
 * Normalise a JS8CALL UTC value to epoch milliseconds.
 * JS8CALL sends ms; seconds are accepted too. Missing, invalid or
 * future values (clock skew) fall back to `now`.
 */
function toEpochMs(v, now) {
  let n = toNum(v);
  if (n === undefined || n <= 0) return now;
  if (n < 1e12) n *= 1000;
  return n > now ? now : n;
}

/**
 * Split a band-activity line such as "KN4CRD: @ALLCALL CQ CQ" into
 * { callsign, text }. Returns null when the line doesn't start with a callsign.
 */
function parseBandText(text) {
  const m = String(text || '').trim().match(/^([A-Z0-9/]{2,12}):?\s/i);
  if (!m) return null;
  const callsign = m[1].toUpperCase();
  return isValidCallsign(callsign) ? { callsign, text: String(text).trim() } : null;
}

/** Comparison key for duplicate detection: case/whitespace and JS8 end-of-message marker ignored. */
function normText(t) {
  return String(t || '').replace(/♢/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * The station store: everything JS8CALL tells us, kept in memory.
 *
 * @param {object}   opts
 * @param {Function} opts.broadcast   called with each outgoing payload
 * @param {number}   opts.ttl         ms of silence before a station is dropped
 * @param {number}   opts.maxMessages messages kept per station
 * @param {number}   opts.maxMsgText  characters kept per message
 * @param {number}   opts.dedupeWindow ms within which identical text counts as a repeat
 * @param {Function} opts.now         clock (overridable for tests)
 */
function createStationStore({
  broadcast    = () => {},
  ttl          = 60 * 60 * 1000,
  maxMessages  = 100,
  maxMsgText   = 500,
  dedupeWindow = 10 * 60 * 1000,
  now          = Date.now,
} = {}) {
  const stations  = new Map();
  const myStation = { callsign: '', grid: '' };

  function setMyStation(fields) {
    let changed = false;
    if (fields.callsign !== undefined) {
      const cs = clean(fields.callsign);
      if (cs && cs !== myStation.callsign) { myStation.callsign = cs; changed = true; }
    }
    if (fields.grid !== undefined) {
      const g = cleanGrid(fields.grid);
      if (g && g !== myStation.grid) { myStation.grid = g; changed = true; }
    }
    if (changed) broadcast({ type: 'MY_STATION', myStation: { ...myStation } });
    return changed;
  }

  /**
   * Record that `callsign` was heard. `update.heardAt` is when JS8CALL heard it
   * (not when we were told), so re-polled activity doesn't keep a station alive.
   */
  function touchStation(callsign, update = {}) {
    if (!isValidCallsign(callsign)) return null;
    const t       = now();
    const heardAt = update.heardAt ?? t;
    const prev    = stations.get(callsign);

    // Don't resurrect stations that are already past their expiry.
    if (heardAt < t - ttl && !prev) return null;

    const next = prev
      ? { ...prev }
      : { callsign, messages: [], firstSeen: heardAt, lastHeard: heardAt };

    // Only reports at least as recent as what we have may change the readings,
    // so an old poll result can't overwrite a fresh live decode.
    const fresh = heardAt >= (next.utc || 0);
    if (heardAt > (next.lastHeard || 0)) next.lastHeard = heardAt;
    if (update.grid && (fresh || !next.grid)) next.grid = update.grid;
    if (fresh) {
      if (update.snr    !== undefined) next.snr    = update.snr;
      if (update.freq   !== undefined) next.freq   = update.freq;
      if (update.offset !== undefined) next.offset = update.offset;
      next.utc = heardAt;
    }

    // Skip the broadcast when nothing visible changed (typical for re-polls).
    if (prev && ['grid', 'snr', 'freq', 'offset', 'lastHeard'].every(k => prev[k] === next[k])) {
      return prev;
    }

    stations.set(callsign, next);
    const { messages: _m, ...stationData } = next;
    broadcast({ type: 'STATION_UPDATE', station: stationData });
    return next;
  }

  /** Add a message unless it repeats one already stored. Returns true if added. */
  function pushMessage(callsign, msg) {
    const station = stations.get(callsign);
    if (!station || !msg.text) return false;

    const key = normText(msg.text);
    const dup = station.messages.some(m =>
      normText(m.text) === key && Math.abs((m.utc || 0) - msg.utc) <= dedupeWindow);
    if (dup) return false;

    if (msg.text.length > maxMsgText) msg.text = msg.text.slice(0, maxMsgText) + '…';

    // Keep newest first, even when an older message arrives late.
    let i = 0;
    while (i < station.messages.length && (station.messages[i].utc || 0) > msg.utc) i++;
    station.messages.splice(i, 0, msg);
    if (station.messages.length > maxMessages) station.messages.length = maxMessages;

    broadcast({ type: 'NEW_MESSAGE', callsign, message: msg });
    return true;
  }

  /** Handle a station heard with optional text (shared by directed/activity/band paths). */
  function heard(callsign, update, text, kind, to = '') {
    if (!touchStation(callsign, update)) return;
    if (text) pushMessage(callsign, { from: callsign, to, text, utc: update.heardAt, kind });
  }

  function updateFrom(params, t) {
    const text = String(params.TEXT ?? '').trim();
    return {
      grid:    cleanGrid(params.GRID) || gridFromText(text) || undefined,
      snr:     toNum(params.SNR),
      freq:    toFreq(params.DIAL ?? params.FREQ),
      offset:  toOffset(params.OFFSET),
      heardAt: toEpochMs(params.UTC, t),
    };
  }

  function processMessage(raw) {
    let msg = raw;
    if (typeof raw === 'string') {
      try { msg = JSON.parse(raw); } catch { return false; }
    }
    if (!msg || typeof msg !== 'object') return false;

    const { type, value = '', params = {} } = msg;
    const t = now();

    switch (type) {
      case 'STATION.CALLSIGN':
        setMyStation({ callsign: value });
        break;

      case 'STATION.GRID':
        setMyStation({ grid: value });
        break;

      case 'RX.SPOT': {
        const cs = clean(params.FROM || params.CALLSIGN);
        touchStation(cs, updateFrom(params, t));
        break;
      }

      case 'RX.DIRECTED':
      case 'RX.ACTIVITY': {
        const cs   = clean(params.FROM || params.CALLSIGN);
        const text = String(params.TEXT || value || '').trim();
        const u    = updateFrom({ ...params, TEXT: text }, t);
        heard(cs, u, text, type === 'RX.DIRECTED' ? 'directed' : 'activity', clean(params.TO));
        break;
      }

      case 'RX.CALL_ACTIVITY': {
        for (const [key, info] of Object.entries(params.CALL_ACTIVITY || {})) {
          if (!info || typeof info !== 'object') continue;
          const text = String(info.TEXT || '').trim();
          heard(clean(key), updateFrom(info, t), text, 'activity');
        }
        break;
      }

      case 'RX.BAND_ACTIVITY': {
        for (const info of Object.values(params.BAND_ACTIVITY || {})) {
          if (!info || typeof info !== 'object') continue;
          const parsed = parseBandText(info.TEXT);
          if (!parsed) continue;
          heard(parsed.callsign, updateFrom({ ...info, TEXT: parsed.text }, t), parsed.text, 'band');
        }
        break;
      }

      default:
        return false;
    }
    return true;
  }

  /** Remove stations not heard within the TTL. Returns the removed callsigns. */
  function expire() {
    const cutoff  = now() - ttl;
    const removed = [];
    for (const [cs, s] of stations) {
      if ((s.lastHeard || s.firstSeen || 0) < cutoff) {
        stations.delete(cs);
        removed.push(cs);
        broadcast({ type: 'STATION_EXPIRED', callsign: cs });
      }
    }
    return removed;
  }

  function snapshot() {
    return { stations: [...stations.values()], myStation: { ...myStation }, maxMessages };
  }

  return { stations, myStation, processMessage, touchStation, pushMessage, setMyStation, expire, snapshot };
}

module.exports = {
  createStationStore,
  isValidCallsign, clean, cleanGrid, gridFromText, toNum, toFreq, toOffset, toEpochMs,
  parseBandText, normText,
};
