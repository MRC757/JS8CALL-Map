'use strict';

const { spawn } = require('child_process');

/**
 * The URL a local browser should open for a server listening on host:port.
 * Wildcard and loopback addresses become "localhost".
 */
function browserUrl(host, port) {
  const h = String(host || '').trim();
  let shown;
  if (!h || h === '0.0.0.0' || h === '::' || h === '127.0.0.1' || h === '::1' || h === 'localhost') shown = 'localhost';
  else if (h.includes(':')) shown = `[${h}]`;          // other IPv6 address
  else shown = h;
  return `http://${shown}:${port}/`;
}

/**
 * The command that opens `url` in the default browser on this platform.
 * Windows uses rundll32 rather than `cmd /c start`, so the URL is never
 * parsed by the shell.
 */
function openCommand(url, platform = process.platform) {
  if (platform === 'win32')  return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/** Open `url` in the default browser. Failures are reported, never thrown. */
function openBrowser(url, { platform = process.platform, spawnFn = spawn, log = console } = {}) {
  const [cmd, args] = openCommand(url, platform);
  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', err => log.warn(`Could not open a browser (${err.message}). Browse to ${url}`));
    child.unref();
  } catch (err) {
    log.warn(`Could not open a browser (${err.message}). Browse to ${url}`);
  }
}

module.exports = { browserUrl, openCommand, openBrowser };
