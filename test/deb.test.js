'use strict';

// The .deb builder, checked by unpacking its output the way dpkg would.

const test   = require('node:test');
const assert = require('node:assert/strict');
const zlib   = require('zlib');
const crypto = require('crypto');

const { buildDeb, tar } = require('../scripts/build-deb');

function parseAr(buf) {
  assert.equal(buf.subarray(0, 8).toString(), '!<arch>\n');
  const members = [];
  let off = 8;
  while (off < buf.length) {
    const h = buf.subarray(off, off + 60).toString('latin1');
    assert.equal(h.slice(58, 60), '`\n', 'ar member header terminator');
    const size = Number(h.slice(48, 58).trim());
    members.push({ name: h.slice(0, 16).trim(), mode: h.slice(40, 48).trim(), data: buf.subarray(off + 60, off + 60 + size) });
    off += 60 + size + (size % 2);
  }
  return members;
}

function parseTar(buf) {
  const entries = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('latin1').replace(/\0.*$/s, '');
    const num = (a, b) => parseInt(str(a, b).trim() || '0', 8);
    // checksum: sum of header bytes with the checksum field read as spaces
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
    assert.equal(num(148, 156), sum, `tar checksum for ${str(0, 100)}`);
    const prefix = str(345, 500);
    const name = (prefix ? prefix + '/' : '') + str(0, 100);
    const size = num(124, 136);
    entries.push({ name, mode: num(100, 108), uid: num(108, 116), gid: num(116, 124), type: str(156, 157),
                   uname: str(265, 297), magic: str(257, 263), data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const fakeBinary = Buffer.concat([Buffer.from('\x7fELF'), crypto.randomBytes(5000)]);
const build = (opts = {}) => buildDeb({ binary: fakeBinary, arch: 'amd64', version: '1.3.0', mtime: 1_763_900_000, ...opts });

function unpack(deb) {
  const members = parseAr(deb);
  const control = parseTar(zlib.gunzipSync(members.find(m => m.name === 'control.tar.gz').data));
  const data    = parseTar(zlib.gunzipSync(members.find(m => m.name === 'data.tar.gz').data));
  const file    = (entries, n) => entries.find(e => e.name === n);
  return { members, control, data, file };
}

test('ar layout: debian-binary first, then control and data', () => {
  const { members } = unpack(build());
  assert.deepEqual(members.map(m => m.name), ['debian-binary', 'control.tar.gz', 'data.tar.gz']);
  assert.equal(members[0].data.toString(), '2.0\n');
});

test('control file has the required fields and correct architecture', () => {
  for (const arch of ['amd64', 'arm64']) {
    const { control, file } = unpack(build({ arch }));
    const text = file(control, './control').data.toString();
    for (const field of ['Package: js8call-map', 'Version: 1.3.0', `Architecture: ${arch}`, 'Maintainer: ',
                         'Installed-Size: ', 'Depends: libc6', 'Section: hamradio', 'Description: ']) {
      assert.ok(text.includes(field), `${arch}: ${field}`);
    }
    assert.ok(text.endsWith('\n'));
    // Extended description lines start with a space; blank lines are " ."
    const desc = text.split('\n').slice(text.split('\n').findIndex(l => l.startsWith('Description:')) + 1).filter(Boolean);
    assert.ok(desc.length > 0 && desc.every(l => l.startsWith(' ')));
  }
});

test('installs the binary, menu entry, icon, user service and docs with Debian permissions', () => {
  const { data, file } = unpack(build());
  const expected = {
    './usr/bin/js8call-map':                                   0o755,
    './usr/share/applications/js8call-map.desktop':            0o644,
    './usr/share/icons/hicolor/scalable/apps/js8call-map.svg': 0o644,
    './usr/lib/systemd/user/js8call-map.service':              0o644,
    './usr/share/doc/js8call-map/copyright':                   0o644,
    './usr/share/doc/js8call-map/README.Debian':               0o644,
    './usr/share/doc/js8call-map/changelog.gz':                0o644,
    './usr/share/man/man1/js8call-map.1.gz':                   0o644,
  };
  for (const [name, mode] of Object.entries(expected)) {
    const e = file(data, name);
    assert.ok(e, `${name} present`);
    assert.equal(e.mode, mode, `${name} mode`);
    assert.equal(e.type, '0');
  }
  assert.deepEqual(file(data, './usr/bin/js8call-map').data, fakeBinary, 'binary copied byte for byte');

  for (const e of data) {
    assert.equal(e.uid, 0); assert.equal(e.gid, 0); assert.equal(e.uname, 'root');
    assert.equal(e.magic, 'ustar');
    assert.ok(e.name.startsWith('./'), e.name);
  }
  // Every parent directory exists as a directory entry before its contents
  const names = data.map(e => e.name);
  for (const e of data.filter(x => x.type === '0')) {
    const parts = e.name.split('/').slice(0, -1);
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i + 1).join('/') + '/';
      assert.ok(names.includes(dir) && names.indexOf(dir) < names.indexOf(e.name), `${dir} before ${e.name}`);
    }
  }
  assert.ok(data.filter(e => e.type === '5').every(e => e.mode === 0o755));
});

test('md5sums match the installed files', () => {
  const { control, data, file } = unpack(build());
  const lines = file(control, './md5sums').data.toString().trim().split('\n');
  assert.equal(lines.length, data.filter(e => e.type === '0').length);
  for (const line of lines) {
    const [sum, p] = line.split(/\s+/);
    assert.ok(!p.startsWith('/') && !p.startsWith('./'), 'paths are relative without ./');
    assert.equal(crypto.createHash('md5').update(file(data, './' + p).data).digest('hex'), sum, p);
  }
});

test('desktop entry and service point at the installed binary', () => {
  const { data, file } = unpack(build());
  const desktop = file(data, './usr/share/applications/js8call-map.desktop').data.toString();
  assert.match(desktop, /^\[Desktop Entry\]/);
  assert.match(desktop, /^Exec=js8call-map$/m);
  assert.match(desktop, /^Icon=js8call-map$/m);
  assert.match(desktop, /^Terminal=true$/m);
  const service = file(data, './usr/lib/systemd/user/js8call-map.service').data.toString();
  assert.match(service, /^ExecStart=\/usr\/bin\/js8call-map --no-open$/m);
  assert.match(service, /^WantedBy=default\.target$/m);
  const changelog = zlib.gunzipSync(file(data, './usr/share/doc/js8call-map/changelog.gz').data).toString();
  assert.match(changelog, /^js8call-map \(1\.3\.0\) /);
});

test('man page is installed and documents every option and environment variable', () => {
  const { data, file } = unpack(build());
  assert.equal(file(data, './usr/share/doc/js8call-map/changelog.Debian.gz'), undefined,
    'native package uses changelog.gz (lintian: wrong-name-for-changelog-of-native-package)');
  const man = zlib.gunzipSync(file(data, './usr/share/man/man1/js8call-map.1.gz').data).toString();
  assert.match(man, /^\.TH JS8CALL\\-MAP 1 /);
  for (const section of ['NAME', 'SYNOPSIS', 'DESCRIPTION', 'OPTIONS', 'FILES', 'ENVIRONMENT']) {
    assert.match(man, new RegExp(`^\\.SH ${section}$`, 'm'), `section ${section}`);
  }
  const plain = man.replace(/\\-/g, '-');   // roff writes option dashes as \-
  const { HELP } = require('../lib/config');
  for (const flag of new Set(HELP.match(/--[a-z0-9-]+/g))) {
    assert.ok(plain.includes(flag), `man page documents ${flag}`);
  }
  for (const env of new Set(require('fs').readFileSync(require.resolve('../lib/config'), 'utf8').match(/JS8MAP_[A-Z0-9_]+/g))) {
    assert.ok(plain.includes(env), `man page documents ${env}`);
  }
});

test('packaging files use LF line endings (systemd and desktop entries reject CRLF)', () => {
  const { data } = unpack(build());
  for (const e of data.filter(x => x.type === '0' && !/\.(gz)$/.test(x.name) && !x.name.endsWith('/js8call-map'))) {
    assert.ok(!e.data.includes(0x0d), `${e.name} contains a carriage return`);
  }
});

test('builds are reproducible for the same inputs and time', () => {
  assert.deepEqual(build(), build());
});

test('rejects unknown architectures and invalid versions', () => {
  assert.throws(() => build({ arch: 'i386' }), /arch must be/);
  assert.throws(() => build({ version: 'v1.3.0' }), /invalid Debian version/);
});

test('tar splits long paths into the ustar prefix field', () => {
  const long = './' + 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/file.txt';
  const [entry] = parseTar(tar([{ name: long, mode: 0o644, data: Buffer.from('x') }], 0));
  assert.equal(entry.name, long);
  assert.equal(entry.data.toString(), 'x');
});
