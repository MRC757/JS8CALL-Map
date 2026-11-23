'use strict';

// Pure browser modules (public/js/*.js are ES modules) tested in Node.

const test   = require('node:test');
const assert = require('node:assert/strict');

const load = name => import(`../public/js/${name}`);

const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ── sun.js ────────────────────────────────────────────────────────────────────

test('sun declination at solstices and equinox', async () => {
  const { sunPosition } = await load('sun.js');
  const deg = d => sunPosition(new Date(d)).dec * 180 / Math.PI;
  assert.ok(near(deg('2026-06-21T12:00:00Z'),  23.44, 0.3));
  assert.ok(near(deg('2026-12-21T12:00:00Z'), -23.44, 0.3));
  assert.ok(near(deg('2026-03-20T15:00:00Z'),   0,    0.5));
});

test('the sun is overhead near the subsolar point at noon UTC', async () => {
  const { sunPosition, solarAltitude } = await load('sun.js');
  const pos = sunPosition(new Date('2026-06-21T12:00:00Z'));
  // On 21 June the sun crosses Greenwich ~1.6 min after 12:00 UTC (equation of
  // time), so at noon the subsolar point is at about 23.4° N, 0.4° E.
  assert.ok(solarAltitude(23.4, 0.4, pos) > 89.5);
  assert.ok(solarAltitude(-23.4, -179.6, pos) < -89.5);   // antipode: sun straight below
});

test('terminator points have sun altitude 0°, -6° curve points have -6°', async () => {
  const { sunPosition, solarAltitude, altitudeCurve, darkPole } = await load('sun.js');
  for (const when of ['2026-11-23T16:00:00Z', '2026-06-21T03:00:00Z', '2026-03-20T15:00:00Z']) {
    const pos = sunPosition(new Date(when));
    for (const [lat, lon] of altitudeCurve(0, pos, 5)) {
      assert.ok(near(solarAltitude(lat, lon, pos), 0, 0.05), `${when} terminator ${lat},${lon}`);
    }
    for (const [lat, lon] of altitudeCurve(-6, pos, 5)) {
      if (lat === darkPole(pos)) continue;   // meridian never reaches -6° (polar twilight)
      assert.ok(near(solarAltitude(lat, lon, pos), -6, 0.05), `${when} -6° curve ${lat},${lon}`);
    }
  }
});

test('greyline band lies between sunset and the end of civil twilight', async () => {
  const { sunPosition, solarAltitude, greylineCoords } = await load('sun.js');
  const date = new Date('2026-11-23T16:00:00Z');
  const pos  = sunPosition(date);
  const ring = greylineCoords(date);
  assert.equal(ring.length, 361 * 2);
  const n = 361;
  for (let i = 0; i < n; i += 15) {
    const [lat0, lon] = ring[i];               // terminator
    const [lat6]      = ring[2 * n - 1 - i];   // -6° curve, same longitude
    const mid = solarAltitude((lat0 + lat6) / 2, lon, pos);
    assert.ok(mid < 0.01 && mid > -6.01, `lon ${lon}: midpoint altitude ${mid}`);
  }
});

test('night polygon closes around the dark pole', async () => {
  const { nightCoords } = await load('sun.js');
  const nov = nightCoords(new Date('2026-11-23T16:00:00Z'));   // northern winter → north pole dark
  assert.equal(nov[0][0], 90);
  assert.equal(nov[nov.length - 1][0], 90);
  const jun = nightCoords(new Date('2026-06-21T16:00:00Z'));
  assert.equal(jun[0][0], -90);
});

// ── geo.js ────────────────────────────────────────────────────────────────────

test('great-circle path starts and ends at the endpoints', async () => {
  const { greatCircleSegments } = await load('geo.js');
  const segs = greatCircleSegments(37.5, -77.5, 51.5, -0.1);   // Richmond → London
  assert.equal(segs.length, 1);
  const pts = segs[0];
  assert.ok(near(pts[0][0], 37.5, 1e-9) && near(pts[0][1], -77.5, 1e-9));
  assert.ok(near(pts.at(-1)[0], 51.5, 1e-9) && near(pts.at(-1)[1], -0.1, 1e-9));
  // The great circle bulges north of both endpoints
  assert.ok(Math.max(...pts.map(p => p[0])) > 52);
});

test('a trans-Pacific path is split at the antimeridian', async () => {
  const { greatCircleSegments } = await load('geo.js');
  const segs = greatCircleSegments(35.7, 139.7, 37.8, -122.4);   // Tokyo → San Francisco
  assert.equal(segs.length, 2);
  assert.equal(segs[0].at(-1)[1], 180);
  assert.equal(segs[1][0][1], -180);
  assert.ok(near(segs[0].at(-1)[0], segs[1][0][0], 1e-9), 'joins at the same latitude');
  for (const seg of segs) {
    for (let i = 1; i < seg.length; i++) assert.ok(Math.abs(seg[i][1] - seg[i - 1][1]) < 180, 'no wrap inside a segment');
  }
});

test('identical endpoints give a single-point path', async () => {
  const { greatCircleSegments } = await load('geo.js');
  const segs = greatCircleSegments(10, 20, 10, 20, 4);
  assert.equal(segs.length, 1);
  for (const p of segs[0]) assert.ok(near(p[0], 10, 1e-9) && near(p[1], 20, 1e-9));
});

// ── util.js ───────────────────────────────────────────────────────────────────

test('ageOpacity: solid when fresh, fades to the minimum at expiry', async () => {
  const { ageOpacity, FADE_START, MIN_OPACITY } = await load('util.js');
  const ttl = 60 * 60 * 1000;
  assert.equal(ageOpacity(0, ttl), 1);
  assert.equal(ageOpacity(FADE_START, ttl), 1);
  assert.equal(ageOpacity(ttl, ttl), MIN_OPACITY);
  assert.equal(ageOpacity(ttl * 3, ttl), MIN_OPACITY);
  const mid = ageOpacity((FADE_START + ttl) / 2, ttl);
  assert.ok(near(mid, (1 + MIN_OPACITY) / 2, 0.01), `mid ${mid}`);
  assert.equal(ageOpacity(NaN, ttl), 1);
});

test('snrLabel, snrClass, timeAgo, escHtml', async () => {
  const { snrLabel, snrClass, timeAgo, escHtml } = await load('util.js');
  assert.equal(snrLabel(5), '+5 dB');
  assert.equal(snrLabel(-12), '-12 dB');
  assert.equal(snrLabel(undefined), '—');
  assert.equal(snrClass(-15), 'snr-fair');
  assert.equal(timeAgo(1000, 31_000), '30s ago');
  assert.equal(timeAgo(0, 1), '—');
  assert.equal(timeAgo(0 + 1, 2 * 3_600_000), '1h ago');
  assert.equal(escHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});
