'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const S      = require('../lib/station-store');

function harness() {
  const sent  = [];
  const clock = { t: 1_750_000_000_000 };
  const store = S.createStationStore({ broadcast: p => sent.push(p), now: () => clock.t });
  return { store, sent, clock, of: type => sent.filter(p => p.type === type) };
}

const directed = (from, text, utc, extra = {}) =>
  ({ type: 'RX.DIRECTED', params: { FROM: from, TEXT: text, UTC: utc, ...extra } });

test('addresseeOf finds the callsign a message is sent to', () => {
  assert.equal(S.addresseeOf('KN4CRD: KJ4QEO SNR -05'), 'KJ4QEO');
  assert.equal(S.addresseeOf('KN4CRD KJ4QEO HELLO', 'KN4CRD'), 'KJ4QEO');
  assert.equal(S.addresseeOf('KJ4QEO: HELLO'), '');                  // after the colon: "HELLO" isn't a call
  assert.equal(S.addresseeOf('KN4CRD: @ALLCALL CQ CQ'), '');         // group call
  assert.equal(S.addresseeOf('KN4CRD: KJ4QEO: GRID FM16'), 'KJ4QEO');
  assert.equal(S.addresseeOf(''), '');
});

test('parseSnrReport handles plain, heartbeat and ack forms', () => {
  assert.deepEqual(S.parseSnrReport('KN4CRD: KJ4QEO SNR -05 ♢'), { to: 'KJ4QEO', snr: -5 });
  assert.deepEqual(S.parseSnrReport('KN4CRD: KJ4QEO HEARTBEAT SNR -12'), { to: 'KJ4QEO', snr: -12 });
  assert.deepEqual(S.parseSnrReport('KN4CRD: KJ4QEO ACK SNR +03'), { to: 'KJ4QEO', snr: 3 });
  assert.equal(S.parseSnrReport('KN4CRD: KJ4QEO HELLO'), null);
  assert.equal(S.parseSnrReport('KN4CRD: @HB HEARTBEAT EM73'), null);
  assert.equal(S.parseSnrReport('KN4CRD: KJ4QEO SNRX 5'), null);
});

test('a report addressed to us sets heardMe; reports to others do not', () => {
  const { store, clock, of } = harness();
  store.processMessage({ type: 'STATION.CALLSIGN', value: 'KJ4QEO' });
  store.processMessage(directed('KN4CRD', 'KN4CRD: KJ4QEO SNR -05', clock.t, { TO: 'KJ4QEO' }));
  store.processMessage(directed('W1AW',   'W1AW: K1ABC SNR -10',     clock.t, { TO: 'K1ABC' }));

  assert.deepEqual(store.stations.get('KN4CRD').heardMe, { snr: -5, at: clock.t });
  assert.equal(store.stations.get('W1AW').heardMe, undefined);
  assert.ok(of('STATION_UPDATE').some(p => p.station.callsign === 'KN4CRD' && p.station.heardMe));
});

test('band activity reports count too, and fill in the message addressee', () => {
  const { store, clock } = harness();
  store.processMessage({ type: 'STATION.CALLSIGN', value: 'KJ4QEO' });
  store.processMessage({ type: 'RX.BAND_ACTIVITY', params: { BAND_ACTIVITY: {
    1500: { TEXT: 'KN4CRD: KJ4QEO HEARTBEAT SNR -12 ♢', UTC: clock.t, SNR: -9 } } } });
  const s = store.stations.get('KN4CRD');
  assert.equal(s.heardMe.snr, -12);
  assert.equal(s.messages[0].to, 'KJ4QEO');
});

test('newer reports replace older ones; older ones are ignored', () => {
  const { store, clock } = harness();
  store.processMessage({ type: 'STATION.CALLSIGN', value: 'KJ4QEO' });
  store.processMessage(directed('KN4CRD', 'KN4CRD: KJ4QEO SNR -05', clock.t));
  store.processMessage(directed('KN4CRD', 'KN4CRD: KJ4QEO SNR -15', clock.t - 60_000));
  assert.equal(store.stations.get('KN4CRD').heardMe.snr, -5);
  store.processMessage(directed('KN4CRD', 'KN4CRD: KJ4QEO SNR +02', clock.t + 60_000));
  assert.equal(store.stations.get('KN4CRD').heardMe.snr, 2);
});

test('repeated polls of the same report do not re-broadcast', () => {
  const { store, clock, of } = harness();
  store.processMessage({ type: 'STATION.CALLSIGN', value: 'KJ4QEO' });
  const poll = { type: 'RX.BAND_ACTIVITY', params: { BAND_ACTIVITY: {
    1500: { TEXT: 'KN4CRD: KJ4QEO SNR -05', UTC: clock.t } } } };
  store.processMessage(poll);
  const before = of('STATION_UPDATE').length;
  store.processMessage(poll);
  store.processMessage(poll);
  assert.equal(of('STATION_UPDATE').length, before);
});

