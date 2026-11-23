'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const S      = require('../lib/station-store');

const MIN  = 60_000;
const HOUR = 60 * MIN;

/** A store with a controllable clock that records every broadcast. */
function harness(opts = {}) {
  const sent  = [];
  const clock = { t: 1_750_000_000_000 };
  const store = S.createStationStore({ broadcast: p => sent.push(p), now: () => clock.t, ...opts });
  const of    = type => sent.filter(p => p.type === type);
  return { store, sent, clock, of };
}

const callActivity = (entries) => ({ type: 'RX.CALL_ACTIVITY', value: '', params: { CALL_ACTIVITY: entries } });
const bandActivity = (entries) => ({ type: 'RX.BAND_ACTIVITY', value: '', params: { BAND_ACTIVITY: entries } });

// ── helpers ───────────────────────────────────────────────────────────────────

test('isValidCallsign requires a digit and sane characters', () => {
  for (const c of ['W1AW', 'KN4CRD', 'VE3/W1AW', 'W1AW/P', '9A1A']) assert.ok(S.isValidCallsign(c), c);
  for (const c of ['CQ', 'GRID', '@ALLCALL', 'W', '', 'W1AW!', 'ABCDEFGHIJKL9X']) assert.ok(!S.isValidCallsign(c), c);
});

test('parseBandText handles "CALL: text" and "CALL text"', () => {
  assert.deepEqual(S.parseBandText('KN4CRD: @ALLCALL CQ CQ'), { callsign: 'KN4CRD', text: 'KN4CRD: @ALLCALL CQ CQ' });
  assert.equal(S.parseBandText('W1AW HELLO').callsign, 'W1AW');
  assert.equal(S.parseBandText('  w1aw: hi ').callsign, 'W1AW');
  assert.equal(S.parseBandText('CQ CQ CQ'), null);     // no digit → not a callsign
  assert.equal(S.parseBandText('@ALLCALL: hi'), null);
  assert.equal(S.parseBandText(''), null);
  assert.equal(S.parseBandText(undefined), null);
});

test('gridFromText, toFreq, toOffset, toEpochMs', () => {
  assert.equal(S.gridFromText('W1AW: @APRSIS GRID fn31pr'), 'FN31PR');
  assert.equal(S.gridFromText('GRID EM73'), 'EM73');
  assert.equal(S.gridFromText('GRIDLOCK ZZ99'), null);
  assert.equal(S.toFreq(7078000), 7078000);
  assert.equal(S.toFreq(500), undefined);
  assert.equal(S.toFreq('abc'), undefined);
  assert.equal(S.toOffset(1500), 1500);
  assert.equal(S.toOffset(9000), undefined);
  const now = 2_000_000_000_000;
  assert.equal(S.toEpochMs(now - 5000, now), now - 5000);
  assert.equal(S.toEpochMs(1_900_000_000, now), 1_900_000_000_000);   // seconds → ms
  assert.equal(S.toEpochMs(now + HOUR, now), now);                    // future → now
  assert.equal(S.toEpochMs(undefined, now), now);
});

// ── recommendation 1: polling must not duplicate or keep stations alive ───────

test('re-polled band activity does not duplicate messages', () => {
  const { store, of, clock } = harness();
  const poll = bandActivity({
    1500: { DIAL: 7078000, OFFSET: 1500, SNR: -5, TEXT: 'KN4CRD: @ALLCALL CQ CQ ♢', UTC: clock.t - 20_000 },
    1720: { DIAL: 7078000, OFFSET: 1720, SNR: -12, TEXT: 'W1AW: KN4CRD SNR -05', UTC: clock.t - 10_000 },
  });
  store.processMessage(poll);
  for (let i = 0; i < 5; i++) { clock.t += 30_000; store.processMessage(poll); }

  assert.equal(store.stations.get('KN4CRD').messages.length, 1);
  assert.equal(store.stations.get('W1AW').messages.length, 1);
  assert.equal(of('NEW_MESSAGE').length, 2);
  assert.equal(of('STATION_UPDATE').length, 2, 'unchanged re-polls broadcast nothing');
});

