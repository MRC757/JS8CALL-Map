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
  '/js/js8stat.js':                   'public/js/js8stat.js',
  '/js/cs-alerts.js':                  'public/js/cs-alerts.js',
  '/js/cs-dashboard.js':               'public/js/cs-dashboard.js',
  '/js/cs-forms.js':                   'public/js/cs-forms.js',
  '/js/cs-messages.js':                'public/js/cs-messages.js',
  '/js/cs-roster.js':                  'public/js/cs-roster.js',
  '/js/cs-statreps.js':                'public/js/cs-statreps.js',
  '/js/daynight.js':                   'public/js/daynight.js',
  '/js/detail.js':                     'public/js/detail.js',
  '/js/geo.js':                        'public/js/geo.js',
  '/js/grid-overlay.js':               'public/js/grid-overlay.js',
  '/js/heard-paths.js':                'public/js/heard-paths.js',
  '/js/main.js':                       'public/js/main.js',
  '/js/map.js':                        'public/js/map.js',
  '/js/markers.js':                    'public/js/markers.js',
  '/js/measure.js':                    'public/js/measure.js',
  '/js/selection.js':                  'public/js/selection.js',
  '/js/sidebar.js':                    'public/js/sidebar.js',
  '/js/state.js':                      'public/js/state.js',
  '/js/sun.js':                        'public/js/sun.js',
  '/js/theme.js':                      'public/js/theme.js',
  '/js/us-overlays.js':                'public/js/us-overlays.js',
  '/js/util.js':                       'public/js/util.js',
  '/js/ws.js':                         'public/js/ws.js',
  '/grid.js':                          'public/grid.js',
  '/style.css':                        'public/style.css',
  '/js8stat.css':                     'public/js8stat.css',
  '/data/interstates.geojson':         'public/data/interstates.geojson',
  '/data/county_names.json':           'public/data/county_names.json',

  '/leaflet/leaflet.js':               'node_modules/leaflet/dist/leaflet.js',
  '/leaflet/leaflet.css':              'node_modules/leaflet/dist/leaflet.css',
  '/leaflet/images/layers.png':        'node_modules/leaflet/dist/images/layers.png',
  '/leaflet/images/layers-2x.png':     'node_modules/leaflet/dist/images/layers-2x.png',
  '/leaflet/images/marker-icon.png':   'node_modules/leaflet/dist/images/marker-icon.png',
  '/leaflet/images/marker-icon-2x.png':'node_modules/leaflet/dist/images/marker-icon-2x.png',
  '/leaflet/images/marker-shadow.png': 'node_modules/leaflet/dist/images/marker-shadow.png',

  // JS8Stat panel fonts (OFL-1.1), Latin subset only
  '/fonts/roboto-400.woff2':           'node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff2',
  '/fonts/roboto-700.woff2':           'node_modules/@fontsource/roboto/files/roboto-latin-700-normal.woff2',
  '/fonts/roboto-slab-900.woff2':      'node_modules/@fontsource/roboto-slab/files/roboto-slab-latin-900-normal.woff2',
  '/fonts/kode-mono-400.woff2':        'node_modules/@fontsource/kode-mono/files/kode-mono-latin-400-normal.woff2',
  '/fonts/kode-mono-500.woff2':        'node_modules/@fontsource/kode-mono/files/kode-mono-latin-500-normal.woff2',

  '/topojson/topojson-client.min.js':  'node_modules/topojson-client/dist/topojson-client.min.js',
  '/world-atlas/countries-110m.json':  'node_modules/world-atlas/countries-110m.json',
  '/us-atlas/counties-10m.json':       'node_modules/us-atlas/counties-10m.json',
};

/** Absolute path of an asset. Built from parts so pkg can't detect and bundle whole folders. */
function assetPath(rel, root = path.dirname(__dirname)) {
  return path.join(root, ...rel.split('/'));
}

module.exports = { ASSETS, assetPath };
