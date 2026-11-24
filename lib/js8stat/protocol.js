'use strict';

// JS8Stat's message formats: decoding what is heard and encoding what we send.
//
// JS8Stat is part of JS8CALL Map. It is not CommStat and not affiliated with
// it, but it uses the same plain-text formats that CommStat stations exchange
// over JS8CALL, so the two can read each other's traffic. This file is an
// independent implementation written from the formats themselves:
//
//   StatRep    @GROUP ,GRID,SCOPE,ID,STATUS12,REMARKS,{&%}     ("+" = all green)
//              forwarded copies end {F%} and carry the original sender's "CALL:" prefix
//   F!304      F!304 dddddddd [remarks]      (older 8-digit status report)
//   F!301      F!301 ddddddddd [remarks]     (older 9-digit report, first digit = scope)
//   Incident   @GROUP ,GRID,TYPE,ID,PIN,MESSAGE,{##}   TYPE 6 = Event, 7 = Attack
//   Alert      @GROUP ,ID,COLOR,TITLE,MESSAGE,{%%}     COLOR 1 Yellow 2 Orange 3 Red 4 Black
//   Message    @GROUP MSG ,ID,TEXT,{^%}    (trailing + = request for info, - = reply)
//              @GROUP MSG text             (plain JS8 group message)
//   Ack        @GROUP RRSR CALL,ID         (acknowledges CALL's StatRep ID)
//   Relay      MYCALL> TEXT *DE* SENDER
//
// Internet-only variants ({&%3}, {%%3}, {^%3}, {#3}) never travel by radio
// honestly; the marker is normalised and the record treated as radio traffic.

// ─── Shared vocabulary ────────────────────────────────────────────────────────

/** The 12 StatRep conditions, in wire order. */
const STATUS_FIELDS = ['map', 'power', 'water', 'medical', 'comms', 'travel',
                       'internet', 'fuel', 'food', 'crime', 'civil', 'weather'];

/** 1 Green, 2 Yellow, 3 Red, 4 Unknown. */
const STATUS_VALUES = ['1', '2', '3', '4'];

/** Wire scope code → label. Code 5 is a retired value still seen from older stations. */
const SCOPES = { 1: 'My QTH', 2: 'Community', 3: 'County', 4: 'Region', 5: 'Other' };

const INCIDENT_TYPES = { 6: 'Event', 7: 'Attack' };

const ALERT_COLORS = { 1: 'Yellow', 2: 'Orange', 3: 'Red', 4: 'Black' };

// Hour letters for record IDs: A–Y without O (24 letters for 24 hours).
const HOUR_LETTERS = 'ABCDEFGHIJKLMNPQRSTUVWXY';

/** Time-based record ID, e.g. 14:47 UTC → "Q47". */
function timeId(ms = Date.now()) {
  const d = new Date(ms);
  return HOUR_LETTERS[d.getUTCHours()] + String(d.getUTCMinutes()).padStart(2, '0');
}

/** Callsign without a /P, /M … suffix (or prefix), for comparisons. */
function baseCall(cs) {
  const parts = String(cs || '').toUpperCase().trim().split('/').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return parts.reduce((best, p) => (/\d/.test(p) && p.length > best.length ? p : best), '') || parts[0];
}

const sameCall = (a, b) => !!a && !!b && baseCall(a) === baseCall(b);

const CALL_RE  = /^[A-Z0-9/]{3,12}$/;
const isCall   = s => CALL_RE.test(s) && /\d/.test(s) && /[A-Z]/.test(s);
const GRID_RE  = /^[A-R]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)?$/;
const isGrid   = g => GRID_RE.test(String(g || '').toUpperCase());

// Group calls that carry ordinary band chatter rather than group traffic.
const CHATTER_GROUPS = new Set(['@ALLCALL', '@HB', '@CQ']);

// ─── Decoding ─────────────────────────────────────────────────────────────────

/**
 * Prepare received text for parsing: keep printable ASCII only (JS8CALL ends
 * messages with ♢, and garbled decodes contain other symbols), collapse
 * runs of spaces, and drop a trailing end-of-message "*".
 */
