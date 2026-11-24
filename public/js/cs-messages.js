// Group messages table, message detail window, and the live feed.

import { stationData } from './state.js';
import { escHtml } from './util.js';
import { selectStation } from './selection.js';
import {
  cs, settings, on, recordsOf, isMe, fmtShort, fmtFull, fmtMHz, fmtSnr, lines, sourceCell,
  openDialog, confirmDialog, confirmAndResend, request, playSound, transmitBlocker, deliveryCell, deliveryState,
} from './js8stat.js';
import { deliveryHtml } from './cs-statreps.js';
import { openMessageForm, openDraft, isDraft } from './cs-forms.js';

// ─── Messages table ───────────────────────────────────────────────────────────

const COLUMNS = ['', 'Date Time', 'Freq', 'From', 'To', 'ID', 'Ack', 'Message'];
const filters = ['', '', '', '', '', '', '', ''];   // per-column filter text
const toText = r => (r.target || '') + (r.relay ? ` via ${r.relay}` : '');
const ackText = r => ({ acked: 'ACK', waiting: 'WAIT', overdue: 'NO ACK' }[deliveryState(r)?.state] || '');
let filterOpen = false;

function cellTexts(r) {
  return ['', fmtShort(r.utc), fmtMHz(r.freq), r.from, toText(r), r.msgId || '', ackText(r), lines(r.text).join(' ')];
}

function rowHtml(r) {
  const [srcCls, srcTip] = sourceCell(r);
  const t = cellTexts(r);
  const rfi = r.rfi === 1 ? ' cs-rfi' : r.rfi === 2 ? ' cs-rfi-reply' : '';
  return `<tr data-id="${r.id}">
    <td class="cs-src ${srcCls}" title="${escHtml(srcTip)}"></td>
    <td class="cs-nowrap">${escHtml(t[1])}</td>
    <td>${escHtml(t[2])}</td>
    <td><a href="#" class="cs-link" data-act="from">${escHtml(t[3])}</a></td>
    <td class="${isMe(r.target) ? 'cs-bold' : ''}">${escHtml(t[4])}</td>
    <td class="cs-center">${escHtml(t[5])}</td>
    ${deliveryCell(r)}
    <td class="cs-mono cs-msg${rfi}" title="${escHtml(lines(r.text).join('\n'))}">${escHtml(t[7])}</td>
  </tr>`;
}

let queued = false;
function scheduleRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
}

function render() {
  const active = filters.map(f => f.trim().toUpperCase());
  const rows = recordsOf('message').filter(r => {
    const t = cellTexts(r);
    return active.every((f, i) => !f || t[i].toUpperCase().includes(f));
  });
  const tbody = document.querySelector('#cs-message-table tbody');
  tbody.innerHTML = rows.length ? rows.map(rowHtml).join('')
    : `<tr class="cs-empty"><td colspan="${COLUMNS.length}">No messages in this period.</td></tr>`;
  document.getElementById('cs-message-count').textContent = `${rows.length} ${rows.length === 1 ? 'message' : 'messages'}`;
}

function openMessage(id) {
  const r = cs.records.get(id);
  if (!r) return;
  const [, srcTip] = sourceCell(r);
  const replyTo = r.target && r.target.startsWith('@') ? r.target : r.from;
  openDialog({
    title: `Message — ${r.from}`,
    width: 560,
    body: `
      <div class="cs-info">
        <div><span>From</span><b>${escHtml(r.from)}</b></div>
        <div><span>To</span><b>${escHtml(toText(r) || '—')}</b></div>
        <div><span>Date (UTC)</span><b>${escHtml(fmtFull(r.utc))}</b></div>
        <div><span>Frequency</span><b>${r.freq ? escHtml(fmtMHz(r.freq)) + ' MHz' : '—'}</b></div>
        <div><span>ID</span><b>${escHtml(r.msgId || '—')}</b></div>
        <div><span>Source</span><b>${escHtml(srcTip)}${r.rfi === 1 ? ' · request for information' : r.rfi === 2 ? ' · reply' : ''}</b></div>
      </div>
      <div class="cs-remarks-box">${lines(r.text).map(escHtml).join('<br>')}</div>
      ${r.source === 'sent' ? deliveryHtml(r) + (r.ackExpected ? ''
        : '<div class="cs-hint">Group messages are not acknowledged on the air.</div>') : ''}`,
    buttons: [
      { label: 'Close', color: 'gray' },
      { label: 'Delete', color: 'red', action: async () => {
        if (!await confirmDialog({ title: 'Delete message', html: '<p>Delete this message from the map?</p>', yes: 'Delete', yesColor: 'red' })) return false;
        await request({ type: 'CS_DELETE', id: r.id });
      } },
      ...(r.source === 'sent' && r.wire ? [{ label: 'Resend', color: 'cyan', id: 'resend', disabled: !!transmitBlocker(),
        title: transmitBlocker() || 'Send the same message again (same ID)',
        action: async () => { if (!await confirmAndResend(r)) return false; } }] : []),
      isDraft(r)
        ? { label: 'Edit / Send', color: 'blue', id: 'edit', title: 'Reopen this saved draft to change or transmit it',
            action: () => { openDraft(r); } }
        : { label: 'Reply', color: 'blue', action: () => { openMessageForm({ target: replyTo }); } },
    ],
  });
}

