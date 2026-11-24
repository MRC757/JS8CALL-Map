'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { createRecordStore } = require('../lib/js8stat/store');
const { createJS8Stat }    = require('../lib/js8stat');

const DAY = 24 * 60 * 60 * 1000;
const T0  = Date.UTC(2026, 10, 24, 12, 0);

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-cs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sub', 'js8stat.jsonl');
}

const statrep = (extra = {}) => ({ kind: 'statrep', from: 'K1ABC', target: '@AMRRON', grid: 'EM73', scope: '1',
  srId: 'M00', status: '111111111111', remarks: '', utc: T0, source: 'rf', ...extra });

test('duplicates are kept once (same day, station base call and ID)', () => {
  let clock = T0;
  const sent = [];
  const s = createRecordStore({ now: () => clock, broadcast: p => sent.push(p) });
  assert.ok(s.add(statrep()));
  assert.equal(s.add(statrep({ from: 'K1ABC/P', utc: T0 + 60_000 })), null);
  assert.ok(s.add(statrep({ srId: 'M01' })));
  assert.ok(s.add({ kind: 'message', from: 'K1ABC', target: '@AMRRON', text: 'hello  world', utc: T0 }));
  assert.equal(s.add({ kind: 'message', from: 'K1ABC', target: '@AMRRON', text: 'HELLO WORLD', utc: T0 + 5 }), null);
  assert.equal(s.records.size, 3);
  assert.equal(sent.filter(p => p.type === 'CS_RECORD').length, 3);
});

test('records older than keepDays are refused and pruned', () => {
  let clock = T0;
  const s = createRecordStore({ keepDays: 7, now: () => clock });
  assert.equal(s.add(statrep({ utc: T0 - 8 * DAY })), null);
  s.add(statrep());
  clock = T0 + 7 * DAY + 1;
  assert.equal(s.prune(), 1);
  assert.equal(s.records.size, 0);
});

test('records, acks and deletions survive a restart; the file is compacted', (t) => {
  const file = tmpFile(t);
  let clock = T0;
  const a = createRecordStore({ file, now: () => clock });
  const r1 = a.add(statrep());
  const r2 = a.add(statrep({ srId: 'M05' }));
  a.ack('K1ABC/P', 'M00', 'w1aw');
  a.ack('K1ABC', 'M00', 'W1AW');            // second ack from the same station is a no-op
  a.remove(r2.id);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 4);   // add, add, ack, del

  const b = createRecordStore({ file, now: () => clock });
  assert.equal(b.records.size, 1);
  assert.deepEqual(b.records.get(r1.id).acks, ['W1AW']);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);   // compacted on load
  assert.ok(b.add(statrep({ srId: 'M06' })).id > r2.id, 'ids are never reused');

  clock = T0 + 8 * DAY;
  const c = createRecordStore({ file, now: () => clock });
  assert.equal(c.records.size, 0);
});

test('a torn last line (crash mid-write) is skipped', (t) => {
  const file = tmpFile(t);
  const a = createRecordStore({ file, now: () => T0 });
  a.add(statrep());
  fs.appendFileSync(file, '{"op":"add","rec":{"id":9');
  assert.equal(createRecordStore({ file, now: () => T0 }).records.size, 1);
});

test('an unwritable file is reported once and records stay in memory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-cs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, '');
  const logs = [];
  const s = createRecordStore({ file: path.join(blocker, 'js8stat.jsonl'), now: () => T0, log: m => logs.push(m) });
  s.add(statrep());
  s.add(statrep({ srId: 'M01' }));
  assert.equal(s.records.size, 2);
  assert.equal(logs.length, 1);
});

// ─── The JS8Stat service ────────────────────────────────────────────────────

function service({ connected = true } = {}) {
  let clock = T0;
  const sent = [], js8 = [];
  const records = createRecordStore({ now: () => clock, broadcast: p => sent.push(p) });
  const cs = createJS8Stat({
    broadcast: p => sent.push(p), records,
    getMyStation:  () => ({ callsign: 'W1AW', grid: 'FN31' }),
    lookupStation: c => (c === 'K1ABC' ? { grid: 'FN42AB' } : undefined),
    sendToJS8: async (type, value, params) => { js8.push({ type, value, params }); },
    queryJS8:  async () => ({ type: 'RIG.FREQ', params: { DIAL: 7078000 } }),
    isConnected: () => connected, now: () => clock,
  });
  return { cs, records, sent, js8, tick: ms => { clock += ms; } };
}

