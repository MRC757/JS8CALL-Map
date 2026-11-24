// JS8Stat features in the browser: shared state, settings, filters, requests
// to the server, and the dialog/notification helpers the JS8Stat panels use.

import { state, stationData } from './state.js';
import { escHtml } from './util.js';

// ─── Vocabulary (mirrors lib/js8stat/protocol.js) ────────────────────────────

export const STATUS_FIELDS = ['map', 'power', 'water', 'medical', 'comms', 'travel',
                              'internet', 'fuel', 'food', 'crime', 'civil', 'weather'];
export const STATUS_LABELS = ['Map Pin', 'Power', 'Water', 'Medical', 'Comms', 'Travel',
                              'Internet', 'Fuel', 'Food', 'Crime', 'Civil', 'Weather'];
export const STATUS_SHORT  = ['Map', 'Powr', 'H2O', 'Med', 'Comm', 'Trvl', 'Inet', 'Fuel', 'Food', 'Crime', 'Civil', 'Wthr'];
export const STATUS_NAMES  = { 1: 'Green', 2: 'Yellow', 3: 'Red', 4: 'Unknown', 6: 'Event', 7: 'Attack' };
export const SCOPES        = { 1: 'My QTH', 2: 'Community', 3: 'County', 4: 'Region', 5: 'Other' };
export const SCOPE_RADIUS  = { 1: 3, 2: 10, 3: 16, 4: 24, 5: 16 };
export const INCIDENT_TYPES = { 6: 'Event', 7: 'Attack' };
// Alert colours: name, background, text colour.
export const ALERT_COLORS  = { 1: ['Yellow', '#e8e800', '#000000'], 2: ['Orange', '#ff8c00', '#ffffff'],
                               3: ['Red', '#dc3545', '#ffffff'],    4: ['Black', '#000000', '#ffffff'] };
export const SPEEDS        = [['', 'Current'], ['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast'],
                              ['turbo', 'Turbo'], ['ultra', 'Ultra']];
export const LIMITS        = { remarks: 500, alertTitle: 20, alertMessage: 195, message: 500, incident: 500 };

const HOUR_LETTERS = 'ABCDEFGHIJKLMNPQRSTUVWXY';
/** Time-based record ID, e.g. 14:47 UTC → "P47" (the server uses the same rule). */
export function timeId(ms = Date.now()) {
  const d = new Date(ms);
  return HOUR_LETTERS[d.getUTCHours()] + String(d.getUTCMinutes()).padStart(2, '0');
}

export function baseCall(cs) {
  const parts = String(cs || '').toUpperCase().split('/').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return parts.reduce((best, p) => (/\d/.test(p) && p.length > best.length ? p : best), '') || parts[0];
}
export const isMe = cs => !!cs && !!state.myStation.callsign && baseCall(cs) === baseCall(state.myStation.callsign);

// ─── Formatting ───────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');

/** "Nov-24  14:32" (UTC), the table date format. */
export function fmtShort(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]}-${pad(d.getUTCDate())}  ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/** "2026-11-24 14:32:07" (UTC). */
export const fmtFull = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
export const fmtMHz  = hz => (hz ? (hz / 1e6).toFixed(3) : '');
export const fmtSnr  = snr => (Number.isFinite(snr) ? (snr > 0 ? '+' : snr < 0 ? '-' : '+') + pad(Math.abs(snr)) : '');
/** Stored text uses "||" for line breaks. */
export const lines   = t => String(t || '').split('||').map(s => s.trim());

/** Class for the leftmost colour cell of a table row: signal strength, or how the record got here. */
export function sourceCell(rec) {
  if (rec.source === 'saved') return ['cs-src-saved', 'Saved only (not transmitted)'];
  if (rec.source === 'sent')  return ['cs-src-sent', 'Transmitted from this station'];
  if (!Number.isFinite(rec.snr)) return ['cs-src-unknown', 'Heard on the air'];
  const cls = rec.snr >= -5 ? 'cs-snr-good' : rec.snr >= -16 ? 'cs-snr-fair' : 'cs-snr-poor';
  return [cls, `RF SNR ${rec.snr}`];
}

