// The JS8Stat view: menu bar (Transmit / Filter / View), UTC clock, the
// StatRep panel above the map and the messages / live-feed column beside it,
// with draggable dividers. The rest of the map keeps its own styling.

import { map } from './map.js';
import { setToggle, escHtml } from './util.js';
import { cs, settings, saveSettings, on, transmitBlocker, openDialog, toast, deliveryState, playSound } from './js8stat.js';
import { openRoster } from './cs-roster.js';
import { openStatRepForm, openAlertForm, openMessageForm, openIncidentForm } from './cs-forms.js';
import { initStatReps } from './cs-statreps.js';
import { initMessages } from './cs-messages.js';
import { initAlerts, showAlerts } from './cs-alerts.js';

const $ = id => document.getElementById(id);

// ─── Layout ───────────────────────────────────────────────────────────────────

const PANELS = ['cs-menubar', 'cs-statrep-panel', 'cs-split-top', 'cs-split-side', 'cs-side'];

function applyLayout() {
  const on = settings.dashboard;
  for (const id of PANELS) $(id).hidden = !on;
  setToggle($('btn-js8stat'), on);
  $('cs-statrep-panel').style.height = `${settings.topH}px`;
  $('cs-side').style.width = `${settings.sideW}px`;
  $('cs-feed-panel').style.flexBasis = `${Math.round(settings.feedFrac * 100)}%`;
  map.invalidateSize();
}

/** Draggable divider. `onMove(dx, dy, start)` returns the patch to save. */
function makeSplitter(el, startValues, onMove) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const x0 = e.clientX, y0 = e.clientY, start = startValues();
    const move = ev => {
      const patch = onMove(ev.clientX - x0, ev.clientY - y0, start);
      Object.assign(settings, patch);
      applyLayout();
    };
    const up = () => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      saveSettings({});
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  // Keyboard resizing for the focusable dividers
  el.addEventListener('keydown', e => {
    const step = e.shiftKey ? 50 : 15;
    const d = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[e.key];
    if (!d) return;
    e.preventDefault();
    Object.assign(settings, onMove(d[0], d[1], startValues()));
    applyLayout();
    saveSettings({});
  });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function initSplitters() {
  makeSplitter($('cs-split-top'), () => ({ h: settings.topH }),
    (dx, dy, s) => ({ topH: clamp(s.h + dy, 90, window.innerHeight - 220) }));
  makeSplitter($('cs-split-side'), () => ({ w: settings.sideW }),
    (dx, dy, s) => ({ sideW: clamp(s.w - dx, 260, window.innerWidth - 360) }));
  makeSplitter($('cs-split-feed'), () => ({ f: settings.feedFrac, h: $('cs-side').clientHeight }),
    (dx, dy, s) => ({ feedFrac: clamp(s.f - dy / Math.max(1, s.h), 0.1, 0.9) }));
}

// ─── Menus ────────────────────────────────────────────────────────────────────

function closeMenus(except) {
  document.querySelectorAll('.cs-menu.open').forEach(m => {
    if (m === except) return;
    m.classList.remove('open');
    m.querySelector('.cs-menu-btn').setAttribute('aria-expanded', 'false');
  });
}

/** Reflect current settings on the menu's check and radio items. */
function syncMenus() {
  document.querySelectorAll('#cs-menubar [data-setting]').forEach(item => {
    const key = item.dataset.setting;
    const checked = item.dataset.value !== undefined ? settings[key] === item.dataset.value : !!settings[key];
    item.setAttribute('aria-checked', String(checked));
  });
  const groups = settings.groups.trim();
  $('cs-groups-label').textContent = groups ? `Groups: ${groups}` : 'Groups: all';
  updateTxState();
}

function updateTxState() {
  const blocker = transmitBlocker();
  const el = $('cs-tx-state');
  el.textContent = blocker ? 'TX OFF' : 'TX READY';
  el.className = blocker ? 'cs-tx-off' : 'cs-tx-on';
  el.title = blocker || 'Transmitting is on. You will be asked to confirm every transmission.';
  const txItem = document.querySelector('#cs-menubar [data-setting="txEnabled"]');
  txItem.setAttribute('aria-disabled', String(!cs.mayTransmit));
  txItem.title = cs.mayTransmit ? '' : transmitBlocker();
}

