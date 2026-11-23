// US state/county borders and interstate highways, with zoom- and
// viewport-dependent name labels. All data is bundled offline.

import { map, onRestyle } from './map.js';
import { cssVar, escHtml, setToggle } from './util.js';

let usNationLayer, usStatesLayer, usCountiesLayer, usCountyLabels;
let usHighwayLayer, usHighwayLabels;
let usAtlasData = null, usCountyNames = null, usHighwayData = null;
let countiesVisible = false, highwaysVisible = false;

/** Centroid of a polygon's exterior ring (array of [lon,lat]). */
function ringCentroid(ring) {
  let x = 0, y = 0;
  for (const [lon, lat] of ring) { x += lon; y += lat; }
  return [x / ring.length, y / ring.length];
}

/** Midpoint of a LineString (array of [lon,lat]). */
const lineMidpoint = coords => coords[Math.floor(coords.length / 2)];

/** "I105" → "I-105". */
const fmtRoute = r => r.replace(/^I(\d)/, 'I-$1');

const cached = (get, set, url, fallback) => () => {
  if (get()) return Promise.resolve(get());
  return fetch(url).then(r => r.json()).then(d => { set(d); return d; })
    .catch(() => { console.warn(`${url} failed to load`); return fallback; });
};
const loadUsAtlas    = cached(() => usAtlasData,   d => { usAtlasData = d; },   '/us-atlas/counties-10m.json', null);
const loadCountyNames = cached(() => usCountyNames, d => { usCountyNames = d; }, '/data/county_names.json',     {});
const loadHighways   = cached(() => usHighwayData, d => { usHighwayData = d; }, '/data/interstates.geojson',   null);

/**
 * Text labels that only keep the ones inside the current view on the map.
 * There are ~3,200 county labels; adding them all at once is slow.
 * items: [{ lat, lon, text }]
 */
class ViewportLabels {
  constructor(items, className, minZoom) {
    this.items     = items.map(i => ({ ...i, latlng: L.latLng(i.lat, i.lon), marker: null, shown: false }));
    this.className = className;
    this.minZoom   = minZoom;
    this.group     = L.layerGroup().addTo(map);
  }

  update(enabled) {
    const show   = enabled && map.getZoom() >= this.minZoom;
    const bounds = show ? map.getBounds().pad(0.2) : null;
    for (const it of this.items) {
      const want = show && bounds.contains(it.latlng);
      if (want === it.shown) continue;
      if (want) {
        it.marker = it.marker || L.marker(it.latlng, {
          icon: L.divIcon({ className: this.className, html: escHtml(it.text), iconSize: null }),
          interactive: false,
        });
        this.group.addLayer(it.marker);
      } else {
        this.group.removeLayer(it.marker);
      }
      it.shown = want;
    }
  }

  remove() { this.group.remove(); }
}

function updateLabels() {
  if (usCountyLabels)  usCountyLabels.update(countiesVisible);
  if (usHighwayLabels) usHighwayLabels.update(highwaysVisible);
}

function showCounties() {
  if (usNationLayer) return;
  Promise.all([loadUsAtlas(), loadCountyNames()]).then(([us, names]) => {
    if (!us || !countiesVisible || usNationLayer) return;
    usNationLayer = L.geoJSON(topojson.mesh(us, us.objects.nation), {
      style: { color: cssVar('--map-border'), weight: 1.0, fill: false }, interactive: false,
    }).addTo(map);
    usStatesLayer = L.geoJSON(topojson.mesh(us, us.objects.states, (a, b) => a !== b), {
      style: { color: cssVar('--map-border-inner'), weight: 0.8, fill: false }, interactive: false,
    }).addTo(map);
    usCountiesLayer = L.geoJSON(topojson.mesh(us, us.objects.counties, (a, b) => a !== b), {
      style: { color: cssVar('--map-county'), weight: 0.4, fill: false }, interactive: false,
    }).addTo(map);

    const items = [];
    for (const f of topojson.feature(us, us.objects.counties).features) {
      const name = names[f.id];
      if (!name) continue;
      const geom = f.geometry;
      const ring = geom.type === 'Polygon'
        ? geom.coordinates[0]
        : geom.coordinates.reduce((a, b) => b[0].length > a[0].length ? b : a)[0];
      const [lon, lat] = ringCentroid(ring);
      items.push({ lat, lon, text: name });
    }
    usCountyLabels = new ViewportLabels(items, 'us-county-label', 8);
    updateLabels();
  });
}

function hideCounties() {
  for (const l of [usNationLayer, usStatesLayer, usCountiesLayer, usCountyLabels]) if (l) l.remove();
  usNationLayer = usStatesLayer = usCountiesLayer = usCountyLabels = null;
}

function showHighways() {
  if (usHighwayLayer) return;
  loadHighways().then(data => {
    if (!data || !highwaysVisible || usHighwayLayer) return;
    usHighwayLayer = L.geoJSON(data, {
      style: { color: cssVar('--map-highway'), weight: 1.2, fill: false }, interactive: false,
    }).addTo(map);

    const items = [];
    for (const f of data.features) {
      const route = fmtRoute(f.properties.route || '');
      if (!route) continue;
      const coords = f.geometry.type === 'LineString'
        ? f.geometry.coordinates
        : f.geometry.coordinates.reduce((a, b) => b.length > a.length ? b : a);
      const [lon, lat] = lineMidpoint(coords);
      items.push({ lat, lon, text: route });
    }
    usHighwayLabels = new ViewportLabels(items, 'us-highway-label', 7);
    updateLabels();
  });
}

function hideHighways() {
  for (const l of [usHighwayLayer, usHighwayLabels]) if (l) l.remove();
  usHighwayLayer = usHighwayLabels = null;
}

export function initUsOverlays() {
  map.on('moveend', updateLabels);   // also fires after zoom

  onRestyle(() => {
    if (usNationLayer)   usNationLayer.setStyle({ color: cssVar('--map-border') });
    if (usStatesLayer)   usStatesLayer.setStyle({ color: cssVar('--map-border-inner') });
    if (usCountiesLayer) usCountiesLayer.setStyle({ color: cssVar('--map-county') });
    if (usHighwayLayer)  usHighwayLayer.setStyle({ color: cssVar('--map-highway') });
  });

  const cBtn = document.getElementById('btn-us-counties');
  cBtn.addEventListener('click', () => {
    countiesVisible = !countiesVisible;
    setToggle(cBtn, countiesVisible);
    countiesVisible ? showCounties() : hideCounties();
  });

  const hBtn = document.getElementById('btn-us-highways');
  hBtn.addEventListener('click', () => {
    highwaysVisible = !highwaysVisible;
    setToggle(hBtn, highwaysVisible);
    highwaysVisible ? showHighways() : hideHighways();
  });
}
