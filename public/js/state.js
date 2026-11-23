// Shared, mutable app state. Modules import these objects and read/write their
// properties; nothing here touches the DOM or Leaflet.

export const state = {
  myStation:    { callsign: '', grid: '' },
  selectedCall: null,
  maxMessages:  100,               // updated from the server SNAPSHOT
  ttlMs:        60 * 60 * 1000,    // station expiry, updated from the server SNAPSHOT
  measuring:    false,
};

export const stationData   = new Map();   // callsign → full station object (inc. messages)
export const newMsgPending = new Set();   // callsigns with unread messages

export const isHomeCall = cs => !!cs && cs === state.myStation.callsign;

/** The station's "heard me" report, if it is still within the expiry time. */
export function currentHeardMe(station, now = Date.now()) {
  const hm = station && station.heardMe;
  return hm && now - hm.at < state.ttlMs ? hm : null;
}
