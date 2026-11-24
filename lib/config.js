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
  record:      null,         // file path to record raw JS8CALL traffic to (off by default)
  transmit:    'local',      // who may send JS8Stat traffic: off | local (this PC) | lan
  dataDir:     null,         // where JS8Stat records are saved; null = the usual per-user folder
  keepDays:    7,            // JS8Stat records older than this are deleted
});

const TRANSMIT_MODES = ['off', 'local', 'lan'];

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
  record:      ['--record',       'JS8MAP_RECORD',       'string'],
  transmit:    ['--transmit',     'JS8MAP_TRANSMIT',     'transmit'],
  dataDir:     ['--data-dir',     'JS8MAP_DATA_DIR',     'string'],
  keepDays:    ['--keep-days',    'JS8MAP_KEEP_DAYS',    'positive'],
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
  if (kind === 'transmit') {
    const w = String(raw).trim().toLowerCase();
    if (!TRANSMIT_MODES.includes(w)) throw new Error(`${source}: ${name} must be off, local or lan, not "${raw}"`);
    return w;
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
 * config.json locations, lowest to highest priority. Later files override
 * earlier ones, so a per-user file beats the system-wide one.
 *   Linux/macOS: /etc/js8call-map/config.json, ~/.config/js8call-map/config.json,
 *                then config.json next to the program (or in the project folder)
 *   Windows:     config.json next to js8call-map.exe (or in the project folder)
 */
function configFiles({ platform = process.platform, env = process.env, dir = appDir() } = {}) {
  const files = [];
  if (platform !== 'win32') {
    files.push('/etc/js8call-map/config.json');
    const base = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, '.config') : null);
    if (base) files.push(path.join(base, 'js8call-map', 'config.json'));
  }
  files.push(path.join(dir, 'config.json'));
  return files;
}

function applyConfigFile(cfg, file) {
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`${file}: ${e.message}`); }
  for (const [name, [, , kind]] of Object.entries(OPTIONS)) {
    if (json[name] !== undefined) cfg[name] = coerce(name, kind, json[name], file);
  }
}

/**
 * Settings, lowest to highest priority:
 *   defaults → config.json files (see configFiles) → environment → CLI flags.
 * `--config <file>` (or `configPath`) uses that one file instead of the search.
 */
function loadConfig({ argv = process.argv.slice(2), env = process.env, configPath,
                      packaged = !!process.pkg, platform = process.platform, dir } = {}) {
  const cfg = { ...DEFAULTS };

  const ci = argv.findIndex(a => a === '--config' || a.startsWith('--config='));
  if (ci >= 0) {
    configPath = argv[ci].includes('=') ? argv[ci].slice('--config='.length) : argv[ci + 1];
    if (!configPath) throw new Error('Missing value for --config');
    if (!fs.existsSync(configPath)) throw new Error(`--config: ${configPath} not found`);
    argv = argv.filter((_, i) => i !== ci && !(i === ci + 1 && !argv[ci].includes('=')));
  }

  const files = configPath ? [configPath] : configFiles({ platform, env, dir: dir ?? appDir() });
  cfg.configFilesUsed = [];
  for (const file of files) {
    if (file && fs.existsSync(file)) { applyConfigFile(cfg, file); cfg.configFilesUsed.push(file); }
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
  if (!cfg.dataDir) cfg.dataDir = defaultDataDir({ platform, env });
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
  --open / --no-open     Open the map in your web browser at startup (default: on for
                         the installed app when a desktop is available, off with node)
  --config <file>        Read settings from this file instead of the usual places
  --transmit <mode>      Who may send JS8Stat reports, alerts and messages through
                         JS8CALL: off, local (default: a browser on this PC only) or
                         lan (any device that can open the map). The operator must
                         also switch transmitting on in the map and confirm every send.
  --data-dir <folder>    Where JS8Stat records are saved (default: your user data folder)
  --keep-days <n>        Keep JS8Stat records this many days (default ${DEFAULTS.keepDays})
  --record <file>        Save raw JS8CALL traffic to <file> (JSON Lines) for testing;
                         summarise it later with  npm run replay -- <file>

Each option can also be set with an environment variable (JS8MAP_PORT, JS8MAP_HOST, …)
or in a config.json file, e.g. { "webPort": 8282, "openBrowser": false }:
  Windows:  next to js8call-map.exe
  Linux:    ~/.config/js8call-map/config.json  or  /etc/js8call-map/config.json`;

/**
 * Per-user folder for saved JS8Stat records:
 *   Windows:     %LOCALAPPDATA%\js8call-map
 *   Linux/macOS: $XDG_DATA_HOME/js8call-map, normally ~/.local/share/js8call-map
 * Falls back to the program folder when neither is known.
 */
function defaultDataDir({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'js8call-map') : path.join(appDir(), 'data');
  }
  const base = env.XDG_DATA_HOME || (env.HOME ? path.join(env.HOME, '.local', 'share') : null);
  return base ? path.join(base, 'js8call-map') : path.join(appDir(), 'data');
}

/** Where to tell the user to put config.json, for error messages. */
function configHint(platform = process.platform) {
  return platform === 'win32'
    ? 'config.json next to the program'
    : '~/.config/js8call-map/config.json';
}

module.exports = { loadConfig, configFiles, configHint, defaultDataDir, DEFAULTS, HELP, appDir };
