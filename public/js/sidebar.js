// Station list sidebar — partial DOM updates to avoid full rebuilds on every tick.

import { state, stationData, newMsgPending, isHomeCall, currentHeardMe } from './state.js';
import { snrClass, snrLabel, timeAgo, escHtml } from './util.js';
import { selectStation } from './selection.js';

const listEl = () => document.getElementById('station-list');
const itemEl = cs => document.querySelector(`.station-item[data-callsign="${CSS.escape(cs)}"]`);

function hearsBadgeHtml(station) {
  const hm = !isHomeCall(station.callsign) && currentHeardMe(station);
  if (!hm) return '';
  return `<span class="hears-badge ${snrClass(hm.snr)}" title="${escHtml(station.callsign)} reported your signal at ${snrLabel(hm.snr)}, ${timeAgo(hm.at)}">hears you ${snrLabel(hm.snr)}</span>`;
}

let rebuildTimer = null;

/** Update the mutable parts of an existing item, or schedule a rebuild if it's new. */
export function patchSidebarItem(station) {
  const el = itemEl(station.callsign);
  if (!el) { scheduleSidebarRebuild(); return; }

  const badge = el.querySelector('.snr-badge');
  if (badge) {
    badge.className   = `snr-badge ${snrClass(station.snr)}`;
    badge.textContent = snrLabel(station.snr);
  }
  const grid = el.querySelector('.station-grid');
  if (grid) grid.textContent = station.grid || '—';
  const hears = el.querySelector('.station-hears');
  if (hears) hears.innerHTML = hearsBadgeHtml(station);
  const age = el.querySelector('.station-age');
  if (age) age.textContent = timeAgo(station.lastHeard);
}

/** Debounce full rebuilds — at most once per 400 ms. */
export function scheduleSidebarRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuildSidebar(); }, 400);
}

export function rebuildSidebar() {
  document.getElementById('station-count').textContent = stationData.size;
  const sorted = [...stationData.values()].sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0));
  listEl().innerHTML = sorted.map(s => `
      <div class="station-item${s.callsign === state.selectedCall ? ' selected' : ''}${newMsgPending.has(s.callsign) ? ' has-new-msg' : ''}"
           data-callsign="${escHtml(s.callsign)}" role="listitem" tabindex="0">
        <div class="station-callsign">${escHtml(s.callsign)}</div>
        <div class="station-meta">
          <span class="station-grid">${escHtml(s.grid || '—')}</span>
          <span class="snr-badge ${snrClass(s.snr)}">${snrLabel(s.snr)}</span>
        </div>
        <div class="station-hears">${hearsBadgeHtml(s)}</div>
        <div class="station-age">${timeAgo(s.lastHeard)}</div>
      </div>`).join('');
}

export function markSelected(cs) {
  document.querySelectorAll('.station-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.callsign === cs);
    if (el.dataset.callsign === cs) el.classList.remove('has-new-msg');
  });
}

export function markUnread(cs) {
  const el = itemEl(cs);
  if (el) el.classList.add('has-new-msg');
}

/** Refresh ages and "hears you" badges without a rebuild. */
export function refreshSidebarAges() {
  document.querySelectorAll('.station-item').forEach(el => {
    const station = stationData.get(el.dataset.callsign);
    if (!station) return;
    el.querySelector('.station-age').textContent = timeAgo(station.lastHeard);
    el.querySelector('.station-hears').innerHTML = hearsBadgeHtml(station);
  });
}

export function initSidebar() {
  const list = listEl();
  list.addEventListener('click', e => {
    const item = e.target.closest('.station-item');
    if (item && item.dataset.callsign) selectStation(item.dataset.callsign);
  });
  list.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.station-item');
    if (item && item.dataset.callsign) { e.preventDefault(); selectStation(item.dataset.callsign); }
  });

  const toggle = visible => {
    document.getElementById('sidebar').style.display            = visible ? '' : 'none';
    document.getElementById('btn-expand-sidebar').style.display = visible ? 'none' : '';
    document.getElementById('btn-collapse-sidebar').setAttribute('aria-expanded', String(visible));
    window.dispatchEvent(new Event('resize'));   // Leaflet re-measures the map
  };
  document.getElementById('btn-collapse-sidebar').addEventListener('click', () => toggle(false));
  document.getElementById('btn-expand-sidebar').addEventListener('click',   () => toggle(true));
}