function editGroups() {
  const dlg = openDialog({
    title: 'Show Groups',
    width: 460,
    body: `<label class="cs-field cs-field-wide"><span>Groups to show (comma separated; leave empty for all)</span>
             <input name="groups" value="${escHtml(settings.groups)}" placeholder="AMRRON, MAGNET" class="cs-upper" spellcheck="false"></label>
           <p class="cs-hint">Reports, alerts and messages addressed to you always show.</p>`,
    buttons: [
      { label: 'Cancel', color: 'gray' },
      { label: 'Show All', color: 'cyan', action: () => saveSettings({ groups: '' }) },
      { label: 'Apply', color: 'blue', id: 'apply', action: d => saveSettings({ groups: d.body.querySelector('input').value.toUpperCase() }) },
    ],
  });
  dlg.body.querySelector('input').addEventListener('keydown', e => { if (e.key === 'Enter') dlg.button('apply')?.click(); });
}

async function setTransmitEnabled(want) {
  if (want && !cs.mayTransmit) { toast(transmitBlocker(), 'warn'); return; }
  saveSettings({ txEnabled: want });
  if (want) toast('Transmitting is on — you will be asked before anything is sent');
}

const ACTIONS = {
  statrep:  () => openStatRepForm(),
  alert:    () => openAlertForm(),
  message:  () => openMessageForm(),
  incident: () => openIncidentForm(),
  groups:   editGroups,
  alerts:   () => { if (!showAlerts()) toast('No alerts in this period', 'warn'); },
  about:    showAbout,
  roster:   openRoster,
};

// ─── Clock check ──────────────────────────────────────────────────────────────

let lastClockStatus = 'unknown';

/** CLOCK indicator: decodes arriving off-time mean the PC clock (no internet time) has drifted. */
function updateClockState() {
  const c = cs.clock || {};
  const el = $('cs-clock-state');
  const off = c.offset === null || c.offset === undefined ? '' : `${c.offset > 0 ? '+' : ''}${c.offset.toFixed(1)} s`;
  el.textContent = c.status === 'unknown' ? 'CLOCK ?' : c.status === 'ok' ? 'CLOCK OK' : `CLOCK ${off}`;
  el.className = `cs-clock-${c.status || 'unknown'}`;
  el.title = {
    unknown: 'Clock check: not enough decodes yet in the last 15 minutes.',
    ok:      `Clock check: decodes arrive on time (median offset ${off} over ${c.samples} decodes).`,
    warn:    `Decodes are arriving about ${off} off your PC clock. JS8CALL starts losing decodes beyond about 2 s. ` +
             'Without internet time, set the clock from a GPS receiver or by hand.',
    bad:     `Decodes are arriving about ${off} off your PC clock — JS8CALL will miss many decodes and other stations may not decode you. ` +
             'Correct the clock now (GPS time source, or set it by hand against a known-good clock).',
  }[c.status] || '';
  if ((c.status === 'warn' || c.status === 'bad') && c.status !== lastClockStatus) {
    toast(`Clock check: decodes are about ${off} off your PC clock — check the time`, 'warn');
  }
  lastClockStatus = c.status;
}

// ─── Nudges: unacknowledged reports and missing group memberships ────────────

const nudged = new Set();        // "id:lastTx" already flagged
const warnedGroups = new Set();

function checkDelivery() {
  for (const r of cs.records.values()) {
    const d = deliveryState(r);
    const key = `${r.id}:${r.lastTx}`;
    if (d?.state !== 'overdue' || nudged.has(key)) continue;
    nudged.add(key);
    const what = r.kind === 'message' ? `message ${r.msgId} to ${r.target}` : `${r.kind === 'incident' ? 'incident' : 'status report'} ${r.srId}`;
    toast(`No acknowledgement for ${what} after ${d.minutes} min — open it to resend`, 'warn');
    playSound('message');
  }
}

