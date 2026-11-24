'use strict';

// JS8Stat records (StatReps, incidents, alerts, group messages) kept for
// `keepDays` days. Unlike heard stations, which live only in memory, these are
// saved to a JSON Lines file so a restart doesn't lose them.
//
// File format — one operation per line, replayed on start-up:
//   {"op":"add","rec":{…}}      a new record
//   {"op":"ack","id":7,"call":"K1ABC"}   a station acknowledged record 7
//   {"op":"del","id":7}         the operator deleted record 7
// The file is rewritten without expired or deleted records at start-up and
// whenever more than half of its lines are dead.

const fs   = require('fs');
const path = require('path');
const { baseCall, timeId } = require('./protocol');

const DAY = 24 * 60 * 60 * 1000;

const utcDate = ms => new Date(ms).toISOString().slice(0, 10);
const normText = t => String(t || '').replace(/\s+/g, ' ').trim().toUpperCase();

/** Duplicate-detection key: the same report heard twice (or by poll and live event) maps to one key. */
function recordKey(rec) {
  const day  = utcDate(rec.utc);
  const call = baseCall(rec.from);
  switch (rec.kind) {
    case 'statrep':
    case 'incident': return `sr|${day}|${call}|${rec.srId || timeId(rec.utc)}`;
    case 'alert':    return `al|${day}|${call}|${rec.alertId || normText(rec.title)}`;
    case 'message':  return rec.msgId ? `ms|${day}|${call}|${rec.msgId}` : `mt|${day}|${call}|${normText(rec.text)}`;
    default:         return `${rec.kind}|${day}|${call}|${rec.utc}`;
  }
}

/**
 * @param {object}   opts
 * @param {string}   [opts.file]      JSON Lines file; omit to keep records in memory only
 * @param {number}   [opts.keepDays]  records older than this are dropped
 * @param {Function} [opts.broadcast] called with each outgoing payload
 * @param {Function} [opts.now]       clock (overridable for tests)
 * @param {Function} [opts.log]       where problems are reported
 */
function createRecordStore({ file = null, keepDays = 7, broadcast = () => {}, now = Date.now, log = console.warn } = {}) {
  const records = new Map();   // id → record
  const byKey   = new Map();   // key → id
  let nextId    = 1;
  let fileLines = 0;           // lines currently in the file (live + dead)
  let writeFailed = false;

  const keepMs = () => keepDays * DAY;

  function append(op) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(op) + '\n');
      fileLines++;
      writeFailed = false;
    } catch (err) {
      if (!writeFailed) log(`Could not save JS8Stat records to ${file}: ${err.message}`);
      writeFailed = true;
    }
  }

  function index(rec) {
    records.set(rec.id, rec);
    byKey.set(rec.key, rec.id);
    if (rec.id >= nextId) nextId = rec.id + 1;
  }

  function drop(id) {
    const rec = records.get(id);
    if (!rec) return null;
    records.delete(id);
    if (byKey.get(rec.key) === id) byKey.delete(rec.key);
    return rec;
  }

  /** Rewrite the file with only the live records (atomically, via a temp file). */
  function compact() {
    if (!file) return;
    const lines = [...records.values()].map(rec => JSON.stringify({ op: 'add', rec }));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '');
      fs.renameSync(tmp, file);
      fileLines = lines.length;
    } catch (err) {
      log(`Could not rewrite ${file}: ${err.message}`);
    }
  }

  function load() {
    if (!file || !fs.existsSync(file)) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (err) { log(`Could not read ${file}: ${err.message}`); return; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      fileLines++;
      let op;
      try { op = JSON.parse(line); } catch { continue; }   // a torn last line after a crash
      if (op.op === 'add' && op.rec && Number.isInteger(op.rec.id)) index(op.rec);
      else if (op.op === 'ack') { const r = records.get(op.id); if (r && !r.acks.includes(op.call)) r.acks.push(op.call); }
      else if (op.op === 'del') drop(op.id);
      else if (op.op === 'set') { const r = records.get(op.id); if (r && op.patch) Object.assign(r, op.patch); }
    }
    prune({ quiet: true });
    if (fileLines !== records.size) compact();
  }

  /**
   * Store a decoded record unless it duplicates one already kept.
   * Returns the stored record, or null for a duplicate or an expired one.
   */
  function add(fields) {
    const t = now();
    const rec = { ...fields };
    rec.utc = Number.isFinite(rec.utc) && rec.utc <= t ? rec.utc : t;
    if (rec.utc < t - keepMs()) return null;
    rec.key = recordKey(rec);
    if (byKey.has(rec.key)) return null;
    rec.id = nextId;
    rec.acks = rec.acks || [];
    index(rec);
    append({ op: 'add', rec });
    broadcast({ type: 'CS_RECORD', record: rec });
    return rec;
  }

  /**
   * Note that `ackCall` acknowledged `call`'s report `srId`. Matches the most
   * recent StatRep or incident with that ID from that station.
   */
  function ack(call, srId, ackCall) {
    let match = null;
    for (const r of records.values()) {
      if ((r.kind === 'statrep' || r.kind === 'incident') && r.srId === srId &&
          baseCall(r.from) === baseCall(call) && (!match || r.utc > match.utc)) match = r;
    }
    return match ? addAck(match.id, ackCall) : null;
  }

  /** Record that `ackCall` acknowledged record `id` (any kind). */
  function addAck(id, ackCall) {
    const rec = records.get(id);
    if (!rec) return null;
    const who = String(ackCall).toUpperCase();
    if (rec.acks.includes(who)) return rec;
    rec.acks.push(who);
    append({ op: 'ack', id, call: who });
    broadcast({ type: 'CS_UPDATE', record: rec });
    return rec;
  }

  /** Change fields of a record (not its identity: id, key, kind, from). */
  function update(id, patch) {
    const rec = records.get(id);
    if (!rec) return null;
    const clean = { ...patch };
    for (const k of ['id', 'key', 'kind', 'from', 'acks']) delete clean[k];
    Object.assign(rec, clean);
    append({ op: 'set', id, patch: clean });
    broadcast({ type: 'CS_UPDATE', record: rec });
    return rec;
  }

  function remove(id) {
    const rec = drop(id);
    if (!rec) return false;
    append({ op: 'del', id });
    broadcast({ type: 'CS_REMOVE', id });
    if (fileLines > 2 * records.size + 50) compact();
    return true;
  }

  /** Drop records older than keepDays. Returns how many were removed. */
  function prune({ quiet = false } = {}) {
    const cutoff = now() - keepMs();
    let n = 0;
    for (const [id, r] of records) {
      if (r.utc < cutoff) {
        drop(id);
        n++;
        if (!quiet) broadcast({ type: 'CS_REMOVE', id });
      }
    }
    if (n && !quiet && fileLines > 2 * records.size + 50) compact();
    return n;
  }

  /** The record a new one would duplicate, if any. */
  function findDuplicate(fields) {
    const id = byKey.get(recordKey({ ...fields, utc: Number.isFinite(fields.utc) ? fields.utc : now() }));
    return id ? records.get(id) : null;
  }

  const list = () => [...records.values()].sort((a, b) => a.utc - b.utc);

  load();
  return { records, add, ack, addAck, update, remove, prune, list, compact, findDuplicate, get file() { return file; } };
}

module.exports = { createRecordStore, recordKey };