// ─── State ────────────────────────────────────────────────────────────────────

export const cs = {
  records:      new Map(),   // id → record
  feed:         [],          // newest first
  mayTransmit:  false,       // the server allows this browser to transmit
  transmitMode: 'local',
  keepDays:     7,
  connected:    false,       // JS8CALL connected
  clock:        { status: 'unknown', offset: null, samples: 0 },   // PC clock check
  groupWarnings: [],         // groups heard only in partial frames (not added in JS8CALL)
  activity:     {},          // "@GROUP" → { CALL: { utc, kind } } for the roster
};

const SETTINGS_KEY = 'js8map-js8stat';
const DEFAULT_SETTINGS = {
  dashboard:  false,   // JS8Stat panels shown
  txEnabled:  false,   // the operator has switched transmitting on
  since:      'all',   // 'midnight' | '24h' | 'all'
  groups:     '',      // "AMRRON, MAGNET" — empty shows every group
  showPins:   true,
  hideGreen:  false,
  hideHB:     false,   // hide CQ and heartbeat lines in the live feed
  sounds:     false,
  speed:      '',
  lastTarget: '',
  topH:       230,     // StatRep panel height, px
  sideW:      480,     // messages/feed column width, px
  feedFrac:   0.5,     // share of the column given to the live feed
  ackWaitMin: 15,      // minutes before an unacknowledged report is flagged for resending
};

export const settings = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch { /* storage blocked */ }
  return { ...DEFAULT_SETTINGS, ...saved };
})();

export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
  emit('settings', patch);
}

// ─── Events ───────────────────────────────────────────────────────────────────

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(fn);
}
export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (err) { console.error(`[js8stat] ${event} handler failed`, err); }
  }
}

// ─── Filters ──────────────────────────────────────────────────────────────────

/** The groups the operator chose to show, as "@NAME"; empty = all groups. */
export function groupList() {
  return settings.groups.split(/[\s,;]+/).map(g => g.trim().toUpperCase().replace(/^@?/, '@'))
    .filter(g => /^@[A-Z0-9]{2,12}$/.test(g));
}

/** Known group names (from records and the filter), for pickers. */
export function knownGroups() {
  const set = new Set(groupList());
  for (const r of cs.records.values()) if (r.target && r.target.startsWith('@')) set.add(r.target);
  return [...set].sort();
}

export function sinceMs(now = Date.now()) {
  if (settings.since === 'midnight') { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
  if (settings.since === '24h') return now - 24 * 3600_000;
  return 0;
}

/** Does a record pass the date and group filters? Anything addressed to us always shows. */
export function passesFilter(rec, now = Date.now()) {
  if (rec.utc < sinceMs(now)) return false;
  if (isMe(rec.target) || isMe(rec.from)) return true;
  const groups = groupList();
  return !groups.length || !rec.target || groups.includes(rec.target);
}

export const recordsOf = (...kinds) =>
  [...cs.records.values()].filter(r => kinds.includes(r.kind) && passesFilter(r)).sort((a, b) => b.utc - a.utc);

/** Can this browser transmit right now? Returns '' if so, otherwise the reason. */
export function transmitBlocker() {
  if (!cs.mayTransmit) {
    return cs.transmitMode === 'off'
      ? 'Transmitting is switched off in the server settings (transmit: "off").'
      : 'Transmitting is only allowed from a browser on the PC running the map.';
  }
  if (!settings.txEnabled) return 'Transmitting is switched off. Turn it on in the Transmit menu.';
  if (!cs.connected) return 'JS8CALL is not connected.';
  if (!state.myStation.callsign) return 'Your callsign is not known yet.';
  return '';
}

// ─── Server messages and requests ─────────────────────────────────────────────

let sender = () => false;
export function setSender(fn) { sender = fn; }

const pending = new Map();
let nextReq = 1;

/** Send a request to the server; resolves with its CS_RESULT (rejects on error or timeout). */
export function request(payload, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const reqId = nextReq++;
    const timer = setTimeout(() => { pending.delete(reqId); reject(new Error('The map server did not answer')); }, timeoutMs);
    pending.set(reqId, res => {
      clearTimeout(timer);
      res.ok ? resolve(res) : reject(new Error(res.error || 'Request failed'));
    });
    if (!sender({ ...payload, reqId })) {
      clearTimeout(timer);
      pending.delete(reqId);
      reject(new Error('Not connected to the map server'));
    }
  });
}

