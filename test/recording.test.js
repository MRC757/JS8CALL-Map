'use strict';

// Recorder, replay, and the recorded-session fixtures in test/fixtures/.
//
// To test against real JS8CALL traffic, record a session with
//   js8call-map.exe --record session.jsonl      (or: npm start -- --record session.jsonl)
// and copy the file into test/fixtures/. Every *.jsonl file there is replayed
// below and checked against the store's invariants.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { createRecorder }                    = require('../lib/recorder');
const { parseRecording, replay, summarize } = require('../lib/replay');
const { isValidCallsign, normText }         = require('../lib/station-store');
const { isValidGrid }                       = require('../public/grid');

const FIXTURES = path.join(__dirname, 'fixtures');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-rec-'));
  return { dir, file: path.join(dir, 'sub', 'rec.jsonl') };
}

test('recorder writes one JSON line per entry and appends across runs', async () => {
  const { dir, file } = tmpFile();
  try {
    let t = 1000;
    const r1 = createRecorder(file, { now: () => t++ });
    r1.record('event', '{"type":"RX.SPOT"}');
    r1.record('reply', '{"type":"STATION.GRID","value":"FN31"}', { query: 'STATION.GET_GRID' });
    await r1.close();
    const r2 = createRecorder(file, { now: () => t++ });
    r2.record('event', 'not json at all');
    await r2.close();

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[0], { t: 1000, src: 'event', line: '{"type":"RX.SPOT"}' });
    assert.equal(lines[1].query, 'STATION.GET_GRID');
    assert.equal(lines[2].line, 'not json at all');
    assert.equal(r2.count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recorder stops at its size limit instead of filling the disk', async () => {
  const { dir, file } = tmpFile();
  const warnings = [];
  try {
    const r = createRecorder(file, { maxBytes: 200, log: { warn: m => warnings.push(m), error() {} } });
    let written = 0;
    for (let i = 0; i < 20; i++) if (r.record('event', 'x'.repeat(40))) written++;
    await r.close();
    assert.ok(written > 0 && written < 20);
    assert.ok(fs.statSync(file).size <= 200);
    assert.equal(warnings.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseRecording reports malformed lines instead of throwing', () => {
  const { entries, errors } = parseRecording('{"t":1,"src":"event","line":"{}"}\n\nnope\n{"t":2}\n');
  assert.equal(entries.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /line 3/);
});

test('replay uses recorded times, so expiry and dedupe behave as they did live', () => {
  const t0 = 1_750_000_000_000;
  const line = o => JSON.stringify(o);
  const entries = [
    { t: t0,          src: 'reply', line: line({ type: 'STATION.CALLSIGN', value: 'KJ4QEO' }) },
    { t: t0 + 1000,   src: 'event', line: line({ type: 'RX.DIRECTED', params: { FROM: 'W1AW', TEXT: 'W1AW: KJ4QEO SNR -03', UTC: t0 + 1000 } }) },
    { t: t0 + 30_000, src: 'event', line: line({ type: 'RX.DIRECTED', params: { FROM: 'W1AW', TEXT: 'W1AW: KJ4QEO SNR -03', UTC: t0 + 1000 } }) },
  ];
  const result = replay(entries);
  const w = result.store.stations.get('W1AW');
  assert.equal(w.messages.length, 1);
  assert.equal(w.heardMe.snr, -3);
  assert.equal(result.endTime, t0 + 30_000);
  const sum = summarize(result, entries);
  assert.deepEqual(sum.heardMe, ['W1AW -3 dB']);
  assert.equal(sum.messageTypes['RX.DIRECTED'], 2);
});

// ── recorded sessions ─────────────────────────────────────────────────────────

const fixtures = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter(f => f.endsWith('.jsonl')) : [];

test('at least one recorded session fixture is present', () => {
  assert.ok(fixtures.length > 0, 'add a recording to test/fixtures/');
});

for (const name of fixtures) {
  test(`recorded session ${name} replays cleanly`, () => {
    const { entries, errors } = parseRecording(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
    assert.deepEqual(errors, [], 'every line parses');
    assert.ok(entries.length > 0, 'not empty');

    const { store } = replay(entries);

    // If JS8CALL answered the callsign query, we must have picked it up.
    const answered = entries.some(e => e.src === 'reply' && e.query === 'STATION.GET_CALLSIGN');
    if (answered) assert.ok(store.myStation.callsign, 'my callsign learned from the reply');

    for (const s of store.stations.values()) {
      assert.ok(isValidCallsign(s.callsign), `valid callsign ${s.callsign}`);
      if (s.grid) assert.ok(isValidGrid(s.grid), `${s.callsign}: valid grid ${s.grid}`);
      if (s.freq !== undefined) assert.ok(s.freq >= 1e6 && s.freq <= 30e6, `${s.callsign}: HF freq`);
      assert.ok(s.lastHeard >= s.firstSeen, `${s.callsign}: lastHeard ≥ firstSeen`);

      // Newest first, and no message stored twice
      for (let i = 1; i < s.messages.length; i++) {
        assert.ok((s.messages[i - 1].utc || 0) >= (s.messages[i].utc || 0), `${s.callsign}: messages newest-first`);
      }
      const keys = s.messages.map(m => `${m.utc}|${normText(m.text)}`);
      assert.equal(new Set(keys).size, keys.length, `${s.callsign}: no duplicate messages`);

      if (s.heardMe) assert.ok(Number.isFinite(s.heardMe.snr), `${s.callsign}: heardMe SNR is a number`);
    }
  });
}
