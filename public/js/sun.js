// Solar geometry for the day/night and greyline overlays. Pure maths — no
// Leaflet or DOM — so it can be unit-tested in Node.

const D2R = Math.PI / 180;

/** Julian Day for a Date. */
export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Low-precision solar position (accurate to ~1°).
 * Returns { dec, gha } in radians: declination and Greenwich hour angle.
 */
export function sunPosition(date) {
  const JD = julianDay(date);
  const n  = JD - 2451545.0;                           // days since J2000.0

  const L   = (280.46 + 0.9856474 * n) % 360;          // mean longitude (deg)
  const g   = ((357.528 + 0.9856003 * n) % 360) * D2R; // mean anomaly

  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;  // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * D2R;                            // obliquity

  let dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  if (Math.abs(dec) < 1e-6) dec = dec < 0 ? -1e-6 : 1e-6;   // avoid 0/0 at the equinox

  const JD0  = Math.floor(JD - 0.5) + 0.5;
  const H    = (JD - JD0) * 24;
  const T0   = (JD0 - 2451545.0) / 36525;
  const gmst = ((6.697374558 + 2400.0513369 * T0 + 1.0027379093 * H) % 24 + 24) % 24;
  const ra   = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / D2R;
  const gha  = ((gmst * 15 - ra) % 360) * D2R;

  return { dec, gha };
}

/** Sun altitude (degrees) at a point, for a given solar position. */
export function solarAltitude(latDeg, lonDeg, { dec, gha }) {
  const lat = latDeg * D2R;
  const H   = lonDeg * D2R + gha;
  return Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H)) / D2R;
}

/** Latitude (degrees) of the terminator (sun altitude 0°) on a meridian. */
export function terminatorLat(lonDeg, { dec, gha }) {
  return Math.atan(-Math.cos(lonDeg * D2R + gha) / Math.tan(dec)) / D2R;
}

/** The pole that is in darkness. */
export const darkPole = ({ dec }) => (dec > 0 ? -90 : 90);

/**
 * Latitude (degrees) on a meridian where the sun's altitude is `altDeg`,
 * choosing the solution nearest the terminator. If the meridian never reaches
 * that altitude (polar day/night), the dark pole is returned.
 */
export function altitudeLat(lonDeg, altDeg, pos) {
  const { dec, gha } = pos;
  const a = Math.sin(dec);
  const b = Math.cos(dec) * Math.cos(lonDeg * D2R + gha);
  const R = Math.hypot(a, b);
  const s = Math.sin(altDeg * D2R) / R;
  if (Math.abs(s) > 1) return darkPole(pos);

  const alpha = Math.atan2(b, a);
  const base  = Math.asin(s);
  const wrap  = x => Math.atan2(Math.sin(x), Math.cos(x));    // → (-π, π]
  const near  = terminatorLat(lonDeg, pos) * D2R;
  const candidates = [wrap(base - alpha), wrap(Math.PI - base - alpha)]
    .filter(x => Math.abs(x) <= Math.PI / 2 + 1e-12);
  if (!candidates.length) return darkPole(pos);
  candidates.sort((p, q) => Math.abs(p - near) - Math.abs(q - near));
  return candidates[0] / D2R;
}

/** [lat, lon] points along a constant-altitude curve from -180° to 180°. */
export function altitudeCurve(altDeg, pos, stepDeg = 1) {
  const pts = [];
  for (let lon = -180; lon <= 180; lon += stepDeg) {
    pts.push([altDeg === 0 ? terminatorLat(lon, pos) : altitudeLat(lon, altDeg, pos), lon]);
  }
  return pts;
}

/** Night-side polygon: the terminator, closed around the dark pole. */
export function nightCoords(date) {
  const pos  = sunPosition(date);
  const pole = darkPole(pos);
  return [[pole, -180], ...altitudeCurve(0, pos), [pole, 180]];
}

// Greyline: the twilight band from sunset/sunrise (0°) down to the end of
// civil twilight (sun 6° below the horizon), where HF paths along the
// terminator are often enhanced.
export const GREYLINE_DEPTH = -6;

/** Greyline polygon: the terminator, then the -6° curve back the other way. */
export function greylineCoords(date, depthDeg = GREYLINE_DEPTH) {
  const pos = sunPosition(date);
  return [...altitudeCurve(0, pos), ...altitudeCurve(depthDeg, pos).reverse()];
}
