'use strict';

const path = require('path');

// Every file the browser loads, as  URL → path relative to the project root.
// Each one must also be listed in package.json "pkg.assets" so it is bundled
// into the .exe (test/assets.test.js checks this).
//
// Files are served from an explicit list rather than express.static on whole
// node_modules folders: pkg bundles any folder it sees in
// a path.join() of __dirname and a string literal, which pulled ~10 MB of unused map data
// into the exe.
const ASSETS = {
  '/':                                 'public/index.html',
  '/app.js':                           'public/app.js',
  '/grid.js':                          'public/grid.js',
  '/style.css':                        'public/style.css',
  '/data/interstates.geojson':         'public/data/interstates.geojson',
  '/data/county_names.json':           'public/data/county_names.json',

  '/leaflet/leaflet.js':               'node_modules/leaflet/dist/leaflet.js',
  '/leaflet/leaflet.css':              'node_modules/leaflet/dist/leaflet.css',
  '/leaflet/images/layers.png':        'node_modules/leaflet/dist/images/layers.png',
  '/leaflet/images/layers-2x.png':     'node_modules/leaflet/dist/images/layers-2x.png',
  '/leaflet/images/marker-icon.png':   'node_modules/leaflet/dist/images/marker-icon.png',
  '/leaflet/images/marker-icon-2x.png':'node_modules/leaflet/dist/images/marker-icon-2x.png',
  '/leaflet/images/marker-shadow.png': 'node_modules/leaflet/dist/images/marker-shadow.png',

  '/topojson/topojson-client.min.js':  'node_modules/topojson-client/dist/topojson-client.min.js',
  '/world-atlas/countries-110m.json':  'node_modules/world-atlas/countries-110m.json',
  '/us-atlas/counties-10m.json':       'node_modules/us-atlas/counties-10m.json',
};

/** Absolute path of an asset. Built from parts so pkg can't detect and bundle whole folders. */
function assetPath(rel, root = path.dirname(__dirname)) {
  return path.join(root, ...rel.split('/'));
}

module.exports = { ASSETS, assetPath };