test('live RX.ACTIVITY followed by the same text in a poll is stored once', () => {
  const { store, clock } = harness();
  store.processMessage({ type: 'RX.ACTIVITY', value: 'KN4CRD: HELLO ',
    params: { FROM: 'KN4CRD', TEXT: 'KN4CRD: HELLO ', UTC: clock.t, DIAL: 7078000, OFFSET: 1500, SNR: -3 } });
  clock.t += 30_000;
  store.processMessage(bandActivity({ 1500: { TEXT: 'KN4CRD: HELLO ♢', UTC: clock.t - 29_000 } }));
  assert.equal(store.stations.get('KN4CRD').messages.length, 1);
});

test('lastHeard comes from JS8CALL UTC, so polled stations still expire', () => {
  const { store, clock, of } = harness({ ttl: HOUR });
  const heard = clock.t;
  const poll  = callActivity({ W1AW: { GRID: 'FN31', SNR: -10, UTC: heard } });

  store.processMessage(poll);
  // Keep polling for 61 minutes; JS8CALL keeps reporting the same old UTC.
  for (let m = 1; m <= 61; m++) {
    clock.t = heard + m * MIN;
    store.processMessage(poll);
    store.expire();
  }
  assert.equal(store.stations.has('W1AW'), false);
  assert.deepEqual(of('STATION_EXPIRED').map(p => p.callsign), ['W1AW']);

  // And further polls must not bring it back.
  clock.t += 30_000;
  store.processMessage(poll);
  assert.equal(store.stations.has('W1AW'), false);
});

test('a newer UTC refreshes lastHeard; an older one never moves it back', () => {
  const { store, clock } = harness();
  store.processMessage(callActivity({ W1AW: { UTC: clock.t } }));
  store.processMessage(callActivity({ W1AW: { UTC: clock.t - 10 * MIN } }));
  assert.equal(store.stations.get('W1AW').lastHeard, clock.t);
  clock.t += MIN;
  store.processMessage(callActivity({ W1AW: { UTC: clock.t } }));
  assert.equal(store.stations.get('W1AW').lastHeard, clock.t);
});

test('an older polled report does not overwrite fresher live readings', () => {
  const { store, clock } = harness();
  store.processMessage({ type: 'RX.ACTIVITY', params: { FROM: 'W1AW', TEXT: 'HI', SNR: -1, OFFSET: 1500, UTC: clock.t } });
  store.processMessage(callActivity({ W1AW: { SNR: -20, OFFSET: 900, GRID: 'FN31', UTC: clock.t - 5 * MIN } }));
  const s = store.stations.get('W1AW');
  assert.equal(s.snr, -1);
  assert.equal(s.offset, 1500);
  assert.equal(s.grid, 'FN31', 'grid is still filled in when we had none');
});

test('the same text after the dedupe window is kept as a new message', () => {
  const { store, clock } = harness({ dedupeWindow: 10 * MIN });
  const send = () => store.processMessage({ type: 'RX.ACTIVITY',
    params: { FROM: 'W1AW', TEXT: 'W1AW: @ALLCALL CQ', UTC: clock.t } });
  send(); clock.t += 5 * MIN; send(); clock.t += 11 * MIN; send();
  assert.equal(store.stations.get('W1AW').messages.length, 2);
});

test('messages stay newest-first and are capped', () => {
  const { store, clock } = harness({ maxMessages: 3 });
  const at = (t, text) => store.processMessage({ type: 'RX.ACTIVITY', params: { FROM: 'W1AW', TEXT: text, UTC: t } });
  at(clock.t - 3000, 'B');
  at(clock.t - 1000, 'D');
  at(clock.t - 4000, 'A');   // arrives late
  at(clock.t - 2000, 'C');
  assert.deepEqual(store.stations.get('W1AW').messages.map(m => m.text), ['D', 'C', 'B']);
});

test('long message text is truncated', () => {
  const { store } = harness({ maxMsgText: 10 });
  store.processMessage({ type: 'RX.ACTIVITY', params: { FROM: 'W1AW', TEXT: 'X'.repeat(50) } });
  assert.equal(store.stations.get('W1AW').messages[0].text, 'X'.repeat(10) + '…');
});

