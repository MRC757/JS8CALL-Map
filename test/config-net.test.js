'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { loadConfig, DEFAULTS }                         = require('../lib/config');
const { isResponseTo, isAllowedOrigin, LineSplitter }  = require('../lib/net-utils');

const none = path.join(os.tmpdir(), 'js8map-no-such-config.json');

// ── config ────────────────────────────────────────────────────────────────────

test('defaults: web server is bound to localhost only', () => {
  const c = loadConfig({ argv: [], env: {}, configPath: none });
  assert.equal(c.webHost, '127.0.0.1');
  assert.equal(c.webPort, DEFAULTS.webPort);
});

test('priority: config.json < env < CLI', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ webPort: 9001, js8Port: 3000, ttlMinutes: 15 }));
  try {
    const c = loadConfig({ argv: ['--port', '9003'], env: { JS8MAP_PORT: '9002', JS8MAP_JS8_PORT: '3001' }, configPath: file });
    assert.equal(c.webPort, 9003);
    assert.equal(c.js8Port, 3001);
    assert.equal(c.ttlMinutes, 15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI accepts --flag=value and --host', () => {
  const c = loadConfig({ argv: ['--port=8282', '--host', '0.0.0.0', '--poll-seconds', '5'], env: {}, configPath: none });
  assert.equal(c.webPort, 8282);
  assert.equal(c.webHost, '0.0.0.0');
  assert.equal(c.pollSeconds, 5);
});

test('invalid values and unknown options are rejected', () => {
  const load = (argv, env = {}) => () => loadConfig({ argv, env, configPath: none });
  assert.throws(load(['--port', '70000']), /invalid webPort/);
  assert.throws(load(['--port', 'abc']),   /invalid webPort/);
  assert.throws(load(['--port']),          /Missing value/);
  assert.throws(load(['--bogus', '1']),    /Unknown option/);
  assert.throws(load([], { JS8MAP_TTL_MINUTES: '-5' }), /invalid ttlMinutes/);
  assert.equal(loadConfig({ argv: ['--help'], env: {}, configPath: none }).help, true);
});

test('config file locations per platform', () => {
  const { configFiles } = require('../lib/config');
  assert.deepEqual(configFiles({ platform: 'linux', env: { HOME: '/home/pi' }, dir: '/usr/bin' }),
    ['/etc/js8call-map/config.json', path.join('/home/pi', '.config', 'js8call-map', 'config.json'), path.join('/usr/bin', 'config.json')]);
  assert.deepEqual(configFiles({ platform: 'linux', env: { HOME: '/home/pi', XDG_CONFIG_HOME: '/cfg' }, dir: '/opt' })[1],
    path.join('/cfg', 'js8call-map', 'config.json'));
  assert.deepEqual(configFiles({ platform: 'win32', env: {}, dir: 'C:\\maps' }), [path.join('C:\\maps', 'config.json')]);
});

test('per-user config overrides system config; --config uses only the named file', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-'));
  const home = path.join(dir, 'home');
  const user = path.join(home, '.config', 'js8call-map', 'config.json');
  fs.mkdirSync(path.dirname(user), { recursive: true });
  fs.writeFileSync(user, JSON.stringify({ webHost: '0.0.0.0', webPort: 9100 }));
  const appDirCfg = path.join(dir, 'app');
  fs.mkdirSync(appDirCfg);
  fs.writeFileSync(path.join(appDirCfg, 'config.json'), JSON.stringify({ webPort: 9200 }));
  const other = path.join(dir, 'other.json');
  fs.writeFileSync(other, JSON.stringify({ ttlMinutes: 5 }));
  try {
    const c = loadConfig({ argv: [], env: { HOME: home }, platform: 'linux', dir: appDirCfg });
    assert.equal(c.webHost, '0.0.0.0', 'from ~/.config');
    assert.equal(c.webPort, 9200, 'file next to the program wins over ~/.config');
    assert.deepEqual(c.configFilesUsed, [user, path.join(appDirCfg, 'config.json')]);

    const only = loadConfig({ argv: ['--config', other, '--port', '9300'], env: { HOME: home }, platform: 'linux', dir: appDirCfg });
    assert.equal(only.ttlMinutes, 5);
    assert.equal(only.webHost, '127.0.0.1', 'search skipped with --config');
    assert.equal(only.webPort, 9300, 'other CLI flags still apply');
    assert.equal(loadConfig({ argv: [`--config=${other}`], env: {}, platform: 'linux', dir: appDirCfg }).ttlMinutes, 5);
    assert.throws(() => loadConfig({ argv: ['--config', path.join(dir, 'missing.json')], env: {} }), /not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('broken config.json gives a clear error', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ not json');
  try {
    assert.throws(() => loadConfig({ argv: [], env: {}, configPath: file }), /config\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── recommendation 2: query reply matching ────────────────────────────────────

test('isResponseTo matches by echoed _ID, rejects live events', () => {
  const reply = { type: 'STATION.CALLSIGN', value: 'W1AW', params: { _ID: 123 } };
  assert.ok(isResponseTo(reply, 'STATION.GET_CALLSIGN', 123));
  assert.ok(isResponseTo({ ...reply, params: { _ID: '123' } }, 'STATION.GET_CALLSIGN', 123));
  assert.ok(!isResponseTo({ ...reply, params: { _ID: 999 } }, 'STATION.GET_CALLSIGN', 123));

  // A live event arriving first must not be taken as the callsign
  const live = { type: 'RX.ACTIVITY', value: 'KN4CRD: HELLO', params: { FROM: 'KN4CRD' } };
  assert.ok(!isResponseTo(live, 'STATION.GET_CALLSIGN', 123));
  assert.ok(!isResponseTo({ ...live, params: { _ID: -1 } }, 'STATION.GET_CALLSIGN', 123));

  // Older JS8CALL builds without _ID echo: fall back to reply type
  assert.ok(isResponseTo({ type: 'STATION.GRID', value: 'FN31', params: {} }, 'STATION.GET_GRID', 1));
  assert.ok(!isResponseTo(null, 'STATION.GET_GRID', 1));
});

// ── recommendation 12: WebSocket origin check ─────────────────────────────────

test('isAllowedOrigin', () => {
  assert.ok(isAllowedOrigin(undefined, 'localhost:8181'));                       // non-browser client
  assert.ok(isAllowedOrigin('http://localhost:8181', 'localhost:8181'));
  assert.ok(isAllowedOrigin('http://127.0.0.1:8181', '127.0.0.1:8181'));
  assert.ok(isAllowedOrigin('http://[::1]:8181', '[::1]:8181'));
  assert.ok(isAllowedOrigin('http://192.168.1.20:8181', '192.168.1.20:8181'));   // LAN, same server
  assert.ok(!isAllowedOrigin('https://evil.example', 'localhost:8181'));
  assert.ok(!isAllowedOrigin('http://192.168.1.20:8181', 'localhost:8181'));
  assert.ok(!isAllowedOrigin('null', 'localhost:8181'));
  assert.ok(!isAllowedOrigin('file:///C:/x.html', 'localhost:8181'));
});

// ── line splitting ────────────────────────────────────────────────────────────

test('LineSplitter joins chunks and drops oversized garbage', () => {
  const s = new LineSplitter(50);
  assert.deepEqual(s.push(Buffer.from('{"a":1}\r\n{"b"')), ['{"a":1}']);
  assert.deepEqual(s.push(Buffer.from(':2}\n\n')), ['{"b":2}']);
  assert.deepEqual(s.push('x'.repeat(60)), []);
  assert.ok(s.overflowed);
  assert.deepEqual(s.push('ok\n'), ['ok']);
});
