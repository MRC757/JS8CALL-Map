// Great-circle paths. Pure maths, unit-tested in Node.

const D2R = Math.PI / 180;

/**
 * Points along the great circle from (lat1, lon1) to (lat2, lon2), returned as
 * one or more segments of [lat, lon] so a path that crosses the ±180°
 * meridian is split instead of being drawn the long way round the map.
 */
export function greatCircleSegments(lat1, lon1, lat2, lon2, steps = 64) {
  const toVec = (lat, lon) => [
    Math.cos(lat * D2R) * Math.cos(lon * D2R),
    Math.cos(lat * D2R) * Math.sin(lon * D2R),
    Math.sin(lat * D2R),
  ];
  const A = toVec(lat1, lon1);
  const B = toVec(lat2, lon2);
  const dot   = Math.min(1, Math.max(-1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const omega = Math.acos(dot);

  const points = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    let v;
    if (omega < 1e-9) {
      v = A;
    } else {
      const s1 = Math.sin((1 - f) * omega) / Math.sin(omega);
      const s2 = Math.sin(f * omega) / Math.sin(omega);
      v = [s1 * A[0] + s2 * B[0], s1 * A[1] + s2 * B[1], s1 * A[2] + s2 * B[2]];
    }
    points.push([Math.atan2(v[2], Math.hypot(v[0], v[1])) / D2R, Math.atan2(v[1], v[0]) / D2R]);
  }

  // Split where consecutive points jump across the antimeridian.
  const segments = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur  = points[i];
    if (Math.abs(cur[1] - prev[1]) > 180) {
      const edge   = prev[1] > 0 ? 180 : -180;
      const curLon = cur[1] + (prev[1] > 0 ? 360 : -360);
      const f      = (edge - prev[1]) / (curLon - prev[1]);
      const lat    = prev[0] + f * (cur[0] - prev[0]);
      segments[segments.length - 1].push([lat, edge]);
      segments.push([[lat, -edge]]);
    }
    segments[segments.length - 1].push(cur);
  }
  return segments;
}
