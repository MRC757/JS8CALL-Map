'use strict';

// Browser test for the JS8Stat view: the real server + a fake JS8CALL +
// headless Chrome/Edge. Run with:  npm run test:browser
// Set SCREENSHOT_DIR to save a screenshot of the JS8Stat view.

const test      = require('node:test');
const assert    = require('node:assert/strict');
const fs        = require('fs');
const os        = require('os');
const path      = require('path');
const { spawn } = require('child_process');

const { startFakeJS8, freePort }          = require('../helpers/fake-js8');
const { findBrowser, launchPage, sleep }  = require('../helpers/browser');

const ROOT    = path.join(__dirname, '..', '..');
const BROWSER = findBrowser();

test('JS8Stat view in a real browser', {
  skip:    !BROWSER && 'no Chrome/Chromium/Edge found (set CHROME_PATH)',
  timeout: 5 * 60_000,
}, async (t) => {
  const js8 = await startFakeJS8({ replies: {
    'STATION.GET_CALLSIGN': id => ({ type: 'STATION.CALLSIGN', value: 'W1AW', params: { _ID: id } }),
    'STATION.GET_GRID':     id => ({ type: 'STATION.GRID', value: 'FN31PR', params: { _ID: id } }),
    'RX.GET_CALL_ACTIVITY': id => ({ type: 'RX.CALL_ACTIVITY', params: { _ID: id } }),
    'RX.GET_BAND_ACTIVITY': id => ({ type: 'RX.BAND_ACTIVITY', params: { _ID: id } }),
    'RIG.GET_FREQ':         id => ({ type: 'RIG.FREQ', params: { _ID: id, DIAL: 7078000 } }),
    'MODE.GET_SPEED':       id => ({ type: 'MODE.SPEED', params: { _ID: id, SPEED: 0 } }),
  } });
  t.after(() => js8.close());

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-csb-'));
  t.after(async () => { await sleep(300); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp */ } });

  const webPort = await freePort();
  const server  = spawn(process.execPath,
    ['server.js', '--no-open', '--port', String(webPort), '--js8-port', String(js8.port), '--poll-seconds', '2', '--data-dir', dataDir],
    { cwd: ROOT, stdio: 'ignore' });
  t.after(() => { server.kill(); });

  const page = await launchPage(BROWSER);
  t.after(() => page.close());
  const ev = expr => page.eval(expr);
  const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const menu  = async (label, item) => {
    await ev(`[...document.querySelectorAll('.cs-menu-btn')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    await click(item);
  };

  await page.navigate(`http://localhost:${webPort}/`);
  await page.waitFor(`js8map.state.myStation.callsign === 'W1AW' && js8map.js8stat.connected`, 20_000);

  const at = Date.now() - 3000;
  const directed = (from, to, text, extra = {}) => js8.emit({ type: 'RX.DIRECTED', value: text,
    params: { FROM: from, TO: to, TEXT: text, UTC: at, DIAL: 7078000, OFFSET: 1500, SNR: -9, ...extra } });
  directed('KN4CRD', '@AMRRON', '@AMRRON ,EM73TU,3,M05,333211111141,BRIDGE OUT||ROAD CLOSED,{&%} ♢');
  directed('K4ABC',  '@AMRRON', '@AMRRON ,EM74,6,M06,1,TREE DOWN ON HWY 9,{##} ♢', { SNR: -20 });
  directed('VE3AAA', '@AMRRON', '@AMRRON ,M07,3,TORNADO WARNING,TAKE SHELTER NOW,{%%} ♢', { SNR: 2 });
  directed('N4XYZ',  '@AMRRON', '@AMRRON MSG ,M08,NET TONIGHT AT 2100,{^%} ♢');

  await t.test('the JS8Stat view is off until switched on', async () => {
    await page.waitFor(`js8map.js8stat.records.size === 4`);
    assert.equal(await ev(`document.getElementById('cs-menubar').hidden`), true);
    await click('#btn-js8stat');
    assert.equal(await ev(`document.getElementById('cs-menubar').hidden`), false);
    assert.equal(await ev(`document.getElementById('btn-js8stat').getAttribute('aria-pressed')`), 'true');
    assert.equal(await ev(`getComputedStyle(document.getElementById('cs-menubar')).backgroundColor`), 'rgb(48, 80, 204)');
  });

  await t.test('StatRep table: one row per report, colour-coded conditions', async () => {
    await page.waitFor(`document.querySelectorAll('#cs-statrep-table tbody tr[data-id]').length === 2`);
    const row = await ev(`(() => { const tr = [...document.querySelectorAll('#cs-statrep-table tbody tr')]
        .find(r => r.textContent.includes('KN4CRD'));
      return { cells: tr.children.length, st: [...tr.querySelectorAll('td.cs-st')].map(td => td.className.replace('cs-st ', '')),
               remarks: tr.querySelector('.cs-remarks').textContent, scope: tr.children[7].textContent }; })()`);
    assert.equal(row.cells, 22);   // 12 conditions + Ack column
    assert.deepEqual(row.st, ['cs-st-3', 'cs-st-3', 'cs-st-3', 'cs-st-2', 'cs-st-1', 'cs-st-1', 'cs-st-1', 'cs-st-1',
                              'cs-st-1', 'cs-st-1', 'cs-st-4', 'cs-st-1']);
    assert.equal(row.remarks, 'BRIDGE OUT  ROAD CLOSED');
    assert.equal(row.scope, 'County');
    assert.equal(await ev(`document.getElementById('cs-statrep-count').textContent`), '2 reports');
    assert.equal(await ev(`getComputedStyle(document.querySelector('#cs-statrep-table th')).backgroundColor`), 'rgb(240, 120, 0)');
  });

  await t.test('pins: status dot with scope halo, and an incident marker', async () => {
    assert.equal(await ev(`document.querySelectorAll('.leaflet-statrep-pane path.cs-statrep-dot').length`), 1);
    assert.equal(await ev(`document.querySelectorAll('.leaflet-statrep-pane .cs-incident-icon').length`), 1);
    assert.equal(await ev(`document.querySelector('path.cs-statrep-dot').getAttribute('fill')`), '#CC2020');
    // A station heard without a grid takes the one from its report, so it gets a station pin too
    await page.waitFor(`document.querySelector('.station-item[data-callsign="KN4CRD"] .station-grid')?.textContent === 'EM73TU'`);
  });

  await t.test('detail window shows all twelve conditions', async () => {
    await ev(`[...document.querySelectorAll('#cs-statrep-table tbody tr')].find(r => r.textContent.includes('KN4CRD')).children[1].click()`);
    await page.waitFor(`document.querySelector('.cs-dialog')`);
    assert.equal(await ev(`document.querySelectorAll('.cs-dialog .cs-tile').length`), 12);
    assert.match(await ev(`document.querySelector('.cs-dialog-title').textContent`), /Status Report — KN4CRD/);
    assert.match(await ev(`document.querySelector('.cs-remarks-box').innerHTML`), /BRIDGE OUT<br>ROAD CLOSED/);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    assert.equal(await ev(`document.querySelector('.cs-dialog')`), null);
  });

  await t.test('alert pops up; messages and live feed fill in', async () => {
    assert.equal(await ev(`document.getElementById('cs-alert').classList.contains('hidden')`), false);
    assert.equal(await ev(`document.querySelector('.cs-alert-title').textContent`), 'TORNADO WARNING');
    await click('#cs-alert [data-act="close"]');
    assert.equal(await ev(`document.getElementById('cs-alert').classList.contains('hidden')`), true);

    assert.match(await ev(`document.querySelector('#cs-message-table tbody tr[data-id]').textContent`), /NET TONIGHT AT 2100/);
    const feed = await ev(`document.getElementById('cs-feed').textContent`);
    assert.match(feed, /\t7\.078\t1500\t-09\tKN4CRD: @AMRRON ,EM73TU/);
  });

  await t.test('group filter hides other groups', async () => {
    directed('K1OTH', '@OTHER', '@OTHER ,FN42,1,M09,+,,{&%} ♢');
    await page.waitFor(`js8map.js8stat.records.size === 5`);
    await page.waitFor(`document.querySelectorAll('#cs-statrep-table tbody tr[data-id]').length === 3`);
    await ev(`(() => { const s = js8map.js8statSettings; s.groups = 'AMRRON'; })()`);
    await menu('Filter', '[data-setting="hideGreen"]');   // any settings change re-renders
    await menu('Filter', '[data-setting="hideGreen"]');
    await page.waitFor(`document.querySelectorAll('#cs-statrep-table tbody tr[data-id]').length === 2`);
    await ev(`js8map.js8statSettings.groups = ''`);
  });

  await t.test('transmitting is off until the operator switches it on', async () => {
    assert.equal(await ev(`document.getElementById('cs-tx-state').textContent`), 'TX OFF');
    await menu('Transmit', '[data-action="message"]');
    await page.waitFor(`document.querySelector('.cs-dialog')`);
    assert.equal(await ev(`document.querySelector('.cs-btn[data-id="tx"]').disabled`), true);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

    await menu('Transmit', '[data-setting="txEnabled"]');
    await page.waitFor(`document.getElementById('cs-tx-state').textContent === 'TX READY'`);
    await ev(`document.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);   // close the menu
  });

  await t.test('the operator is asked before anything is transmitted', async () => {
    await menu('Transmit', '[data-action="message"]');
    await page.waitFor(`document.querySelector('.cs-dialog textarea[name="text"]')`);
    await ev(`(() => { const d = document.querySelector('.cs-dialog');
      d.querySelector('[name="target"]').value = '@AMRRON';
      d.querySelector('[name="text"]').value = 'Checking in from the valley'; })()`);
    await click('.cs-btn[data-id="tx"]');
    await page.waitFor(`document.querySelectorAll('.cs-dialog').length === 2`);
    const shown = await ev(`document.querySelector('.cs-confirm-text').textContent`);
    assert.match(shown, /^@AMRRON MSG ,[A-Y]\d\d,CHECKING IN FROM THE VALLEY,\{\^%\}$/);

    // Cancel: nothing is sent and the form stays open
    await ev(`[...document.querySelectorAll('.cs-dialog')].at(-1).querySelector('.cs-btn-gray').click()`);
    await sleep(300);
    assert.equal(js8.sent.filter(q => q.type === 'TX.SEND_MESSAGE').length, 0);
    assert.equal(await ev(`document.querySelectorAll('.cs-dialog').length`), 1);

    // Confirm: JS8CALL receives exactly the text that was shown
    await click('.cs-btn[data-id="tx"]');
    await page.waitFor(`document.querySelectorAll('.cs-dialog').length === 2`);
    await click('.cs-btn[data-id="yes"]');
    for (let i = 0; i < 50 && !js8.sent.some(q => q.type === 'TX.SEND_MESSAGE'); i++) await sleep(100);
    const tx = js8.sent.filter(q => q.type === 'TX.SEND_MESSAGE');
    assert.equal(tx.length, 1);
    assert.equal(tx[0].value, shown);
    await page.waitFor(`document.querySelectorAll('.cs-dialog').length === 0`);
    await page.waitFor(`[...document.querySelectorAll('#cs-message-table tbody tr')].some(r => r.textContent.includes('CHECKING IN')
                        && r.querySelector('.cs-src-sent'))`);
  });

  await t.test('StatRep form: Map Pin follows the worst condition; All Green', async () => {
    await menu('Transmit', '[data-action="statrep"]');
    await page.waitFor(`document.querySelector('.cs-status-grid')`);
    assert.equal(await ev(`document.querySelector('.cs-dialog [name="grid"]').value`), 'FN31PR');
    await click('.cs-dialog [data-act="all-green"]');
    await ev(`(() => { const s = document.querySelector('[data-field="water"]'); s.value = '3'; s.dispatchEvent(new Event('change')); })()`);
    assert.equal(await ev(`document.querySelector('[data-field="map"]').value`), '3');
    assert.equal(await ev(`getComputedStyle(document.querySelector('[data-field="water"]')).backgroundColor`), 'rgb(220, 53, 69)');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  });

  await t.test('a saved draft can be reopened, edited and sent as the same report', async () => {
    const rowsFor = id => `[...document.querySelectorAll('#cs-statrep-table tbody tr')].filter(r => r.children[5]?.textContent === '${id}')`;

    // Draft: all green, a two-line remark, Save Only
    await menu('Transmit', '[data-action="statrep"]');
    await page.waitFor(`document.querySelector('.cs-status-grid')`);
    const srId = await ev(`document.querySelector('.cs-dialog [name="srId"]').value`);
    await ev(`(() => { const d = document.querySelector('.cs-dialog');
      d.querySelector('[name="target"]').value = '@AMRRON';
      d.querySelector('[name="remarks"]').value = 'Line one\\nLine two'; })()`);
    await click('.cs-dialog [data-act="all-green"]');
    await ev(`[...document.querySelectorAll('.cs-dialog .cs-btn')].find(b => b.textContent === 'Save Only').click()`);
    await page.waitFor(`${rowsFor(srId)}.length === 1 && ${rowsFor(srId)}[0].querySelector('.cs-src-saved')`);
    assert.equal(js8.sent.filter(q => q.type === 'TX.SEND_MESSAGE').length, 1, 'saving does not transmit');

    // Reopen it from its detail window: every field comes back, with the same ID
    await ev(`${rowsFor(srId)}[0].children[1].click()`);
    await page.waitFor(`document.querySelector('.cs-btn[data-id="edit"]')`);
    await click('.cs-btn[data-id="edit"]');
    await page.waitFor(`document.querySelector('.cs-status-grid')`);
    assert.equal(await ev(`document.querySelector('.cs-dialog-title').textContent`), `Status Report — draft ${srId}`);
    assert.equal(await ev(`document.querySelector('.cs-dialog [name="srId"]').value`), srId);
    assert.equal(await ev(`document.querySelector('.cs-dialog [name="target"]').value`), '@AMRRON');
    assert.equal(await ev(`document.querySelector('.cs-dialog [name="remarks"]').value`), 'LINE ONE\nLINE TWO');
    assert.equal(await ev(`document.querySelector('[data-field="power"]').value`), '1');

    // Edit one condition and transmit (after the 5 s gap since the last transmission)
    await ev(`(() => { const s = document.querySelector('[data-field="power"]'); s.value = '2'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(5200);
    await click('.cs-btn[data-id="tx"]');
    await page.waitFor(`document.querySelector('.cs-confirm-text')`);
    const shown = await ev(`document.querySelector('.cs-confirm-text').textContent`);
    assert.equal(shown, `W1AW: @AMRRON ,FN31PR,1,${srId},221111111111,LINE ONE||LINE TWO,{&%}`);
    await click('.cs-btn[data-id="yes"]');
    for (let i = 0; i < 50 && js8.sent.filter(q => q.type === 'TX.SEND_MESSAGE').length < 2; i++) await sleep(100);
    assert.equal(js8.sent.filter(q => q.type === 'TX.SEND_MESSAGE').at(-1).value, shown);

    // One row remains, now marked as sent
    await page.waitFor(`${rowsFor(srId)}.length === 1 && ${rowsFor(srId)}[0].querySelector('.cs-src-sent')`);
    assert.equal(await ev(`[...js8map.js8stat.records.values()].filter(r => r.srId === '${srId}').length`), 1);
    // A sent report has no Edit / Send
    await ev(`${rowsFor(srId)}[0].children[1].click()`);
    await page.waitFor(`document.querySelector('.cs-dialog')`);
    assert.equal(await ev(`document.querySelector('.cs-btn[data-id="edit"]')`), null);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  });

  // ─── Getting traffic through: delivery, airtime, relays, roster, clock, groups ───

  const txCount = () => js8.sent.filter(q => q.type === 'TX.SEND_MESSAGE').length;
  const waitTx = async n => { for (let i = 0; i < 80 && txCount() < n; i++) await sleep(100); assert.equal(txCount(), n); };
  const escape = () => ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  const lastDialog = `[...document.querySelectorAll('.cs-dialog')].at(-1)`;

  await t.test('a sent report waits for an acknowledgement, then shows who acked', async () => {
    const row = await ev(`(() => { const r = [...js8map.js8stat.records.values()].find(x => x.kind === 'statrep' && x.source === 'sent');
      return { id: r.id, srId: r.srId }; })()`);
    const cell = `document.querySelector('#cs-statrep-table tr[data-id="${row.id}"] td.cs-dlv')`;
    await page.waitFor(`${cell}?.classList.contains('cs-dlv-waiting')`);
    directed('K4ABC', '@AMRRON', `@AMRRON RRSR W1AW,${row.srId}`);
    await page.waitFor(`${cell}?.classList.contains('cs-dlv-acked')`);
    assert.equal(await ev(`${cell}.textContent`), '✓1');
    assert.match(await ev(`${cell}.title`), /Acknowledged by K4ABC/);
  });

  await t.test('reports sent by an older version (no ackExpected field) still show their acks', async () => {
    await ev(`js8map.handleServerMsg({ type: 'CS_RECORD', record: { id: 9001, kind: 'statrep', from: 'W1AW', target: '@AMRRON',
      grid: 'FN31PR', scope: '1', srId: 'T54', status: '111111111111', remarks: '', utc: Date.now() - 3600_000,
      freq: 7110000, source: 'sent', key: 'legacy', acks: ['K1ABC'] } })`);
    const cell = `document.querySelector('#cs-statrep-table tr[data-id="9001"] td.cs-dlv')`;
    await page.waitFor(`${cell}?.classList.contains('cs-dlv-acked')`);
    assert.equal(await ev(`${cell}.textContent`), '✓1');
    await ev(`js8map.handleServerMsg({ type: 'CS_REMOVE', id: 9001 })`);
  });

  await t.test('resend shows the same text and airtime, asks, then sends it unchanged', async () => {
    const rec = await ev(`(() => { const r = [...js8map.js8stat.records.values()].find(x => x.kind === 'statrep' && x.source === 'sent');
      return { id: r.id, wire: r.wire }; })()`);
    await ev(`document.querySelector('#cs-statrep-table tr[data-id="${rec.id}"]').children[1].click()`);
    await page.waitFor(`document.querySelector('.cs-btn[data-id="resend"]')`);
    assert.match(await ev(`document.querySelector('.cs-dialog .cs-acks').textContent`), /Sent .* UTC\. Acknowledged by: K4ABC/);
    await sleep(5200);   // transmissions are at least 5 s apart
    await click('.cs-btn[data-id="resend"]');
    await page.waitFor(`document.querySelector('.cs-confirm-text')`);
    assert.equal(await ev(`${lastDialog}.querySelector('.cs-dialog-title').textContent`), 'Resend?');
    assert.equal(await ev(`document.querySelector('.cs-confirm-text').textContent`), rec.wire);
    assert.match(await ev(`${lastDialog}.querySelector('.cs-airtime').textContent`), /^About \d+ frames · about .* at Normal speed \(JS8CALL's current speed\)/);
    const before = txCount();
    await click('.cs-btn[data-id="yes"]');
    await waitTx(before + 1);
    assert.equal(js8.sent.filter(q => q.type === 'TX.SEND_MESSAGE').at(-1).value, rec.wire);
    await page.waitFor(`js8map.js8stat.records.get(${rec.id}).resends === 1`);
    await page.waitFor(`document.querySelectorAll('.cs-dialog').length === 0`);
  });

  await t.test('forms show live airtime for the exact text', async () => {
    await menu('Transmit', '[data-action="message"]');
    await page.waitFor(`document.querySelector('.cs-dialog .cs-airtime')`);
    await ev(`(() => { const d = document.querySelector('.cs-dialog');
      d.querySelector('[name="target"]').value = '@AMRRON';
      const t = d.querySelector('[name="text"]'); t.value = 'Short'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await page.waitFor(`/^About 4 frames · about 1 min at Normal speed/.test(document.querySelector('.cs-dialog .cs-airtime').textContent)`);
    await ev(`(() => { const t = document.querySelector('.cs-dialog [name="text"]'); t.value = 'X'.repeat(400);
      t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await page.waitFor(`document.querySelector('.cs-dialog .cs-airtime').classList.contains('cs-airtime-long')`);
    assert.match(await ev(`document.querySelector('.cs-dialog .cs-airtime').textContent`), /consider shortening/);
    await escape();
  });

  await t.test('relay: suggested from who hears whom, sent via the relay, acked through it', async () => {
    directed('K9RLY', 'W1AW', 'W1AW SNR -08');                 // K9RLY hears us
    directed('N0FAR', 'K9RLY', 'K9RLY HEARTBEAT SNR -12');     // N0FAR hears K9RLY
    await sleep(300);
    await menu('Transmit', '[data-action="message"]');
    await page.waitFor(`document.querySelector('.cs-dialog [name="target"]')`);
    await ev(`(() => { const d = document.querySelector('.cs-dialog');
      const t = d.querySelector('[name="target"]'); t.value = 'N0FAR'; t.dispatchEvent(new Event('input', { bubbles: true }));
      d.querySelector('[name="text"]').value = 'Meet at noon'; })()`);
    await page.waitFor(`[...document.querySelectorAll('.cs-dialog [name="relay"] option')].some(o => o.value === 'K9RLY')`);
    assert.match(await ev(`document.querySelector('.cs-route-hint').textContent`), /You hear N0FAR, but there is no report of N0FAR hearing you.*Suggested relay: K9RLY/);
    await ev(`(() => { const s = document.querySelector('.cs-dialog [name="relay"]'); s.value = 'K9RLY'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    assert.match(await ev(`document.querySelector('.cs-route-hint').textContent`), /K9RLY hears you \(-8 dB.*N0FAR hears K9RLY \(-12 dB/);
    await sleep(5200);
    const before = txCount();
    await click('.cs-btn[data-id="tx"]');
    await page.waitFor(`document.querySelector('.cs-confirm-text')`);
    assert.match(await ev(`document.querySelector('.cs-confirm-text').textContent`), /^K9RLY> N0FAR MSG ,[A-Y]\d\d,MEET AT NOON,\{\^%\}$/);
    await click('.cs-btn[data-id="yes"]');
    await waitTx(before + 1);
    const row = `[...document.querySelectorAll('#cs-message-table tbody tr')].find(r => r.textContent.includes('N0FAR via K9RLY'))`;
    await page.waitFor(`${row}?.querySelector('.cs-dlv-waiting')`);
    directed('K9RLY', 'W1AW', 'W1AW> ACK *DE* N0FAR');
    await page.waitFor(`${row}?.querySelector('.cs-dlv-acked')`);
  });

  await t.test('group roster: reported, heard without a report, and silent stations', async () => {
    directed('N4CHK', '@AMRRON', '@AMRRON SNR?');   // heard on the group, no report
    await sleep(300);
    await menu('View', '[data-action="roster"]');
    await page.waitFor(`document.querySelector('.cs-roster tbody tr')`);
    await ev(`(() => { const s = document.querySelector('.cs-dialog [name="group"]'); s.value = '@AMRRON'; s.dispatchEvent(new Event('change')); })()`);
    const rows = await ev(`[...document.querySelectorAll('.cs-roster tbody tr')].map(r => r.children[0].textContent + ':' + r.className)`);
    assert.ok(rows.includes('KN4CRD:cs-roster-reported'), rows.join(' '));
    assert.ok(rows.includes('N4CHK:cs-roster-active'), rows.join(' '));
    assert.match(await ev(`document.querySelector('.cs-roster-summary').textContent`), /on @AMRRON: \d+ reported, \d+ heard without a report, 0 silent/);
    await escape();
  });

  await t.test('a group heard only in partial frames is flagged (not added in JS8CALL)', async () => {
    for (const call of ['K1GH', 'K2GH', 'K3GH']) {
      js8.emit({ type: 'RX.ACTIVITY', value: `${call}: @GHOSTNET NET TONIGHT`, params: { UTC: Date.now() - 1000, SNR: -5, DIAL: 7078000, OFFSET: 900 } });
    }
    await page.waitFor(`js8map.js8stat.groupWarnings.includes('@GHOSTNET')`);
    await page.waitFor(`[...document.querySelectorAll('.cs-toast')].some(t => t.textContent.includes('@GHOSTNET'))`);
    await menu('View', '[data-action="roster"]');
    await page.waitFor(`document.querySelector('.cs-dialog [name="group"]')`);
    await ev(`(() => { const s = document.querySelector('.cs-dialog [name="group"]'); s.value = '@GHOSTNET'; s.dispatchEvent(new Event('change')); })()`);
    assert.equal(await ev(`document.querySelector('.cs-roster-warning').hidden`), false);
    assert.match(await ev(`document.querySelector('.cs-roster-warning').textContent`), /not one of your groups in JS8CALL/);
    await escape();
  });

  await t.test('clock check: decodes arriving off-time turn the CLOCK indicator amber', async () => {
    assert.equal(await ev(`document.getElementById('cs-clock-state').className`), 'cs-clock-unknown');
    for (let i = 0; i < 6; i++) {
      js8.emit({ type: 'RX.ACTIVITY', value: `K${i}CLK: @HB HEARTBEAT FN42`,
        params: { UTC: Date.now() - 1000, SNR: -5, DIAL: 7078000, OFFSET: 900, TDRIFT: 1.6 } });
    }
    await page.waitFor(`document.getElementById('cs-clock-state').className === 'cs-clock-warn'`);
    assert.equal(await ev(`document.getElementById('cs-clock-state').textContent`), 'CLOCK +1.6 s');
    assert.match(await ev(`document.getElementById('cs-clock-state').title`), /GPS/);
  });

  await t.test('the app says plainly that JS8Stat is not CommStat', async () => {
    assert.equal(await ev(`document.getElementById('btn-js8stat').textContent`), 'JS8Stat');
    assert.match(await ev(`document.getElementById('btn-js8stat').title`), /not CommStat/);
    await menu('View', '[data-action="about"]');
    await page.waitFor(`document.querySelector('.cs-dialog')`);
    assert.equal(await ev(`document.querySelector('.cs-dialog-title').textContent`), 'About JS8Stat');
    assert.match(await ev(`document.querySelector('.cs-dialog-body').textContent`), /JS8Stat is not CommStat\..*not a new version of CommStat/s);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  });

  if (process.env.SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
    await click('#btn-js8stat');
    await click('#btn-js8stat');
    await sleep(500);
    await page.screenshot(path.join(process.env.SCREENSHOT_DIR, 'js8stat.png'));
  }

  await t.test('no errors in the browser console', () => {
    assert.deepEqual(page.errors, []);
  });
});