// ── recommendation 4: band activity parsing ───────────────────────────────────

test('band activity "CALL: text" lines create stations with frequency data', () => {
  const { store, clock } = harness();
  store.processMessage(bandActivity({
    1500: { DIAL: 14078000, FREQ: 14079500, OFFSET: 1500, SNR: -7, TEXT: 'KN4CRD: @ALLCALL GRID EM73', UTC: clock.t },
    900:  { DIAL: 14078000, OFFSET: 900,  SNR: -20, TEXT: '@ALLCALL CQ', UTC: clock.t },
  }));
  const s = store.stations.get('KN4CRD');
  assert.ok(s);
  assert.equal(s.grid, 'EM73');
  assert.equal(s.freq, 14078000);
  assert.equal(s.offset, 1500);
  assert.equal(s.snr, -7);
  assert.equal(s.messages[0].kind, 'band');
  assert.equal(store.stations.size, 1);
});

// ── recommendations 5 & 6: validation on every path ───────────────────────────

test('invalid grids are ignored, valid ones accepted', () => {
  const { store } = harness();
  store.processMessage({ type: 'RX.SPOT', params: { CALL: 'W1AW', FROM: 'W1AW', GRID: 'ZZ99' } });
  assert.equal(store.stations.get('W1AW').grid, undefined);
  store.processMessage({ type: 'RX.SPOT', params: { FROM: 'W1AW', GRID: ' fn31 ' } });
  assert.equal(store.stations.get('W1AW').grid, 'FN31');
  store.processMessage({ type: 'RX.SPOT', params: { FROM: 'W1AW', GRID: '?' } });
  assert.equal(store.stations.get('W1AW').grid, 'FN31', 'bad grid does not overwrite a good one');
});

test('call activity applies frequency and offset range checks', () => {
  const { store } = harness();
  store.processMessage(callActivity({
    W1AW:   { DIAL: 7078000, OFFSET: 1500, SNR: -3 },
    KN4CRD: { DIAL: 42,      OFFSET: 99999, SNR: 'x' },
  }));
  assert.equal(store.stations.get('W1AW').freq, 7078000);
  assert.equal(store.stations.get('W1AW').offset, 1500);
  const k = store.stations.get('KN4CRD');
  assert.equal(k.freq, undefined);
  assert.equal(k.offset, undefined);
  assert.equal(k.snr, undefined);
});

test('bad input never throws or creates junk stations', () => {
  const { store } = harness();
  for (const raw of ['not json', '{}', 'null', '[]', JSON.stringify({ type: 'RX.SPOT' }),
                     JSON.stringify({ type: 'RX.CALL_ACTIVITY', params: { CALL_ACTIVITY: { CQ: {}, W1AW: null } } }),
                     JSON.stringify({ type: 'RX.BAND_ACTIVITY', params: { BAND_ACTIVITY: { 1: null, 2: { TEXT: 5 } } } })]) {
    assert.doesNotThrow(() => store.processMessage(raw), raw);
  }
  assert.equal(store.stations.size, 0);
});

// ── my station ────────────────────────────────────────────────────────────────

test('MY_STATION is broadcast only when the value changes', () => {
  const { store, of } = harness();
  store.processMessage({ type: 'STATION.CALLSIGN', value: 'w1aw ' });
  store.processMessage({ type: 'STATION.CALLSIGN', value: 'W1AW' });
  store.processMessage({ type: 'STATION.GRID', value: 'FN31pr' });
  store.processMessage({ type: 'STATION.GRID', value: 'FN31PR' });
  store.processMessage({ type: 'STATION.GRID', value: 'garbage' });
  assert.equal(of('MY_STATION').length, 2);
  assert.deepEqual(store.myStation, { callsign: 'W1AW', grid: 'FN31PR' });
});

test('snapshot contains stations, my station and maxMessages', () => {
  const { store } = harness({ maxMessages: 42 });
  store.processMessage({ type: 'RX.SPOT', params: { FROM: 'W1AW', GRID: 'FN31' } });
  const snap = store.snapshot();
  assert.equal(snap.stations.length, 1);
  assert.equal(snap.maxMessages, 42);
  assert.ok('callsign' in snap.myStation);
});
