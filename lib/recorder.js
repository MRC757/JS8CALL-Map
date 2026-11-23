'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;   // stop after 100 MB

/**
 * Records the raw JS8CALL traffic to a JSON Lines file, one entry per line:
 *
 *   {"t":1763900000000,"src":"event","line":"{\"type\":\"RX.ACTIVITY\",…}"}
 *   {"t":1763900000050,"src":"reply","query":"RX.GET_CALL_ACTIVITY","line":"…"}
 *
 * `line` is exactly what JS8CALL sent, so a recording can be replayed through
 * the station store (see lib/replay.js and `npm run replay`).
 */
function createRecorder(file, { maxBytes = DEFAULT_MAX_BYTES, now = Date.now, log = console } = {}) {
  const full = path.resolve(file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const stream = fs.createWriteStream(full, { flags: 'a' });
  let bytes   = fs.existsSync(full) ? fs.statSync(full).size : 0;
  let stopped = false;
  let count   = 0;

  stream.on('error', err => {
    if (!stopped) log.error(`Recording stopped: ${err.message}`);
    stopped = true;
  });

  function record(src, line, extra = {}) {
    if (stopped) return false;
    const entry = JSON.stringify({ t: now(), src, ...extra, line }) + '\n';
    if (bytes + entry.length > maxBytes) {
      stopped = true;
      log.warn(`Recording stopped: ${full} reached ${Math.round(maxBytes / 1024 / 1024)} MB`);
      return false;
    }
    bytes += entry.length;
    count++;
    stream.write(entry);
    return true;
  }

  function close() {
    stopped = true;
    return new Promise(resolve => stream.end(resolve));
  }

  return { file: full, record, close, get count() { return count; } };
}

module.exports = { createRecorder, DEFAULT_MAX_BYTES };
