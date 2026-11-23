// Station detail panel. Built once per selection; later updates patch the stats
// and insert new message rows so the message list keeps its scroll position.

import { state, isHomeCall, currentHeardMe } from './state.js';
import { snrClass, snrLabel, timeAgo, formatUTC, escHtml } from './util.js';

const { gridToLatLon, haversineKm, bearingDeg } = globalThis.Grid;

const $ = id => document.getElementById(id);

function gridRowHtml(station) {
  return `
      <span>Grid: <strong>${escHtml(station.grid || '—')}</strong></span>
      <a class="qrz-link" href="https://www.qrz.com/db/${encodeURIComponent(station.callsign)}"
         target="_blank" rel="noopener noreferrer">QRZ &#8599;</a>`;
}

const stat = (label, value, cls = '', id = '') => `
      <div class="detail-stat">
        <div class="detail-stat-label">${label}</div>
        <div class="detail-stat-value ${cls}"${id ? ` id="${id}"` : ''}>${value}</div>
      </div>`;

function statsHtml(station) {
  let html = stat('SNR', snrLabel(station.snr), snrClass(station.snr))
           + stat('Last Heard', timeAgo(station.lastHeard), '', 'detail-last-heard')
           + stat('Dial Frequency', station.freq ? (station.freq / 1e6).toFixed(4) + ' MHz' : '—')
           + stat('Audio Offset', station.offset ? station.offset + ' Hz' : '—');

  if (!isHomeCall(station.callsign)) {
    const hm = currentHeardMe(station);
    html += stat('Hears You', hm ? `${snrLabel(hm.snr)}<small><br>${timeAgo(hm.at)}</small>` : '—',
                 hm ? snrClass(hm.snr) : '', 'detail-hears-you');
  }

  const me = state.myStation;
  if (me.grid && station.grid && !isHomeCall(station.callsign)) {
    const a = gridToLatLon(me.grid);
    const b = gridToLatLon(station.grid);
    if (a && b) {
      const km = Math.round(haversineKm(a.lat, a.lon, b.lat, b.lon));
      html += stat('Distance', `${km.toLocaleString()} km<small><br>${Math.round(km * 0.621371).toLocaleString()} mi</small>`)
            + stat('Bearing', `${bearingDeg(a.lat, a.lon, b.lat, b.lon)}°`);
    }
  }
  return html;
}

function messageHtml(m) {
  const toMe = m.to && m.to === state.myStation.callsign;
  return `
        <div class="message-item${toMe ? ' to-me' : ''}">
          <div class="message-header">
            <span class="kind-badge kind-${escHtml(m.kind || 'activity')}">${escHtml(m.kind || 'rx')}</span>
            <span class="message-time">${formatUTC(m.utc)}</span>
            ${m.to ? `<span class="message-to">&#8594; ${escHtml(m.to)}${toMe ? ' (you)' : ''}</span>` : ''}
          </div>
          <div class="message-text">${escHtml(m.text)}</div>
        </div>`;
}

const NO_MESSAGES_HTML = '<div class="no-messages">No messages recorded yet</div>';

/** Full render — used when a station is selected. */
export function renderDetailPanel(station) {
  const msgs = station.messages || [];
  const content = $('detail-content');
  content.innerHTML = `
    <div class="detail-callsign">${escHtml(station.callsign)}</div>
    <div class="detail-grid-row" id="detail-grid-row">${gridRowHtml(station)}</div>
    <div class="detail-stats" id="detail-stats">${statsHtml(station)}</div>
    <div class="detail-messages-header">
      <span>Messages</span><span id="detail-msg-count">${msgs.length}</span>
    </div>
    <div id="detail-messages">${msgs.length ? msgs.map(messageHtml).join('') : NO_MESSAGES_HTML}</div>`;
  content.scrollTop = 0;
  $('detail-panel').classList.remove('hidden');
}

/** Patch stats in place after a STATION_UPDATE. */
export function updateDetailStats(station) {
  const row = $('detail-grid-row');
  const stats = $('detail-stats');
  if (!row || !stats) return renderDetailPanel(station);
  row.innerHTML   = gridRowHtml(station);
  stats.innerHTML = statsHtml(station);
}

/** Insert one message row at `index` (newest-first order) without re-rendering. */
export function insertDetailMessage(station, index) {
  const list    = $('detail-messages');
  const content = $('detail-content');
  if (!list) return renderDetailPanel(station);

  // If the user has scrolled down, hold the first visible row in place.
  let anchor = null, anchorTop = 0;
  if (content.scrollTop > 0) {
    const viewTop = content.getBoundingClientRect().top;
    anchor = [...list.children].find(el => el.getBoundingClientRect().bottom > viewTop) || null;
    if (anchor) anchorTop = anchor.getBoundingClientRect().top;
  }

  list.querySelector('.no-messages')?.remove();
  const tpl = document.createElement('template');
  tpl.innerHTML = messageHtml(station.messages[index]).trim();
  const row = tpl.content.firstElementChild;
  list.insertBefore(row, list.children[index] || null);
  while (list.children.length > state.maxMessages) list.lastElementChild.remove();

  if (anchor && anchor.isConnected) content.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  $('detail-msg-count').textContent = station.messages.length;
}

export function hideDetailPanel() {
  $('detail-panel').classList.add('hidden');
}
