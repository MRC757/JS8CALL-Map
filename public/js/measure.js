// Distance / bearing measurement between two clicked points.

import { map } from './map.js';
import { state } from './state.js';

const { haversineKm, bearingDeg } = globalThis.Grid;

const $ = id => document.getElementById(id);
let points  = [];
let dots    = [];
let line    = null;

function setHint(text) {
  const el = $('measure-hint');
  if (text) { el.textContent = text; el.classList.remove('hidden'); }
  else      { el.classList.add('hidden'); }
}

function clearVisuals() {
  dots.forEach(d => map.removeLayer(d));
  dots = [];
  if (line) { map.removeLayer(line); line = null; }
}

function setMeasureButton(active) {
  const btn = $('btn-measure');
  btn.classList.toggle('active', active);
  btn.textContent = active ? '✕ Cancel' : 'Measure Distance';
  btn.setAttribute('aria-pressed', String(active));
}

function start() {
  state.measuring = true;
  points = [];
  clearVisuals();
  $('map').classList.add('measuring');
  $('measure-result').classList.add('hidden');
  setMeasureButton(true);
  setHint('Click point 1 of 2 on the map');
}

function stop() {
  state.measuring = false;
  $('map').classList.remove('measuring');
  setMeasureButton(false);
  setHint(null);
  // Only offer "Clear" when there is a finished measurement to clear.
  $('btn-clear-measure').style.display = line ? '' : 'none';
}

function clear() {
  clearVisuals();
  stop();
  $('measure-result').classList.add('hidden');
  points = [];
}

export function handleMeasureClick(e) {
  if (!state.measuring) return;
  const { lat, lng } = e.latlng;
  points.push([lat, lng]);
  dots.push(L.circleMarker([lat, lng], {
    radius: 5, color: '#388bfd', fillColor: '#388bfd', fillOpacity: 1, interactive: false, weight: 2,
  }).addTo(map));

  if (points.length === 1) { setHint('Click point 2 of 2 on the map'); return; }

  line = L.polyline(points, { color: '#388bfd', weight: 2, dashArray: '7 5', interactive: false }).addTo(map);
  const [p1, p2] = points;
  const km  = haversineKm(p1[0], p1[1], p2[0], p2[1]);
  const brg = bearingDeg(p1[0], p1[1], p2[0], p2[1]);

  const result = $('measure-result');
  result.innerHTML = `
    <strong>${km.toFixed(1)} km</strong> &nbsp;/&nbsp; ${(km * 0.621371).toFixed(1)} mi
    &nbsp;&nbsp;&#183;&nbsp;&nbsp; Bearing&nbsp;<strong>${brg}&deg;</strong>
    <button class="measure-clear-btn" type="button">Clear</button>`;
  result.querySelector('.measure-clear-btn').addEventListener('click', clear);
  result.classList.remove('hidden');
  stop();
}

export function initMeasure() {
  map.on('click', handleMeasureClick);
  $('btn-measure').addEventListener('click', () => (state.measuring ? stop() : start()));
  $('btn-clear-measure').addEventListener('click', clear);
}