// ─── Live feed ────────────────────────────────────────────────────────────────

const CHATTER = /HEARTBEAT|@HB\b|\bCQ\b/i;

/** Same layout as JS8CALL's DIRECTED.TXT: time, MHz, offset, SNR, "FROM: text". */
function feedLine(l) {
  const text = /^[A-Z0-9/]+:\s/i.test(l.text) ? l.text : `${l.from}: ${l.text}`;
  return `${fmtFull(l.utc)}\t${fmtMHz(l.freq) || '—'}\t${l.offset ?? ''}\t${fmtSnr(l.snr)}\t${text}`;
}

const showInFeed = l => !(settings.hideHB && CHATTER.test(l.text));

function renderFeed() {
  const el = document.getElementById('cs-feed');
  el.textContent = '';
  const frag = document.createDocumentFragment();
  for (const l of cs.feed) if (showInFeed(l)) frag.append(feedDiv(l));
  el.append(frag);
}

function feedDiv(l) {
  const div = document.createElement('div');
  div.textContent = feedLine(l);
  if (isMe(l.from)) div.className = 'cs-feed-me';
  return div;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

export function initMessages() {
  const table = document.getElementById('cs-message-table');
  table.querySelector('thead').innerHTML = `
    <tr>${COLUMNS.map((c, i) => i === COLUMNS.length - 1
      ? `<th class="cs-th-remarks"><span>Message</span><span id="cs-message-count"></span>
           <a href="#" class="cs-filter-link" id="cs-message-filter-toggle" aria-expanded="false">FILTER</a></th>`
      : `<th>${c}</th>`).join('')}</tr>
    <tr class="cs-filter-row" hidden>${COLUMNS.map((c, i) => i === 0 ? '<th></th>'
      : `<th><input data-col="${i}" aria-label="Filter ${c}" placeholder="${c}" spellcheck="false"></th>`).join('')}</tr>`;

  const filterRow = table.querySelector('.cs-filter-row');
  document.getElementById('cs-message-filter-toggle').addEventListener('click', e => {
    e.preventDefault();
    filterOpen = !filterOpen;
    filterRow.hidden = !filterOpen;
    e.target.setAttribute('aria-expanded', String(filterOpen));
    if (!filterOpen) { filters.fill(''); filterRow.querySelectorAll('input').forEach(i => { i.value = ''; }); render(); }
    else filterRow.querySelector('input').focus();
  });
  filterRow.addEventListener('input', e => {
    const col = Number(e.target.dataset.col);
    if (col) { filters[col] = e.target.value; scheduleRender(); }
  });

  table.querySelector('tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    e.preventDefault();
    const r = cs.records.get(Number(tr.dataset.id));
    if (!r) return;
    if (e.target.closest('[data-act="from"]') && stationData.has(r.from)) selectStation(r.from);
    else openMessage(r.id);
  });

  on('reset', () => { scheduleRender(); renderFeed(); });
  on('remove', scheduleRender);
  on('settings', patch => {
    scheduleRender();
    if ('hideHB' in patch) renderFeed();
  });
  on('record', ({ record, isNew }) => {
    if (record.kind !== 'message') return;
    scheduleRender();
    if (isNew && record.source === 'rf' && isMe(record.target)) playSound('message');
  });
  on('feed', line => {
    if (!showInFeed(line)) return;
    const el = document.getElementById('cs-feed');
    el.prepend(feedDiv(line));
    while (el.childElementCount > 300) el.lastElementChild.remove();
  });
  setInterval(scheduleRender, 60_000);
  render();
  renderFeed();
}
