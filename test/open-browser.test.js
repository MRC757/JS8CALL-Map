'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const os     = require('os');
const path   = require('path');
const { EventEmitter } = require('events');

const { browserUrl, openCommand, openBrowser } = require('../lib/open-browser');
const { loadConfig } = require('../lib/config');

const none = path.join(os.tmpdir(), 'js8map-no-such-config.json');

test('browserUrl uses localhost for loopback/wildcard and the real address otherwise', () => {
  assert.equal(browserUrl('127.0.0.1', 8181), 'http://localhost:8181/');
  assert.equal(browserUrl('0.0.0.0', 8282),   'http://localhost:8282/');
  assert.equal(browserUrl('::', 8181),        'http://localhost:8181/');
  assert.equal(browserUrl('::1', 8181),       'http://localhost:8181/');
  assert.equal(browserUrl('192.168.1.20', 9000), 'http://192.168.1.20:9000/');
  assert.equal(browserUrl('fe80::1', 8181),   'http://[fe80::1]:8181/');
});

test('openCommand per platform (no shell on Windows)', () => {
  const url = 'http://localhost:8181/';
  assert.deepEqual(openCommand(url, 'win32'),  ['rundll32', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(openCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(openCommand(url, 'linux'),  ['xdg-open', [url]]);
});

test('openBrowser launches detached and reports failures without throwing', () => {
  const calls = [];
  const warnings = [];
  const log = { warn: m => warnings.push(m) };
  let child;
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    return child;
  };

  openBrowser('http://localhost:8181/', { platform: 'win32', spawnFn, log });
  assert.equal(calls[0].cmd, 'rundll32');
  assert.equal(calls[0].opts.detached, true);
  assert.ok(child.unrefed, 'does not keep the server process waiting');

  child.emit('error', new Error('ENOENT'));
  assert.match(warnings[0], /Could not open a browser.*localhost:8181/);

  assert.doesNotThrow(() => openBrowser('http://x/', { spawnFn: () => { throw new Error('boom'); }, log }));
  assert.equal(warnings.length, 2);
});

test('openBrowser setting: on for the exe, off from source, overridable', () => {
  const load = (o) => loadConfig({ argv: [], env: {}, configPath: none, ...o });
  assert.equal(load({ packaged: true }).openBrowser, true);
  assert.equal(load({ packaged: false }).openBrowser, false);
  assert.equal(load({ packaged: true,  argv: ['--no-open'] }).openBrowser, false);
  assert.equal(load({ packaged: false, argv: ['--open'] }).openBrowser, true);
  assert.equal(load({ packaged: true,  argv: ['--open=false'] }).openBrowser, false);
  assert.equal(load({ packaged: true,  env: { JS8MAP_OPEN: 'no' } }).openBrowser, false);
  assert.equal(load({ packaged: false, env: { JS8MAP_OPEN: '1' } }).openBrowser, true);
  assert.throws(() => load({ env: { JS8MAP_OPEN: 'maybe' } }), /true or false/);
});
