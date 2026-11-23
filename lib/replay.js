'use strict';

const { createStationStore } = require('./station-store');

/**
 * Parse a recording made with --record into entries. Blank lines are skipped;
 * malformed lines are reported in `errors` rather than thrown.
 */
function parseRecording(text) {
  const entries = [];
  const errors  = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      const e = JSON.parse(raw);
      if (typeof e.line !== 'string' || typeof e.t !== 'number') throw new Error('missing t/line');
      entries.push(e);
    } catch (err) {
      errors.push(`line ${i + 1}: ${err.message}`);
    }
  });
  return { entries, errors };
}

/**
 * Feed a recording through a fresh station store, with the store's clock set
 * to each entry's recorded time. Returns the store and every broadcast payload.
 */
function replay(entries, storeOpts = {}) {
  let clock = entries.length ? entries[0].t : Date.now();
  const sent  = [];
  const store = createStationStore({ ...storeOpts, now: () => clock, broadcast: p => sent.push(p) });
  let handled = 0;
  for (const e of entries) {
    clock = e.t;
    if (store.processMessage(e.line)) handled++;
  }
  return { store, sent, handled, endTime: clock };
}

/** A short human-readable summary of a replay. */
function summarize({ store, sent, handled }, entries, errors = []) {
  const stations = [...store.stations.values()];
  const types = {};
  for (const e of entries) {
    let type = '?';
    try { type = JSON.parse(e.line).type || '?'; } catch { type = '(not JSON)'; }
    types[type] = (types[type] || 0) + 1;
  }
  return {
    entries:     entries.length,
    handled,
    errors,
    messageTypes: types,
    myStation:   store.myStation,
    stations:    stations.length,
    withGrid:    stations.filter(s => s.grid).length,
    messages:    stations.reduce((n, s) => n + s.messages.length, 0),
    heardMe:     stations.filter(s => s.heardMe).map(s => `${s.callsign} ${s.heardMe.snr} dB`),
    broadcasts:  sent.length,
  };
}

module.exports = { parseRecording, replay, summarize };