test('reports received before our callsign was known are picked up once it is', () => {
  const { store, clock, of } = harness();
  store.processMessage(directed('KN4CRD', 'KN4CRD: KJ4QEO SNR -05', clock.t));
  assert.equal(store.stations.get('KN4CRD').heardMe, undefined);

  store.processMessage({ type: 'STATION.CALLSIGN', value: 'KJ4QEO' });
  assert.deepEqual(store.stations.get('KN4CRD').heardMe, { snr: -5, at: clock.t });
  assert.ok(of('STATION_UPDATE').some(p => p.station.callsign === 'KN4CRD' && p.station.heardMe));

  // Changing callsign clears reports that were about the old one
  store.processMessage({ type: 'STATION.CALLSIGN', value: 'W1AW' });
  assert.equal(store.stations.get('KN4CRD').heardMe, undefined);
  const last = of('STATION_UPDATE').at(-1);
  assert.equal(last.station.heardMe, null, 'tells clients to clear it');
});

test('RX.SPOT names the station in CALL; RX.ACTIVITY without FROM uses the text prefix', () => {
  const { store, clock } = harness();
  store.processMessage({ type: 'RX.SPOT', params: { CALL: 'KC1PHY', GRID: 'FN42DL', SNR: -14, DIAL: 7078000 } });
  assert.equal(store.stations.get('KC1PHY').grid, 'FN42DL');

  store.processMessage({ type: 'RX.ACTIVITY', value: 'W3DOF: @ALLCALL GRID FM28 ♢ ',
    params: { DIAL: 7078000, OFFSET: 1400, SNR: 2, UTC: clock.t } });
  const w = store.stations.get('W3DOF');
  assert.ok(w, 'station taken from the "CALL:" prefix');
  assert.equal(w.grid, 'FM28');
  assert.equal(w.messages.length, 1);

  // Text that doesn't start with a callsign is still ignored
  store.processMessage({ type: 'RX.ACTIVITY', value: '@ALLCALL CQ', params: { UTC: clock.t } });
  assert.equal(store.stations.size, 2);
});

// Shapes below are as JS8CALL actually sends them (from a recorded session):
// entries sit directly in params, keyed by callsign / offset, next to _ID.
test('RX.CALL_ACTIVITY with entries directly in params (real JS8CALL shape)', () => {
  const { store, clock } = harness();
  store.processMessage({ type: 'RX.CALL_ACTIVITY', value: '', params: {
    _ID: 1763900000123,
    '':     { GRID: '', SNR: -10, UTC: clock.t },            // JS8CALL includes an empty-key entry
    K4HWK:  { GRID: ' EM95', SNR: -12, UTC: clock.t - 60_000 },
    KB3HWM: { GRID: '', SNR: 4, UTC: clock.t - 120_000 },
  } });
  assert.deepEqual([...store.stations.keys()].sort(), ['K4HWK', 'KB3HWM']);
  assert.equal(store.stations.get('K4HWK').grid, 'EM95');
  assert.equal(store.stations.get('K4HWK').lastHeard, clock.t - 60_000);
  assert.equal(store.stations.get('KB3HWM').snr, 4);
});

test('RX.BAND_ACTIVITY with entries directly in params (real JS8CALL shape)', () => {
  const { store, clock } = harness();
  store.processMessage({ type: 'STATION.CALLSIGN', value: 'KJ4QEO' });
  store.processMessage({ type: 'RX.BAND_ACTIVITY', value: '', params: {
    _ID: 1763900000456,
    1065: { DIAL: 7078000, FREQ: 7079065, OFFSET: 1065, SNR: -6,  TEXT: 'KD2UWR: KJ4QEO SNR -09 ♢ ', UTC: clock.t },
    1496: { DIAL: 7078000, FREQ: 7079496, OFFSET: 1496, SNR: -15, TEXT: '@HB HEARTBEAT EM85 ', UTC: clock.t },
  } });
  const s = store.stations.get('KD2UWR');
  assert.ok(s);
  assert.equal(s.offset, 1065);
  assert.equal(s.freq, 7078000);
  assert.equal(s.heardMe.snr, -9);
  assert.equal(store.stations.size, 1, 'group heartbeat line without a callsign is skipped');
});

test('snapshot includes the expiry time for pin fading', () => {
  const store = S.createStationStore({ ttl: 15 * 60_000 });
  assert.equal(store.snapshot().ttlMs, 15 * 60_000);
});
