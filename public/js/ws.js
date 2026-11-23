// WebSocket connection to the server and handling of its messages.

import { map } from './map.js';
import { state, stationData, newMsgPending } from './state.js';
import { placeOrUpdateMarker, removeMarker, refreshMarker, relayoutFor, refreshAllMarkers } from './markers.js';
import { patchSidebarItem, rebuildSidebar, scheduleSidebarRebuild, markUnread } from './sidebar.js';
import { renderDetailPanel, updateDetailStats, insertDetailMessage, hideDetailPanel } from './detail.js';
import { scheduleHeardPaths } from './heard-paths.js';
import { redrawGrid } from './grid-overlay.js';

const { gridToLatLon } = globalThis.Grid;

export function connectWS() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onopen    = () => console.log('[WS] connected');
  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleServerMsg(msg);
  };
  ws.onerror = err => console.error('[WS] error', err);
  ws.onclose = () => {
    console.log('[WS] closed — retrying in 3 s');
    setTimeout(connectWS, 3_000);
  };
}

export function handleServerMsg(msg) {
  switch (msg.type) {

    // Full state on first connect or reconnect
    case 'SNAPSHOT': {
      state.myStation   = msg.myStation || state.myStation;
      state.maxMessages = msg.maxMessages ?? state.maxMessages;
      state.ttlMs       = msg.ttlMs ?? state.ttlMs;
      const snap = msg.stations || [];

      // Drop anything the server no longer has (e.g. after a server restart),
      // except the locally-created home record.
      const keep = new Set(snap.map(s => s.callsign));
      for (const [cs, st] of stationData) if (!keep.has(cs) && !st.homeOnly) dropStation(cs);

      for (const s of snap) {
        stationData.set(s.callsign, s);
        placeOrUpdateMarker(s);
      }
      if (state.selectedCall && stationData.has(state.selectedCall)) renderDetailPanel(stationData.get(state.selectedCall));

      updateMyStationUI();
      updateConnectionBadge(msg.connected);
      rebuildSidebar();
      scheduleHeardPaths();
      break;
    }

    case 'MY_STATION':
      state.myStation = msg.myStation;
      updateMyStationUI();
      refreshAllMarkers();
      scheduleHeardPaths();
      break;

    // A station's metadata changed (no messages in this payload)
    case 'STATION_UPDATE': {
      const s    = msg.station;
      const next = { ...(stationData.get(s.callsign) || { messages: [] }), ...s };
      delete next.homeOnly;                                // the server knows it now
      if (next.heardMe === null) delete next.heardMe;      // server cleared it
      stationData.set(s.callsign, next);
      placeOrUpdateMarker(next);
      patchSidebarItem(next);
      if (state.selectedCall === s.callsign) updateDetailStats(next);
      scheduleHeardPaths();
      break;
    }

    case 'NEW_MESSAGE': {
      const station = stationData.get(msg.callsign);
      if (!station) break;
      station.messages = station.messages || [];

      // Keep newest-first order even if an older message arrives late
      const utc = msg.message.utc || 0;
      let idx = 0;
      while (idx < station.messages.length && (station.messages[idx].utc || 0) > utc) idx++;
      station.messages.splice(idx, 0, msg.message);
      if (station.messages.length > state.maxMessages) station.messages.length = state.maxMessages;
      if (idx >= state.maxMessages) break;

      if (state.selectedCall === msg.callsign) insertDetailMessage(station, idx);
      else { newMsgPending.add(msg.callsign); markUnread(msg.callsign); }
      break;
    }

    // Server removed a station that hasn't been heard within the expiry time
    case 'STATION_EXPIRED':
      dropStation(msg.callsign);
      rebuildSidebar();
      scheduleHeardPaths();
      break;

    case 'CONNECTION_STATUS':
      updateConnectionBadge(msg.connected);
      break;
  }
}

function dropStation(cs) {
  stationData.delete(cs);
  newMsgPending.delete(cs);
  removeMarker(cs);
  if (state.selectedCall === cs) {
    state.selectedCall = null;
    hideDetailPanel();
  }
}

let homeCall   = '';     // callsign the home marker was last drawn for
let mapCentred = false;

function updateMyStationUI() {
  const me    = state.myStation;
  const badge = document.getElementById('my-callsign-badge');
  if (me.callsign) {
    badge.textContent   = me.callsign + (me.grid ? '  ' + me.grid : '');
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }

  // Callsign changed: drop the old home record (if only we created it) or
  // restyle it as an ordinary station.
  if (homeCall && homeCall !== me.callsign) {
    const old = stationData.get(homeCall);
    if (old && old.homeOnly) dropStation(homeCall);
    else if (old) refreshMarker(homeCall);
    homeCall = '';
    scheduleSidebarRebuild();
  }

  if (!me.callsign || !me.grid) return;

  let home = stationData.get(me.callsign);
  if (!home) {
    home = { callsign: me.callsign, messages: [], homeOnly: true };
    stationData.set(me.callsign, home);
    scheduleSidebarRebuild();
  }
  home.grid = me.grid;
  homeCall  = me.callsign;
  placeOrUpdateMarker(home);
  relayoutFor(homeCall);

  if (!mapCentred) {
    const pos = gridToLatLon(me.grid);
    if (pos) {
      map.setView([pos.lat, pos.lon], 6);
      redrawGrid();
      mapCentred = true;
    }
  }
}

function updateConnectionBadge(connected) {
  const el = document.getElementById('connection-status');
  el.textContent = connected ? '● Connected to JS8CALL' : '● Disconnected';
  el.className   = connected ? 'connected' : 'disconnected';
}
