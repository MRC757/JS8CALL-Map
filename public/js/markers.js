// Station markers: SNR colour, age fading, "hears you" ring, and fanning out
// of stations that share a grid square.

import { map } from './map.js';
import { state, stationData, isHomeCall, currentHeardMe } from './state.js';
import { snrClass, escHtml, ageOpacity } from './util.js';
import { selectStation } from './selection.js';
import { handleMeasureClick } from './measure.js';

const { gridToLatLon, spreadOffsets } = globalThis.Grid;

const stationMarkers = new Map();   // callsign → L.Marker
// Stations in the same grid square share one centre point; markers at the same
// point are fanned out by a few pixels so each stays visible and clickable.
const markerPosKey  = new Map();    // callsign → "lat,lon"
const posGroups     = new Map();    // "lat,lon" → Set of callsigns
const markerOffsets = new Map();    // callsign → [dx, dy] px

export const getMarker = cs => stationMarkers.get(cs);

function markerIcon(station) {
  const isHome = isHomeCall(station.callsign);
  const size   = isHome ? 14 : 12;
  const cls    = ['station-marker', isHome ? 'my-station' : snrClass(station.snr)];
  if (station.callsign === state.selectedCall)  cls.push('selected');
  if (!isHome && currentHeardMe(station))       cls.push('hears-me');
  const [dx, dy] = markerOffsets.get(station.callsign) || [0, 0];
  return L.divIcon({
    className: '',
    html: `<div class="${cls.join(' ')}" style="width:${size}px;height:${size}px;"
               title="${escHtml(station.callsign)}"></div>`,
    iconSize:      [size, size],
    iconAnchor:    [size / 2 - dx, size / 2 - dy],
    tooltipAnchor: [dx, dy],
  });
}

/** Fade by time since last heard; your own and the selected station stay solid. */
function markerOpacity(station, now = Date.now()) {
  if (isHomeCall(station.callsign) || station.callsign === state.selectedCall) return 1;
  return ageOpacity(now - (station.lastHeard || now), state.ttlMs);
}

function relayoutGroup(key) {
  const group = posGroups.get(key);
  if (!group) return;
  // Home first (nearest the true centre), then alphabetical for stability.
  const calls   = [...group].sort((a, b) => (isHomeCall(b) - isHomeCall(a)) || a.localeCompare(b));
  const offsets = spreadOffsets(calls.length);
  calls.forEach((cs, i) => {
    const prev = markerOffsets.get(cs);
    const next = offsets[i];
    if (prev && prev[0] === next[0] && prev[1] === next[1]) return;
    markerOffsets.set(cs, next);
    refreshMarker(cs);
  });
}

function leaveGroup(cs) {
  const key = markerPosKey.get(cs);
  if (!key) return;
  markerPosKey.delete(cs);
  markerOffsets.delete(cs);
  const group = posGroups.get(key);
  if (!group) return;
  group.delete(cs);
  if (group.size) relayoutGroup(key); else posGroups.delete(key);
}

function joinGroup(cs, key) {
  if (markerPosKey.get(cs) === key) return;
  leaveGroup(cs);
  markerPosKey.set(cs, key);
  if (!posGroups.has(key)) posGroups.set(key, new Set());
  posGroups.get(key).add(cs);
  relayoutGroup(key);
}

export function placeOrUpdateMarker(station) {
  const cs  = station.callsign;
  const pos = cs && gridToLatLon(station.grid);
  if (!pos) return;
  const key = pos.lat.toFixed(5) + ',' + pos.lon.toFixed(5);

  let marker = stationMarkers.get(cs);
  if (marker) {
    marker.setLatLng([pos.lat, pos.lon]);
  } else {
    marker = L.marker([pos.lat, pos.lon], { icon: markerIcon(station), title: cs });
    marker.bindTooltip(cs, { permanent: false, direction: 'top', className: 'station-tooltip', offset: [0, -8] });
    marker.on('click', e => {
      if (state.measuring) { handleMeasureClick(e); return; }
      selectStation(cs);
    });
    marker.addTo(map);
    stationMarkers.set(cs, marker);
  }

  joinGroup(cs, key);
  refreshMarker(cs, station);
}

export function refreshMarker(cs, station = stationData.get(cs)) {
  const marker = stationMarkers.get(cs);
  if (!marker || !station) return;
  marker.setIcon(markerIcon(station));
  marker.setZIndexOffset(isHomeCall(cs) ? 1000 : 0);
  marker.setOpacity(markerOpacity(station));
}

/** Re-apply age fading (and expire stale "hears you" rings) on every marker. */
export function refreshAllMarkers() {
  for (const cs of stationMarkers.keys()) refreshMarker(cs);
}

/** Re-layout the fan-out group a station belongs to (e.g. after home changes). */
export function relayoutFor(cs) {
  const key = markerPosKey.get(cs);
  if (key) relayoutGroup(key);
}

export function removeMarker(cs) {
  const marker = stationMarkers.get(cs);
  if (marker) { map.removeLayer(marker); stationMarkers.delete(cs); }
  leaveGroup(cs);
}
