// JS8Stat transmit forms: Status Report, Alert, Message and Incident.
// Every form offers "Save Only" and "Transmit"; Transmit always shows the exact
// text and asks the operator to confirm before anything is sent.

import { state } from './state.js';
import { escHtml } from './util.js';
import {
  STATUS_FIELDS, STATUS_LABELS, SCOPES, INCIDENT_TYPES, ALERT_COLORS, SPEEDS, LIMITS,
  settings, saveSettings, knownGroups, groupList, timeId, transmitBlocker,
  openDialog, request, confirmAndSend, toast, fmtAirtime, LONG_AIRTIME_S,
} from './js8stat.js';

const opts = (pairs, selected = '') =>
  pairs.map(([v, l]) => `<option value="${escHtml(v)}"${String(v) === String(selected) ? ' selected' : ''}>${escHtml(l)}</option>`).join('');

function defaultTarget() {
  return settings.lastTarget || groupList()[0] || '';
}

/** Group/callsign input with known groups as suggestions. */
function targetField(value = defaultTarget()) {
  return `
    <label class="cs-field"><span>To (group or callsign)</span>
      <input name="target" list="cs-group-list" value="${escHtml(value)}" placeholder="@GROUP or CALLSIGN"
             autocomplete="off" spellcheck="false" maxlength="13" class="cs-upper">
      <datalist id="cs-group-list">${knownGroups().map(g => `<option value="${escHtml(g)}">`).join('')}</datalist>
    </label>`;
}

function speedField() {
  return `<label class="cs-field"><span>Speed</span><select name="speed">${opts(SPEEDS, settings.speed)}</select></label>`;
}

function counter(el, max, display) {
  const update = () => {
    const n = el.value.replace(/\r?\n/g, '||').length;
    display.textContent = `${n} of ${max}`;
    display.classList.toggle('cs-over', n > max);
  };
  el.addEventListener('input', update);
  update();
}

/** Footer buttons shared by every form. `collect` reads the form and returns its data. */
function formButtons(form, collect, afterSave) {
  const blocker = transmitBlocker();
  return [
    { label: 'Cancel', color: 'gray' },
    { label: 'Save Only', color: 'cyan', action: async () => {
      await request({ type: 'CS_SUBMIT', action: 'save', form, data: collect() });
      toast('Saved (not transmitted)');
      afterSave?.();
    } },
    { label: 'Transmit', color: 'blue', id: 'tx', disabled: !!blocker, title: blocker, action: async () => {
      const data = collect();
      const res = await confirmAndSend(form, data);
      if (!res) return false;   // operator cancelled: keep the form open
      afterSave?.();
    } },
  ];
}

function remember(data) {
  saveSettings({ lastTarget: data.target || settings.lastTarget, speed: data.speed ?? settings.speed });
}

const val = (root, name) => root.querySelector(`[name="${name}"]`)?.value ?? '';

// ─── Status Report ────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [['', ''], ['1', 'Green'], ['2', 'Yellow'], ['3', 'Red'], ['4', 'Unknown']];
const SEVERITY = { 3: 3, 2: 2, 4: 1, 1: 0 };   // worst first, for the automatic Map Pin