export function csSnapshot(snap) {
  cs.records.clear();
  for (const r of snap.records || []) cs.records.set(r.id, r);
  cs.feed = snap.feed || [];
  cs.mayTransmit  = !!snap.mayTransmit;
  cs.transmitMode = snap.transmitMode || 'local';
  cs.keepDays     = snap.keepDays || 7;
  cs.clock         = snap.clock || cs.clock;
  cs.groupWarnings = snap.groupWarnings || [];
  cs.activity      = snap.activity || {};
  emit('reset');
}

export function csSetConnected(connected) {
  cs.connected = !!connected;
  emit('connection', cs.connected);
}

/** Handle a JS8Stat message from the server. Returns true if it was one. */
export function csHandle(msg) {
  switch (msg.type) {
    case 'CS_RECORD':
      cs.records.set(msg.record.id, msg.record);
      emit('record', { record: msg.record, isNew: true });
      return true;
    case 'CS_UPDATE':
      cs.records.set(msg.record.id, msg.record);
      emit('record', { record: msg.record, isNew: false });
      return true;
    case 'CS_REMOVE':
      if (cs.records.delete(msg.id)) emit('remove', msg.id);
      return true;
    case 'CS_CLOCK':
      cs.clock = msg.clock;
      emit('clock', msg.clock);
      return true;
    case 'CS_GROUPS':
      cs.groupWarnings = msg.warnings || [];
      emit('groups', cs.groupWarnings);
      return true;
    case 'CS_ACTIVITY':
      (cs.activity[msg.group] ||= {})[msg.call] = { utc: msg.utc, kind: msg.kind };
      emit('activity', msg);
      return true;
    case 'CS_FEED':
      cs.feed.unshift(msg.line);
      if (cs.feed.length > 300) cs.feed.length = 300;
      emit('feed', msg.line);
      return true;
    case 'CS_RESULT': {
      const done = pending.get(msg.reqId);
      if (done) { pending.delete(msg.reqId); done(msg); }
      return true;
    }
  }
  return false;
}

// ─── Dialogs (JS8Stat dialog chrome) ─────────────────────────────────────────

const openDialogs = [];

/**
 * Open a modal dialog with a JS8Stat title strip.
 *   buttons: [{ label, color: 'blue'|'cyan'|'green'|'red'|'gray'|'pink', action(dlg) → false keeps it open, id }]
 * Returns { el, body, close(), setError(msg), button(id) }.
 */
