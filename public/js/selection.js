// Selecting a station: sidebar highlight, marker highlight, pan, detail panel.

import { map } from './map.js';
import { state, stationData, newMsgPending } from './state.js';
import { refreshMarker } from './markers.js';
import { markSelected } from './sidebar.js';
import { renderDetailPanel, hideDetailPanel } from './detail.js';

const { gridToLatLon } = globalThis.Grid;

export function selectStation(cs) {
  const prev = state.selectedCall;
  state.selectedCall = cs;
  newMsgPending.delete(cs);
  markSelected(cs);

  if (prev && prev !== cs) refreshMarker(prev);
  refreshMarker(cs);

  const station = stationData.get(cs);
  if (!station) return;
  const pos = gridToLatLon(station.grid);
  if (pos) map.panTo([pos.lat, pos.lon], { animate: true });
  renderDetailPanel(station);
}

export function clearSelection() {
  const prev = state.selectedCall;
  state.selectedCall = null;
  hideDetailPanel();
  markSelected(null);
  if (prev) refreshMarker(prev);
}

export function initSelection() {
  document.getElementById('detail-close').addEventListener('click', clearSelection);
}
