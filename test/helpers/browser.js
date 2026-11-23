'use strict';

// Minimal headless-Chrome driver over the DevTools protocol (no extra
// dependencies — uses the `ws` package the server already needs).

const fs        = require('fs');
const os        = require('os');
const path      = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Path to Chrome, Chromium or Edge, or null. CHROME_PATH overrides. */
function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  }[process.platform];
  if (candidates) return candidates.find(p => fs.existsSync(p)) || null;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { /* not installed */ }
  }
  return null;
}

/**
 * Launch a headless browser and return a page handle:
 *   { navigate(url), eval(expr), errors, screenshot(file), close() }
 */
async function launchPage(executable, { width = 1400, height = 900, scale = 2 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'js8map-cdp-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
                `--window-size=${width},${height}`, `--force-device-scale-factor=${scale}`,
                '--no-first-run', '--no-default-browser-check', 'about:blank'];
  if (process.env.CI) args.push('--no-sandbox');   // CI containers lack the user namespaces the sandbox needs
  const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  // Chrome prints "DevTools listening on ws://…" to stderr
  const browserWs = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error('browser did not start:\n' + err)), 20_000);
    proc.stderr.on('data', d => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`browser exited (${code}):\n${err}`)); });
  });
  const port = new URL(browserWs).port;

  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); }
    catch { /* not ready */ }
    if (!target) await sleep(100);
  }

  const cdp = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cdp.once('open', res); cdp.once('error', rej); });

  let nextId = 1;
  const pending = new Map();
  const errors  = [];
  cdp.on('message', d => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const ex = m.params.exceptionDetails;
      errors.push(ex.exception?.description || ex.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
    }
  });
  const send = (method, params = {}) => new Promise(resolve => {
    const id = nextId++;
    pending.set(id, resolve);
    cdp.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  return {
    errors,
    navigate: url => send('Page.navigate', { url }),
    /** Evaluate an expression in the page; promises are awaited, results returned by value. */
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.error) throw new Error(`CDP ${r.error.message}: ${expression.slice(0, 80)}`);
      if (r.result.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      }
      return r.result.result.value;
    },
    /** Poll an expression until it is truthy. */
    async waitFor(expression, timeout = 10_000) {
      const end = Date.now() + timeout;
      for (;;) {
        try { const v = await this.eval(expression); if (v) return v; } catch { /* page still loading */ }
        if (Date.now() > end) throw new Error(`timed out waiting for: ${expression}`);
        await sleep(150);
      }
    },
    async screenshot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    },
    async close() {
      cdp.close();
      proc.kill();
      await new Promise(r => (proc.exitCode !== null ? r() : proc.once('exit', r)));
      await sleep(200);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still locked on Windows */ }
    },
  };
}

module.exports = { findBrowser, launchPage, sleep };