test('heard traffic becomes records; acks attach to the report', () => {
  const { cs, records, sent } = service();
  cs.handleHeard({ from: 'K1ABC', text: '@AMRRON ,EM73,2,M00,111211111111,OK,{&%} ♢', kind: 'directed',
                   complete: true, utc: T0, freq: 7078000, snr: -9 });
  cs.handleHeard({ from: 'N0DDK', text: 'N0DDK: @AMRRON RRSR K1ABC,M00', kind: 'activity', complete: false, utc: T0 + 1 });
  const [rec] = records.list();
  assert.equal(rec.snr, -9);
  assert.equal(rec.source, 'rf');
  assert.deepEqual(rec.acks, ['N0DDK']);
  const feed = sent.filter(p => p.type === 'CS_FEED');
  assert.equal(feed.length, 2);
  assert.equal(feed[0].line.text, '@AMRRON ,EM73,2,M00,111211111111,OK,{&%}');
});

test('a report without a grid takes the station\'s heard grid', () => {
  const { cs, records } = service();
  cs.handleHeard({ from: 'K1ABC', text: '@AMRRON F!304 11111111', kind: 'directed', complete: true, utc: T0 });
  assert.equal(records.list()[0].grid, 'FN42AB');
  assert.equal(records.list()[0].gridFromStation, true);
});

test('a station without a grid takes the grid from its own report', () => {
  const grids = [];
  const records = createRecordStore({ now: () => T0 });
  const cs = createJS8Stat({ broadcast: () => {}, records, getMyStation: () => ({ callsign: 'W1AW' }),
    sendToJS8: async () => {}, queryJS8: async () => ({}), onReportGrid: (c, g) => grids.push([c, g]), now: () => T0 });
  cs.handleHeard({ from: 'K1ABC', text: '@AMRRON ,EM73,1,M00,+,,{&%}', kind: 'directed', complete: true, utc: T0 });
  cs.handleHeard({ from: 'K1ABC', text: 'N0DDK: @AMRRON ,EM12,1,M01,+,,{F%}', kind: 'directed', complete: true, utc: T0 });
  assert.deepEqual(grids, [['K1ABC', 'EM73']], 'forwarded reports describe someone else');
});

test('polled band activity does not repeat feed lines', () => {
  const { cs, sent } = service();
  const h = { from: 'K1ABC', text: 'K1ABC: @AMRRON SNR?', kind: 'activity', utc: T0 };
  cs.handleHeard(h);
  cs.handleHeard({ ...h, utc: T0 + 30_000 });
  cs.handleHeard({ ...h, kind: 'band' });   // poll results never go to the feed
  assert.equal(sent.filter(p => p.type === 'CS_FEED').length, 1);
});

test('submit: preview, save, send (with speed), and save-then-send', async () => {
  const { cs, records, js8, tick } = service();
  const data = { target: '@AMRRON', text: 'Net at 2100', msgId: 'P47' };

  const p = await cs.submit({ action: 'preview', form: 'message', data });
  assert.equal(p.text, '@AMRRON MSG ,P47,NET AT 2100,{^%}');
  assert.equal(records.records.size, 0);
  assert.equal(js8.length, 0);

  const s = await cs.submit({ action: 'save', form: 'message', data });
  assert.equal(s.record.source, 'saved');
  await cs.submit({ action: 'save', form: 'message', data });   // saving the draft again replaces it
  assert.equal(records.records.size, 1);

  const r = await cs.submit({ action: 'send', form: 'message', data: { ...data, speed: 'slow' } });
  assert.deepEqual(js8.map(c => c.type), ['MODE.SET_SPEED', 'TX.SEND_MESSAGE']);
  assert.equal(js8[0].params.SPEED, 4);
  assert.equal(js8[1].value, '@AMRRON MSG ,P47,NET AT 2100,{^%}');
  assert.equal(r.record.source, 'sent');
  assert.equal(r.record.freq, 7078000);
  assert.equal(records.records.size, 1, 'the saved copy became the sent one');

  await assert.rejects(cs.submit({ action: 'send', form: 'message', data: { ...data, msgId: 'P48' } }), /wait/);
  tick(6000);
  await cs.submit({ action: 'send', form: 'message', data: { ...data, msgId: 'P48' } });
  assert.equal(js8.filter(c => c.type === 'TX.SEND_MESSAGE').length, 2);
});

