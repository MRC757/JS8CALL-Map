'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const P = require('../lib/js8stat/protocol');

const ctx = (extra = {}) => ({ from: 'K1ABC', myCall: 'W1AW', complete: true, ...extra });

test('timeId: hour letter (no O) plus minute', () => {
  assert.equal(P.timeId(Date.UTC(2026, 0, 1, 0, 5)), 'A05');
  assert.equal(P.timeId(Date.UTC(2026, 0, 1, 14, 47)), 'P47');
  assert.equal(P.timeId(Date.UTC(2026, 0, 1, 23, 59)), 'Y59');
});

test('baseCall strips portable suffixes and prefixes', () => {
  assert.equal(P.baseCall('n0ddk/p'), 'N0DDK');
  assert.equal(P.baseCall('VE3/W1AW'), 'W1AW');
  assert.ok(P.sameCall('W1AW/M', 'W1AW'));
});

test('StatRep from RX.DIRECTED text (no sender prefix)', () => {
  const r = P.decode('@AMRRON ,EM73TU,2,P47,111213111141,POWER OUT ON MAIN ST||WATER OK,{&%} ♢', ctx());
  assert.deepEqual(r, {
    kind: 'statrep', target: '@AMRRON', grid: 'EM73TU', scope: '2', srId: 'P47',
    status: '111213111141', remarks: 'POWER OUT ON MAIN ST||WATER OK', forwarded: false, from: 'K1ABC',
  });
});

test('StatRep from activity text with a (repeated) sender prefix and "+" all-green', () => {
  const r = P.decode('K1ABC: K1ABC: @MAGNET ,FN42,1,B07,+,,{&%}', ctx());
  assert.equal(r.status, '111111111111');
  assert.equal(r.target, '@MAGNET');
  assert.equal(r.remarks, '');
  assert.equal(r.from, 'K1ABC');
});

test('forwarded StatRep is credited to the original sender', () => {
  const r = P.decode('N0DDK: @AMRRON ,EM12,3,C10,333333333333,FLOODING,{F%}', ctx());
  assert.equal(r.from, 'N0DDK');
  assert.equal(r.forwardedBy, 'K1ABC');
  assert.equal(r.forwarded, true);
});

test('internet-only marker is treated as the radio form', () => {
  assert.equal(P.decode('@AMRRON ,EM12,1,C10,+,OK,{&%3}', ctx()).kind, 'statrep');
});

test('invalid StatReps are ignored', () => {
  assert.equal(P.decode('@AMRRON ,EM12,1,C10,12345,BAD,{&%}', ctx()), null);   // short status
  assert.equal(P.decode('@AMRRON ,EM12,1,C10,111111111119,X,{&%}', ctx()), null); // bad digit
  assert.equal(P.decode('@AMRRON ,EM12,1,C10,+,OK', ctx()), null);              // no marker (partial)
});

test('StatRep addressed to another station is ignored; to us is kept', () => {
  assert.equal(P.decode('N0XYZ ,EM12,1,C10,+,OK,{&%}', ctx()), null);
  assert.equal(P.decode('W1AW ,EM12,1,C10,+,OK,{&%}', ctx()).target, 'W1AW');
});

test('incidents: Event and Attack', () => {
  const e = P.decode('@AMRRON ,EM73,6,D22,1,BRIDGE OUT ON HWY 9,{##}', ctx());
  assert.deepEqual({ kind: e.kind, type: e.type, pinned: e.pinned, remarks: e.remarks, grid: e.grid },
                   { kind: 'incident', type: '6', pinned: true, remarks: 'BRIDGE OUT ON HWY 9', grid: 'EM73' });
  assert.equal(P.decode('@AMRRON ,EM73,7,D22,0,SHOTS FIRED,{#3}', ctx()).type, '7');
  assert.equal(P.decode('@AMRRON ,EM73,3,D22,0,NOT AN INCIDENT,{##}', ctx()), null);
});

test('F!304 and F!301 reports become StatReps without a grid', () => {
  const r = P.decode('@AMRRON F!304 11111111 ALL GOOD', ctx());
  assert.equal(r.kind, 'statrep');
  assert.equal(r.grid, '');
  assert.equal(r.status[0], '1');
  assert.match(r.remarks, /^F!304, Landline = Yes/);
  assert.match(r.remarks, / - ALL GOOD$/);
  const bad = P.decode('F!301 433333333', ctx());
  assert.equal(bad.scope, '4');
  assert.equal(bad.status[0], '3');   // high score → red
});

test('alerts: current and older forms', () => {
  assert.deepEqual(P.decode('@AMRRON ,E15,3,TORNADO WARNING,TAKE SHELTER NOW, CELLAR,{%%}', ctx()), {
    kind: 'alert', target: '@AMRRON', alertId: 'E15', color: '3', title: 'TORNADO WARNING',
    message: 'TAKE SHELTER NOW, CELLAR', from: 'K1ABC',
  });
  const old = P.decode('@AMRRON ,2,GRID DOWN,EXPECT OUTAGES,{%%}', ctx());
  assert.equal(old.color, '2');
  assert.equal(old.alertId, '');
});

