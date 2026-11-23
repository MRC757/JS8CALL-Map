'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  webHost:     '127.0.0.1',  // use 0.0.0.0 to allow other devices on your LAN
  webPort:     8181,
  js8Host:     '127.0.0.1',
  js8Port:     2237,
  pollSeconds: 30,
  ttlMinutes:  60,
  maxMessages: 100,
  openBrowser: null,         // null = open only when running as the packaged .exe
});

// option name → [CLI flag, environment variable, kind]
const OPTIONS = {
  webHost:     ['--host',         'JS8MAP_HOST',         'string'],
  webPort:     ['--port',         'JS8MAP_PORT',         'port'],
  js8Host:     ['--js8-host',     'JS8MAP_JS8_HOST',     'string'],
  js8Port:     ['--js8-port',     'JS8MAP_JS8_PORT',     'port'],
  pollSeconds: ['--poll-seconds', 'JS8MAP_POLL_SECONDS', 'positive'],
  ttlMinutes:  ['--ttl-minutes',  'JS8MAP_TTL_MINUTES',  'positive'],
  maxMessages: ['--max-messages', 'JS8MAP_MAX_MESSAGES', 'positive'],
  openBrowser: ['--open',         'JS8MAP_OPEN',         'boolean'],   // also --no-open
};

const TRUE_WORDS  = ['1', 'true', 'yes', 'on'];
const FALSE_WORDS = ['0', 'false', 'no', 'off'];

function coerce(name, kind, raw, source) {
  if (kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const w = String(raw).trim().toLowerCase();
    if (TRUE_WORDS.includes(w))  return true;
    if (FALSE_WORDS.includes(w)) return false;
    throw new Error(`${source}: ${name} must be true or false, not "${raw}"`);
  }
  if (kind === 'string') {
    const s = String(raw).trim();
    if (!s) throw new Error(`${source}: ${name} must not be empty`);
    return s;
  }
  const n = Number(raw);
  const ok = kind === 'port'
    ? Number.isInteger(n) && n >= 1 && n <= 65535
    : Number.isFinite(n) && n > 0;
  if (!ok) throw new Error(`${source}: invalid ${name} "${raw}"`);
  return n;
}

/** The folder next to the .exe when packaged, otherwise the project root. */
function appDir() {
  return process.pkg ? path.dirname(process.execPath) : path.dirname(__dirname);
}

/**
 * Settings, lowest to highest priority:
 *   defaults → config.json (next to the exe / project root) → environment → CLI flags.
 */
function loadConfig({ argv = process.argv.slice(2), env = process.env, configPath, packaged = !!process.pkg } = {}) {
  const cfg  = { ...DEFAULTS };
  const file = configPath ?? path.join(appDir(), 'config.json');

  if (file && fs.existsSync(file)) {
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`${file}: ${e.message}`); }
    for (const [name, [, , kind]] of Object.entries(OPTIONS)) {
      if (json[name] !== undefined) cfg[name] = coerce(name, kind, json[name], path.basename(file));
    }
  }

  for (const [name, [, envVar, kind]] of Object.entries(OPTIONS)) {
    if (env[envVar] !== undefined && env[envVar] !== '') cfg[name] = coerce(name, kind, env[envVar], envVar);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { cfg.help = true; continue; }
    if (arg === '--open')    { cfg.openBrowser = true;  continue; }
    if (arg === '--no-open') { cfg.openBrowser = false; continue; }
    const [flag, inline] = arg.split('=', 2);
    const entry = Object.entries(OPTIONS).find(([, [f]]) => f === flag);
    if (!entry) throw new Error(`Unknown option: ${arg}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    cfg[entry[0]] = coerce(entry[0], entry[1][2], value, flag);
  }

  if (cfg.openBrowser === null) cfg.openBrowser = packaged;
  return cfg;
}

const HELP = `Usage: js8call-map [options]

  --host <addr>          Web interface address   (default ${DEFAULTS.webHost}; 0.0.0.0 = whole LAN)
  --port <n>             Web interface port      (default ${DEFAULTS.webPort})
  --js8-host <addr>      JS8CALL TCP API host    (default ${DEFAULTS.js8Host})
  --js8-port <n>         JS8CALL TCP API port    (default ${DEFAULTS.js8Port})
  --poll-seconds <n>     Activity poll interval  (default ${DEFAULTS.pollSeconds})
  --ttl-minutes <n>      Drop stations unheard for this long (default ${DEFAULTS.ttlMinutes})
  --max-messages <n>     Messages kept per station (default ${DEFAULTS.maxMessages})
  --open / --no-open     Open the map in your web browser at startup
                         (default: on for js8call-map.exe, off when run with node)

Each option can also be set with an environment variable (JS8MAP_PORT, JS8MAP_HOST, …)
or in a config.json file next to the program, e.g. { "webPort": 8282, "openBrowser": false }.`;

module.exports = { loadConfig, DEFAULTS, HELP, appDir };
