'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const G      = require('../public/grid');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('isValidGrid accepts 4/6-char locators, rejects junk', () => {
  for (const g of ['FN31', 'fn31', 'FN31pr', 'AA00', 'RR99XX']) assert.ok(G.isValidGrid(g), g);
  for (const g of ['', 'FN', 'FN3', 'ZZ99', 'FN31Y', 'FN31YZ', 'FN31P', '1234', null, undefined, 42])
    assert.ok(!G.isValidGrid(g), String(g));
});

test('gridToLatLon returns square / subsquare centres', () => {
  const sq = G.gridToLatLon('FN31');
  assert.ok(near(sq.lat, 41.5) && near(sq.lon, -73));
  const ss = G.gridToLatLon('FN31pr');
  // F→-80, 3→+6, p(15)→+15·5′ + 2.5′ centre  ⇒  -74 + 1.25 + 0.041667
  assert.ok(near(ss.lon, -72.708333, 1e-5), `lon ${ss.lon}`);
  // N→40, 1→+1, r(17)→+17·2.5′ + 1.25′ centre ⇒  41 + 0.708333 + 0.020833
  assert.ok(near(ss.lat, 41.729167, 1e-5), `lat ${ss.lat}`);
});

test('gridToLatLon returns null for invalid locators', () => {
  assert.equal(G.gridToLatLon('ZZ99'), null);
  assert.equal(G.gridToLatLon('FN'), null);
  assert.equal(G.gridToLatLon(''), null);
});

test('latLonToGrid round-trips with gridToLatLon', () => {
  for (const g of ['FN31', 'JO65', 'QF56', 'AA00', 'RR99', 'EM73']) {
    const p = G.gridToLatLon(g);
    assert.equal(G.latLonToGrid(p.lat, p.lon, 4), g);
  }
  for (const g of ['FN31PR', 'IO91WM', 'PM95VQ']) {
    const p = G.gridToLatLon(g);
    assert.equal(G.latLonToGrid(p.lat, p.lon, 6), g);
  }
  assert.equal(G.latLonToGrid(41.5, -73, 2), 'FN');
  assert.equal(G.latLonToGrid(90, 180, 4), 'RR99');   // clamped at the edge
});

test('haversine and bearing give known values', () => {
  // London → New York ≈ 5570 km, initial bearing ≈ 288°
  const km = G.haversineKm(51.5074, -0.1278, 40.7128, -74.006);
  assert.ok(Math.abs(km - 5570) < 15, `km ${km}`);
  assert.equal(G.bearingDeg(51.5074, -0.1278, 40.7128, -74.006), 288);
  assert.equal(G.bearingDeg(0, 0, 10, 0), 0);
  assert.equal(G.bearingDeg(0, 0, 0, 10), 90);
});

test('spreadOffsets: one marker centred, many markers all distinct', () => {
  assert.deepEqual(G.spreadOffsets(1), [[0, 0]]);
  for (const n of [2, 5, 20]) {
    const offs = G.spreadOffsets(n);
    assert.equal(offs.length, n);
    assert.equal(new Set(offs.map(o => o.join(','))).size, n, `distinct for n=${n}`);
    for (const [dx, dy] of offs) assert.ok(Math.hypot(dx, dy) >= 5, 'not on top of the centre');
  }
});