export function openStatRepForm(prefill = {}) {
  const me = state.myStation;
  const srId = prefill.id || timeId();
  const statusCells = STATUS_FIELDS.map((k, i) => `
      <label class="cs-status-cell"><span>${STATUS_LABELS[i]}</span>
        <select name="st-${k}" data-field="${k}" class="cs-status-select">${opts(STATUS_OPTIONS, prefill.status?.[k] || '')}</select>
      </label>`).join('');

  const dlg = openDialog({
    title: prefill.replaceId ? `Status Report — draft ${srId}` : 'Status Report',
    width: 720,
    body: `
      <div class="cs-form-row">
        ${targetField(prefill.target)}
        <label class="cs-field"><span>From</span><input value="${escHtml(me.callsign || '—')}" readonly></label>
        <label class="cs-field"><span>Grid</span><input name="grid" value="${escHtml(prefill.grid || me.grid || '')}"
               maxlength="8" class="cs-upper" spellcheck="false"></label>
        <label class="cs-field"><span>Scope</span><select name="scope">${opts(Object.entries(SCOPES).filter(([c]) => c !== '5'), prefill.scope || '1')}</select></label>
        <label class="cs-field cs-field-narrow"><span>ID</span><input name="srId" value="${srId}" readonly></label>
        ${speedField()}
      </div>
      <div class="cs-status-grid">${statusCells}</div>
      <div class="cs-form-actions">
        <button type="button" class="cs-btn cs-btn-green cs-btn-small" data-act="all-green">All Green</button>
        <button type="button" class="cs-btn cs-btn-gray cs-btn-small" data-act="all-unknown">All Unknown</button>
        <span class="cs-hint">Map Pin follows the worst condition unless you set it yourself.</span>
      </div>
      <label class="cs-field cs-field-wide"><span>Remarks <em class="cs-counter"></em></span>
        <textarea name="remarks" rows="3" maxlength="600" spellcheck="true"
                  placeholder="Optional. Commas are not allowed (they separate fields).">${escHtml(prefill.remarks || '')}</textarea>
      </label>`,
    buttons: formButtons('statrep', () => collect(), null),
  });
  const root = dlg.body;
  liveAirtime(dlg, 'statrep', () => collect(true));
  const selects = [...root.querySelectorAll('.cs-status-select')];
  const mapSel = root.querySelector('[data-field="map"]');
  const worstOfOthers = () => {
    const vals = selects.filter(s => s !== mapSel).map(s => s.value).filter(Boolean);
    return vals.length ? vals.reduce((w, v) => (SEVERITY[v] > SEVERITY[w] ? v : w), vals[0]) : '';
  };
  // A prefilled Map Pin counts as set by hand only if it differs from what the
  // automatic rule would choose (so a reopened draft keeps following its conditions).
  let mapPinManual = !!prefill.status?.map && prefill.status.map !== worstOfOthers();

  const paint = sel => { sel.dataset.value = sel.value; };
  const autoMapPin = () => {
    if (mapPinManual) return;
    const worst = worstOfOthers();
    if (!worst) return;
    mapSel.value = worst;
    paint(mapSel);
  };
  selects.forEach(s => {
    paint(s);
    s.addEventListener('change', () => {
      if (s === mapSel) mapPinManual = !!s.value;
      paint(s);
      autoMapPin();
    });
  });
  const setAll = v => { selects.forEach(s => { s.value = v; paint(s); }); mapPinManual = false; };
  root.querySelector('[data-act="all-green"]').addEventListener('click', () => setAll('1'));
  root.querySelector('[data-act="all-unknown"]').addEventListener('click', () => setAll('4'));
  counter(root.querySelector('[name="remarks"]'), LIMITS.remarks, root.querySelector('.cs-counter'));

  function collect(quiet) {
    const data = {
      target: val(root, 'target'), grid: val(root, 'grid'), scope: val(root, 'scope'),
      srId, speed: val(root, 'speed'), remarks: val(root, 'remarks'),
      status: Object.fromEntries(selects.map(s => [s.dataset.field, s.value])),
    };
    if (prefill.replaceId) data.replaceId = prefill.replaceId;
    if (!quiet) remember(data);
    return data;
  }
  return dlg;
}

// ─── Alert ────────────────────────────────────────────────────────────────────

export function openAlertForm(prefill = {}) {
  const alertId = prefill.id || timeId();
  const dlg = openDialog({
    title: prefill.replaceId ? `Group Alert — draft ${alertId}` : 'Group Alert',
    width: 560,
    body: `
      <div class="cs-form-row">
        ${targetField(prefill.target)}
        <label class="cs-field"><span>Colour</span>
          <select name="color" class="cs-alert-color">${opts(Object.entries(ALERT_COLORS).map(([v, [n]]) => [v, n]), prefill.color || '1')}</select>
        </label>
        ${speedField()}
      </div>
      <label class="cs-field cs-field-wide"><span>Title <em class="cs-counter" data-for="title"></em></span>
        <input name="title" maxlength="${LIMITS.alertTitle}" value="${escHtml(prefill.title || '')}" class="cs-upper"></label>
      <label class="cs-field cs-field-wide"><span>Message <em class="cs-counter" data-for="message"></em></span>
        <textarea name="message" rows="4" maxlength="${LIMITS.alertMessage + 20}">${escHtml(prefill.message || '')}</textarea></label>`,
    buttons: formButtons('alert', () => collect(), null),
  });
  const root = dlg.body;
  liveAirtime(dlg, 'alert', () => collect(true));
  const colorSel = root.querySelector('[name="color"]');
  const paint = () => { colorSel.dataset.value = colorSel.value; };
  colorSel.addEventListener('change', paint);
  paint();
  counter(root.querySelector('[name="title"]'), LIMITS.alertTitle, root.querySelector('[data-for="title"]'));
  counter(root.querySelector('[name="message"]'), LIMITS.alertMessage, root.querySelector('[data-for="message"]'));
  function collect(quiet) {
    const data = { target: val(root, 'target'), color: val(root, 'color'), title: val(root, 'title'),
                   message: val(root, 'message'), alertId, speed: val(root, 'speed') };
    if (prefill.replaceId) data.replaceId = prefill.replaceId;
    if (!quiet) remember(data);
    return data;
  }
  return dlg;
}

// ─── Message ──────────────────────────────────────────────────────────────────

