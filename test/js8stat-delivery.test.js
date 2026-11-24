'use strict';

// Getting traffic through without the internet: acknowledgements and resending,
// airtime estimates, relay suggestions, the group roster and membership check,
// and the PC clock check.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { createRecordStore } = require('../lib/js8stat/store');
const { createJS8Stat }     = require('../lib/js8stat');

const T0  = Date.UTC(2026, 10, 24, 12, 0);
const MIN = 60_000;
const allGreen = Object.fromEntries(['map', 'power', 'water', 'medical', 'comms', 'travel', 'internet', 'fuel',
  'food', 'crime', 'civil', 'weather'].map(k => [k, '1']));

function service({ speed = 0, file = null } = {}) {
  let clock = T0;
  const sent = [], js8 = [];
  const records = createRecordStore({ file, now: () => clock, broadcast: p => sent.push(p) });
  const cs = createJS8Stat({
    broadcast: p => sent.push(p), records,
    getMyStation: () => ({ callsign: 'W1AW', grid: 'FN31' }),
    sendToJS8: async (type, value, params) => { js8.push({ type, value, params }); },
    queryJS8: async type => (type === 'MODE.GET_SPEED'
      ? { type: 'MODE.SPEED', params: { SPEED: speed } }
      : { type: 'RIG.FREQ', params: { DIAL: 7078000 } }),
    isConnected: () => true, now: () => clock,
  });
  const heard = (from, text, extra = {}) =>
    cs.handleHeard({ from, text, kind: 'directed', complete: true, utc: clock, snr: -10, ...extra });
  return { cs, records, sent, js8, heard, tick: ms => { clock += ms; }, now: () => clock };
}

// ─── 1. Acknowledgements and resending ───────────────────────────────────────

test('sent records remember their exact text and whether an ack is expected', async () => {
  const { cs } = service();
  const sr = await cs.submit({ action: 'send', form: 'statrep',
    data: { target: '@AMRRON', grid: 'FN31', scope: '1', srId: 'M00', status: allGreen } });
  assert.equal(sr.record.wire, 'W1AW: @AMRRON ,FN31,1,M00,+,,{&%}');
  assert.equal(sr.record.ackExpected, true);
  assert.equal(sr.record.resends, 0);
});

test('which sent traffic expects an acknowledgement', async () => {
  const { cs, tick } = service();
  const send = async (form, data) => { tick(6000); return (await cs.submit({ action: 'send', form, data })).record; };
  assert.equal((await send('message', { target: '@AMRRON', text: 'net at 9', msgId: 'M01' })).ackExpected, false);
  assert.equal((await send('message', { target: 'K1ABC', text: 'hello', msgId: 'M02' })).ackExpected, true);
  assert.equal((await send('alert', { target: '@AMRRON', color: '1', title: 'T', message: 'M', alertId: 'M03' })).ackExpected, false);
  assert.equal((await send('incident', { target: '@AMRRON', grid: 'FN31', type: '6', remarks: 'X', srId: 'M04' })).ackExpected, true);
});

test('JS8CALL\'s ACK reply credits the latest message we sent to that station', async () => {
  const { cs, records, heard, tick } = service();
  const { record } = await cs.submit({ action: 'send', form: 'message', data: { target: 'K1ABC', text: 'hello', msgId: 'M05' } });
  tick(2 * MIN);
  heard('N0XYZ', 'W1AW ACK');         // a different station: not for this message
  heard('K1ABC', 'N0XYZ ACK');        // K1ABC acking someone else
  assert.deepEqual(records.records.get(record.id).acks, []);
  heard('K1ABC', 'W1AW ACK');
  assert.deepEqual(records.records.get(record.id).acks, ['K1ABC']);
  // Too late to count: 40 minutes after sending
  tick(6000);
  const second = (await cs.submit({ action: 'send', form: 'message', data: { target: 'K4ABC', text: 'hi', msgId: 'M06' } })).record;
  tick(40 * MIN);
  heard('K4ABC', 'W1AW ACK');
  assert.deepEqual(records.records.get(second.id).acks, []);
});

test('a relayed message is acknowledged through the relay', async () => {
  const { cs, records, heard, tick } = service();
  const { record, text } = await cs.submit({ action: 'send', form: 'message',
    data: { target: 'N0DDK', relay: 'K4ABC', text: 'meet at noon', msgId: 'M07' } });
  assert.equal(text, 'K4ABC> N0DDK MSG ,M07,MEET AT NOON,{^%}');
  tick(5 * MIN);
  heard('K4ABC', 'W1AW> ACK *DE* N0DDK');
  assert.deepEqual(records.records.get(record.id).acks, ['N0DDK']);
});

