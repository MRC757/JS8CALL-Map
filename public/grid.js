/*
 * Maidenhead grid + geo helpers shared by the browser (window.Grid) and the
 * Node server / tests (require('./public/grid')).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Grid = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Field (AA–RR) + square (00–99), optional subsquare (AA–XX). */
  const GRID_RE = /^[A-R]{2}[0-9]{2}(?:[A-X]{2})?$/;

  function isValidGrid(grid) {
    return typeof grid === 'string' && GRID_RE.test(grid.toUpperCase());
  }

  /** Convert a Maidenhead locator to its {lat, lon} centre point, or null if invalid. */
  function gridToLatLon(grid) {
    if (!isValidGrid(grid)) return null;
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

    let g = String.fromCharCode(A + fLon) + String.fromCharCode(A + fLat) + sLon + sLat;

    if (precision >= 6) {
      lo -= sLon * 2;
      la -= sLat;
      const ssLon = Math.min(Math.floor(lo * 12), 23);
      const ssLat = Math.min(Math.floor(la * 24), 23);
      g += String.fromCharCode(A + ssLon) + String.fromCharCode(A + ssLat);
    }

    return g;
  }

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

  /**
   * Screen-pixel offsets for n markers that share one map position.
   * Index 0 stays centred when alone; otherwise markers fan out on a
   * sunflower spiral so every one of them stays clickable.
   */
  function spreadOffsets(n, spacing = 9) {
    if (n <= 1) return [[0, 0]];
    const golden = Math.PI * (3 - Math.sqrt(5));
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = spacing * Math.sqrt(i + 0.6);
      const a = i * golden;
      out.push([Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))]);
    }
    return out;
  }

  return { GRID_RE, isValidGrid, gridToLatLon, latLonToGrid, haversineKm, bearingDeg, spreadOffsets };
}));
