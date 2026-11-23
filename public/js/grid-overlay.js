// Maidenhead grid overlay: Leaflet polylines for fields/squares (zoom < 9) and
// a single canvas for subsquares (zoom ≥ 9), where thousands of polylines
// would be slow.

import { map, onRestyle } from './map.js';
import { cssVar, setToggle } from './util.js';

const { latLonToGrid } = globalThis.Grid;

const gridPolyLayer = L.layerGroup().addTo(map);
let   gridVisible   = true;

function redrawPolyGrid() {
  gridPolyLayer.clearLayers();
  if (!gridVisible) return;

  const zoom = map.getZoom();
  if (zoom >= 9) return;  // subsquares handled by the canvas layer

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

  const isFieldEdge = (v, step, fieldStep) => step < fieldStep && Math.abs(v % fieldStep) < step * 0.01;

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
        L.marker([cLat, cLon], {
          icon: L.divIcon({
            className:  isField ? 'grid-label grid-label-field' : 'grid-label',
            html:       latLonToGrid(cLat, cLon, labelPrecision),
            iconSize:   [0, 0],
            iconAnchor: [0, 0],
          }),
          interactive: false,
        }).addTo(gridPolyLayer);
      }
    }
  }
}

const CanvasGridLayer = L.Layer.extend({
  onAdd(m) {
    this._map    = m;
    this._canvas = document.createElement('canvas');
    Object.assign(this._canvas.style, {
      position: 'absolute', top: '0', left: '0', pointerEvents: 'none', zIndex: '250',
    });
    // The canvas covers the viewport (it isn't inside a panning pane), so it is
    // redrawn on every 'move' — throttled to one draw per animation frame.
    m.getContainer().appendChild(this._canvas);
    this._onResize    = this._resize.bind(this);
    this._onMove      = this._schedule.bind(this);
    this._onZoomStart = this.clear.bind(this);   // lines would drift during the zoom animation
    m.on('resize', this._onResize);
    m.on('move moveend zoomend', this._onMove);
    m.on('zoomstart', this._onZoomStart);
    this._resize();
  },

  onRemove(m) {
    this._canvas.remove();
    m.off('resize', this._onResize);
    m.off('move moveend zoomend', this._onMove);
    m.off('zoomstart', this._onZoomStart);
    if (this._frame) cancelAnimationFrame(this._frame);
  },

  _resize() {
    const size = this._map.getSize();
    const dpr  = window.devicePixelRatio || 1;
    this._dpr  = dpr;
    this._canvas.width        = Math.round(size.x * dpr);
    this._canvas.height       = Math.round(size.y * dpr);
    this._canvas.style.width  = size.x + 'px';
    this._canvas.style.height = size.y + 'px';
    this._draw();
  },

  _schedule() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => { this._frame = null; this._draw(); });
  },

  _draw() {
    const m = this._map;
    if (!m || !this._canvas) return;
    if ((window.devicePixelRatio || 1) !== this._dpr) return this._resize();  // moved to another screen

    const ctx  = this._canvas.getContext('2d');
    const size = m.getSize();
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    if (!gridVisible || m.getZoom() < 9) return;

    const lonStep = 5 / 60;    // 5 arcmin
    const latStep = 2.5 / 60;  // 2.5 arcmin
    const bounds  = m.getBounds().pad(0.05);

    const minLon = Math.floor(bounds.getWest()  / lonStep) * lonStep;
    const maxLon = Math.ceil(bounds.getEast()   / lonStep) * lonStep;
    const minLat = Math.floor(bounds.getSouth() / latStep) * latStep;
    const maxLat = Math.ceil(bounds.getNorth()  / latStep) * latStep;

    ctx.strokeStyle = cssVar('--grid-canvas');
    ctx.lineWidth   = 0.7;
    ctx.beginPath();
    for (let lon = minLon; lon <= maxLon; lon += lonStep) {
      const p1 = m.latLngToContainerPoint([maxLat, lon]);
      const p2 = m.latLngToContainerPoint([minLat, lon]);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    for (let lat = minLat; lat <= maxLat; lat += latStep) {
      const p1 = m.latLngToContainerPoint([lat, minLon]);
      const p2 = m.latLngToContainerPoint([lat, maxLon]);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();
  },

  clear() {
    if (!this._canvas) return;
    const ctx = this._canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  },
});

const canvasGrid = new CanvasGridLayer();
canvasGrid.addTo(map);

export function redrawGrid() {
  redrawPolyGrid();
  canvasGrid._draw();
}

export function initGridOverlay() {
  map.on('moveend zoomend', redrawGrid);
  onRestyle(redrawGrid);
  redrawGrid();

  const btn = document.getElementById('btn-grid');
  btn.addEventListener('click', () => {
    gridVisible = !gridVisible;
    setToggle(btn, gridVisible);
    if (gridVisible) redrawGrid();
    else { gridPolyLayer.clearLayers(); canvasGrid.clear(); }
  });
}
