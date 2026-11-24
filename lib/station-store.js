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

/**
 * Who a JS8 message is addressed to: the first word after the sender, e.g.
 * "KN4CRD: KJ4QEO SNR -05" -> "KJ4QEO". Group calls (@ALLCALL…) and text
 * without a callsign return ''.
 */
function addresseeOf(text, from = '') {
  let words = String(text || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (words[0].endsWith(':')) words = words.slice(1);           // "FROM:" prefix
  else if (from && words[0] === from) words = words.slice(1);   // "FROM TO …" without colon
  const to = (words[0] || '').replace(/:$/, '');
  return isValidCallsign(to) ? to : '';
}

/**
 * An SNR report inside a message, e.g. "KN4CRD: KJ4QEO SNR -05" or
 * "KN4CRD: KJ4QEO HEARTBEAT SNR -12" -> { to: 'KJ4QEO', snr: -5 }.
 */
function parseSnrReport(text, from = '') {
  const to = addresseeOf(text, from);
  if (!to) return null;
  const m = String(text).match(/\bSNR\s+([+-]?\d{1,2})\b/i);
  return m ? { to, snr: Number(m[1]) } : null;
}

/**
 * The [key, entry] pairs of an activity reply. JS8CALL puts the entries
 * directly in params, keyed by callsign (call activity) or audio offset (band
 * activity), next to _ID — confirmed from a recorded session. A nested
 * params.CALL_ACTIVITY / params.BAND_ACTIVITY object is accepted too.
 */
function activityEntries(params, nestedKey) {
  const source = params[nestedKey] && typeof params[nestedKey] === 'object' ? params[nestedKey] : params;
  return Object.entries(source).filter(([k, v]) => k !== '_ID' && v && typeof v === 'object');
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
 * @param {Function} opts.onText      called with every message heard (see heard())
 */
function createStationStore({
  broadcast    = () => {},
  ttl          = 60 * 60 * 1000,
  maxMessages  = 100,
  maxMsgText   = 500,
  dedupeWindow = 10 * 60 * 1000,
  now          = Date.now,
  onText       = null,
} = {}) {
  const stations  = new Map();
  const myStation = { callsign: '', grid: '' };

  function setMyStation(fields) {
    let changed = false;
    let callsignChanged = false;
    if (fields.callsign !== undefined) {
      const cs = clean(fields.callsign);
      if (cs && cs !== myStation.callsign) { myStation.callsign = cs; changed = callsignChanged = true; }
    }
    if (fields.grid !== undefined) {
      const g = cleanGrid(fields.grid);
      if (g && g !== myStation.grid) { myStation.grid = g; changed = true; }
    }
    if (changed) broadcast({ type: 'MY_STATION', myStation: { ...myStation } });
    if (callsignChanged) rescanHeardMe();
    return changed;
  }

  /**
   * Re-derive every station's "heard me" report from its stored messages.
   * Runs when our callsign becomes known or changes, so messages that arrived
   * before JS8CALL told us our callsign still count.
   */
  function rescanHeardMe() {
    const me = myStation.callsign;
    for (const [cs, s] of stations) {
      let heardMe;
      for (const m of s.messages) {               // newest first
        const r = parseSnrReport(m.text, cs);
        if (r && r.to === me) { heardMe = { snr: r.snr, at: m.utc }; break; }
      }
      const same = heardMe === s.heardMe ||
        (heardMe && s.heardMe && heardMe.snr === s.heardMe.snr && heardMe.at === s.heardMe.at);
      if (same) continue;
      const next = { ...s, heardMe };
      if (!heardMe) delete next.heardMe;
      stations.set(cs, next);
      const { messages: _m, ...stationData } = next;
      broadcast({ type: 'STATION_UPDATE', station: { heardMe: null, ...stationData } });
    }
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
    // "Heard me" reports keep their own timestamp, independent of the readings.
    if (update.heardMe && (!next.heardMe || update.heardMe.at >= next.heardMe.at)) next.heardMe = update.heardMe;
    if (update.grid && (fresh || !next.grid)) next.grid = update.grid;
    if (fresh) {
      if (update.snr    !== undefined) next.snr    = update.snr;
      if (update.freq   !== undefined) next.freq   = update.freq;
      if (update.offset !== undefined) next.offset = update.offset;
      next.utc = heardAt;
    }

    // Skip the broadcast when nothing visible changed (typical for re-polls).
    const sameHeardMe = (prev && prev.heardMe) === next.heardMe ||
      (prev && prev.heardMe && next.heardMe &&
       prev.heardMe.snr === next.heardMe.snr && prev.heardMe.at === next.heardMe.at);
    if (prev && sameHeardMe && ['grid', 'snr', 'freq', 'offset', 'lastHeard'].every(k => prev[k] === next[k])) {
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
    // Fill in the addressee from the text, and note SNR reports about us.
    if (text) {
      to = to || addresseeOf(text, callsign);
      const me = myStation.callsign;
      const report = me && parseSnrReport(text, callsign);
      if (report && report.to === me) update = { ...update, heardMe: { snr: report.snr, at: update.heardAt } };
    }
    if (!touchStation(callsign, update)) return;
    if (!text) return;
    pushMessage(callsign, { from: callsign, to, text, utc: update.heardAt, kind });
    if (onText) {
      // A whole transmission: a directed event, or text ending in JS8CALL's ♢
      // end-of-message marker. Activity frames without it may be partial.
      const complete = kind === 'directed' || /♢\s*$/.test(text);
      onText({ from: callsign, to, text, kind, complete, utc: update.heardAt,
               freq: update.freq, offset: update.offset, snr: update.snr, tdrift: update.tdrift });
    }
  }

  function updateFrom(params, t) {
    const text = String(params.TEXT ?? '').trim();
    return {
      grid:    cleanGrid(params.GRID) || gridFromText(text) || undefined,
      snr:     toNum(params.SNR),
      freq:    toFreq(params.DIAL ?? params.FREQ),
      offset:  toOffset(params.OFFSET),
      heardAt: toEpochMs(params.UTC, t),
      tdrift:  toNum(params.TDRIFT),   // decode timing offset (s); used for the clock check
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
        // JS8CALL names the spotted station in CALL
        const cs = clean(params.CALL || params.FROM || params.CALLSIGN);
        touchStation(cs, updateFrom(params, t));
        break;
      }

      case 'RX.DIRECTED':
      case 'RX.ACTIVITY': {
        const text = String(params.TEXT || value || '').trim();
        // RX.ACTIVITY usually has no FROM; the sender is the "CALL:" prefix of the text.
        const cs   = clean(params.FROM || params.CALL || params.CALLSIGN) || (parseBandText(text)?.callsign ?? '');
        const u    = updateFrom({ ...params, TEXT: text }, t);
        heard(cs, u, text, type === 'RX.DIRECTED' ? 'directed' : 'activity', clean(params.TO));
        break;
      }

      case 'RX.CALL_ACTIVITY': {
        for (const [key, info] of activityEntries(params, 'CALL_ACTIVITY')) {
          const text = String(info.TEXT || '').trim();
          heard(clean(key), updateFrom(info, t), text, 'activity');
        }
        break;
      }

      case 'RX.BAND_ACTIVITY': {
        for (const [, info] of activityEntries(params, 'BAND_ACTIVITY')) {
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
    return { stations: [...stations.values()], myStation: { ...myStation }, maxMessages, ttlMs: ttl };
  }

  return { stations, myStation, processMessage, touchStation, pushMessage, setMyStation, expire, snapshot };
}

module.exports = {
  createStationStore,
  isValidCallsign, clean, cleanGrid, gridFromText, toNum, toFreq, toOffset, toEpochMs,
  parseBandText, normText, addresseeOf, parseSnrReport,
};
