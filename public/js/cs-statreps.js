// StatReps and incidents: the JS8Stat table, their map pins, and the detail window.

import { map } from './map.js';
import { state, stationData } from './state.js';
import { escHtml } from './util.js';
import { selectStation } from './selection.js';
import { handleMeasureClick } from './measure.js';
import {
  cs, settings, on, recordsOf, isMe, STATUS_FIELDS, STATUS_LABELS, STATUS_SHORT, STATUS_NAMES,
  SCOPES, SCOPE_RADIUS, INCIDENT_TYPES, fmtShort, fmtFull, fmtMHz, lines, sourceCell,
  openDialog, confirmDialog, confirmAndSend, confirmAndResend, request, transmitBlocker, playSound, toast,
  deliveryCell, deliveryState, recentlyHearingMe,
} from './js8stat.js';
import { openDraft, isDraft } from './cs-forms.js';

const { gridToLatLon } = globalThis.Grid;

// Pin colours by Map Pin status (the colours other stations using these formats expect).
const PIN_COLORS = { 1: '#20AA20', 2: '#FF8C00', 3: '#CC2020', 4: '#000000', 6: '#8000FF', 7: '#FF00FF' };

const isIncident = r => r.kind === 'incident';
/** Each condition's value; incidents fill every column with their type (6 or 7). */
const statusOf = r => (isIncident(r) ? Array(12).fill(r.type) : [...(r.status || '444444444444')]);

function remarksText(r) {
  const parts = lines(r.remarks).filter(Boolean);
  if (r.forwardedBy) parts.push(`Forwarded by ${r.forwardedBy}`);
  if (r.acks?.length) parts.push(`ACK ${r.acks.join(', ')}`);
  return parts;
}

// ─── Table ────────────────────────────────────────────────────────────────────

const COLUMNS = ['', 'Date Time', 'Freq', 'From', 'To', 'ID', 'Grid', 'Scope', ...STATUS_SHORT, 'Ack', 'Remarks'];

function rowHtml(r) {
  const [srcCls, srcTip] = sourceCell(r);
  const st = statusOf(r);
  const scope = isIncident(r) ? INCIDENT_TYPES[r.type].toUpperCase() : (SCOPES[r.scope] || '');
  const remarks = remarksText(r);
  return `<tr data-id="${r.id}" class="${isMe(r.target) ? 'cs-to-me' : ''}">
    <td class="cs-src ${srcCls}" title="${escHtml(srcTip)}"></td>
    <td class="cs-nowrap">${fmtShort(r.utc)}</td>
    <td>${fmtMHz(r.freq)}</td>
    <td><a href="#" class="cs-link" data-act="from">${escHtml(r.from)}</a></td>
    <td class="${isMe(r.target) ? 'cs-bold' : ''}">${escHtml(r.target || '')}</td>
    <td class="cs-center"><a href="#" class="cs-link cs-bold" data-act="locate" title="Show on the map">${escHtml(r.srId || '')}</a></td>
    <td class="cs-mono">${escHtml(r.grid || '')}</td>
    <td class="cs-nowrap">${escHtml(scope)}</td>
    ${st.map((v, i) => `<td class="cs-st cs-st-${escHtml(v)}" title="${STATUS_LABELS[i]}: ${STATUS_NAMES[v] || 'Unknown'}"></td>`).join('')}
    ${deliveryCell(r)}
    <td class="cs-mono cs-remarks" title="${escHtml(remarks.join('\n'))}">${escHtml(remarks.join('  '))}</td>
  </tr>`;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const rows = recordsOf('statrep', 'incident');
  const tbody = document.querySelector('#cs-statrep-table tbody');
  if (tbody) {
    tbody.innerHTML = rows.length ? rows.map(rowHtml).join('')
      : `<tr class="cs-empty"><td colspan="${COLUMNS.length}">No status reports${settings.groups ? ' for the chosen groups' : ''} in this period.</td></tr>`;
    document.getElementById('cs-statrep-count').textContent = `${rows.length} ${rows.length === 1 ? 'report' : 'reports'}`;
  }
  renderPins(rows);
}

// ─── Map pins ─────────────────────────────────────────────────────────────────

map.createPane('statrepPane');
map.getPane('statrepPane').style.zIndex = 590;   // under station markers (600), over overlays
const pinLayer = L.layerGroup().addTo(map);
const pinById  = new Map();   // record id → { marker, latlng }

function popupHtml(r) {
  const scope = isIncident(r) ? INCIDENT_TYPES[r.type] : (SCOPES[r.scope] || '');
  return `<div class="cs-pin-card">
      <div class="cs-pin-call">${escHtml(r.from)}</div>
      <table>
        <tr><td>${isIncident(r) ? 'Type' : 'Scope'}:</td><td>${escHtml(scope)}</td></tr>
        <tr><td>Freq:</td><td>${r.freq ? fmtMHz(r.freq) + ' MHz' : ''}</td></tr>
        <tr><td>Group:</td><td>${escHtml((r.target || '').replace(/^@/, ''))}</td></tr>
        <tr><td>Date:</td><td>${escHtml(fmtShort(r.utc))}</td></tr>
      </table>
      <a href="#" class="cs-pin-details" data-id="${r.id}">Details</a>
    </div>`;
}