export function openMessageForm(prefill = {}) {
  const msgId = prefill.id || timeId();
  const dlg = openDialog({
    title: prefill.replaceId ? `Group Message — draft ${msgId}` : 'Group Message',
    width: 560,
    body: `
      <div class="cs-form-row">${targetField(prefill.target)}${speedField()}</div>
      <div class="cs-route" hidden>
        <label class="cs-field cs-field-wide"><span>Route</span>
          <select name="relay"><option value="">Direct</option>${prefill.relay
            ? `<option value="${escHtml(prefill.relay)}" selected>via ${escHtml(prefill.relay)}</option>` : ''}</select></label>
        <p class="cs-route-hint cs-hint"></p>
      </div>
      <label class="cs-field cs-field-wide"><span>Message <em class="cs-counter"></em></span>
        <textarea name="text" rows="5" maxlength="${LIMITS.message + 20}">${escHtml(prefill.text || '')}</textarea></label>`,
    buttons: formButtons('message', () => collect(), null),
  });
  const root = dlg.body;
  liveAirtime(dlg, 'message', () => collect(true));
  routePicker(root, prefill.relay);
  counter(root.querySelector('[name="text"]'), LIMITS.message, root.querySelector('.cs-counter'));
  function collect(quiet) {
    const data = { target: val(root, 'target'), text: val(root, 'text'), msgId, speed: val(root, 'speed'),
                   relay: root.querySelector('.cs-route').hidden ? '' : val(root, 'relay') };
    if (prefill.replaceId) data.replaceId = prefill.replaceId;
    if (!quiet) remember(data);
    return data;
  }
  return dlg;
}

// ─── Incident ─────────────────────────────────────────────────────────────────

export function openIncidentForm(prefill = {}) {
  const srId = prefill.id || timeId();
  const dlg = openDialog({
    title: prefill.replaceId ? `Group Incident — draft ${srId}` : 'Group Incident',
    width: 600,
    body: `
      <div class="cs-form-row">
        ${targetField(prefill.target)}
        <label class="cs-field"><span>Type</span>
          <select name="type" class="cs-incident-type">${opts(Object.entries(INCIDENT_TYPES), prefill.type || '6')}</select></label>
        <label class="cs-field"><span>Grid</span><input name="grid" value="${escHtml(prefill.grid || state.myStation.grid || '')}"
               maxlength="8" class="cs-upper" spellcheck="false"></label>
        <label class="cs-field"><span>Pin to map</span><select name="pinned">${opts([['1', 'Yes'], ['0', 'No']], prefill.pinned === false ? '0' : '1')}</select></label>
        ${speedField()}
      </div>
      <label class="cs-field cs-field-wide"><span>Message <em class="cs-counter"></em></span>
        <textarea name="remarks" rows="4" maxlength="${LIMITS.incident + 20}"
                  placeholder="What happened, where. Commas are not allowed.">${escHtml(prefill.remarks || '')}</textarea></label>`,
    buttons: formButtons('incident', () => collect(), null),
  });
  const root = dlg.body;
  liveAirtime(dlg, 'incident', () => collect(true));
  const typeSel = root.querySelector('[name="type"]');
  const paint = () => { typeSel.dataset.value = typeSel.value; };
  typeSel.addEventListener('change', paint);
  paint();
  counter(root.querySelector('[name="remarks"]'), LIMITS.incident, root.querySelector('.cs-counter'));
  function collect(quiet) {
    const data = { target: val(root, 'target'), type: val(root, 'type'), grid: val(root, 'grid'),
                   pinned: val(root, 'pinned') === '1', remarks: val(root, 'remarks'), srId, speed: val(root, 'speed') };
    if (prefill.replaceId) data.replaceId = prefill.replaceId;
    if (!quiet) remember(data);
    return data;
  }
  return dlg;
}

// ─── Reopening saved drafts ───────────────────────────────────────────────────

/** Saved (not yet transmitted) records can be reopened, edited and sent. */
export const isDraft = rec => rec && rec.source === 'saved';

const unbreak = t => String(t || '').split('||').map(l => l.trim()).join('\n');

/**
 * Reopen a saved record in its form with every field filled in and its
 * original ID kept. Saving or sending from that form replaces the draft.
 */
export function openDraft(rec) {
  if (!isDraft(rec)) return null;
  const base = { target: rec.target, replaceId: rec.id };
  switch (rec.kind) {
    case 'statrep':
      return openStatRepForm({ ...base, id: rec.srId, grid: rec.grid, scope: rec.scope, remarks: unbreak(rec.remarks),
        status: Object.fromEntries(STATUS_FIELDS.map((k, i) => [k, rec.status?.[i] || ''])) });
    case 'incident':
      return openIncidentForm({ ...base, id: rec.srId, grid: rec.grid, type: rec.type, pinned: !!rec.pinned,
        remarks: unbreak(rec.remarks) });
    case 'alert':
      return openAlertForm({ ...base, id: rec.alertId, color: rec.color, title: rec.title, message: unbreak(rec.message) });
    case 'message':
      return openMessageForm({ ...base, id: rec.msgId, text: unbreak(rec.text), relay: rec.relay || '' });
  }
  return null;
}

