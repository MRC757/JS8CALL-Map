// The Leaflet map, the offline world basemap, and theme-change hooks.

import { cssVar } from './util.js';

export const map = L.map('map', { center: [39, -98], zoom: 4, zoomControl: true });
map.zoomControl.setPosition('bottomright');

// Layers with inline colours register a restyle function; the theme switcher
// calls them all after changing the CSS variables.
const restylers = [];
export function onRestyle(fn) { restylers.push(fn); }
export function restyleAll() { for (const fn of restylers) fn(); }

// Offline world basemap — rendered from bundled TopoJSON (no internet required).
// Ocean colour comes from .leaflet-container background (CSS variable --map-ocean).
let worldLandLayer   = null;
let worldBorderLayer = null;

fetch('/world-atlas/countries-110m.json')
  .then(r => r.json())
  .then(world => {
    worldLandLayer = L.geoJSON(topojson.feature(world, world.objects.countries), {
      style:       { fillColor: cssVar('--map-land'), fillOpacity: 1, color: cssVar('--map-border'), weight: 0.5 },
      interactive: false,
    }).addTo(map);
    worldBorderLayer = L.geoJSON(topojson.mesh(world, world.objects.countries, (a, b) => a !== b), {
      style:       { color: cssVar('--map-border-inner'), weight: 0.6, fill: false },
      interactive: false,
    }).addTo(map);
  })
  .catch(() => console.warn('World basemap failed to load'));

onRestyle(() => {
  if (worldLandLayer)   worldLandLayer.setStyle({ fillColor: cssVar('--map-land'), color: cssVar('--map-border') });
  if (worldBorderLayer) worldBorderLayer.setStyle({ color: cssVar('--map-border-inner') });
});