function onPinClick(e, r, latlng) {
  if (state.measuring) { handleMeasureClick(e); return; }
  L.popup({ className: 'cs-popup', closeButton: false, minWidth: 190, maxWidth: 190, offset: [0, -4] })
    .setLatLng(latlng).setContent(popupHtml(r)).openOn(map);
}

function renderPins(rows) {
  pinLayer.clearLayers();
  pinById.clear();
  if (!settings.showPins) return;

  // The newest report from each station, plus every incident.
  const seen = new Set();
  const shown = [];
  for (const r of rows) {                        // newest first
    if (!r.grid) continue;
    if (isIncident(r)) { if (r.pinned || r.utc > Date.now() - 24 * 3600_000) shown.push(r); continue; }
    if (seen.has(r.from)) continue;
    seen.add(r.from);
    if (settings.hideGreen && r.status?.[0] === '1') continue;
    shown.push(r);
  }

  const perGrid = new Map();
  for (const r of shown.reverse()) {             // oldest first, so the newest draws on top
    const pos = gridToLatLon(r.grid);
    if (!pos) continue;
    const n = perGrid.get(r.grid) || 0;
    perGrid.set(r.grid, n + 1);
    const latlng = [pos.lat + n * 0.01, pos.lon + n * 0.01];
    const color = PIN_COLORS[isIncident(r) ? r.type : r.status[0]] || '#000000';
    let marker;
    if (isIncident(r)) {
      marker = L.marker(latlng, {
        pane: 'statrepPane',
        icon: L.divIcon({
          className: 'cs-incident-icon', iconSize: [16, 16], iconAnchor: [8, 8],
          html: `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="${color}"
                   fill-opacity="0.4" stroke="${color}" stroke-width="3"/></svg>`,
        }),
      });
    } else {
      // Halo size shows the report's scope; the solid dot carries the status colour.
      L.circleMarker(latlng, { pane: 'statrepPane', radius: SCOPE_RADIUS[r.scope] || 3, color, fillColor: color,
        fillOpacity: 0.22, opacity: 0, interactive: false }).addTo(pinLayer);
      marker = L.circleMarker(latlng, { pane: 'statrepPane', radius: 4, color, fillColor: color,
        fillOpacity: 1, opacity: 0, weight: 1, className: 'cs-statrep-dot' });
    }
    marker.on('click', e => { L.DomEvent.stopPropagation(e); onPinClick(e, r, latlng); });
    marker.addTo(pinLayer);
    pinById.set(r.id, { marker, latlng });
  }
}

// "Details" link inside a pin's popup
map.on('popupopen', e => {
  const link = e.popup.getElement()?.querySelector('.cs-pin-details');
  if (link) link.addEventListener('click', ev => { ev.preventDefault(); map.closePopup(); openDetail(Number(link.dataset.id)); });
});

/** Pan to a record's pin and bounce it. */
export function locateRecord(id) {
  const pin = pinById.get(id);
  const rec = cs.records.get(id);
  if (!pin) {
    toast(rec?.grid ? 'That report is hidden by the map pin filters' : 'That report has no grid square', 'warn');
    return;
  }
  map.setView(pin.latlng, Math.max(map.getZoom(), 6), { animate: true });
  setTimeout(() => {
    const el = pin.marker.getElement?.() || pin.marker._path;
    const target = el?.querySelector?.('svg') || el;
    if (!target) return;
    target.classList.remove('cs-bounce');
    void target.getBoundingClientRect();
    target.classList.add('cs-bounce');
  }, 350);
}

// ─── Delivery ─────────────────────────────────────────────────────────────────

/** Acknowledgements and delivery advice for the detail window. */
export function deliveryHtml(r) {
  const acks = r.acks?.length ? `Acknowledged by: <b>${escHtml(r.acks.join(', '))}</b>` : 'No acknowledgements yet.';
  if (r.source !== 'sent') return `<div class="cs-acks">${acks}</div>`;
  const d = deliveryState(r);
  const sent = `Sent ${escHtml(fmtShort(r.lastTx || r.utc))} UTC${r.resends ? ` · resent ${r.resends}×` : ''}.`;
  const advice = d?.state === 'overdue'
    ? `<div class="cs-dlv-advice">No acknowledgement after ${d.minutes} minutes. Conditions may be poor:
         consider <b>Resend</b>, a slower speed, or a shorter message.</div>` : '';
  const hearing = recentlyHearingMe();
  const heard = hearing.length ? `<div class="cs-hint">Reported hearing you in the last 30 min: ${escHtml(hearing.join(', '))}</div>` : '';
  return `<div class="cs-acks">${sent} ${acks}</div>${advice}${heard}`;
}

