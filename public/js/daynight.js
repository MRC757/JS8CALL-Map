// Day/night shading and the greyline (civil-twilight) band, refreshed every minute.

import { map } from './map.js';
import { setToggle } from './util.js';
import { nightCoords, greylineCoords } from './sun.js';

const REFRESH_MS = 60_000;

/** A toggleable polygon overlay that recomputes its shape every minute. */
function timedOverlay(buttonId, buildCoords, style) {
  const btn = document.getElementById(buttonId);
  let layer = null;
  let timer = null;

  const update = () => {
    const coords = buildCoords(new Date());
    if (layer) layer.setLatLngs(coords);
    else layer = L.polygon(coords, { interactive: false, ...style }).addTo(map);
  };

  btn.addEventListener('click', () => {
    const on = !layer;
    setToggle(btn, on);
    if (on) {
      update();
      timer = setInterval(update, REFRESH_MS);
    } else {
      clearInterval(timer);
      timer = null;
      layer.remove();
      layer = null;
    }
  });

  return { get layer() { return layer; } };
}

export function initDayNight() {
  const night = timedOverlay('btn-night', nightCoords, {
    color: 'transparent', fillColor: '#000011', fillOpacity: 0.45, className: 'night-overlay',
  });
  const greyline = timedOverlay('btn-greyline', greylineCoords, {
    color: '#e3a008', weight: 1, opacity: 0.6, fillColor: '#f2b705', fillOpacity: 0.28, className: 'greyline-overlay',
  });
  return { night, greyline };
}
