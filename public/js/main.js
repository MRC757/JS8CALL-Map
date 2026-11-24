// Entry point. Leaflet, topojson-client and grid.js are loaded as classic
// scripts before this module (see index.html) and used through globals.

import { map } from './map.js';
import { state, stationData } from './state.js';
import { initGridOverlay } from './grid-overlay.js';
import { initUsOverlays } from './us-overlays.js';
import { initDayNight } from './daynight.js';
import { initSidebar, refreshSidebarAges } from './sidebar.js';
import { initSelection } from './selection.js';
import { initMeasure } from './measure.js';
import { initHeardPaths, scheduleHeardPaths, heardPathCount } from './heard-paths.js';
import { initTheme } from './theme.js';
import { refreshAllMarkers } from './markers.js';
import { connectWS, handleServerMsg } from './ws.js';
import { initJS8Stat } from './cs-dashboard.js';
import { cs, settings as js8statSettings } from './js8stat.js';

initGridOverlay();
initUsOverlays();
const dayNight = initDayNight();
initSidebar();
initSelection();
initMeasure();
initHeardPaths();
initTheme();
initJS8Stat();

// Every 30 s: refresh ages, pin fading and "hears you" expiry without rebuilding.
// Skipped while the tab is hidden.
setInterval(() => {
  if (document.hidden) return;
  refreshSidebarAges();
  refreshAllMarkers();
  scheduleHeardPaths();
}, 30_000);

connectWS();

// Handles for debugging in the browser console and for the browser test suite.
window.js8map = { map, state, stationData, dayNight, handleServerMsg, refreshAllMarkers, heardPathCount,
                  js8stat: cs, js8statSettings };
