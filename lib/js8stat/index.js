'use strict';

// JS8Stat features on the server: decodes heard traffic into records, keeps
// the live feed, builds and sends the operator's transmissions, and watches
// the things that decide whether traffic gets through without the internet:
// acknowledgements, airtime, who can hear whom (for relays), group activity,
// the PC clock, and JS8CALL group membership.

const { decode, encode, isGrid, baseCall, sameCall, cleanText, stripPrefixes, estimateAirtime, timeId } = require('./protocol');
const { parseSnrReport } = require('../station-store');

// JS8CALL speed modes: label → value for MODE.SET_SPEED.
const SPEEDS = { slow: 4, normal: 0, fast: 1, turbo: 2, ultra: 8 };

const TX_GAP_MS      = 5_000;               // minimum time between transmissions
const ID_FIELDS      = { statrep: 'srId', incident: 'srId', alert: 'alertId', message: 'msgId' };
const HEAR_WINDOW    = 3 * 3600_000;        // who-hears-whom evidence is used for 3 hours
const DACK_WINDOW    = 30 * 60_000;         // a direct "ACK" counts for a message sent within 30 min
const CLOCK_WINDOW   = 15 * 60_000;         // clock check uses the last 15 minutes of decodes
const CLOCK_MIN      = 5;                   // …and needs at least this many
const CLOCK_WARN_S   = 1.0;                 // JS8CALL decodes suffer beyond about ±2 s
const CLOCK_BAD_S    = 2.0;
const ACTIVITY_KEEP  = 7 * 24 * 3600_000;   // group activity kept for the roster
const GROUP_WARN_TX  = 3;                   // partial-only transmissions before warning
const SPEED_CACHE_MS = 20_000;

// Group calls that every JS8CALL station hears; never part of a roster or membership check.
const CHATTER_GROUPS = new Set(['@ALLCALL', '@HB', '@CQ']);

const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Does this kind of transmission get acknowledged by receiving stations? */
function expectsAck(rec) {
  if (rec.kind === 'statrep' || rec.kind === 'incident') return true;   // RRSR
  if (rec.kind === 'message') return !String(rec.target).startsWith('@'); // JS8CALL's automatic ACK
  return false;
}

/**
 * @param {object}   opts
 * @param {Function} opts.broadcast      send a payload to every browser
 * @param {object}   opts.records        record store (lib/js8stat/store.js)
 * @param {Function} opts.getMyStation   () → { callsign, grid }
 * @param {Function} opts.lookupStation  callsign → heard-station object or undefined
 * @param {Function} opts.sendToJS8      (type, value, params) → Promise; fire-and-forget command
 * @param {Function} opts.queryJS8       (type) → Promise of reply
 * @param {Function} opts.isConnected    () → is JS8CALL connected
 * @param {Function} [opts.onReportGrid] (callsign, grid, utc) for each report heard with a grid
 * @param {number}   [opts.feedSize]     live-feed lines kept
 * @param {Function} [opts.now]
 */
