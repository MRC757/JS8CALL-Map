'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const { ASSETS, assetPath } = require('../lib/assets');
const pkgAssets = require('../package.json').pkg.assets;

// Minimal glob → RegExp for the patterns used in pkg.assets ("*" and "**").
const globRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
const bundled = rel => pkgAssets.some(g => globRe(g).test(rel));

test('every served file exists on disk', () => {
  for (const rel of Object.values(ASSETS)) assert.ok(fs.existsSync(assetPath(rel)), rel);
});

test('every browser module in public/js is served (none forgotten)', () => {
  const served = new Set(Object.values(ASSETS));
  const dir = path.join(__dirname, '..', 'public', 'js');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    assert.ok(served.has(`public/js/${f}`), `public/js/${f} missing from lib/assets.js`);
  }
});

test('every served file is bundled into the exe', () => {
  for (const rel of Object.values(ASSETS)) assert.ok(bundled(rel), `${rel} missing from package.json pkg.assets`);
});

test('the exe bundles nothing the app does not serve', () => {
  const served = Object.values(ASSETS);
  for (const g of pkgAssets) assert.ok(served.some(rel => globRe(g).test(rel)), `${g} is bundled but never served`);
});

test('unused map data stays out of the bundle', () => {
  for (const rel of ['node_modules/world-atlas/countries-10m.json', 'node_modules/world-atlas/land-10m.json',
                     'node_modules/us-atlas/states-albers-10m.json', 'node_modules/leaflet/dist/leaflet-src.js',
                     'node_modules/leaflet/dist/leaflet.js.map']) {
    assert.ok(!bundled(rel), rel);
  }
});

test('no code builds path.join(__dirname, "<literal>") paths (pkg would bundle whole folders)', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['server.js', ...fs.readdirSync(path.join(root, 'lib')).map(n => 'lib/' + n)]) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /path\.(join|resolve)\(\s*__dirname\s*,\s*['"`]/, f);
  }
});