test('group messages: structured, MSG keyword, RFI flag and plain text', () => {
  const s = P.decode('@AMRRON MSG ,F12,NET TONIGHT AT 2100,{^%}+', ctx());
  assert.deepEqual([s.kind, s.target, s.msgId, s.text, s.rfi], ['message', '@AMRRON', 'F12', 'NET TONIGHT AT 2100', 1]);
  assert.equal(P.decode('@AMRRON MSG CHECKING IN FROM THE VALLEY', ctx()).text, 'CHECKING IN FROM THE VALLEY');
  assert.equal(P.decode('@AMRRON ANYBODY NEED THE AIB REPORT TONIGHT', ctx()).kind, 'message');
});

test('plain messages need a complete transmission; band chatter is ignored', () => {
  assert.equal(P.decode('@AMRRON ANYBODY NEED THE AIB REPORT TONIGHT', ctx({ complete: false })), null);
  assert.equal(P.decode('@ALLCALL CQ CQ CQ DE K1ABC FN42 PLEASE', ctx()), null);
  assert.equal(P.decode('@AMRRON SNR?', ctx()), null);
  assert.equal(P.decode('@HB HEARTBEAT FN42 AND SOME MORE TEXT', ctx()), null);
  // structured messages carry their own terminator, so partial frames are no risk
  assert.equal(P.decode('@AMRRON MSG ,F12,HELLO,{^%}', ctx({ complete: false })).kind, 'message');
});

test('direct messages only when addressed to us', () => {
  assert.equal(P.decode('W1AW MSG ,F12,HELLO THERE,{^%}', ctx()).target, 'W1AW');
  assert.equal(P.decode('N0XYZ MSG ,F12,HELLO THERE,{^%}', ctx()), null);
  assert.equal(P.decode('W1AW MSG HELLO', ctx({ myCall: '' })), null);   // our call not known yet
});

test('RRSR acknowledgements', () => {
  assert.deepEqual(P.decode('K1ABC: @AMRRON RRSR N0DDK,Y26.', ctx()),
    { kind: 'ack', target: '@AMRRON', call: 'N0DDK', srId: 'Y26', from: 'K1ABC' });
  assert.equal(P.decode('N0XYZ RRSR N0DDK,Y26', ctx()), null);   // directed to someone else
});

test('relayed messages to us', () => {
  const r = P.decode('W1AW> MEET AT THE PARK *DE* N0DDK', ctx());
  assert.deepEqual([r.kind, r.from, r.text], ['message', 'N0DDK', 'MEET AT THE PARK - Relayed by: K1ABC']);
  assert.equal(P.decode('N0XYZ> HI *DE* N0DDK', ctx()), null);
});

test('acknowledgements of directed messages: JS8CALL ACK and relayed ACK', () => {
  assert.deepEqual(P.decode('W1AW ACK', ctx()), { kind: 'dack', target: 'W1AW', from: 'K1ABC' });
  assert.deepEqual(P.decode('K1ABC: W1AW ACK ♢', ctx({ complete: false })), { kind: 'dack', target: 'W1AW', from: 'K1ABC' });
  // relayed: K1ABC passed on N0DDK's ACK of our relayed message
  assert.deepEqual(P.decode('W1AW> ACK *DE* N0DDK', ctx()), { kind: 'dack', target: 'W1AW', from: 'N0DDK', via: 'K1ABC' });
  assert.equal(P.decode('N0XYZ ACK', ctx()), null);                // someone else's
  assert.equal(P.decode('N0XYZ> ACK *DE* N0DDK', ctx()), null);
});

test('relay addressing for messages to a callsign', () => {
  const opts = { myCall: 'W1AW', now: Date.UTC(2026, 10, 24, 14, 47) };
  const { text, record } = P.encode('message', { target: 'N0DDK', relay: 'k4abc', text: 'Meet at the park' }, opts);
  assert.equal(text, 'K4ABC> N0DDK MSG ,P47,MEET AT THE PARK,{^%}');
  assert.equal(record.relay, 'K4ABC');
  assert.equal(record.target, 'N0DDK');
  assert.throws(() => P.encode('message', { target: '@AMRRON', relay: 'K4ABC', text: 'x' }, opts), /not to a group/);
  assert.throws(() => P.encode('message', { target: 'N0DDK', relay: 'N0DDK', text: 'x' }, opts), /other than/);
  assert.throws(() => P.encode('message', { target: 'N0DDK', relay: 'W1AW', text: 'x' }, opts), /other than/);
  // What the relay station passes on decodes at the recipient as a message from us
  const passedOn = P.decode('N0DDK> MSG ,P47,MEET AT THE PARK,{^%} *DE* W1AW', { from: 'K4ABC', myCall: 'N0DDK' });
  assert.equal(passedOn.from, 'W1AW');
});