test('submit: sending an ack records it against the report', async () => {
  const { cs, records, js8 } = service();
  cs.handleHeard({ from: 'K1ABC', text: '@AMRRON ,EM73,1,M00,+,,{&%}', kind: 'directed', complete: true, utc: T0 });
  await cs.submit({ action: 'send', form: 'ack', data: { target: '@AMRRON', call: 'K1ABC', srId: 'M00' } });
  assert.equal(js8.at(-1).value, 'W1AW: @AMRRON RRSR K1ABC,M00');
  assert.deepEqual(records.list()[0].acks, ['W1AW']);
  await assert.rejects(cs.submit({ action: 'save', form: 'ack', data: { call: 'K1ABC', srId: 'M00' } }), /only be transmitted/);
});

test('submit refuses to send while JS8CALL is disconnected', async () => {
  const { cs, js8 } = service({ connected: false });
  await assert.rejects(cs.submit({ action: 'send', form: 'message', data: { target: '@A1', text: 'x' } }), /not connected/);
  assert.equal(js8.length, 0);
});

// ─── Saved drafts reopened, edited and sent ──────────────────────────────────

test('a reopened draft can be saved again under its ID, replacing the old copy', async () => {
  const { cs, records } = service();
  const first = await cs.submit({ action: 'save', form: 'message', data: { target: '@AMRRON', text: 'first try', msgId: 'M01' } });
  const again = await cs.submit({ action: 'save', form: 'message',
    data: { target: '@AMRRON', text: 'second try', msgId: 'M01', replaceId: first.record.id } });
  assert.equal(records.records.size, 1);
  assert.equal(records.list()[0].text, 'SECOND TRY');
  assert.equal(records.list()[0].id, again.record.id);
  // Re-saving the same ID without saying which draft it replaces also works
  await cs.submit({ action: 'save', form: 'message', data: { target: '@AMRRON', text: 'third', msgId: 'M01' } });
  assert.equal(records.records.size, 1);
});

test('sending a reopened draft replaces it, even on a later day', async () => {
  const { cs, records, js8, tick } = service();
  const draft = await cs.submit({ action: 'save', form: 'statrep', data: { target: '@AMRRON', grid: 'FN31', scope: '1',
    srId: 'M02', status: Object.fromEntries(['map', 'power', 'water', 'medical', 'comms', 'travel', 'internet', 'fuel',
      'food', 'crime', 'civil', 'weather'].map(k => [k, '1'])) } });
  tick(2 * DAY);
  const sent = await cs.submit({ action: 'send', form: 'statrep', data: { ...{ target: '@AMRRON', grid: 'FN31', scope: '1',
    status: Object.fromEntries(['map', 'power', 'water', 'medical', 'comms', 'travel', 'internet', 'fuel',
      'food', 'crime', 'civil', 'weather'].map(k => [k, '2'])) }, srId: 'M02', replaceId: draft.record.id } });
  assert.equal(js8.at(-1).value, 'W1AW: @AMRRON ,FN31,1,M02,222222222222,,{&%}');
  assert.deepEqual(records.list().map(r => [r.srId, r.source]), [['M02', 'sent']]);
  assert.equal(sent.record.status, '222222222222');
});

test('only our own unsent drafts can be replaced', async () => {
  const { cs, records, tick } = service();
  cs.handleHeard({ from: 'K1ABC', text: '@AMRRON MSG ,M03,HELLO,{^%}', kind: 'directed', complete: true, utc: T0 });
  const heard = records.list()[0];
  const sentMsg = await cs.submit({ action: 'send', form: 'message', data: { target: '@AMRRON', text: 'one', msgId: 'M04' } });
  tick(6000);
  // A heard record and an already-sent record are never removed by replaceId
  await cs.submit({ action: 'save', form: 'message', data: { target: '@AMRRON', text: 'x', msgId: 'M05', replaceId: heard.id } });
  await cs.submit({ action: 'save', form: 'message', data: { target: '@AMRRON', text: 'y', msgId: 'M06', replaceId: sentMsg.record.id } });
  assert.ok(records.records.has(heard.id));
  assert.ok(records.records.has(sentMsg.record.id));
  // Nor can a draft overwrite a record that was already sent under the same ID: it gets a new one
  const clash = await cs.submit({ action: 'save', form: 'message', data: { target: '@AMRRON', text: 'z', msgId: 'M04' } });
  assert.notEqual(clash.record.msgId, 'M04');
  assert.equal(records.records.get(sentMsg.record.id).text, 'ONE');
  // A draft of a different kind is not replaced either
  const alertDraft = await cs.submit({ action: 'save', form: 'alert',
    data: { target: '@AMRRON', color: '1', title: 'T', message: 'M', alertId: 'M07' } });
  await cs.submit({ action: 'save', form: 'message', data: { target: '@AMRRON', text: 'w', msgId: 'M08', replaceId: alertDraft.record.id } });
  assert.ok(records.records.has(alertDraft.record.id));
});