function checkGroups() {
  for (const g of cs.groupWarnings) {
    if (warnedGroups.has(g)) continue;
    warnedGroups.add(g);
    toast(`Only partial messages are arriving for ${g} — add it to your groups in JS8CALL (see View → Group Roster)`, 'warn');
  }
}

function showAbout() {
  openDialog({
    title: 'About JS8Stat',
    width: 520,
    body: `
      <p class="cs-about-lead"><b>JS8Stat is not CommStat.</b></p>
      <p>JS8Stat is part of JS8CALL Map. It is not a new version of CommStat, is not based on
         CommStat's code, and is not affiliated with the CommStat project or its authors.</p>
      <p>It reads and sends the same plain-text message formats (status reports, incidents,
         alerts and group messages), so JS8Stat and CommStat stations can exchange traffic
         on the air.</p>
      <p class="cs-hint">Records are kept for ${cs.keepDays} days. Transmitting is
         ${cs.transmitMode === 'off' ? 'switched off on the server' : 'available once you enable it in the Transmit menu'};
         you are always asked before anything is sent.</p>`,
    buttons: [{ label: 'Close', color: 'gray' }],
  });
}

function initMenus() {
  const bar = $('cs-menubar');
  bar.addEventListener('click', e => {
    const btn = e.target.closest('.cs-menu-btn');
    if (btn) {
      const menu = btn.parentElement;
      const opening = !menu.classList.contains('open');
      closeMenus();
      menu.classList.toggle('open', opening);
      btn.setAttribute('aria-expanded', String(opening));
      if (opening) menu.querySelector('[role^="menuitem"]')?.focus();
      return;
    }
    const item = e.target.closest('[role^="menuitem"]');
    if (!item || item.getAttribute('aria-disabled') === 'true' && item.dataset.setting !== 'txEnabled') return;
    const key = item.dataset.setting;
    if (key === 'txEnabled') { setTransmitEnabled(!settings.txEnabled); return; }   // menu stays open
    if (key && item.dataset.value !== undefined) { saveSettings({ [key]: item.dataset.value }); return; }
    if (key) { saveSettings({ [key]: !settings[key] }); return; }
    closeMenus();
    ACTIONS[item.dataset.action]?.();
  });
  bar.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeMenus(); return; }
    const items = [...(e.target.closest('.cs-menu-list')?.querySelectorAll('[role^="menuitem"]') || [])];
    const i = items.indexOf(e.target);
    if (i < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }
  });
  document.addEventListener('click', e => { if (!(e.target instanceof Element && e.target.closest('.cs-menu'))) closeMenus(); });
}

// ─── Clock ────────────────────────────────────────────────────────────────────

function tickClock() {
  $('cs-clock').textContent = new Date().toISOString().slice(11, 19);
}

// ─── Start ────────────────────────────────────────────────────────────────────

export function initJS8Stat() {
  initStatReps();
  initMessages();
  initAlerts();
  initMenus();
  initSplitters();

  $('btn-js8stat').addEventListener('click', () => { saveSettings({ dashboard: !settings.dashboard }); applyLayout(); });
  window.addEventListener('resize', () => {
    // Keep panels usable after the window shrinks.
    settings.topH  = clamp(settings.topH, 90, Math.max(90, window.innerHeight - 220));
    settings.sideW = clamp(settings.sideW, 260, Math.max(260, window.innerWidth - 360));
    if (settings.dashboard) applyLayout();
  });

  on('settings', syncMenus);
  on('reset', syncMenus);
  on('connection', updateTxState);
  on('clock', updateClockState);
  on('groups', checkGroups);
  on('reset', () => {
    // Reports already overdue when the page opens are not announced again.
    for (const r of cs.records.values()) if (deliveryState(r)?.state === 'overdue') nudged.add(`${r.id}:${r.lastTx}`);
    updateClockState();
    checkGroups();
  });
  setInterval(checkDelivery, 30_000);
  updateClockState();
  tickClock();
  setInterval(tickClock, 1000);
  applyLayout();
  syncMenus();
}
