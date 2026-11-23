// Display helpers. Pure functions apart from cssVar() (which reads the page).

/** CSS class name for an SNR value. */
export function snrClass(snr) {
  if (snr === undefined || snr === null) return 'snr-unknown';
  if (snr >= 0)   return 'snr-strong';
  if (snr >= -10) return 'snr-good';
  if (snr >= -20) return 'snr-fair';
  if (snr >= -30) return 'snr-weak';
  return 'snr-vweak';
}

export function snrLabel(snr) {
  if (snr === undefined || snr === null) return '—';
  return (snr > 0 ? '+' : '') + snr + ' dB';
}

export function formatUTC(utc) {
  if (!utc) return '—';
  const d = new Date(typeof utc === 'number' && utc < 1e12 ? utc * 1000 : utc);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '—';
  const diff = Math.max(0, now - ts);
  if (diff < 60_000)    return Math.floor(diff / 1000) + 's ago';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  return Math.floor(diff / 3_600_000) + 'h ago';
}

export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Reflect a toggle's on/off state on its toolbar button. */
export function setToggle(btn, on) {
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
}

// Pins stay fully opaque for FADE_START after a station was heard, then fade
// linearly to MIN_OPACITY by the time the station expires.
export const FADE_START  = 5 * 60 * 1000;
export const MIN_OPACITY = 0.3;

export function ageOpacity(ageMs, ttlMs) {
  if (!(ageMs > FADE_START)) return 1;
  const span = Math.max(1, ttlMs - FADE_START);
  const f    = Math.min(1, (ageMs - FADE_START) / span);
  return Math.round((1 - f * (1 - MIN_OPACITY)) * 100) / 100;
}
