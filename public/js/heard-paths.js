// "Heard Me" paths: great-circle lines from your station to every station that
// has recently reported your signal, coloured by the SNR they reported.

import { map, onRestyle } from './map.js';
import { state, stationData, isHomeCall, currentHeardMe } from './state.js';
import { snrClass, snrLabel, timeAgo, cssVar, setToggle, escHtml } from './util.js';
import { greatCircleSegments } from './geo.js';

const { gridToLatLon } = globalThis.Grid;

const layer = L.layerGroup();
let visible = false;
let pending = null;

function draw() {
  layer.clearLayers();
  if (!visible) return;
  const home = gridToLatLon(state.myStation.grid);
  if (!home) return;

  for (const s of stationData.values()) {
    const hm  = !isHomeCall(s.callsign) && currentHeardMe(s);
    const pos = hm && gridToLatLon(s.grid);
    if (!pos) continue;
    const color = cssVar('--' + snrClass(hm.snr));
    for (const seg of greatCircleSegments(home.lat, home.lon, pos.lat, pos.lon)) {
      L.polyline(seg, { color, weight: 2, opacity: 0.75, className: 'heard-path' })
        .bindTooltip(`${escHtml(s.callsign)} hears you ${snrLabel(hm.snr)} (${timeAgo(hm.at)})`, { sticky: true })
        .addTo(layer);
    }
  }
}

/** Redraw soon (coalesces bursts of station updates). */
export function scheduleHeardPaths() {
  if (!visible || pending) return;
  pending = setTimeout(() => { pending = null; draw(); }, 250);
}

export const heardPathCount = () => layer.getLayers().length;

export function initHeardPaths() {
  onRestyle(scheduleHeardPaths);
  const btn = document.getElementById('btn-heard-paths');
  btn.addEventListener('click', () => {
    visible = !visible;
    setToggle(btn, visible);
    if (visible) { layer.addTo(map); draw(); }
    else         { layer.clearLayers(); layer.remove(); }
  });
}
