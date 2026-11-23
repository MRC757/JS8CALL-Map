// Colour themes, persisted per browser.

import { restyleAll } from './map.js';

const THEMES = ['dark', 'midnight', 'green', 'light', 'slate'];
const KEY    = 'js8map-theme';

export function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'dark';
  document.documentElement.dataset.theme = name === 'dark' ? '' : name;
  document.getElementById('theme-select').value = name;
  try { localStorage.setItem(KEY, name); } catch { /* storage blocked */ }
  restyleAll();   // Leaflet layers with inline colours
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  applyTheme(saved || 'dark');
  document.getElementById('theme-select').addEventListener('change', e => applyTheme(e.target.value));
}
