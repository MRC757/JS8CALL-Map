'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  Maidenhead Grid Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert a Maidenhead locator to a {lat, lon} centre point. */
function gridToLatLon(grid) {
  if (!grid || grid.length < 4) return null;
  grid = grid.toUpperCase();
  const A = 65;

  let lon = (grid.charCodeAt(0) - A) * 20 - 180;
  let lat = (grid.charCodeAt(1) - A) * 10 - 90;
  lon += (grid.charCodeAt(2) - 48) * 2;
  lat += (grid.charCodeAt(3) - 48);

  if (grid.length >= 6) {
    lon += (grid.charCodeAt(4) - A) * (5 / 60) + (2.5 / 60);
    lat += (grid.charCodeAt(5) - A) * (2.5 / 60) + (1.25 / 60);
  } else {
    lon += 1;    // centre of 2° square
    lat += 0.5;  // centre of 1° square
  }

  return { lat, lon };
}

/** Convert {lat, lon} to a Maidenhead locator string. precision: 2, 4, or 6. */
function latLonToGrid(lat, lon, precision = 4) {
  const A = 65;
  let lo = Math.max(0, Math.min(360, lon + 180));
  let la = Math.max(0, Math.min(180, lat + 90));

  const fLon = Math.min(Math.floor(lo / 20), 17);
  const fLat = Math.min(Math.floor(la / 10), 17);

  if (precision <= 2) {
    return String.fromCharCode(A + fLon) + String.fromCharCode(A + fLat);
  }

  lo -= fLon * 20;
  la -= fLat * 10;

  const sLon = Math.min(Math.floor(lo / 2), 9);
  const sLat = Math.min(Math.floor(la),     9);

  let g = String.fromCharCode(A + fLon) + String.fromCharCode(A + fLat)
        + sLon + sLat;

  if (precision >= 6) {
    lo -= sLon * 2;
    la -= sLat;
    const ssLon = Math.min(Math.floor(lo * 12), 23);
    const ssLat = Math.min(Math.floor(la * 24), 23);
    g += String.fromCharCode(A + ssLon) + String.fromCharCode(A + ssLat);
  }

  return g;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Geo / Signal Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function haversineKm(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y    = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x    = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
             - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
}

/** Return a CSS class name for the given SNR value. */
function snrClass(snr) {
  if (snr === undefined || snr === null) return 'snr-unknown';
  if (snr >= 0)   return 'snr-strong';
  if (snr >= -10) return 'snr-good';
  if (snr >= -20) return 'snr-fair';
  if (snr >= -30) return 'snr-weak';
  return 'snr-vweak';
}

function snrLabel(snr) {
  if (snr === undefined || snr === null) return '—';
  return (snr > 0 ? '+' : '') + snr + ' dB';
}

function formatUTC(utc) {
  if (!utc) return '—';
  const d = new Date(typeof utc === 'number' && utc < 1e12 ? utc * 1000 : utc);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000)    return Math.floor(diff / 1000) + 's ago';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  return Math.floor(diff / 3_600_000) + 'h ago';
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Map Initialisation
// ═══════════════════════════════════════════════════════════════════════════════

const map = L.map('map', {
  center:      [39, -98],
  zoom:        4,
  zoomControl: true,
});
map.zoomControl.setPosition('bottomright');
map.on('zoomend', updateOverlayLabels);

// Offline world basemap — rendered from locally-bundled TopoJSON (no internet required).
// Ocean colour comes from .leaflet-container background (CSS variable --map-ocean).
let worldLandLayer   = null;
let worldBorderLayer = null;

// US state/county overlay
let usNationLayer    = null;
let usStatesLayer    = null;
let usCountiesLayer  = null;
let usCountyLabels   = null;
let usAtlasData      = null;
let usCountyNames    = null;
let usCountiesVisible = false;

// US interstate highway overlay
let usHighwayLayer   = null;
let usHighwayLabels  = null;
let usHighwayData    = null;
let usHighwaysVisible = false;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function updateMapColors() {
  const land        = cssVar('--map-land');
  const border      = cssVar('--map-border');
  const borderInner = cssVar('--map-border-inner');
  const county      = cssVar('--map-county');
  const highway     = cssVar('--map-highway');
  if (worldLandLayer)   worldLandLayer.setStyle({ fillColor: land, color: border });
  if (worldBorderLayer) worldBorderLayer.setStyle({ color: borderInner });
  if (usNationLayer)    usNationLayer.setStyle({ color: border });
  if (usStatesLayer)    usStatesLayer.setStyle({ color: borderInner });
  if (usCountiesLayer)  usCountiesLayer.setStyle({ color: county });
  if (usHighwayLayer)   usHighwayLayer.setStyle({ color: highway });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Centroid of a polygon's exterior ring (array of [lon,lat]). */
function ringCentroid(ring) {
  let x = 0, y = 0;
  for (const [lon, lat] of ring) { x += lon; y += lat; }
  return [x / ring.length, y / ring.length];
}

/** Midpoint of a LineString (array of [lon,lat]). */
function lineMidpoint(coords) {
  return coords[Math.floor(coords.length / 2)];
}

/** Format route code like "I105" → "I-105". */
function fmtRoute(r) {
  return r.replace(/^I(\d)/, 'I-$1');
}

// ── Data loaders ─────────────────────────────────────────────────────────────

function loadUsAtlas() {
  if (usAtlasData) return Promise.resolve(usAtlasData);
  return fetch('/us-atlas/counties-10m.json')
    .then(r => r.json())
    .then(d => { usAtlasData = d; return d; })
    .catch(() => { console.warn('US atlas data failed to load'); return null; });
}

function loadUsCountyNames() {
  if (usCountyNames) return Promise.resolve(usCountyNames);
  return fetch('/data/county_names.json')
    .then(r => r.json())
    .then(d => { usCountyNames = d; return d; })
    .catch(() => { usCountyNames = {}; return {}; });
}

function loadUsHighways() {
  if (usHighwayData) return Promise.resolve(usHighwayData);
  return fetch('/data/interstates.geojson')
    .then(r => r.json())
    .then(d => { usHighwayData = d; return d; })
    .catch(() => { console.warn('Interstate data failed to load'); return null; });
}

// ── Label visibility (zoom-dependent) ────────────────────────────────────────

function updateOverlayLabels() {
  const zoom = map.getZoom();
  if (usCountyLabels) {
    if (usCountiesVisible && zoom >= 8) { if (!map.hasLayer(usCountyLabels))  map.addLayer(usCountyLabels); }
    else                                { if (map.hasLayer(usCountyLabels))   map.removeLayer(usCountyLabels); }
  }
  if (usHighwayLabels) {
    if (usHighwaysVisible && zoom >= 7) { if (!map.hasLayer(usHighwayLabels)) map.addLayer(usHighwayLabels); }
    else                                { if (map.hasLayer(usHighwayLabels))  map.removeLayer(usHighwayLabels); }
  }
}

// ── Show / hide ───────────────────────────────────────────────────────────────

function showUsCounties() {
  if (usNationLayer) return;
  Promise.all([loadUsAtlas(), loadUsCountyNames()]).then(([us, names]) => {
    if (!us || !usCountiesVisible) return;
    usNationLayer = L.geoJSON(topojson.mesh(us, us.objects.nation), {
      style: { color: cssVar('--map-border'), weight: 1.0, fill: false },
      interactive: false,
    }).addTo(map);
    usStatesLayer = L.geoJSON(topojson.mesh(us, us.objects.states, (a, b) => a !== b), {
      style: { color: cssVar('--map-border-inner'), weight: 0.8, fill: false },
      interactive: false,
    }).addTo(map);
    usCountiesLayer = L.geoJSON(topojson.mesh(us, us.objects.counties, (a, b) => a !== b), {
      style: { color: cssVar('--map-county'), weight: 0.4, fill: false },
      interactive: false,
    }).addTo(map);

    // County name labels — one per county polygon, shown at zoom ≥ 8
    const labelGroup = L.layerGroup();
    for (const f of topojson.feature(us, us.objects.counties).features) {
      const name = names[f.id];
      if (!name) continue;
      const geom = f.geometry;
      const ring = geom.type === 'Polygon'
        ? geom.coordinates[0]
        : geom.coordinates.reduce((a, b) => b[0].length > a[0].length ? b : a)[0];
      const [lon, lat] = ringCentroid(ring);
      L.marker([lat, lon], {
        icon: L.divIcon({ className: 'us-county-label', html: name, iconSize: null }),
        interactive: false,
      }).addTo(labelGroup);
    }
    usCountyLabels = labelGroup;
    updateOverlayLabels();
  });
}

function hideUsCounties() {
  if (usNationLayer)    { usNationLayer.remove();                usNationLayer   = null; }
  if (usStatesLayer)    { usStatesLayer.remove();                usStatesLayer   = null; }
  if (usCountiesLayer)  { usCountiesLayer.remove();              usCountiesLayer = null; }
  if (usCountyLabels)   { map.removeLayer(usCountyLabels);       usCountyLabels  = null; }
}

function showUsHighways() {
  if (usHighwayLayer) return;
  loadUsHighways().then(data => {
    if (!data || !usHighwaysVisible) return;
    usHighwayLayer = L.geoJSON(data, {
      style: { color: cssVar('--map-highway'), weight: 1.2, fill: false },
      interactive: false,
    }).addTo(map);

    // Interstate route labels — one per feature segment, shown at zoom ≥ 7
    const labelGroup = L.layerGroup();
    for (const f of data.features) {
      const route = fmtRoute(f.properties.route || '');
      if (!route) continue;
      const coords = f.geometry.type === 'LineString'
        ? f.geometry.coordinates
        : f.geometry.coordinates.reduce((a, b) => b.length > a.length ? b : a);
      const [lon, lat] = lineMidpoint(coords);
      L.marker([lat, lon], {
        icon: L.divIcon({ className: 'us-highway-label', html: route, iconSize: null }),
        interactive: false,
      }).addTo(labelGroup);
    }
    usHighwayLabels = labelGroup;
    updateOverlayLabels();
  });
}

function hideUsHighways() {
  if (usHighwayLayer)  { usHighwayLayer.remove();               usHighwayLayer  = null; }
  if (usHighwayLabels) { map.removeLayer(usHighwayLabels);      usHighwayLabels = null; }
}

fetch('/world-atlas/countries-110m.json')
  .then(r => r.json())
  .then(world => {
    worldLandLayer = L.geoJSON(topojson.feature(world, world.objects.countries), {
      style:       { fillColor: cssVar('--map-land'), fillOpacity: 1, color: cssVar('--map-border'), weight: 0.5 },
      interactive: false,
    }).addTo(map);
    worldBorderLayer = L.geoJSON(topojson.mesh(world, world.objects.countries, (a, b) => a !== b), {
      style:       { color: cssVar('--map-border-inner'), weight: 0.6, fill: false },
      interactive: false,
    }).addTo(map);
  })
  .catch(() => console.warn('World basemap failed to load'));

// ═══════════════════════════════════════════════════════════════════════════════
//  Maidenhead Grid — Polyline layer (fields & squares, zoom < 9)
// ═══════════════════════════════════════════════════════════════════════════════

const gridPolyLayer = L.layerGroup().addTo(map);
let   gridVisible   = true;

function redrawPolyGrid() {
  gridPolyLayer.clearLayers();
  if (!gridVisible) return;

  const zoom = map.getZoom();
  if (zoom >= 9) return;  // subsquares handled by the canvas layer below

  const bounds = map.getBounds().pad(0.05);

  let lonStep, latStep, labelPrecision, showLabels;
  if (zoom < 5) {
    lonStep = 20; latStep = 10; labelPrecision = 2; showLabels = true;
  } else {
    lonStep = 2;  latStep = 1;  labelPrecision = 4; showLabels = zoom >= 6;
  }

  const minLon = Math.floor(bounds.getWest()  / lonStep) * lonStep;
  const maxLon = Math.ceil(bounds.getEast()   / lonStep) * lonStep;
  const minLat = Math.floor(bounds.getSouth() / latStep) * latStep;
  const maxLat = Math.ceil(bounds.getNorth()  / latStep) * latStep;

  const squareOpts = { color: cssVar('--grid-dim'),    weight: 0.7, interactive: false };
  const fieldOpts  = { color: cssVar('--grid-bright'), weight: 1.5, interactive: false };

  function isFieldEdge(v, step, fieldStep) {
    return step < fieldStep && Math.abs(v % fieldStep) < step * 0.01;
  }

  for (let lon = minLon; lon <= maxLon; lon += lonStep) {
    L.polyline(
      [[Math.max(minLat, -90), lon], [Math.min(maxLat, 90), lon]],
      isFieldEdge(lon + 180, lonStep, 20) ? fieldOpts : squareOpts
    ).addTo(gridPolyLayer);
  }

  for (let lat = minLat; lat <= maxLat; lat += latStep) {
    L.polyline(
      [[lat, Math.max(minLon, -180)], [lat, Math.min(maxLon, 180)]],
      isFieldEdge(lat + 90, latStep, 10) ? fieldOpts : squareOpts
    ).addTo(gridPolyLayer);
  }

  if (showLabels) {
    const isField = labelPrecision === 2;
    for (let lon = minLon; lon < maxLon; lon += lonStep) {
      for (let lat = minLat; lat < maxLat; lat += latStep) {
        const cLat = lat + latStep / 2;
        const cLon = lon + lonStep / 2;
        if (cLat > 90 || cLat < -90) continue;
        const label = latLonToGrid(cLat, cLon, labelPrecision);
        L.marker([cLat, cLon], {
          icon: L.divIcon({
            className: isField ? 'grid-label grid-label-field' : 'grid-label',
            html:       label,
            iconSize:   [0, 0],
            iconAnchor: [0, 0],
          }),
          interactive: false,
        }).addTo(gridPolyLayer);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Maidenhead Grid — Canvas layer (subsquares, zoom >= 9)
//
//  Drawing hundreds of Leaflet polylines at high zoom is slow.
//  A single canvas pass renders thousands of lines in one GPU call.
// ═══════════════════════════════════════════════════════════════════════════════

const CanvasGridLayer = L.Layer.extend({
  onAdd(map) {
    this._map    = map;
    this._canvas = document.createElement('canvas');
    Object.assign(this._canvas.style, {
      position:       'absolute',
      top:            '0',
      left:           '0',
      pointerEvents:  'none',
      zIndex:         '250',
    });
    map.getContainer().appendChild(this._canvas);
    this._onUpdate = this._update.bind(this);
    map.on('moveend zoomend resize', this._onUpdate);
    this._update();
  },

  onRemove(map) {
    this._canvas.remove();
    map.off('moveend zoomend resize', this._onUpdate);
  },

  _update() {
    const size = this._map.getSize();
    this._canvas.width  = size.x;
    this._canvas.height = size.y;
    this._draw();
  },

  _draw() {
    const map  = this._map;
    const ctx  = this._canvas.getContext('2d');
    const size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);

    if (!gridVisible || map.getZoom() < 9) return;

    const lonStep = 5 / 60;    // 5 arcmin
    const latStep = 2.5 / 60;  // 2.5 arcmin
    const bounds  = map.getBounds().pad(0.05);

    const minLon = Math.floor(bounds.getWest()  / lonStep) * lonStep;
    const maxLon = Math.ceil(bounds.getEast()   / lonStep) * lonStep;
    const minLat = Math.floor(bounds.getSouth() / latStep) * latStep;
    const maxLat = Math.ceil(bounds.getNorth()  / latStep) * latStep;

    ctx.strokeStyle = cssVar('--grid-canvas');
    ctx.lineWidth   = 0.7;
    ctx.beginPath();

    for (let lon = minLon; lon <= maxLon; lon += lonStep) {
      const p1 = map.latLngToContainerPoint([maxLat, lon]);
      const p2 = map.latLngToContainerPoint([minLat, lon]);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }

    for (let lat = minLat; lat <= maxLat; lat += latStep) {
      const p1 = map.latLngToContainerPoint([lat, minLon]);
      const p2 = map.latLngToContainerPoint([lat, maxLon]);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }

    ctx.stroke();
  },

  clear() {
    if (!this._canvas) return;
    const ctx = this._canvas.getContext('2d');
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  },
});

const canvasGrid = new CanvasGridLayer();
canvasGrid.addTo(map);

function redrawGrid() {
  redrawPolyGrid();
  canvasGrid._draw();
}

map.on('moveend zoomend', redrawGrid);
redrawGrid();

// ═══════════════════════════════════════════════════════════════════════════════
//  Station State
// ═══════════════════════════════════════════════════════════════════════════════

const stationData    = new Map();   // callsign → full station object (inc messages)
const stationMarkers = new Map();   // callsign → L.Marker
const newMsgPending  = new Set();   // callsigns with unread messages
let   myStation      = { callsign: '', grid: '' };
let   selectedCall   = null;
let   mapCentred     = false;
let   maxMessages    = 100;         // updated from server SNAPSHOT

// ═══════════════════════════════════════════════════════════════════════════════
//  Station Markers
// ═══════════════════════════════════════════════════════════════════════════════

function markerIcon(station, isHome = false) {
  const sc   = isHome ? '' : snrClass(station.snr);
  const size = isHome ? 14 : 12;
  const sel  = station.callsign === selectedCall ? ' selected' : '';
  const home = isHome ? ' my-station' : '';
  return L.divIcon({
    className: '',
    html: `<div class="station-marker ${sc}${home}${sel}"
               style="width:${size}px;height:${size}px;"
               title="${escHtml(station.callsign)}"></div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function placeOrUpdateMarker(station, isHome = false) {
  if (!station.grid) return;
  const pos = gridToLatLon(station.grid);
  if (!pos) return;

  const existing = stationMarkers.get(station.callsign);
  if (existing) {
    existing.setLatLng([pos.lat, pos.lon]);
    existing.setIcon(markerIcon(station, isHome));
    return;
  }

  const marker = L.marker([pos.lat, pos.lon], {
    icon:        markerIcon(station, isHome),
    title:       station.callsign,
    zIndexOffset: isHome ? 1000 : 0,
  });

  marker.bindTooltip(station.callsign, {
    permanent:  false,
    direction:  'top',
    className:  'station-tooltip',
    offset:     [0, -8],
  });

  marker.on('click', e => {
    if (measuring) { handleMeasureClick(e); return; }
    selectStation(station.callsign);
  });

  marker.addTo(map);
  stationMarkers.set(station.callsign, marker);
}

function refreshMarker(callsign) {
  const marker  = stationMarkers.get(callsign);
  const station = stationData.get(callsign);
  if (!marker || !station) return;
  marker.setIcon(markerIcon(station, callsign === myStation.callsign));
}

function removeMarker(callsign) {
  const marker = stationMarkers.get(callsign);
  if (marker) { map.removeLayer(marker); stationMarkers.delete(callsign); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Sidebar — partial DOM updates to avoid full rebuilds on every tick
// ═══════════════════════════════════════════════════════════════════════════════

let sidebarRebuildTimer = null;

/**
 * Update just the mutable parts of an existing sidebar item in-place.
 * If the item doesn't exist yet, schedule a full rebuild instead.
 */
function patchSidebarItem(station) {
  const el = document.querySelector(
    `.station-item[data-callsign="${CSS.escape(station.callsign)}"]`
  );
  if (!el) {
    scheduleSidebarRebuild();
    return;
  }

  // SNR badge
  const badge = el.querySelector('.snr-badge');
  if (badge) {
    badge.className   = `snr-badge ${snrClass(station.snr)}`;
    badge.textContent = snrLabel(station.snr);
  }

  // Age
  const age = el.querySelector('.station-age');
  if (age) age.textContent = timeAgo(station.lastHeard);
}

/** Debounce full sidebar rebuilds — at most once per 400 ms. */
function scheduleSidebarRebuild() {
  if (sidebarRebuildTimer) return;
  sidebarRebuildTimer = setTimeout(() => {
    sidebarRebuildTimer = null;
    rebuildSidebar();
  }, 400);
}

function rebuildSidebar() {
  const list = document.getElementById('station-list');
  document.getElementById('station-count').textContent = stationData.size;

  const sorted = [...stationData.values()]
    .sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0));

  list.innerHTML = sorted.map(s => {
    const isSelected = s.callsign === selectedCall;
    const hasNew     = newMsgPending.has(s.callsign);
    return `
      <div class="station-item${isSelected ? ' selected' : ''}${hasNew ? ' has-new-msg' : ''}"
           data-callsign="${escHtml(s.callsign)}"
           role="listitem"
           tabindex="0">
        <div class="station-callsign">${escHtml(s.callsign)}</div>
        <div class="station-meta">
          <span>${escHtml(s.grid || '—')}</span>
          <span class="snr-badge ${snrClass(s.snr)}">${snrLabel(s.snr)}</span>
        </div>
        <div class="station-age">${timeAgo(s.lastHeard)}</div>
      </div>`;
  }).join('');
}

// ── Sidebar event delegation ──────────────────────────────────────────────────
const stationListEl = document.getElementById('station-list');

stationListEl.addEventListener('click', e => {
  const item = e.target.closest('.station-item');
  if (item && item.dataset.callsign) selectStation(item.dataset.callsign);
});

stationListEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const item = e.target.closest('.station-item');
  if (item && item.dataset.callsign) {
    e.preventDefault();
    selectStation(item.dataset.callsign);
  }
});

// Refresh age labels in the sidebar every 30 s without a full rebuild.
// Skipped when the browser tab is hidden to avoid pointless DOM work.
setInterval(() => {
  if (document.hidden) return;
  document.querySelectorAll('.station-item').forEach(el => {
    const cs      = el.dataset.callsign;
    const station = stationData.get(cs);
    if (!station) return;
    const age = el.querySelector('.station-age');
    if (age) age.textContent = timeAgo(station.lastHeard);
  });
}, 30_000);

// ═══════════════════════════════════════════════════════════════════════════════
//  Station Selection & Detail Panel
// ═══════════════════════════════════════════════════════════════════════════════

function selectStation(callsign) {
  const prevCall = selectedCall;
  selectedCall   = callsign;
  newMsgPending.delete(callsign);

  // Update sidebar selection classes
  document.querySelectorAll('.station-item').forEach(el => {
    el.classList.toggle('selected',     el.dataset.callsign === callsign);
    if (el.dataset.callsign === callsign) el.classList.remove('has-new-msg');
  });

  // Refresh only the previously selected and newly selected markers — O(1) not O(n)
  if (prevCall && prevCall !== callsign) refreshMarker(prevCall);
  refreshMarker(callsign);

  const station = stationData.get(callsign);
  if (!station) return;

  if (station.grid) {
    const pos = gridToLatLon(station.grid);
    if (pos) map.panTo([pos.lat, pos.lon], { animate: true });
  }

  renderDetailPanel(station);
}

function renderDetailPanel(station) {
  const panel   = document.getElementById('detail-panel');
  const content = document.getElementById('detail-content');

  // Distance and bearing from home
  let distHtml = '';
  if (myStation.grid && station.grid && station.callsign !== myStation.callsign) {
    const myPos = gridToLatLon(myStation.grid);
    const stPos = gridToLatLon(station.grid);
    if (myPos && stPos) {
      const km  = Math.round(haversineKm(myPos.lat, myPos.lon, stPos.lat, stPos.lon));
      const mi  = Math.round(km * 0.621371);
      const brg = bearingDeg(myPos.lat, myPos.lon, stPos.lat, stPos.lon);
      distHtml = `
        <div class="detail-stat">
          <div class="detail-stat-label">Distance</div>
          <div class="detail-stat-value">
            ${km.toLocaleString()} km
            <small><br>${mi.toLocaleString()} mi</small>
          </div>
        </div>
        <div class="detail-stat">
          <div class="detail-stat-label">Bearing</div>
          <div class="detail-stat-value">${brg}°</div>
        </div>`;
    }
  }

  const freqText   = station.freq   ? (station.freq / 1e6).toFixed(4) + ' MHz' : '—';
  const offsetText = station.offset ? station.offset + ' Hz'                   : '—';

  const msgs    = station.messages || [];
  const msgsHtml = msgs.length
    ? msgs.map(m => `
        <div class="message-item">
          <div class="message-header">
            <span class="kind-badge kind-${escHtml(m.kind || 'activity')}">${escHtml(m.kind || 'rx')}</span>
            <span class="message-time">${formatUTC(m.utc)}</span>
            ${m.to ? `<span class="message-to">&#8594; ${escHtml(m.to)}</span>` : ''}
          </div>
          <div class="message-text">${escHtml(m.text)}</div>
        </div>`).join('')
    : '<div class="no-messages">No messages recorded yet</div>';

  content.innerHTML = `
    <div class="detail-callsign">${escHtml(station.callsign)}</div>
    <div class="detail-grid-row">
      <span>Grid: <strong>${escHtml(station.grid || '—')}</strong></span>
      <a class="qrz-link"
         href="https://www.qrz.com/db/${encodeURIComponent(station.callsign)}"
         target="_blank" rel="noopener noreferrer">QRZ &#8599;</a>
    </div>
    <div class="detail-stats">
      <div class="detail-stat">
        <div class="detail-stat-label">SNR</div>
        <div class="detail-stat-value ${snrClass(station.snr)}">${snrLabel(station.snr)}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Last Heard</div>
        <div class="detail-stat-value">${timeAgo(station.lastHeard)}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Dial Frequency</div>
        <div class="detail-stat-value">${freqText}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Audio Offset</div>
        <div class="detail-stat-value">${offsetText}</div>
      </div>
      ${distHtml}
    </div>
    <div class="detail-messages-header">
      <span>Messages</span><span>${msgs.length}</span>
    </div>
    <div id="detail-messages">${msgsHtml}</div>
  `;

  panel.classList.remove('hidden');
}

document.getElementById('detail-close').addEventListener('click', () => {
  const prev = selectedCall;
  selectedCall = null;
  document.getElementById('detail-panel').classList.add('hidden');
  if (prev) refreshMarker(prev);   // only the one that was highlighted
  document.querySelectorAll('.station-item')
    .forEach(el => el.classList.remove('selected'));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Distance Measurement Tool
// ═══════════════════════════════════════════════════════════════════════════════

let measuring      = false;
let measurePoints  = [];
let measureMarkers = [];
let measureLine    = null;

const hintEl = document.getElementById('measure-hint');

function setMeasureHint(text) {
  if (text) { hintEl.textContent = text; hintEl.classList.remove('hidden'); }
  else      { hintEl.classList.add('hidden'); }
}

function startMeasure() {
  measuring     = true;
  measurePoints = [];
  clearMeasureVisuals();
  document.getElementById('map').classList.add('measuring');
  document.getElementById('measure-result').classList.add('hidden');
  document.getElementById('btn-clear-measure').style.display = '';
  document.getElementById('btn-measure').classList.add('active');
  document.getElementById('btn-measure').textContent = '&#10005; Cancel';
  document.getElementById('btn-measure').setAttribute('aria-pressed', 'true');
  setMeasureHint('Click point 1 of 2 on the map');
}

function stopMeasure() {
  measuring = false;
  document.getElementById('map').classList.remove('measuring');
  document.getElementById('btn-measure').classList.remove('active');
  document.getElementById('btn-measure').textContent = 'Measure Distance';
  document.getElementById('btn-measure').setAttribute('aria-pressed', 'false');
  setMeasureHint(null);
}

function clearMeasure() {
  stopMeasure();
  clearMeasureVisuals();
  document.getElementById('measure-result').classList.add('hidden');
  document.getElementById('btn-clear-measure').style.display = 'none';
  measurePoints = [];
}

function clearMeasureVisuals() {
  measureMarkers.forEach(m => map.removeLayer(m));
  measureMarkers = [];
  if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
}

function handleMeasureClick(e) {
  if (!measuring) return;
  const { lat, lng } = e.latlng;
  measurePoints.push([lat, lng]);

  const dot = L.circleMarker([lat, lng], {
    radius: 5, color: '#388bfd', fillColor: '#388bfd',
    fillOpacity: 1, interactive: false, weight: 2,
  }).addTo(map);
  measureMarkers.push(dot);

  if (measurePoints.length === 1) {
    setMeasureHint('Click point 2 of 2 on the map');
    return;
  }

  // Second point — draw line and show result
  if (measureLine) map.removeLayer(measureLine);
  measureLine = L.polyline(measurePoints, {
    color: '#388bfd', weight: 2, dashArray: '7 5', interactive: false,
  }).addTo(map);

  const [p1, p2] = measurePoints;
  const km  = haversineKm(p1[0], p1[1], p2[0], p2[1]);
  const mi  = km * 0.621371;
  const brg = bearingDeg(p1[0], p1[1], p2[0], p2[1]);

  const result = document.getElementById('measure-result');
  result.innerHTML = `
    <strong>${km.toFixed(1)} km</strong>
    &nbsp;/&nbsp;
    ${mi.toFixed(1)} mi
    &nbsp;&nbsp;&#183;&nbsp;&nbsp;
    Bearing&nbsp;<strong>${brg}&deg;</strong>
    <button class="measure-clear-btn" onclick="clearMeasure()">Clear</button>
  `;
  result.classList.remove('hidden');
  stopMeasure();
}

map.on('click', handleMeasureClick);

document.getElementById('btn-measure').addEventListener('click', () => {
  if (measuring) { stopMeasure(); } else { startMeasure(); }
});
document.getElementById('btn-clear-measure').addEventListener('click', clearMeasure);

// ═══════════════════════════════════════════════════════════════════════════════
//  Day / Night Overlay
// ═══════════════════════════════════════════════════════════════════════════════

let nightLayer  = null;
let nightVisible = false;
let nightTimer  = null;

/** Julian Day Number for a given Date. */
function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Low-precision solar position (accurate to ~1°).
 * Returns { dec: declination (rad), gha: Greenwich Hour Angle (rad) }.
 */
function sunPosition(date) {
  const D2R = Math.PI / 180;
  const JD  = julianDay(date);
  const n   = JD - 2451545.0;                          // days since J2000.0

  // Geometric mean longitude and mean anomaly (degrees)
  const L   = (280.46 + 0.9856474 * n) % 360;
  const g   = ((357.528 + 0.9856003 * n) % 360) * D2R;

  // Ecliptic longitude and obliquity (degrees → rad)
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;

  // Declination
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));

  // Greenwich Mean Sidereal Time → Greenwich Hour Angle
  const JD0  = Math.floor(JD - 0.5) + 0.5;
  const H    = (JD - JD0) * 24;
  const T0   = (JD0 - 2451545.0) / 36525;
  const gmst = ((6.697374558 + 2400.0513369 * T0 + 1.0027379093 * H) % 24 + 24) % 24;
  const ra   = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / D2R;
  const gha  = ((gmst * 15 - ra) % 360) * D2R;

  return { dec, gha };
}

/**
 * Build the night-side polygon coordinates.
 * Traces the solar terminator then closes around the dark pole.
 */
function buildNightCoords(date) {
  const D2R = Math.PI / 180;
  const { dec, gha } = sunPosition(date);

  const term = [];
  for (let lon = -180; lon <= 180; lon++) {
    const lonRad = lon * D2R;
    const latRad = Math.atan(-Math.cos(lonRad + gha) / Math.tan(dec));
    term.push([latRad / D2R, lon]);
  }

  // Include whichever pole is in darkness
  const pole = dec > 0 ? -90 : 90;
  return [[pole, -180], ...term, [pole, 180]];
}

function updateNightOverlay() {
  const coords = buildNightCoords(new Date());
  if (nightLayer) {
    nightLayer.setLatLngs(coords);
  } else {
    nightLayer = L.polygon(coords, {
      color:       'transparent',
      fillColor:   '#000011',
      fillOpacity: 0.45,
      interactive: false,
      className:   'night-overlay',
    }).addTo(map);
  }
}

document.getElementById('btn-night').addEventListener('click', () => {
  nightVisible = !nightVisible;
  const btn = document.getElementById('btn-night');
  btn.classList.toggle('active', nightVisible);
  btn.setAttribute('aria-pressed', String(nightVisible));

  if (nightVisible) {
    updateNightOverlay();
    nightTimer = setInterval(updateNightOverlay, 60_000);
  } else {
    clearInterval(nightTimer);
    nightTimer = null;
    if (nightLayer) { nightLayer.remove(); nightLayer = null; }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  US State / County Toggle
// ═══════════════════════════════════════════════════════════════════════════════

document.getElementById('btn-us-counties').addEventListener('click', () => {
  usCountiesVisible = !usCountiesVisible;
  const btn = document.getElementById('btn-us-counties');
  btn.classList.toggle('active', usCountiesVisible);
  btn.setAttribute('aria-pressed', String(usCountiesVisible));
  if (usCountiesVisible) { showUsCounties(); }
  else                   { hideUsCounties(); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Interstate Highway Toggle
// ═══════════════════════════════════════════════════════════════════════════════

document.getElementById('btn-us-highways').addEventListener('click', () => {
  usHighwaysVisible = !usHighwaysVisible;
  const btn = document.getElementById('btn-us-highways');
  btn.classList.toggle('active', usHighwaysVisible);
  btn.setAttribute('aria-pressed', String(usHighwaysVisible));
  if (usHighwaysVisible) { showUsHighways(); }
  else                   { hideUsHighways(); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Grid Toggle
// ═══════════════════════════════════════════════════════════════════════════════

document.getElementById('btn-grid').addEventListener('click', () => {
  gridVisible = !gridVisible;
  const btn = document.getElementById('btn-grid');
  btn.classList.toggle('active', gridVisible);
  btn.setAttribute('aria-pressed', String(gridVisible));
  if (gridVisible) { redrawGrid(); }
  else             { gridPolyLayer.clearLayers(); canvasGrid.clear(); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Theme Switcher
// ═══════════════════════════════════════════════════════════════════════════════

const THEMES = ['dark', 'midnight', 'green', 'light', 'slate'];

function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'dark';
  document.documentElement.dataset.theme = name === 'dark' ? '' : name;
  document.getElementById('theme-select').value = name;
  localStorage.setItem('js8map-theme', name);
  // Update Leaflet layers that have inline styles
  updateMapColors();
  redrawGrid();
  if (nightVisible) updateNightOverlay();
}

// Restore saved theme on load
applyTheme(localStorage.getItem('js8map-theme') || 'dark');

document.getElementById('theme-select').addEventListener('change', e => {
  applyTheme(e.target.value);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Sidebar Collapse / Expand
// ═══════════════════════════════════════════════════════════════════════════════

function toggleSidebar(visible) {
  document.getElementById('sidebar').style.display            = visible ? '' : 'none';
  document.getElementById('btn-expand-sidebar').style.display = visible ? 'none' : '';
  document.getElementById('btn-collapse-sidebar').setAttribute('aria-expanded', String(visible));
  map.invalidateSize();
}

document.getElementById('btn-collapse-sidebar').addEventListener('click', () => toggleSidebar(false));
document.getElementById('btn-expand-sidebar').addEventListener('click',   () => toggleSidebar(true));

// ═══════════════════════════════════════════════════════════════════════════════
//  WebSocket — Server Communication
// ═══════════════════════════════════════════════════════════════════════════════

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => console.log('[WS] connected');

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleServerMsg(msg);
  };

  ws.onerror = err => console.error('[WS] error', err);

  ws.onclose = () => {
    console.log('[WS] closed — retrying in 3 s');
    setTimeout(connectWS, 3_000);
  };
}

function handleServerMsg(msg) {
  switch (msg.type) {

    // Full state on first connect or reconnect
    case 'SNAPSHOT': {
      myStation    = msg.myStation || myStation;
      maxMessages  = msg.maxMessages ?? maxMessages;

      // If the previously selected station is gone from the new snapshot, clear it
      const snapCallsigns = new Set((msg.stations || []).map(s => s.callsign));
      if (selectedCall && !snapCallsigns.has(selectedCall)) {
        selectedCall = null;
        document.getElementById('detail-panel').classList.add('hidden');
      }

      for (const s of (msg.stations || [])) {
        stationData.set(s.callsign, s);
        placeOrUpdateMarker(s);
      }

      updateMyStationUI();
      updateConnectionBadge(msg.connected);
      rebuildSidebar();
      break;
    }

    case 'MY_STATION': {
      myStation = msg.myStation;
      updateMyStationUI();
      break;
    }

    // A station's metadata updated (no messages in this payload)
    case 'STATION_UPDATE': {
      const s    = msg.station;
      const prev = stationData.get(s.callsign) || { messages: [], firstSeen: Date.now() };
      const next = { ...prev, ...s };
      stationData.set(s.callsign, next);
      placeOrUpdateMarker(next, s.callsign === myStation.callsign);
      patchSidebarItem(next);                            // surgical DOM update
      if (selectedCall === s.callsign) renderDetailPanel(next);
      break;
    }

    // A new message arrived for a station
    case 'NEW_MESSAGE': {
      const station = stationData.get(msg.callsign);
      if (!station) break;
      station.messages = station.messages || [];
      station.messages.unshift(msg.message);
      if (station.messages.length > maxMessages) station.messages.length = maxMessages;

      if (selectedCall === msg.callsign) {
        // Panel is open — refresh it live
        renderDetailPanel(station);
      } else {
        // Mark the sidebar item with an unread dot
        newMsgPending.add(msg.callsign);
        const el = document.querySelector(
          `.station-item[data-callsign="${CSS.escape(msg.callsign)}"]`
        );
        if (el) el.classList.add('has-new-msg');
      }
      break;
    }

    // Server removed a station that hasn't been heard in 4 hours
    case 'STATION_EXPIRED': {
      const cs = msg.callsign;
      stationData.delete(cs);
      newMsgPending.delete(cs);
      removeMarker(cs);
      if (selectedCall === cs) {
        selectedCall = null;
        document.getElementById('detail-panel').classList.add('hidden');
      }
      rebuildSidebar();
      break;
    }

    case 'CONNECTION_STATUS': {
      updateConnectionBadge(msg.connected);
      break;
    }
  }
}

function updateMyStationUI() {
  const badge = document.getElementById('my-callsign-badge');

  if (myStation.callsign) {
    badge.textContent  = myStation.callsign + (myStation.grid ? '  ' + myStation.grid : '');
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }

  if (myStation.grid) {
    // Ensure the home station has an entry in the data store
    const homeRecord = stationData.get(myStation.callsign) || {
      callsign:  myStation.callsign,
      grid:      myStation.grid,
      messages:  [],
      firstSeen: Date.now(),
    };
    homeRecord.grid = myStation.grid;
    stationData.set(myStation.callsign, homeRecord);
    placeOrUpdateMarker(homeRecord, true);

    // Centre the map on home once
    if (!mapCentred) {
      const pos = gridToLatLon(myStation.grid);
      if (pos) {
        map.setView([pos.lat, pos.lon], 6);
        redrawGrid();
        mapCentred = true;
      }
    }
  }
}

function updateConnectionBadge(connected) {
  const el = document.getElementById('connection-status');
  el.textContent = connected ? '&#9679; Connected to JS8CALL' : '&#9679; Disconnected';
  el.className   = connected ? 'connected' : 'disconnected';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Boot
// ═══════════════════════════════════════════════════════════════════════════════

connectWS();
