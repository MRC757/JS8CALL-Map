# Recorded JS8CALL sessions

Every `*.jsonl` file in this folder is replayed by `test/recording.test.js` and
checked against the station store's rules: valid callsigns and grids, HF
frequencies only, messages newest-first with no duplicates, and your callsign
picked up from JS8CALL's reply.

## Adding a real recording

1. Start the map with recording on:
   - packaged: `js8call-map.exe --record session.jsonl`
   - from source: `npm start -- --record session.jsonl`
2. Leave it running while JS8CALL is on the air (30–60 minutes of normal band
   activity is plenty), then stop it with **Ctrl+C** so the file is flushed.
3. See what it captured: `npm run replay -- session.jsonl --stations`
4. Copy the file into this folder with a descriptive name, for example
   `2026-11-23-40m-evening.jsonl`, and run `npm test`.

Each line is one message exactly as JS8CALL sent it:

```json
{"t":1763910000000,"src":"event","line":"{\"type\":\"RX.DIRECTED\",…}"}
{"t":1763910000050,"src":"reply","query":"RX.GET_CALL_ACTIVITY","line":"{…}"}
```

Recordings contain callsigns, grids and message text heard over the air (all
public radio traffic) plus your own callsign and grid.

## Files

- `synthetic-example.jsonl` — **made up**, not a real recording. It mimics the
  message shapes JS8CALL sends, so the replay tests have something to run until
  real sessions are added. Real recordings are more valuable: if one fails, the
  parser's assumptions about JS8CALL are wrong somewhere.