function createJS8Stat({
  broadcast, records, getMyStation, lookupStation = () => undefined,
  sendToJS8, queryJS8, isConnected = () => false, onReportGrid = () => {}, feedSize = 300, now = Date.now,
}) {
  const feed     = [];          // newest first
  const hears    = new Map();   // "A>B" → { a, b, snr, utc }: A decoded B
  const drift    = [];          // { utc, v } decode timing offsets, seconds
  const groups   = new Map();   // "@G" → { complete, partial } transmissions heard
  const activity = new Map();   // "@G" → Map(call → { utc, kind })
  let lastTx = 0;
  let clockSent = null;         // last clock status broadcast
  let clockSentAt = 0;
  let warningsSent = '';
  let speedCache = null;        // { value, at }

  const myCall = () => getMyStation().callsign;

  // ─── Live feed ──────────────────────────────────────────────────────────────

  function addFeedLine(line) {
    // A message heard both as a live event and again by a poll appears once.
    const dup = feed.some(f => f.from === line.from && f.text === line.text && Math.abs(f.utc - line.utc) < 120_000);
    if (dup) return;
    feed.unshift(line);
    if (feed.length > feedSize) feed.length = feedSize;
    broadcast({ type: 'CS_FEED', line });
  }

  // ─── Who hears whom (relay routing) ─────────────────────────────────────────

  function noteHears(a, b, snr, utc) {
    a = baseCall(a); b = baseCall(b);
    if (!a || !b || a === b || !Number.isFinite(utc)) return;
    const key = `${a}>${b}`;
    const prev = hears.get(key);
    if (!prev || utc >= prev.utc) hears.set(key, { a, b, snr: Number.isFinite(snr) ? snr : null, utc });
  }

  function pruneHears() {
    const cutoff = now() - HEAR_WINDOW;
    for (const [k, e] of hears) if (e.utc < cutoff) hears.delete(k);
  }

  /**
   * Can we reach `target` directly, and if not, which stations could relay?
   * A relay R is useful when R can hear us and the target can hear R.
   * Reports in that direction (from SNR reports) count most; hearing in the
   * opposite direction is used as weaker evidence, as HF paths are often,
   * but not always, two-way.
   */
  function routes(target) {
    pruneHears();
    const me = baseCall(myCall());
    const T  = baseCall(target);
    const get = (a, b) => hears.get(`${a}>${b}`) || null;
    const ago = e => Math.round((now() - e.utc) / 60_000);
    const link = (e, dir) => e && { dir, snr: e.snr, minutesAgo: ago(e) };

    const direct = { targetHearsMe: link(get(T, me), 'hears'), iHearTarget: link(get(me, T), 'heard') };

    const relays = [];
    const calls = new Set();
    for (const e of hears.values()) { calls.add(e.a); calls.add(e.b); }
    for (const R of calls) {
      if (!R || R === me || R === T) continue;
      const out = link(get(R, me), 'hears') || link(get(me, R), 'heard');     // us → R
      const inn = link(get(T, R), 'hears') || link(get(R, T), 'heard');       // R → target
      if (!out || !inn) continue;
      const strength = l => (l.snr ?? -20) + (l.dir === 'hears' ? 3 : 0) - l.minutesAgo / 30;
      relays.push({ call: R, toRelay: out, toTarget: inn, score: Math.round(Math.min(strength(out), strength(inn)) * 10) / 10 });
    }
    relays.sort((a, b) => b.score - a.score);
    return { target: T, direct, relays: relays.slice(0, 5) };
  }

  // ─── Clock check ────────────────────────────────────────────────────────────

  function clockStatus() {
    const cutoff = now() - CLOCK_WINDOW;
    while (drift.length && drift[0].utc < cutoff) drift.shift();
    if (drift.length < CLOCK_MIN) return { status: 'unknown', offset: null, samples: drift.length };
    const m = median(drift.map(d => d.v));
    const status = Math.abs(m) >= CLOCK_BAD_S ? 'bad' : Math.abs(m) >= CLOCK_WARN_S ? 'warn' : 'ok';
    return { status, offset: Math.round(m * 10) / 10, samples: drift.length };
  }

  function noteDrift(v, utc) {
    if (!Number.isFinite(v) || Math.abs(v) > 30) return;
    drift.push({ utc: Number.isFinite(utc) ? utc : now(), v });
    const c = clockStatus();
    const changed = !clockSent || c.status !== clockSent.status ||
      (c.offset !== null && Math.abs(c.offset - (clockSent.offset ?? 0)) >= 0.2 && now() - clockSentAt > 30_000);
    if (changed) { clockSent = c; clockSentAt = now(); broadcast({ type: 'CS_CLOCK', clock: c }); }
  }

  // ─── Groups: roster activity and JS8CALL membership ─────────────────────────

  function groupOf(text, from, kind, to) {
    if (kind === 'directed' && String(to).startsWith('@')) return String(to).toUpperCase();
    const { body } = stripPrefixes(cleanText(text), from);
    const m = body.match(/^(@[A-Z0-9]{2,12})\b/i);
    return m ? m[1].toUpperCase() : '';
  }

  function groupWarnings() {
    return [...groups].filter(([, s]) => s.complete === 0 && s.partial >= GROUP_WARN_TX).map(([g]) => g).sort();
  }

  function noteGroup(group, from, kind, utc, recKind) {
    if (!group || CHATTER_GROUPS.has(group)) return;
    // Membership: JS8CALL passes on whole group messages (RX.DIRECTED) only for
    // groups you have added. The first frame of every transmission also
    // arrives as activity, so partial-only traffic means you aren't in the group.
    const g = groups.get(group) || { complete: 0, partial: 0 };
    if (kind === 'directed') g.complete++;
    else if (kind === 'activity') g.partial++;
    groups.set(group, g);
    const w = groupWarnings().join(',');
    if (w !== warningsSent) { warningsSent = w; broadcast({ type: 'CS_GROUPS', warnings: groupWarnings() }); }

    // Roster: when each station was last heard on the group, and with what.
    const call = baseCall(from);
    if (!activity.has(group)) activity.set(group, new Map());
    const members = activity.get(group);
    const prev = members.get(call);
    // The first frame of a report arrives (as activity) before the whole report,
    // so a report heard within a minute of that frame upgrades it.
    const upgrade = recKind && prev && prev.kind === 'traffic' && Math.abs(utc - prev.utc) < 60_000;
    if (prev && prev.utc >= utc && !upgrade) return;
    const entry = { utc: Math.max(utc, prev?.utc || 0), kind: recKind || 'traffic' };
    members.set(call, entry);
    // Broadcast new stations, report kinds and minute-level changes; skip chatter repeats.
    if (!prev || upgrade || recKind || utc - prev.utc > 60_000) {
      broadcast({ type: 'CS_ACTIVITY', group, call, utc: entry.utc, kind: entry.kind });
    }
  }

  function activitySnapshot() {
    const cutoff = now() - ACTIVITY_KEEP;
    const out = {};
    for (const [g, members] of activity) {
      for (const [c, a] of members) if (a.utc < cutoff) members.delete(c);
      if (members.size) out[g] = Object.fromEntries(members);
    }
    return out;
  }

  // ─── Heard traffic ──────────────────────────────────────────────────────────

  /**
   * Called for every message heard (live events and polled activity).
   * `complete` is true when the text is a whole transmission.
   */
  function handleHeard({ from, to = '', text, kind, utc, freq, offset, snr, complete, tdrift }) {
    if (!from || !text) return;
    const live = kind === 'directed' || kind === 'activity';
    if (live) {
      addFeedLine({ utc, freq, offset, snr, from, text: String(text).replace(/\s*♢\s*$/, '').trim(), kind });
      noteDrift(tdrift, utc);
    }

    // Who hears whom: we decoded `from`; an SNR report means `from` decoded its addressee.
    if (Number.isFinite(snr)) noteHears(myCall(), from, snr, utc);
    const report = parseSnrReport(text, from);
    if (report) noteHears(from, report.to, report.snr, utc);

    const rec = decode(text, { from, myCall: myCall(), complete });
    noteGroup(groupOf(text, from, kind, to), rec?.from || from, kind, utc, rec && rec.kind !== 'ack' ? rec.kind : '');
    if (!rec) return;
    if (rec.kind === 'ack')  { records.ack(rec.call, rec.srId, rec.from); return; }
    if (rec.kind === 'dack') { directAck(rec.from, utc); return; }

    // Reports without a grid square (the older F! formats) take the station's own.
    if ((rec.kind === 'statrep' || rec.kind === 'incident') && !rec.grid) {
      const g = lookupStation(rec.from)?.grid;
      if (isGrid(g)) { rec.grid = g; rec.gridFromStation = true; }
    }
    records.add({ ...rec, utc, freq, offset, snr, source: 'rf' });
    if ((rec.kind === 'statrep' || rec.kind === 'incident') && rec.grid && !rec.gridFromStation && !rec.forwardedBy) {
      onReportGrid(rec.from, rec.grid, utc);
    }
  }

  /** JS8CALL's "ACK" from `call`: credit the latest message we sent to it. */
  function directAck(call, utc) {
    let match = null;
    for (const r of records.records.values()) {
      if (r.kind === 'message' && r.source === 'sent' && sameCall(r.target, call) &&
          utc - (r.lastTx || r.utc) <= DACK_WINDOW && utc >= (r.lastTx || r.utc) - 60_000 &&
          (!match || r.utc > match.utc)) match = r;
    }
    if (match) records.addAck(match.id, baseCall(call));
  }

  // ─── Transmitting ───────────────────────────────────────────────────────────

  async function dialFrequency() {
    try {
      const reply = await queryJS8('RIG.GET_FREQ');
      const dial = Number(reply?.params?.DIAL);
      return Number.isFinite(dial) && dial > 0 ? dial : undefined;
    } catch { return undefined; }
  }

  /** The speed a transmission will use: the one chosen, else JS8CALL's current speed. */
  async function speedFor(label) {
    const chosen = SPEEDS[String(label || '').toLowerCase()];
    if (chosen !== undefined) return { value: chosen, source: 'chosen' };
    if (speedCache && now() - speedCache.at < (speedCache.value === null ? 60_000 : SPEED_CACHE_MS)) {
      return speedCache.value === null ? { value: 0, source: 'assumed' } : { value: speedCache.value, source: 'js8call' };
    }
    try {
      const reply = await queryJS8('MODE.GET_SPEED');
      const v = Number(reply?.params?.SPEED ?? reply?.value);
      if (Number.isFinite(v)) { speedCache = { value: v, at: now() }; return { value: v, source: 'js8call' }; }
    } catch { /* JS8CALL not reachable or too old */ }
    speedCache = { value: null, at: now() };   // don't make every preview wait for a query that fails
    return { value: 0, source: 'assumed' };
  }

  async function airtimeFor(text, label) {
    const s = await speedFor(label);
    return { ...estimateAirtime(text, s.value), speedSource: s.source };
  }

  function checkCanSend(t) {
    if (!isConnected()) throw new Error('JS8CALL is not connected');
    if (t - lastTx < TX_GAP_MS) throw new Error('Please wait a few seconds between transmissions');
  }

  async function transmit(text, speedLabel) {
    const speed = SPEEDS[String(speedLabel || '').toLowerCase()];
    if (speed !== undefined) {
      await sendToJS8('MODE.SET_SPEED', '', { SPEED: speed });
      speedCache = { value: speed, at: now() };
    }
    const freq = await dialFrequency();
    await sendToJS8('TX.SEND_MESSAGE', text);
    return freq;
  }

  /**
   * Handle a form from the browser.
   *   action 'preview' → { text, airtime }        (nothing sent or stored)
   *   action 'save'    → { text, record }          (stored, not sent)
   *   action 'send'    → { text, record }          (sent, then stored)
   * Throws an Error with an operator-readable message on any problem.
   *
   * `data.replaceId` names a saved draft the form was reopened from; once the
   * new version is saved or sent, the draft is removed so no duplicate is left.
   */
  async function submit({ action, form, data = {} }) {
    const me = getMyStation();
    const t  = now();
    let { text, record } = encode(form, data, { myCall: me.callsign, now: t });
    if (action === 'preview') return { text, airtime: await airtimeFor(text, data.speed) };

    // Only one of our own unsent drafts can be replaced.
    const draft = records.records.get(Number(data.replaceId));
    const replaceable = r => r && r.source === 'saved' && r.kind === record.kind;

    // IDs are the hour and minute, so two records started in the same minute
    // would share one and the second would be lost as a "duplicate". A new
    // record that clashes with one already kept today gets the next free ID.
    const idField = ID_FIELDS[form];
    const clash = rec => { const d = records.findDuplicate({ ...rec, utc: t }); return d && !replaceable(d); };
    if (idField && clash(record)) {
      for (let k = 1; k < 24 * 60; k++) {
        const id = timeId(t + k * 60_000);
        if (!clash({ ...record, [idField]: id })) {
          ({ text, record } = encode(form, { ...data, [idField]: id }, { myCall: me.callsign, now: t }));
          break;
        }
      }
    }
    const dropDraft = fields => {
      if (replaceable(draft)) records.remove(draft.id);
      // A draft saved earlier under the same ID (same day) becomes this one, too.
      const same = records.findDuplicate(fields);
      if (replaceable(same)) records.remove(same.id);
    };

    if (action === 'save') {
      if (form === 'ack') throw new Error('An acknowledgement can only be transmitted');
      const fields = { ...record, utc: t, source: 'saved' };
      dropDraft(fields);
      return { text, record: records.add(fields) };
    }

    if (action !== 'send') throw new Error(`Unknown action "${action}"`);
    checkCanSend(t);
    lastTx = t;
    const freq = await transmit(text, data.speed);

    if (form === 'ack') {
      records.ack(record.call, record.srId, me.callsign);
      return { text, record: null };
    }
    // `wire` keeps the exact transmitted text, so the record can be resent unchanged.
    const fields = { ...record, utc: t, freq, source: 'sent', wire: text, lastTx: t, resends: 0, ackExpected: expectsAck(record) };
    dropDraft(fields);   // the saved draft becomes the sent record
    return { text, record: records.add(fields) };
  }

  /**
   * Send one of our transmitted records again, unchanged (same ID, so stations
   * that already have it ignore the repeat). `preview` only returns the text.
   */
  async function resend(id, { speed, preview = false } = {}) {
    const rec = records.records.get(Number(id));
    const text = rec && rec.source === 'sent' && rec.wire;
    if (!text) throw new Error('Only records transmitted from this station can be resent');
    if (preview) return { text, airtime: await airtimeFor(text, speed) };
    const t = now();
    checkCanSend(t);
    lastTx = t;
    await transmit(text, speed);
    return { text, record: records.update(rec.id, { lastTx: t, resends: (rec.resends || 0) + 1 }) };
  }

  function snapshot() {
    return {
      records: records.list(), feed: [...feed], clock: clockStatus(),
      groupWarnings: groupWarnings(), activity: activitySnapshot(),
    };
  }

  return { handleHeard, submit, resend, routes, snapshot, clockStatus, groupWarnings, feed };
}

module.exports = { createJS8Stat, SPEEDS, expectsAck };
