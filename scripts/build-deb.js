#!/usr/bin/env node
'use strict';

// Builds js8call-map_<version>_<arch>.deb from a pkg-built Linux binary.
//
//   npm run deb -- --arch amd64 --binary dist/linux-x64/js8call-map
//   npm run deb -- --arch arm64 --binary dist/linux-arm64/js8call-map
//
// A .deb is an `ar` archive holding debian-binary, control.tar.gz and
// data.tar.gz. Everything is written here in plain Node (no dpkg needed), so
// packages can be built and inspected on any OS; CI then validates them with
// dpkg-deb and installs them on real Debian/Ubuntu machines.

const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');

const ROOT  = path.join(__dirname, '..');
const LINUX = path.join(ROOT, 'packaging', 'linux');

const DEFAULT_MAINTAINER = 'MRC757 <MRC757@users.noreply.github.com>';
const ARCHES = { amd64: 'x64', arm64: 'arm64' };   // Debian arch → pkg arch

// ── tar (ustar) ───────────────────────────────────────────────────────────────

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function tarHeader({ name, mode, size = 0, mtime, type = '0', linkname = '' }) {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {           // split long paths into prefix/name
    const cut = name.lastIndexOf('/', 154);
    prefix = name.slice(0, cut);
    name   = name.slice(cut + 1);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long: ${prefix}/${name}`);
  }
  h.write(name, 0, 100);
  h.write(octal(mode, 8), 100);
  h.write(octal(0, 8), 108);                      // uid  root
  h.write(octal(0, 8), 116);                      // gid  root
  h.write(octal(size, 12), 124);
  h.write(octal(mtime, 12), 136);
  h.write('        ', 148);                       // checksum placeholder
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write('root', 265, 32);
  h.write('root', 297, 32);
  h.write(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** entries: [{ name, mode, data?: Buffer, dir?: true }] → tar Buffer */
function tar(entries, mtime) {
  const parts = [];
  for (const e of entries) {
    if (e.dir) {
      parts.push(tarHeader({ name: e.name, mode: e.mode ?? 0o755, mtime, type: '5' }));
    } else {
      parts.push(tarHeader({ name: e.name, mode: e.mode, size: e.data.length, mtime }));
      parts.push(e.data);
      const pad = (512 - (e.data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));               // end-of-archive marker
  return Buffer.concat(parts);
}

// ── ar ────────────────────────────────────────────────────────────────────────

function ar(members, mtime) {
  const parts = [Buffer.from('!<arch>\n')];
  for (const { name, data } of members) {
    const h = Buffer.alloc(60, ' ');
    h.write(name, 0, 16);
    h.write(String(mtime), 16, 12);
    h.write('0', 28, 6);
    h.write('0', 34, 6);
    h.write('100644', 40, 8);
    h.write(String(data.length), 48, 10);
    h.write('`\n', 58);
    parts.push(h, data);
    if (data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

// ── package contents ──────────────────────────────────────────────────────────

const read = f => fs.readFileSync(path.join(LINUX, f));
// gzip -9n equivalent: Node writes no file name and a zero timestamp, so output is reproducible
const gz   = data => zlib.gzipSync(data, { level: 9 });

function changelog(version, maintainer, date) {
  return `js8call-map (${version}) stable; urgency=medium\n\n` +
         `  * Release ${version}. See https://github.com/MRC757/JS8CALL-Map/releases\n\n` +
         ` -- ${maintainer}  ${date.toUTCString().replace('GMT', '+0000')}\n`;
}

/** Files installed by the package, keyed by absolute install path. */
function payload({ binary, version, maintainer, date }) {
  return {
    '/usr/bin/js8call-map':                                   { data: binary, mode: 0o755 },
    '/usr/share/applications/js8call-map.desktop':            { data: read('js8call-map.desktop'), mode: 0o644 },
    '/usr/share/icons/hicolor/scalable/apps/js8call-map.svg': { data: read('js8call-map.svg'), mode: 0o644 },
    '/usr/lib/systemd/user/js8call-map.service':              { data: read('js8call-map.service'), mode: 0o644 },
    '/usr/share/doc/js8call-map/copyright':                   { data: read('copyright'), mode: 0o644 },
    '/usr/share/doc/js8call-map/README.Debian':               { data: read('README.Debian'), mode: 0o644 },
    // A native package (version without a -revision) uses changelog.gz, not changelog.Debian.gz
    '/usr/share/doc/js8call-map/changelog.gz':                { data: gz(changelog(version, maintainer, date)), mode: 0o644 },
    '/usr/share/man/man1/js8call-map.1.gz':                   { data: gz(read('js8call-map.1')), mode: 0o644 },
  };
}

function controlFile({ version, arch, maintainer, installedKiB }) {
  return [
    'Package: js8call-map',
    `Version: ${version}`,
    `Architecture: ${arch}`,
    `Maintainer: ${maintainer}`,
    `Installed-Size: ${installedKiB}`,
    // The binary embeds the Node.js 22 runtime, which needs glibc 2.28+ and libstdc++.
    'Depends: libc6 (>= 2.28), libstdc++6 (>= 8), libgcc-s1 | libgcc1',
    'Recommends: xdg-utils',
    'Suggests: js8call',
    'Section: hamradio',
    'Priority: optional',
    'Homepage: https://github.com/MRC757/JS8CALL-Map',
    'Description: live Maidenhead grid map of stations heard by JS8CALL',
    ' Shows the stations your JS8CALL hears on an offline map in your web',
    ' browser: signal reports, message history, who is hearing you, day/night',
    ' and greyline overlays, and distance and bearing tools.',
    ' .',
    ' Runs on a desktop (opening your browser) or headless as a systemd user',
    ' service, viewed from any device on your network.',
    '',
  ].join('\n');
}

/** Build the .deb and return it as a Buffer. */
function buildDeb({ binary, arch, version, maintainer = DEFAULT_MAINTAINER, mtime = Math.floor(Date.now() / 1000) }) {
  if (!ARCHES[arch]) throw new Error(`arch must be one of ${Object.keys(ARCHES).join(', ')}`);
  if (!/^[0-9][A-Za-z0-9.+~-]*$/.test(version)) throw new Error(`invalid Debian version "${version}"`);

  const files = payload({ binary, version, maintainer, date: new Date(mtime * 1000) });

  // Every parent directory, then the files, all as ./relative paths
  const dirs = new Set(['./']);
  for (const p of Object.keys(files)) {
    const parts = p.split('/').slice(1, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add('./' + parts.slice(0, i).join('/') + '/');
  }
  const dataEntries = [...dirs].sort().map(name => ({ name, dir: true }))
    .concat(Object.keys(files).sort().map(p => ({ name: '.' + p, ...files[p] })));

  const installedKiB = Math.ceil(Object.values(files).reduce((n, f) => n + f.data.length, 0) / 1024) + dirs.size;
  const md5sums = Object.keys(files).sort()
    .map(p => `${crypto.createHash('md5').update(files[p].data).digest('hex')}  ${p.slice(1)}`).join('\n') + '\n';

  const control = tar([
    { name: './', dir: true },
    { name: './control', mode: 0o644, data: Buffer.from(controlFile({ version, arch, maintainer, installedKiB })) },
    { name: './md5sums', mode: 0o644, data: Buffer.from(md5sums) },
  ], mtime);

  return ar([
    { name: 'debian-binary',  data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: zlib.gzipSync(control, { level: 9 }) },
    { name: 'data.tar.gz',    data: zlib.gzipSync(tar(dataEntries, mtime), { level: 9 }) },
  ], mtime);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt  = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const arch    = opt('arch', 'amd64');
  const version = opt('version', require('../package.json').version);
  const binPath = opt('binary', path.join(ROOT, 'dist', `linux-${ARCHES[arch]}`, 'js8call-map'));
  const outDir  = opt('out', path.join(ROOT, 'dist'));
  // Reproducible builds: honour SOURCE_DATE_EPOCH (set by CI from the commit time)
  const mtime   = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : undefined;

  if (!fs.existsSync(binPath)) {
    console.error(`Binary not found: ${binPath}\nBuild it first:  npm run package:linux-${ARCHES[arch]}`);
    process.exit(1);
  }
  const deb = buildDeb({ binary: fs.readFileSync(binPath), arch, version, mtime,
                         maintainer: process.env.DEB_MAINTAINER || DEFAULT_MAINTAINER });
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `js8call-map_${version}_${arch}.deb`);
  fs.writeFileSync(out, deb);
  console.log(`${out}  (${(deb.length / 1024 / 1024).toFixed(1)} MB)`);
}

module.exports = { buildDeb, tar, ar, controlFile, ARCHES, DEFAULT_MAINTAINER };