test('resend: preview, then the same text again; the count survives a restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-dlv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'js8stat.jsonl');
  const { cs, records, js8, tick } = service({ file });
  const { record } = await cs.submit({ action: 'send', form: 'statrep',
    data: { target: '@AMRRON', grid: 'FN31', scope: '1', srId: 'M08', status: allGreen } });

  const preview = await cs.resend(record.id, { preview: true });
  assert.equal(preview.text, record.wire);
  assert.equal(preview.airtime.frames, 4);   // same shape as the real T54 report: 4 frames
  assert.equal(js8.filter(c => c.type === 'TX.SEND_MESSAGE').length, 1, 'a preview sends nothing');

  await assert.rejects(cs.resend(record.id), /wait/);
  tick(20 * MIN);
  const again = await cs.resend(record.id);
  assert.equal(js8.at(-1).value, record.wire);
  assert.equal(again.record.resends, 1);
  assert.equal(again.record.lastTx, T0 + 20 * MIN);

  const reloaded = createRecordStore({ file, now: () => T0 + 21 * MIN });
  assert.equal(reloaded.records.get(record.id).resends, 1);
  assert.equal(reloaded.records.get(record.id).lastTx, T0 + 20 * MIN);
  assert.equal(records.records.size, 1, 'resending adds no new record');
});

test('only our own transmitted records can be resent', async () => {
  const { cs, records, heard } = service();
  heard('K1ABC', '@AMRRON ,EM73,1,M09,+,,{&%}');
  const saved = await cs.submit({ action: 'save', form: 'message', data: { target: '@AMRRON', text: 'draft', msgId: 'M10' } });
  for (const id of [records.list()[0].id, saved.record.id, 999]) {
    await assert.rejects(cs.resend(id), /Only records transmitted from this station/);
  }
});

// ─── 2. Airtime ──────────────────────────────────────────────────────────────

test('preview gives airtime at the chosen speed, or JS8CALL\'s current speed', async () => {
  const { cs } = service({ speed: 4 });   // JS8CALL is on Slow
  const data = { target: '@AMRRON', text: 'net at 9', msgId: 'M11' };
  const current = await cs.submit({ action: 'preview', form: 'message', data });
  assert.deepEqual([current.airtime.speedName, current.airtime.speedSource], ['Slow', 'js8call']);
  assert.equal(current.airtime.seconds, current.airtime.frames * 30);
  const turbo = await cs.submit({ action: 'preview', form: 'message', data: { ...data, speed: 'turbo' } });
  assert.deepEqual([turbo.airtime.speedName, turbo.airtime.speedSource, turbo.airtime.seconds],
                   ['Turbo', 'chosen', turbo.airtime.frames * 6]);
});

// ─── 3. Relay routing ────────────────────────────────────────────────────────

test('relay suggestions come from who has reported hearing whom', () => {
  const { cs, heard, tick } = service();
  // K4ABC reports hearing us; N0DDK reports hearing K4ABC; nobody links us to N0DDK directly
  heard('K4ABC', 'W1AW SNR -08');
  heard('N0DDK', 'K4ABC HEARTBEAT SNR -12');
  // N4XYZ: we hear it (weaker evidence for the first hop) and it hears N0DDK
  heard('N4XYZ', 'N0DDK SNR -20', { snr: -18 });
  tick(5 * MIN);
  const r = cs.routes('n0ddk');
  assert.equal(r.direct.targetHearsMe, null);
  assert.equal(r.relays[0].call, 'K4ABC');
  assert.deepEqual(r.relays[0].toRelay, { dir: 'hears', snr: -8, minutesAgo: 5 });
  assert.deepEqual(r.relays[0].toTarget.dir, 'hears');
  assert.ok(r.relays.some(x => x.call === 'N4XYZ'), 'weaker evidence still listed');
  assert.ok(!r.relays.some(x => x.call === 'W1AW' || x.call === 'N0DDK'));
});

test('a direct path is reported, and evidence older than three hours is dropped', () => {
  const { cs, heard, tick } = service();
  heard('N0DDK', 'W1AW SNR -15');
  assert.equal(cs.routes('N0DDK').direct.targetHearsMe.snr, -15);
  tick(3 * 60 * MIN + 1);
  const later = cs.routes('N0DDK');
  assert.equal(later.direct.targetHearsMe, null);
  assert.deepEqual(later.relays, []);
});

