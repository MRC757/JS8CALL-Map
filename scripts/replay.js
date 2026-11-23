#!/usr/bin/env node
'use strict';

// Summarise a JS8CALL recording made with `js8call-map --record <file>`.
// Usage: npm run replay -- <file.jsonl> [--stations]

const fs = require('fs');
const { parseRecording, replay, summarize } = require('../lib/replay');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run replay -- <recording.jsonl> [--stations]');
  process.exit(1);
}

const { entries, errors } = parseRecording(fs.readFileSync(file, 'utf8'));
const result  = replay(entries);
const summary = summarize(result, entries, errors);

console.log(JSON.stringify(summary, null, 2));

if (args.includes('--stations')) {
  for (const s of [...result.store.stations.values()].sort((a, b) => b.lastHeard - a.lastHeard)) {
    console.log(`${s.callsign.padEnd(10)} ${String(s.grid || '—').padEnd(7)} ` +
                `${String(s.snr ?? '—').padStart(4)} dB  ${s.messages.length} msg` +
                (s.heardMe ? `  hears you ${s.heardMe.snr} dB` : ''));
  }
}

if (errors.length) process.exitCode = 1;