export function openDialog({ title, body, buttons = [], width = 520, onClose }) {
  const overlay = document.createElement('div');
  overlay.className = 'cs cs-overlay';
  overlay.innerHTML = `
    <div class="cs-dialog" role="dialog" aria-modal="true" aria-label="${escHtml(title)}" style="width:min(${width}px, calc(100vw - 32px))">
      <div class="cs-dialog-title">${escHtml(title)}</div>
      <div class="cs-dialog-error" role="alert" hidden></div>
      <div class="cs-dialog-body"></div>
      <div class="cs-dialog-buttons"></div>
    </div>`;
  const dialog = overlay.querySelector('.cs-dialog');
  const bodyEl = overlay.querySelector('.cs-dialog-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);

  const api = {
    el: dialog, body: bodyEl,
    close() {
      if (!overlay.isConnected) return;
      overlay.remove();
      openDialogs.splice(openDialogs.indexOf(api), 1);
      document.removeEventListener('keydown', onKey, true);
      if (onClose) onClose();
      prevFocus?.focus?.();
    },
    setError(msg) {
      const e = overlay.querySelector('.cs-dialog-error');
      e.textContent = msg || '';
      e.hidden = !msg;
    },
    button: id => overlay.querySelector(`.cs-btn[data-id="${id}"]`),
  };

  const btnRow = overlay.querySelector('.cs-dialog-buttons');
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `cs-btn cs-btn-${b.color || 'gray'}`;
    el.textContent = b.label;
    if (b.id) el.dataset.id = b.id;
    if (b.title) el.title = b.title;
    if (b.disabled) el.disabled = true;
    el.addEventListener('click', async () => {
      if (!b.action) return api.close();
      api.setError('');
      try { if ((await b.action(api)) !== false) api.close(); }
      catch (err) { api.setError(err.message); }
    });
    btnRow.append(el);
  }

  const onKey = e => {
    if (openDialogs[openDialogs.length - 1] !== api) return;
    if (e.key === 'Escape') { e.stopPropagation(); api.close(); }
  };
  document.addEventListener('keydown', onKey, true);
  const prevFocus = document.activeElement;
  document.body.append(overlay);
  openDialogs.push(api);
  (dialog.querySelector('input:not([readonly]), select, textarea') || btnRow.querySelector('button'))?.focus();
  return api;
}