// ─── 4. Group roster ─────────────────────────────────────────────────────────

test('roster: who was heard on each group, and with what', () => {
  const { cs, sent, heard, tick } = service();
  heard('K1ABC', '@AMRRON SNR?', { kind: 'activity' });
  tick(MIN);
  heard('K4ABC', '@AMRRON ,EM73,1,M12,+,,{&%}', { to: '@AMRRON' });
  heard('N0DDK', '@ALLCALL CQ CQ CQ', { kind: 'activity' });   // band chatter is not a group roster
  const act = cs.snapshot().activity;
  assert.deepEqual(Object.keys(act), ['@AMRRON']);
  assert.equal(act['@AMRRON'].K1ABC.kind, 'traffic');
  assert.equal(act['@AMRRON'].K4ABC.kind, 'statrep');
  assert.ok(sent.some(p => p.type === 'CS_ACTIVITY' && p.call === 'K4ABC' && p.kind === 'statrep'));
});

// ─── 10. JS8CALL group membership ────────────────────────────────────────────

test('warns about a group heard only in partial frames (not added in JS8CALL)', () => {
  const { cs, sent, heard } = service();
  for (const call of ['K1ABC', 'K4ABC', 'N0DDK']) heard(call, `${call}: @GHOSTNET NET TONIGHT AT 9`, { kind: 'activity', complete: false });
  assert.deepEqual(cs.groupWarnings(), ['@GHOSTNET']);
  assert.deepEqual(sent.filter(p => p.type === 'CS_GROUPS').at(-1).warnings, ['@GHOSTNET']);
  // One whole message for the group proves we are a member
  heard('K1ABC', '@GHOSTNET NET TONIGHT AT 9', { to: '@GHOSTNET' });
  assert.deepEqual(cs.groupWarnings(), []);
  assert.deepEqual(sent.filter(p => p.type === 'CS_GROUPS').at(-1).warnings, []);
});

test('members are not warned: each transmission arrives both as activity and complete', () => {
  const { cs, heard } = service();
  for (let i = 0; i < 4; i++) {
    heard('K1ABC', 'K1ABC: @AMRRON SNR?', { kind: 'activity', complete: false });
    heard('K1ABC', '@AMRRON SNR?', { to: '@AMRRON' });
  }
  assert.deepEqual(cs.groupWarnings(), []);
});

// ─── 5. Clock check ──────────────────────────────────────────────────────────

test('clock check: median decode offset, needs enough samples, forgets old ones', () => {
  const { cs, sent, heard, tick } = service();
  const decode = v => heard('K1ABC', 'K1ABC: @HB HEARTBEAT FN42', { kind: 'activity', tdrift: v });
  for (const v of [0.1, -0.2, 0.0, 0.15]) decode(v);
  assert.equal(cs.clockStatus().status, 'unknown');
  decode(0.05);
  assert.deepEqual(cs.clockStatus(), { status: 'ok', offset: 0.1, samples: 5 });

  tick(20 * MIN);                                  // old samples expire
  for (const v of [1.4, 1.5, 1.3, 1.6, 9.0]) decode(v);   // one wild station doesn't move the median
  assert.deepEqual(cs.clockStatus(), { status: 'warn', offset: 1.5, samples: 5 });
  assert.equal(sent.filter(p => p.type === 'CS_CLOCK').at(-1).clock.status, 'warn');

  tick(20 * MIN);
  for (let i = 0; i < 6; i++) decode(-2.4);
  assert.equal(cs.clockStatus().status, 'bad');
  // Polled activity (re-reported decodes) is not used
  tick(20 * MIN);
  for (let i = 0; i < 6; i++) heard('K1ABC', 'x', { kind: 'band', tdrift: 5 });
  assert.equal(cs.clockStatus().status, 'unknown');
});

test('two messages sent in the same minute both keep a record (the second gets a new ID)', async () => {
  const { cs, records, js8, tick } = service();
  const a = await cs.submit({ action: 'send', form: 'message', data: { target: '@AMRRON', text: 'first', msgId: 'M20' } });
  tick(6000);
  const b = await cs.submit({ action: 'send', form: 'message', data: { target: '@AMRRON', text: 'second', msgId: 'M20' } });
  assert.equal(a.record.msgId, 'M20');
  assert.ok(b.record, 'second message recorded');
  assert.notEqual(b.record.msgId, 'M20');
  assert.equal(js8.at(-1).value, `@AMRRON MSG ,${b.record.msgId},SECOND,{^%}`, 'the new ID is the one transmitted');
  assert.equal(records.records.size, 2);
});
