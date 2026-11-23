'use strict';

// Browser tests: the real server + a fake JS8CALL + headless Chrome/Edge.
// Run with:  npm run test:browser
// Skipped when no Chrome, Chromium or Edge is installed (set CHROME_PATH to point at one).
// Set SCREENSHOT_DIR to save screenshots of the map.

const test      = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('path');
const { spawn } = require('child_process');

const { startFakeJS8, freePort }          = require('../helpers/fake-js8');
const { findBrowser, launchPage, sleep }  = require('../helpers/browser');

const ROOT    = path.join(__dirname, '..', '..');
const BROWSER = findBrowser();
const MIN     = 60_000;

test('map UI in a real browser', { skip: !BROWSER && 'no Chrome/Chromium/Edge found (set CHROME_PATH)' }, async (t) => {
  const t0 = Date.now() - 5000;
  const js8 = await startFakeJS8({ replies: {
    'STATION.GET_CALLSIGN': id => ({ type: 'STATION.CALLSIGN', value: 'W1AW', params: { _ID: id } }),
    'STATION.GET_GRID':     id => ({ type: 'STATION.GRID', value: 'EM73', params: { _ID: id } }),
    // Activity entries sit directly in params, next to _ID, as JS8CALL sends them
    'RX.GET_CALL_ACTIVITY': id => ({ type: 'RX.CALL_ACTIVITY', params: { _ID: id,
      KN4CRD: { GRID: 'EM73', SNR: -8,  UTC: t0 },
      K4ABC:  { GRID: 'EM73', SNR: 2,   UTC: t0 },
      N4XYZ:  { GRID: 'EM73', SNR: -22, UTC: t0 },
      VE3AAA: { GRID: 'FN25', SNR: -12, UTC: t0 },
      KC1OLD: { GRID: 'FN42', SNR: -15, UTC: Date.now() - 40 * MIN },   // heard 40 minutes ago
    } }),
    'RX.GET_BAND_ACTIVITY': id => ({ type: 'RX.BAND_ACTIVITY', params: { _ID: id,
      1500: { DIAL: 7078000, OFFSET: 1500, SNR: -8, TEXT: 'KN4CRD: @ALLCALL CQ CQ ♢', UTC: t0 },
      1700: { DIAL: 7078000, OFFSET: 1700, SNR: -12, TEXT: 'VE3AAA: W1AW HEARTBEAT SNR -14 ♢', UTC: t0 } } }),
  } });

  const webPort = await freePort();
  const server  = spawn(process.execPath,
    ['server.js', '--no-open', '--port', String(webPort), '--js8-port', String(js8.port), '--poll-seconds', '2'],
    { cwd: ROOT, stdio: 'ignore' });
  const page = await launchPage(BROWSER);

  t.after(async () => {
    await page.close();
    server.kill();
    await js8.close();
  });

  await page.navigate(`http://localhost:${webPort}/`);
  await page.waitFor(`document.querySelectorAll('.station-item').length >= 6`, 20_000);
  const ev = expr => page.eval(expr);
  const setView = (lat, lon, z) => ev(`new Promise(r => { js8map.map.once('moveend', () => r()); js8map.map.setView([${lat}, ${lon}], ${z}, { animate: false }); })`);

  await t.test('modules load and the status shows a real bullet', async () => {
    assert.equal(await ev(`typeof window.js8map`), 'object', 'main.js ran');
    assert.equal(await ev(`document.getElementById('connection-status').textContent.trim()`), '● Connected to JS8CALL');
  });

  await t.test('sidebar lists every station including home', async () => {
    const items = await ev(`[...document.querySelectorAll('.station-item')].map(e => e.dataset.callsign)`);
    for (const cs of ['W1AW', 'KN4CRD', 'K4ABC', 'N4XYZ', 'VE3AAA', 'KC1OLD']) assert.ok(items.includes(cs), cs);
  });

  await t.test('stations sharing a grid square fan out and are each clickable', async () => {
    const pts = await ev(`[...document.querySelectorAll('.station-marker')].map(e => { const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), cs: e.title, home: e.classList.contains('my-station') }; })`);
    const em73 = pts.filter(p => ['W1AW', 'KN4CRD', 'K4ABC', 'N4XYZ'].includes(p.cs));
    assert.equal(em73.length, 4);
    assert.equal(new Set(em73.map(p => `${p.x},${p.y}`)).size, 4, 'distinct positions');
    assert.ok(em73.find(p => p.cs === 'W1AW').home, 'home marker styled');
    const hits = await ev(`(${JSON.stringify(em73)}).map(p => document.elementFromPoint(p.x, p.y)?.title === p.cs)`);
    assert.deepEqual(hits, [true, true, true, true]);
  });

  await t.test('pins fade with age; fresh and home pins stay solid', async () => {
    const op = cs => ev(`Number(document.querySelector('.station-marker[title="${cs}"]').closest('.leaflet-marker-icon').style.opacity || 1)`);
    const old = await op('KC1OLD');
    assert.ok(old < 0.8 && old > 0.3, `40-minute-old pin opacity ${old}`);
    assert.equal(await op('KN4CRD'), 1);
    assert.equal(await op('W1AW'), 1);
  });

  await t.test('a station that reported our signal is marked everywhere', async () => {
    await page.waitFor(`document.querySelector('.station-marker[title="VE3AAA"]')?.classList.contains('hears-me')`);
    const badge = await ev(`document.querySelector('.station-item[data-callsign="VE3AAA"] .hears-badge')?.textContent`);
    assert.equal(badge, 'hears you -14 dB');
    assert.equal(await ev(`document.querySelector('.station-item[data-callsign="KN4CRD"] .hears-badge')`), null);

    await ev(`document.querySelector('.station-item[data-callsign="VE3AAA"]').click()`);
    await page.waitFor(`document.getElementById('detail-hears-you')`);
    assert.match(await ev(`document.getElementById('detail-hears-you').textContent`), /-14 dB/);
    assert.equal(await ev(`document.querySelector('#detail-messages .message-item.to-me .message-to')?.textContent.trim()`), '→ W1AW (you)');
    await ev(`document.getElementById('detail-close').click()`);
  });

  await t.test('Heard Me draws great-circle paths to stations that hear us', async () => {
    await ev(`document.getElementById('btn-heard-paths').click()`);
    await page.waitFor(`js8map.heardPathCount() > 0`);
    assert.equal(await ev(`js8map.heardPathCount()`), 1, 'one station (VE3AAA) hears us');
    assert.ok(await ev(`document.querySelectorAll('path.heard-path').length`) >= 1);

    // A new report from another station adds a path
    js8.emit({ type: 'RX.DIRECTED', params: { FROM: 'N4XYZ', TO: 'W1AW', TEXT: 'N4XYZ: W1AW SNR -03 ♢', UTC: Date.now() - 1000, SNR: -20 } });
    await page.waitFor(`js8map.heardPathCount() === 2`);
    await ev(`document.getElementById('btn-heard-paths').click()`);
    assert.equal(await ev(`js8map.heardPathCount()`), 0, 'toggled off');
  });

  await t.test('detail panel: no duplicates from polling, live inserts, scroll kept', async () => {
    await ev(`document.querySelector('.station-item[data-callsign="KN4CRD"]').click()`);
    await page.waitFor(`document.querySelectorAll('#detail-messages .message-item').length === 1`);
    await ev(`window.__stats = document.getElementById('detail-stats')`);
    await sleep(4500);   // two polls
    assert.equal(await ev(`document.querySelectorAll('#detail-messages .message-item').length`), 1);

    for (let i = 0; i < 25; i++) {
      js8.emit({ type: 'RX.DIRECTED', params: { FROM: 'KN4CRD', TO: 'K1ZZZ', TEXT: `KN4CRD: K1ZZZ MSG ${i} ` + 'lorem ipsum '.repeat(4),
        UTC: Date.now() - 1000 + i, DIAL: 7078000, OFFSET: 1500, SNR: -3 } });
    }
    await page.waitFor(`document.querySelectorAll('#detail-messages .message-item').length === 26`);
    const before = await ev(`(() => { const c = document.getElementById('detail-content'); c.scrollTop = 300;
      window.__anchor = [...document.querySelectorAll('#detail-messages .message-item')].find(e => e.getBoundingClientRect().top >= c.getBoundingClientRect().top);
      return window.__anchor.getBoundingClientRect().top; })()`);
    js8.emit({ type: 'RX.DIRECTED', params: { FROM: 'KN4CRD', TO: 'K1ZZZ', TEXT: 'KN4CRD: K1ZZZ NEWEST', UTC: Date.now(), SNR: -1 } });
    await page.waitFor(`document.querySelector('#detail-messages .message-text').textContent === 'KN4CRD: K1ZZZ NEWEST'`);
    await page.waitFor(`document.querySelector('#detail-stats .detail-stat-value').textContent === '-1 dB'`);
    assert.equal(await ev(`document.getElementById('detail-msg-count').textContent`), '27');
    assert.equal(await ev(`window.__stats === document.getElementById('detail-stats')`), true, 'patched, not re-rendered');
    const after = await ev(`window.__anchor.getBoundingClientRect().top`);
    assert.ok(Math.abs(after - before) <= 1, `reading position kept (${before} → ${after})`);
    await ev(`document.getElementById('detail-close').click()`);
  });

  await t.test('measure: cancel label, and Clear only after a finished measurement', async () => {
    await ev(`document.getElementById('btn-measure').click()`);
    assert.equal(await ev(`document.getElementById('btn-measure').textContent`), '✕ Cancel');
    await ev(`document.getElementById('btn-measure').click()`);   // cancel
    assert.equal(await ev(`document.getElementById('btn-clear-measure').style.display`), 'none');

    await ev(`document.getElementById('btn-measure').click()`);
    await ev(`(() => { const m = js8map.map; for (const ll of [[35, -90], [40, -80]]) m.fire('click', { latlng: L.latLng(ll) }); })()`);
    assert.match(await ev(`document.getElementById('measure-result').textContent`), /km/);
    assert.equal(await ev(`document.getElementById('btn-clear-measure').style.display`), '');
    await ev(`document.querySelector('#measure-result .measure-clear-btn').click()`);
    assert.equal(await ev(`document.getElementById('btn-clear-measure').style.display`), 'none');
  });

  await t.test('night and greyline overlays draw and toggle off', async () => {
    await setView(20, 0, 2);   // whole world: Leaflet clips paths to the view
    await ev(`document.getElementById('btn-night').click()`);
    await ev(`document.getElementById('btn-greyline').click()`);
    assert.equal(await ev(`document.querySelectorAll('path.night-overlay').length`), 1);
    assert.equal(await ev(`document.querySelectorAll('path.greyline-overlay').length`), 1);
    assert.ok(await ev(`document.querySelector('path.greyline-overlay').getAttribute('d').length`) > 100);
    assert.equal(await ev(`document.getElementById('btn-greyline').getAttribute('aria-pressed')`), 'true');
    if (process.env.SCREENSHOT_DIR) {
      await setView(30, -40, 3);
      await page.screenshot(path.join(process.env.SCREENSHOT_DIR, 'greyline.png'));
    }
    await ev(`document.getElementById('btn-night').click()`);
    await ev(`document.getElementById('btn-greyline').click()`);
    assert.equal(await ev(`document.querySelectorAll('path.night-overlay, path.greyline-overlay').length`), 0);
  });

  await t.test('county labels only for the area in view, and only from zoom 8', async () => {
    await ev(`document.getElementById('btn-us-counties').click()`);
    await sleep(2500);
    await setView(35.9, -86.7, 9);
    const n = await ev(`document.querySelectorAll('.us-county-label').length`);
    assert.ok(n > 5 && n < 400, `${n} of 3,143 labels in the DOM`);
    await setView(35.9, -86.7, 6);
    assert.equal(await ev(`document.querySelectorAll('.us-county-label').length`), 0);
    await ev(`document.getElementById('btn-us-counties').click()`);
  });

  await t.test('subsquare canvas is HiDPI and redraws while panning', async () => {
    await setView(35.9, -86.7, 10);
    const c = await ev(`(() => { const c = document.querySelector('#map > canvas'); return { w: c.width, sx: js8map.map.getSize().x, dpr: devicePixelRatio }; })()`);
    assert.equal(c.w, c.sx * c.dpr);
    const [a, b] = await ev(`new Promise(r => {
      const c = document.querySelector('#map > canvas');
      const hash = () => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.reduce((h, v, i) => (v ? (h * 31 + i) >>> 0 : h), 7);
      const before = hash();
      js8map.map.panBy([37, 23], { animate: false });
      requestAnimationFrame(() => requestAnimationFrame(() => r([before, hash()])));
    })`);
    assert.notEqual(a, b);
  });

  await t.test('theme switch', async () => {
    await ev(`(() => { const s = document.getElementById('theme-select'); s.value = 'light'; s.dispatchEvent(new Event('change')); })()`);
    assert.equal(await ev(`document.documentElement.dataset.theme`), 'light');
    if (process.env.SCREENSHOT_DIR) {
      await setView(36, -80, 6);
      await ev(`document.getElementById('btn-heard-paths').click()`);
      await sleep(400);
      await page.screenshot(path.join(process.env.SCREENSHOT_DIR, 'map.png'));
      await ev(`document.getElementById('btn-heard-paths').click()`);
    }
  });

  await t.test('no errors in the browser console', () => {
    assert.deepEqual(page.errors, []);
  });
});