test('airtime estimate matches on-air frame counts', () => {
  // Measured: this status report took 4 frames, the RRSR acknowledgement 3.
  assert.deepEqual(P.estimateAirtime('N0CALL: @AMRRON ,EM73TU,1,T54,+,,{&%}', 0),
    { frames: 4, seconds: 60, speed: 0, speedName: 'Normal' });
  assert.equal(P.estimateAirtime('K1ABC: @AMRRON RRSR N0CALL,T54', 0).frames, 3);
  assert.equal(P.estimateAirtime('@AMRRON MSG ,P47,HI,{^%}', 4).seconds, 3 * 30);   // Slow: 30 s frames
  assert.equal(P.estimateAirtime('@AMRRON MSG ,P47,HI,{^%}', 2).seconds, 3 * 6);    // Turbo: 6 s frames
  assert.equal(P.estimateAirtime('@AMRRON MSG ,P47,HI,{^%}', 8).seconds, null);     // Ultra: varies by version
  assert.ok(P.estimateAirtime('@AMRRON MSG ,P47,' + 'X'.repeat(400) + ',{^%}', 0).frames > 40);
});

test('ordinary JS8 traffic is not JS8Stat traffic', () => {
  for (const t of ['W1AW HEARTBEAT SNR -08 *', 'KM4MGC: @AMRRON SNR?', '@HB HEARTBEAT FN42', 'W1AW SNR -12'])
    assert.equal(P.decode(t, ctx()), null, t);
});

// ─── Encoding ────────────────────────────────────────────────────────────────

const now = Date.UTC(2026, 10, 24, 14, 47);
const allGreen = Object.fromEntries(P.STATUS_FIELDS.map(k => [k, '1']));

test('encode StatRep: all green compresses to "+", round-trips through decode', () => {
  const { text, record } = P.encode('statrep',
    { target: 'amrron', grid: 'em73tu', scope: '2', status: allGreen, remarks: 'all good\nwater, ok' },
    { myCall: 'W1AW', now });
  assert.equal(text, 'W1AW: @AMRRON ,EM73TU,2,P47,+,ALL GOOD||WATER OK,{&%}');
  assert.equal(record.status, '111111111111');
  const back = P.decode(text, { from: 'W1AW', myCall: 'K1ABC' });
  assert.equal(back.remarks, 'ALL GOOD||WATER OK');
  assert.equal(back.srId, 'P47');
});

test('encode StatRep validation', () => {
  const opts = { myCall: 'W1AW', now };
  assert.throws(() => P.encode('statrep', { target: '@AMRRON', grid: 'EM73', scope: '1', status: {} }, opts), /colour/);
  assert.throws(() => P.encode('statrep', { target: '@AMRRON', grid: 'ZZ99', scope: '1', status: allGreen }, opts), /grid/);
  assert.throws(() => P.encode('statrep', { target: '', grid: 'EM73', scope: '1', status: allGreen }, opts), /group/);
  assert.throws(() => P.encode('statrep', { target: '@AMRRON', grid: 'EM73', scope: '1', status: allGreen }, { now }), /callsign/);
  assert.throws(() => P.encode('statrep', { target: '@AMRRON', grid: 'EM73', scope: '1', status: allGreen,
    remarks: 'x'.repeat(501) }, opts), /limit is 500/);
});

test('encode alert, message, incident and ack', () => {
  const opts = { myCall: 'W1AW', now };
  assert.equal(P.encode('alert', { target: '@AMRRON', color: '3', title: 'Storm, big', message: 'Seek shelter, now' }, opts).text,
    'W1AW: @AMRRON ,P47,3,STORM BIG,SEEK SHELTER, NOW,{%%}');
  assert.equal(P.encode('message', { target: '@AMRRON', text: 'Net at 2100{x}' }, opts).text,
    '@AMRRON MSG ,P47,NET AT 2100 X,{^%}');
  assert.equal(P.encode('incident', { target: '@AMRRON', grid: 'EM73', type: '6', pinned: true, remarks: 'Bridge out' }, opts).text,
    'W1AW: @AMRRON ,EM73,6,P47,1,BRIDGE OUT,{##}');
  assert.equal(P.encode('ack', { target: '@AMRRON', call: 'K1ABC', srId: 'B07' }, opts).text,
    'W1AW: @AMRRON RRSR K1ABC,B07');
  assert.equal(P.encode('ack', { target: 'W1AW', call: 'K1ABC', srId: 'B07' }, opts).text,
    'W1AW: K1ABC RRSR K1ABC,B07');
  for (const [form, data] of [['alert', { target: '@A1', color: '3', title: 'X', message: 'Y' }],
                              ['message', { target: '@A1', text: 'Y' }],
                              ['incident', { target: '@A1', grid: 'EM73', type: '7', remarks: 'Y' }]]) {
    const { text } = P.encode(form, data, opts);
    assert.equal(P.decode(text, { from: 'W1AW', myCall: 'K1ABC' }).kind, form, text);
  }
});

test('a client-supplied ID is used only when it is well formed', () => {
  const opts = { myCall: 'W1AW', now };
  assert.match(P.encode('message', { target: '@A1', text: 'hi', msgId: 'B12' }, opts).text, /,B12,/);
  assert.match(P.encode('message', { target: '@A1', text: 'hi', msgId: 'B12,{&%}' }, opts).text, /,P47,/);
});