// ─── Live airtime ─────────────────────────────────────────────────────────────

/**
 * Show, under a form, how long the transmission will take. Uses the server's
 * preview, so the estimate is for the exact text that would be sent.
 */
function liveAirtime(dlg, form, collect) {
  const line = document.createElement('p');
  line.className = 'cs-airtime';
  line.setAttribute('aria-live', 'polite');
  dlg.body.append(line);
  let timer = null, seq = 0;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const { airtime } = await request({ type: 'CS_SUBMIT', action: 'preview', form, data: collect() });
        if (mine !== seq) return;
        const long = airtime.seconds > LONG_AIRTIME_S;
        line.textContent = fmtAirtime(airtime) + (long ? ' — long; consider shortening it' : '');
        line.classList.toggle('cs-airtime-long', long);
        line.classList.remove('cs-airtime-pending');
      } catch (err) {
        if (mine !== seq) return;
        line.textContent = `Airtime: ${err.message}`;      // e.g. "Enter a message"
        line.classList.add('cs-airtime-pending');
        line.classList.remove('cs-airtime-long');
      }
    }, 350);
  };
  dlg.body.addEventListener('input', update);
  dlg.body.addEventListener('change', update);
  dlg.body.addEventListener('click', e => { if (e.target.closest('button')) update(); });
  update();
}

// ─── Relay routing ────────────────────────────────────────────────────────────

const looksLikeCall = t => /^[A-Z0-9/]{3,12}$/i.test(t) && /\d/.test(t) && /[A-Z]/i.test(t);

/**
 * Describe one hop of a path from `a` (receiver) to `b` (sender):
 *   dir 'hears' — `a` reported hearing `b` (the direction that matters);
 *   dir 'heard' — only the reverse is known: `b` decoded `a`.
 */
function linkText(l, a, b) {
  const snr = l.snr === null ? '' : `${l.snr > 0 ? '+' : ''}${l.snr} dB, `;
  return l.dir === 'hears' ? `${a} hears ${b} (${snr}${l.minutesAgo} min ago)`
                           : `${b} heard ${a} (${snr}${l.minutesAgo} min ago)`;
}

/**
 * For a message to a callsign, offer "Direct" or a relay through a station
 * that hears us and is heard by the recipient (from the SNR reports heard).
 */
function routePicker(root, initialRelay = '') {
  const box = root.querySelector('.cs-route');
  const sel = box.querySelector('select');
  const hint = box.querySelector('.cs-route-hint');
  let last = { target: '', routes: null }, timer = null;

  const describe = () => {
    const r = last.routes;
    if (!r) { hint.textContent = ''; return; }
    if (!sel.value) {
      const d = r.direct;
      if (d.targetHearsMe) {
        hint.textContent = `Direct: ${linkText(d.targetHearsMe, r.target, 'you')}.`;
        return;
      }
      // Hearing them doesn't prove they hear us, so a relay is still worth suggesting.
      const heard = d.iHearTarget ? `You hear ${r.target}, but there is no` : 'No';
      hint.textContent = `${heard} report of ${r.target} hearing you in the last 3 hours.` +
        (r.relays.length ? ` Suggested relay: ${r.relays[0].call}.` : ' No relay found; Direct is the only option.');
      return;
    }
    const x = r.relays.find(v => v.call === sel.value);
    hint.textContent = x ? `${linkText(x.toRelay, x.call, 'you')} · ${linkText(x.toTarget, r.target, x.call)}.`
      : `${sel.value} will pass the message on (no recent reports link it to both stations).`;
  };

  const refresh = async () => {
    const target = root.querySelector('[name="target"]').value.trim().toUpperCase();
    box.hidden = !looksLikeCall(target);
    if (box.hidden || target === last.target) { describe(); return; }
    last = { target, routes: null };
    try {
      const { routes } = await request({ type: 'CS_ROUTES', target });
      if (last.target !== target) return;
      last.routes = routes;
      const keep = sel.value || initialRelay;
      sel.innerHTML = `<option value="">Direct</option>` + routes.relays.map(x => `<option value="${escHtml(x.call)}">via ${escHtml(x.call)}</option>`).join('')
        + (keep && !routes.relays.some(x => x.call === keep) ? `<option value="${escHtml(keep)}">via ${escHtml(keep)}</option>` : '');
      sel.value = keep;
      initialRelay = '';
    } catch { /* server unreachable: keep Direct */ }
    describe();
  };

  root.querySelector('[name="target"]').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 300); });
  sel.addEventListener('change', describe);
  refresh();
}