// ─── Detail window ────────────────────────────────────────────────────────────

export function openDetail(id) {
  const r = cs.records.get(id);
  if (!r) return;
  const st = statusOf(r);
  const tiles = st.map((v, i) => `
      <div class="cs-tile cs-st-${escHtml(v)}"><span>${STATUS_LABELS[i]}</span><b>${STATUS_NAMES[v] || 'Unknown'}</b></div>`).join('');
  const [, srcTip] = sourceCell(r);
  const info = [
    ['From', r.from + (r.forwardedBy ? ` (forwarded by ${r.forwardedBy})` : '')],
    ['To', r.target || '—'],
    ['Date (UTC)', fmtFull(r.utc)],
    ['Frequency', r.freq ? `${fmtMHz(r.freq)} MHz` : '—'],
    ['Grid', (r.grid || '—') + (r.gridFromStation ? ' (station\'s grid)' : '')],
    [isIncident(r) ? 'Type' : 'Scope', isIncident(r) ? INCIDENT_TYPES[r.type] + (r.pinned ? ' · pinned' : '') : (SCOPES[r.scope] || '—')],
    ['ID', r.srId || '—'],
    ['Source', srcTip],
  ];
  const canAck = !isMe(r.from) && r.source === 'rf' && r.srId;
  const blocker = transmitBlocker();
  const dlg = openDialog({
    title: `${isIncident(r) ? `Incident (${INCIDENT_TYPES[r.type]})` : 'Status Report'} — ${r.from}`,
    width: 640,
    body: `
      <div class="cs-info">${info.map(([k, v]) => `<div><span>${k}</span><b>${escHtml(v)}</b></div>`).join('')}</div>
      ${isIncident(r) ? '' : `<div class="cs-tiles">${tiles}</div>`}
      <div class="cs-remarks-box">${lines(r.remarks).filter(Boolean).map(escHtml).join('<br>') || '<i>No remarks</i>'}</div>
      ${deliveryHtml(r)}`,
    buttons: [
      { label: 'Close', color: 'gray' },
      { label: 'Delete', color: 'red', action: async () => {
        if (!await confirmDialog({ title: 'Delete record', html: '<p>Delete this record from the map? Other stations keep their copies.</p>',
          yes: 'Delete', yesColor: 'red' })) return false;
        await request({ type: 'CS_DELETE', id: r.id });
      } },
      ...(stationData.has(r.from) ? [{ label: 'Station', color: 'green', action: () => selectStation(r.from) }] : []),
      { label: 'Show on Map', color: 'cyan', action: () => locateRecord(r.id) },
      ...(r.source === 'sent' && r.wire ? [{ label: 'Resend', color: 'blue', id: 'resend', disabled: !!blocker,
        title: blocker || 'Send the same report again (same ID, so stations that already have it ignore the repeat)',
        action: async () => { if (!await confirmAndResend(r)) return false; } }] : []),
      ...(isDraft(r) ? [{ label: 'Edit / Send', color: 'blue', id: 'edit', title: 'Reopen this saved draft to change or transmit it',
        action: () => { openDraft(r); } }] : []),
      ...(canAck ? [{ label: 'Acknowledge', color: 'blue', disabled: !!blocker, title: blocker || 'Send an RRSR acknowledgement',
        action: async () => {
          const res = await confirmAndSend('ack', { target: r.target, call: r.from, srId: r.srId, speed: settings.speed });
          if (!res) return false;
        } }] : []),
    ],
  });
  return dlg;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

export function initStatReps() {
  const table = document.getElementById('cs-statrep-table');
  table.querySelector('thead').innerHTML = `<tr>${COLUMNS.map((c, i) =>
    i === COLUMNS.length - 1
      ? `<th class="cs-th-remarks"><span>Remarks</span><span id="cs-statrep-count"></span></th>`
      : `<th${i >= 8 && i < 20 ? ' class="cs-th-st"' : i === 20 ? ' class="cs-th-dlv" title="Acknowledgements of reports you sent"' : ''}>${c}</th>`).join('')}</tr>`;

  table.querySelector('tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    e.preventDefault();
    const id = Number(tr.dataset.id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    const r = cs.records.get(id);
    if (act === 'locate') locateRecord(id);
    else if (act === 'from' && r && stationData.has(r.from)) selectStation(r.from);
    else openDetail(id);
  });

  on('reset', scheduleRender);
  on('remove', scheduleRender);
  on('settings', scheduleRender);
  on('record', ({ record, isNew }) => {
    if (record.kind !== 'statrep' && record.kind !== 'incident') return;
    scheduleRender();
    if (isNew && record.source === 'rf') playSound('statrep');
  });
  // Date filters such as "since midnight" move on with the clock.
  setInterval(scheduleRender, 60_000);
  render();
}