function cleanText(text) {
  return String(text || '')
    .replace(/[^ -~]+/g, ' ')
    .replace(/\s+\*\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove leading "CALL:" prefixes. JS8CALL's activity text starts with the
 * sender's, and some versions repeat it ("K1ABC: K1ABC: @GROUP …"). A prefix
 * naming someone other than the sender is the original author of a forwarded
 * report and is returned as `origin`.
 */
function stripPrefixes(text, from) {
  let body = text;
  let origin = '';
  for (let m; (m = body.match(/^([A-Z0-9/]{3,12}):\s+/i)); ) {
    const call = m[1].toUpperCase();
    if (!isCall(call)) break;
    if (!sameCall(call, from) && !origin) origin = call;
    body = body.slice(m[0].length);
  }
  return { body, origin };
}

/** Normalise internet-only markers to their radio form. */
function normaliseMarkers(s) {
  return s.replace(/\{&%3\}/g, '{&%}').replace(/\{%%3\}/g, '{%%}')
          .replace(/\{\^%3\}/g, '{^%}').replace(/\{#3\}/g, '{##}');
}

/** "@GROUP" / "CALL" at the start of a body, and what follows it. */
function splitTarget(body) {
  const m = body.match(/^(@?[A-Z0-9/]+)\s*(.*)$/i);
  return m ? { target: m[1].toUpperCase(), rest: m[2] } : { target: '', rest: body };
}

/** Fields between the first comma and a marker: ",A,B,C,{&%}" → ['A','B','C']. */
function fieldsBefore(body, marker) {
  const i = body.indexOf(marker);
  if (i < 0) return null;
  const head = body.slice(0, i);
  const c = head.indexOf(',');
  if (c < 0) return null;
  const inner = head.slice(c + 1).replace(/,\s*$/, '');
  return { prefix: head.slice(0, c).trim(), fields: inner.split(',') };
}

const joinRest = parts => parts.map(s => s.trim()).filter(Boolean).join(', ');

function parseStatRep(body) {
  const forwarded = body.includes('{F%}');
  const f = fieldsBefore(body, forwarded ? '{F%}' : '{&%}');
  if (!f || f.fields.length < 4) return null;
  const [grid, scope, id, rawStatus, ...rest] = f.fields.map(s => s.trim());
  const status = rawStatus === '+' ? '111111111111' : rawStatus;
  if (!/^[1-4]{12}/.test(status)) return null;
  return {
    kind:     'statrep',
    target:   splitTarget(f.prefix).target,
    grid:     isGrid(grid) ? grid.toUpperCase() : '',
    scope:    SCOPES[scope] ? scope : '1',
    srId:     id.toUpperCase().slice(0, 8),
    status:   status.slice(0, 12),
    remarks:  joinRest(rest),
    forwarded,
  };
}

function parseIncident(body) {
  const forwarded = body.includes('{F#}');
  const f = fieldsBefore(body, forwarded ? '{F#}' : '{##}');
  if (!f || f.fields.length < 4) return null;
  const [grid, type, id, pin, ...rest] = f.fields.map(s => s.trim());
  if (!INCIDENT_TYPES[type]) return null;
  return {
    kind:     'incident',
    target:   splitTarget(f.prefix).target,
    grid:     isGrid(grid) ? grid.toUpperCase() : '',
    type,
    srId:     id.toUpperCase().slice(0, 8),
    pinned:   pin === '1',
    remarks:  joinRest(rest),
    forwarded,
  };
}

// The older numeric formats. Digit order (F!304): landline, telecom,
// AM/FM/TV, internet, water, power, natural gas, NOAA radio; each 1 yes,
// 2 limited, 3 no, 4 unknown. F!301 adds a leading scope digit.
const YESNO = { 1: 'Yes', 2: 'Limited', 3: 'No', 4: 'Unknown' };

function parseFCode(body) {
  const m = body.match(/F!(304|301)\s+(\d{8,9})\b\s*(.*?)(?:>\])?$/i);
  if (!m) return null;
  const is301 = m[1] === '301';
  const digits = m[2];
  if (digits.length !== (is301 ? 9 : 8) || /[^1-4]/.test(digits)) return null;
  const scope = is301 ? digits[0] : '1';
  const d = is301 ? digits.slice(1) : digits;
  const telecom = { 1: '1', 2: '2', 3: '2', 4: '3' }[d[1]] || '4';
  const values = { map: '4', power: d[5], water: d[4], medical: '4', comms: telecom, travel: '4',
                   internet: d[3], fuel: '4', food: '4', crime: '4', civil: '4', weather: '4' };
  // Overall pin: the sum of the digits (4 counted as 1) shows how degraded things are.
  const score = [...d].reduce((n, c) => n + (c === '4' ? 1 : Number(c)), 0);
  values.map = score > 12 ? '3' : score > 10 ? '2' : '1';
  const notes = [`F!${m[1]}`];
  if (!is301) notes.push(`Landline = ${YESNO[d[0]]}`);
  notes.push(`AM/FM/TV = ${YESNO[d[2]]}`, `Nat Gas = ${YESNO[d[6]]}`, `NOAA = ${YESNO[d[7]]}`);
  const tail = m[3].trim();
  return {
    kind:    'statrep',
    target:  splitTarget(body).target.startsWith('@') ? splitTarget(body).target : '',
    grid:    '',
    scope,
    srId:    '',
    status:  STATUS_FIELDS.map(k => values[k]).join(''),
    remarks: notes.join(', ') + (tail ? ` - ${tail}` : ''),
    forwarded: false,
  };
}

function parseAlert(body) {
  const f = fieldsBefore(body, '{%%}');
  if (!f) return null;
  const parts = f.fields.map(s => s.trim());
  let id = '', color, title, message;
  if (parts.length >= 4 && !/^\d+$/.test(parts[0]) && /^[1-4]$/.test(parts[1])) {
    [id, color, title] = parts;
    message = parts.slice(3).join(', ');
  } else if (parts.length >= 3 && /^[1-4]$/.test(parts[0])) {
    [color, title] = parts;          // older form without an ID
    message = parts.slice(2).join(', ');
  } else {
    return null;
  }
  let target = splitTarget(f.prefix).target;
  if (target === 'LRT') target = '';
  return { kind: 'alert', target, alertId: id.toUpperCase().slice(0, 8), color, title, message };
}

function parseMessage(body, complete) {
  // Structured: @GROUP MSG ,ID,TEXT,{^%}   (MSG keyword optional when the terminator is present)
  let m = body.match(/^(@?[A-Z0-9/]+)\s+(?:MSG\s+)?,([^,]+),(.+?)\s*,?\s*\{\^%\}([+-])?/i);
  if (m) {
    return { kind: 'message', target: m[1].toUpperCase(), msgId: m[2].trim().toUpperCase().slice(0, 8),
             text: m[3].trim(), rfi: m[4] === '+' ? 1 : m[4] === '-' ? 2 : 0 };
  }
  // Without a terminator we can't tell a finished message from a partial
  // frame, so only complete transmissions are accepted from here on.
  if (!complete) return null;
  m = body.match(/^(@?[A-Z0-9/]+)\s+MSG\s+(.+)$/i);
  if (m) return { kind: 'message', target: m[1].toUpperCase(), msgId: '', text: m[2].trim(), rfi: 0 };
  // A plain conversational group message long enough to carry content.
  m = body.match(/^(@[A-Z0-9/]+)\s+(.+)$/i);
  if (m && m[2].trim().length > 17 && !CHATTER_GROUPS.has(m[1].toUpperCase()) &&
      !/\b(HEARTBEAT|SNR\??|ACK|CQ)\b/i.test(m[2])) {
    return { kind: 'message', target: m[1].toUpperCase(), msgId: '', text: m[2].trim(), rfi: 0 };
  }
  return null;
}

function parseAck(body) {
  const m = body.match(/^(@?[A-Z0-9/]+)\s+RRSR\s+([A-Z0-9/]{3,12}),\s*([A-Z0-9]{2,8})\.?$/i);
  return m ? { kind: 'ack', target: m[1].toUpperCase(), call: m[2].toUpperCase(), srId: m[3].toUpperCase() } : null;
}

function parseRelay(body) {
  const m = body.match(/^([A-Z0-9/]+)>\s+(.+?)\s+\*DE\*\s+([A-Z0-9/]+)$/i);
  if (!m || /^ACK$/i.test(m[2].trim())) return null;
  return { kind: 'relay', to: m[1].toUpperCase(), text: m[2].trim(), sender: m[3].toUpperCase() };
}

/**
 * Decode one heard message.
 *
 * @param {string} text      the message text as JS8CALL gave it
 * @param {object} ctx
 * @param {string} ctx.from      sender callsign
 * @param {string} ctx.myCall    our callsign ('' if unknown)
 * @param {boolean} ctx.complete true when this is a whole transmission
 *                               (RX.DIRECTED, or text ending in JS8CALL's ♢)
 * @returns {object|null} the decoded record, or null when it isn't status traffic
 *          traffic for a group or for us
 */
function decode(text, { from = '', myCall = '', complete = false } = {}) {
  from = String(from).toUpperCase();
  const cleaned = cleanText(text);
  if (!cleaned) return null;
  const { body: raw, origin } = stripPrefixes(cleaned, from);
  const body = normaliseMarkers(raw);
  const forMe = t => !!myCall && sameCall(t, myCall);
  const relevant = t => (t && t.startsWith('@')) || forMe(t);

  let rec = null;
  if (body.includes('{&%}') || body.includes('{F%}'))      rec = parseStatRep(body);
  else if (body.includes('{##}') || body.includes('{F#}')) rec = parseIncident(body);
  else if (/F!30[14]/i.test(body))                         rec = parseFCode(body);
  else if (body.includes('{%%}'))                          rec = parseAlert(body);
  else if (/\sRRSR\s/i.test(body))                         rec = parseAck(body);
  else if (/\*DE\*/.test(body)) {
    // Relayed acknowledgement: "MYCALL> ACK *DE* TARGET" — TARGET got our relayed message.
    const ack = body.match(/^([A-Z0-9/]+)>\s+ACK\s+\*DE\*\s+([A-Z0-9/]+)$/i);
    if (ack) return forMe(ack[1]) ? { kind: 'dack', target: ack[1].toUpperCase(), from: ack[2].toUpperCase(), via: from } : null;
    const r = parseRelay(body);
    if (r && forMe(r.to)) {
      return { kind: 'message', from: r.sender, target: r.to, msgId: '', rfi: 0,
               text: `${r.text} - Relayed by: ${from}` };
    }
    return null;
  } else if (/^[A-Z0-9/]+\s+ACK$/i.test(body)) {
    // JS8CALL's automatic reply to a directed message: "MYCALL ACK".
    const t = body.split(/\s+/)[0].toUpperCase();
    return forMe(t) ? { kind: 'dack', target: t, from } : null;
  } else {
    rec = parseMessage(body, complete);
  }
  if (!rec) return null;

  // A report with no target (old F! formats) belongs to everyone listening.
  if (rec.kind !== 'statrep' && !relevant(rec.target)) return null;
  if (rec.kind === 'statrep' && rec.target && !relevant(rec.target)) return null;

  rec.from = from;
  if (rec.forwarded && origin) { rec.from = origin; rec.forwardedBy = from; }
  return rec;
}

// ─── Encoding ─────────────────────────────────────────────────────────────────

const NEWLINE = '||';

// Characters CommStat-compatible stations accept in StatRep remarks and incident
// messages. Commas separate fields, so they are never allowed in those.
const REMARKS_DISALLOWED = /[^A-Za-z0-9*\-\s|.?!'/:()#@+=&]+/g;

const LIMITS = { remarks: 500, alertTitle: 20, alertMessage: 195, message: 500, incident: 500 };

/** Free text for a StatRep or incident: newlines → "||", no commas or symbols. */
function cleanRemarks(text) {
  return String(text || '').replace(/\r\n|\r|\n/g, NEWLINE).replace(REMARKS_DISALLOWED, ' ')
    .replace(/[ \t]+/g, ' ').trim().toUpperCase();
}

/** Free text for alerts and messages: printable ASCII, newlines → "||". */
function cleanFree(text) {
  return String(text || '').replace(/\r\n|\r|\n/g, NEWLINE).replace(/[^ -~]+/g, ' ')
    .replace(/[{}]/g, ' ').replace(/[ \t]+/g, ' ').trim().toUpperCase();
}

/** "@GROUP" or a callsign; throws on anything else. */
function cleanTarget(t) {
  let s = String(t || '').trim().toUpperCase();
  if (!s) throw new Error('Choose a group or callsign to send to');
  if (/^[A-Z0-9]{2,12}$/.test(s) && !isCall(s)) s = '@' + s;   // bare group name
  if (/^@[A-Z0-9]{2,12}$/.test(s) || isCall(s)) return s;
  throw new Error(`"${t}" is not a valid group (@NAME) or callsign`);
}

const cleanId = (id, ms) => (/^[A-Y]\d{2}$/.test(String(id || '').toUpperCase()) ? String(id).toUpperCase() : timeId(ms));

function requireCall(myCall) {
  const c = String(myCall || '').toUpperCase();
  if (!isCall(c)) throw new Error('Your callsign is not known yet — is JS8CALL connected?');
  return c;
}

function requireGrid(grid) {
  const g = String(grid || '').trim().toUpperCase();
  if (!isGrid(g)) throw new Error('Enter a valid grid square, e.g. EM73 or EM73TU');
  return g;
}

function checkLength(text, max, what) {
  if (text.length > max) throw new Error(`${what} is ${text.length} characters; the limit is ${max}`);
}

/**
 * Turn a filled-in form into the text to transmit and the record to keep.
 * Throws an Error with an operator-readable message when the form is invalid.
 *
 * @param {'statrep'|'alert'|'message'|'incident'|'ack'} form
 * @param {object} data   the form fields
 * @param {object} ctx    { myCall, now }
 * @returns {{ text: string, record: object }}
 */
function encode(form, data = {}, { myCall, now = Date.now() } = {}) {
  const me = requireCall(myCall);
  switch (form) {
    case 'statrep': {
      const target = cleanTarget(data.target);
      const grid   = requireGrid(data.grid);
      const scope  = SCOPES[data.scope] && data.scope !== '5' ? String(data.scope) : null;
      if (!scope) throw new Error('Choose a scope');
      const values = STATUS_FIELDS.map(k => String((data.status || {})[k] ?? ''));
      const missing = STATUS_FIELDS.filter((k, i) => !STATUS_VALUES.includes(values[i]));
      if (missing.length) throw new Error(`Choose a colour for: ${missing.join(', ')}`);
      const status  = values.join('');
      const remarks = cleanRemarks(data.remarks);
      checkLength(remarks, LIMITS.remarks, 'Remarks');
      const srId = cleanId(data.srId, now);
      const wire = status === '111111111111' ? '+' : status;
      return {
        text:   `${me}: ${target} ,${grid},${scope},${srId},${wire},${remarks},{&%}`,
        record: { kind: 'statrep', from: me, target, grid, scope, srId, status, remarks, forwarded: false },
      };
    }
    case 'incident': {
      const target = cleanTarget(data.target);
      const grid   = requireGrid(data.grid);
      const type   = INCIDENT_TYPES[data.type] ? String(data.type) : null;
      if (!type) throw new Error('Choose Event or Attack');
      const remarks = cleanRemarks(data.remarks);
      if (!remarks) throw new Error('Describe the incident');
      checkLength(remarks, LIMITS.incident, 'Message');
      const srId = cleanId(data.srId, now);
      const pin  = data.pinned ? '1' : '0';
      return {
        text:   `${me}: ${target} ,${grid},${type},${srId},${pin},${remarks},{##}`,
        record: { kind: 'incident', from: me, target, grid, type, srId, pinned: !!data.pinned, remarks, forwarded: false },
      };
    }
    case 'alert': {
      const target = cleanTarget(data.target);
      const color  = ALERT_COLORS[data.color] ? String(data.color) : null;
      if (!color) throw new Error('Choose an alert colour');
      const title   = cleanFree(String(data.title || '').replace(/,/g, ' '));
      const message = cleanFree(data.message);
      if (!title)   throw new Error('Enter a title');
      if (!message) throw new Error('Enter a message');
      checkLength(title, LIMITS.alertTitle, 'Title');
      checkLength(message, LIMITS.alertMessage, 'Message');
      const alertId = cleanId(data.alertId, now);
      return {
        text:   `${me}: ${target} ,${alertId},${color},${title},${message},{%%}`,
        record: { kind: 'alert', from: me, target, alertId, color, title, message },
      };
    }
    case 'message': {
      const target = cleanTarget(data.target);
      const text   = cleanFree(data.text);
      if (!text) throw new Error('Enter a message');
      checkLength(text, LIMITS.message, 'Message');
      const msgId = cleanId(data.msgId, now);
      const relay = String(data.relay || '').trim().toUpperCase();
      if (relay) {
        // JS8CALL relay: "RELAY> TARGET MSG …" is passed on by RELAY to TARGET.
        if (!isCall(relay)) throw new Error(`"${data.relay}" is not a valid relay callsign`);
        if (target.startsWith('@')) throw new Error('Relays carry messages to a callsign, not to a group');
        if (sameCall(relay, target) || sameCall(relay, me)) throw new Error('Choose a relay other than yourself or the recipient');
        return {
          text:   `${relay}> ${target} MSG ,${msgId},${text},{^%}`,
          record: { kind: 'message', from: me, target, msgId, text, rfi: 0, relay },
        };
      }
      return {
        text:   `${target} MSG ,${msgId},${text},{^%}`,
        record: { kind: 'message', from: me, target, msgId, text, rfi: 0 },
      };
    }
    case 'ack': {
      const call = String(data.call || '').toUpperCase();
      const srId = String(data.srId || '').toUpperCase();
      if (!isCall(call) || !/^[A-Z0-9]{2,8}$/.test(srId)) throw new Error('Nothing to acknowledge');
      const target = data.target && String(data.target).startsWith('@') ? cleanTarget(data.target) : call;
      return {
        text:   `${me}: ${target} RRSR ${call},${srId}`,
        record: { kind: 'ack', from: me, target, call, srId },
      };
    }
    default:
      throw new Error(`Unknown form "${form}"`);
  }
}

// ─── Airtime ──────────────────────────────────────────────────────────────────

// JS8CALL speed value → seconds per frame. Ultra (8) varies between JS8CALL
// versions, so no time is estimated for it.
const SPEED_SECONDS = { 4: 30, 0: 15, 1: 10, 2: 6 };
const SPEED_NAMES   = { 4: 'Slow', 0: 'Normal', 1: 'Fast', 2: 'Turbo', 8: 'Ultra' };

// Characters per data frame, measured on the air: the status report
// ",EM73TU,1,T54,+,,{&%}" (21 characters) took 3 frames and "RRSR N0CALL,T54"
// (15) took 2. Plain words compress better, so prose is slightly overestimated.
const CHARS_PER_FRAME = 9;

/**
 * Estimate how long JS8CALL needs to send `text`: one header frame (sender
 * and recipient) plus the rest of the message, about 9 characters a frame.
 * @returns {{ frames, seconds: number|null, speed, speedName }}
 */
function estimateAirtime(text, speed = 0) {
  const { body } = stripPrefixes(cleanText(text), '');
  const rest = body.replace(/^@?[A-Z0-9/]+>?\s*/i, '');   // the recipient travels in the header frame
  const frames = 1 + Math.ceil(rest.length / CHARS_PER_FRAME);
  const per = SPEED_SECONDS[speed];
  return { frames, seconds: per ? frames * per : null, speed, speedName: SPEED_NAMES[speed] || 'Unknown' };
}

module.exports = {
  STATUS_FIELDS, STATUS_VALUES, SCOPES, INCIDENT_TYPES, ALERT_COLORS, LIMITS, SPEED_SECONDS, SPEED_NAMES,
  timeId, baseCall, sameCall, isCall, isGrid, cleanText, stripPrefixes,
  decode, encode, cleanRemarks, cleanFree, cleanTarget, estimateAirtime,
};