/** Yes/no question. Resolves true when confirmed. */
export function confirmDialog({ title, html, yes = 'OK', yesColor = 'blue', no = 'Cancel' }) {
  return new Promise(resolve => {
    let answered = false;
    openDialog({
      title, body: html, width: 560,
      buttons: [
        { label: no,  color: 'gray', action: () => { answered = true; resolve(false); } },
        { label: yes, color: yesColor, id: 'yes', action: () => { answered = true; resolve(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

/**
 * Ask the operator before anything is transmitted: shows the exact text
 * JS8CALL will send, then sends it only on "Transmit".
 */
export async function confirmAndSend(form, data) {
  const blocker = transmitBlocker();
  if (blocker) throw new Error(blocker);
  const { text, airtime } = await request({ type: 'CS_SUBMIT', action: 'preview', form, data });
  if (!await confirmTransmit({ text, airtime, title: 'Transmit?' })) return null;
  const res = await request({ type: 'CS_SUBMIT', action: 'send', form, data });
  toast('Transmitted — JS8CALL is sending it now');
  return res;
}

/** Resend one of our transmitted records unchanged, after showing it and asking. */
export async function confirmAndResend(rec) {
  const blocker = transmitBlocker();
  if (blocker) throw new Error(blocker);
  const { text, airtime } = await request({ type: 'CS_RESEND', id: rec.id, preview: true, speed: settings.speed });
  const note = `Resending the same text and ID: stations that already have it ignore the repeat.`;
  if (!await confirmTransmit({ text, airtime, title: 'Resend?', yes: 'Resend', note })) return null;
  const res = await request({ type: 'CS_RESEND', id: rec.id, speed: settings.speed });
  toast('Resent — JS8CALL is sending it now');
  return res;
}

/** The confirmation every transmission goes through: exact text, airtime, a clear yes/no. */
function confirmTransmit({ text, airtime, title, yes = 'Transmit', note = '' }) {
  const long = airtime?.seconds > LONG_AIRTIME_S;
  return confirmDialog({
    title, yes, yesColor: 'blue',
    html: `<p class="cs-confirm-lead">JS8CALL will transmit this on its current frequency:</p>
           <pre class="cs-confirm-text">${escHtml(text)}</pre>
           <p class="cs-airtime${long ? ' cs-airtime-long' : ''}">${escHtml(fmtAirtime(airtime))}${long
             ? ' — long messages are more likely to be lost when conditions are poor; consider shortening it.' : ''}</p>
           ${note ? `<p class="cs-confirm-note">${escHtml(note)}</p>` : ''}
           <p class="cs-confirm-note">From <b>${escHtml(state.myStation.callsign)}</b>.
             You are responsible for this transmission as the control operator.</p>`,
  });
}

// ─── Airtime ──────────────────────────────────────────────────────────────────

export const LONG_AIRTIME_S = 120;

const fmtDuration = s => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`);

/** "About 4 frames · 1 min at Normal speed (JS8CALL's current speed)". */
export function fmtAirtime(a) {
  if (!a) return '';
  const where = { chosen: '', js8call: ' (JS8CALL\'s current speed)', assumed: ' (assumed; JS8CALL did not report its speed)' }[a.speedSource] ?? '';
  const time = a.seconds ? ` · about ${fmtDuration(a.seconds)} at ${a.speedName} speed` : ` at ${a.speedName} speed`;
  return `About ${a.frames} frame${a.frames === 1 ? '' : 's'}${time}${where}`;
}

// ─── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Is an acknowledgement expected? Records sent by older versions don't say,
 * so it is worked out the same way the server does: status reports and
 * incidents (RRSR), and messages to a callsign (JS8CALL's ACK).
 */
function expectsAck(rec) {
  if (typeof rec.ackExpected === 'boolean') return rec.ackExpected;
  return rec.kind === 'statrep' || rec.kind === 'incident' ||
         (rec.kind === 'message' && !String(rec.target || '').startsWith('@'));
}

/**
 * Delivery state of one of our transmitted records:
 *   { state: 'acked', calls } · { state: 'waiting', minutes } · { state: 'overdue', minutes }
 * or null when no acknowledgement is expected (group messages, alerts, heard traffic).
 */
export function deliveryState(rec, now = Date.now()) {
  if (!rec || rec.source !== 'sent' || !expectsAck(rec)) return null;
  if (rec.acks?.length) return { state: 'acked', calls: rec.acks };
  const minutes = Math.floor((now - (rec.lastTx || rec.utc)) / 60_000);
  return { state: minutes >= settings.ackWaitMin ? 'overdue' : 'waiting', minutes };
}

/** Table cell for the delivery column. */
export function deliveryCell(rec) {
  const d = deliveryState(rec);
  if (!d) return '<td class="cs-dlv"></td>';
  if (d.state === 'acked') {
    return `<td class="cs-dlv cs-dlv-acked" title="Acknowledged by ${escHtml(d.calls.join(', '))}">&#10003;${d.calls.length}</td>`;
  }
  const resent = rec.resends ? `, resent ${rec.resends}×` : '';
  return d.state === 'overdue'
    ? `<td class="cs-dlv cs-dlv-overdue" title="No acknowledgement after ${d.minutes} min${resent}. Open it to resend.">!</td>`
    : `<td class="cs-dlv cs-dlv-waiting" title="Waiting for an acknowledgement (${d.minutes} min${resent})">&hellip;</td>`;
}

/** Stations that reported hearing us in the last 30 minutes (evidence a group message was heard). */
export function recentlyHearingMe(now = Date.now()) {
  return [...stationData.values()]
    .filter(s => s.heardMe && now - s.heardMe.at < 30 * 60_000 && s.callsign !== state.myStation.callsign)
    .sort((a, b) => b.heardMe.snr - a.heardMe.snr)
    .map(s => `${s.callsign} (${s.heardMe.snr > 0 ? '+' : ''}${s.heardMe.snr})`);
}

// ─── Notifications ────────────────────────────────────────────────────────────

export function toast(message, kind = 'ok') {
  let host = document.getElementById('cs-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'cs-toasts';
    host.className = 'cs';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `cs-toast cs-toast-${kind}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), 5000);
}

let audioCtx = null;
/** Short notification tones (generated, so no sound files are needed). */
export function playSound(kind) {
  if (!settings.sounds) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = { statrep: [660, 880], alert: [880, 660, 880, 660], message: [990, 1320] }[kind] || [880];
    let t = audioCtx.currentTime;
    for (const f of notes) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
      t += 0.18;
    }
  } catch { /* audio unavailable */ }
}
