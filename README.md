# JS8CALL Map

An interactive browser-based map that displays the real-time locations of ham radio operators heard by your local [JS8CALL](http://js8call.com/) station. Stations are plotted on a Maidenhead grid map with signal strength, frequency data, message history, and distance/bearing tools.
![Light](https://github.com/user-attachments/assets/7c6e1e9f-239b-4f4f-bd51-27bef5bcf27c)
![Slate](https://github.com/user-attachments/assets/960c92b4-2686-47f2-97e5-3d8729c45378)
![Grid](https://github.com/user-attachments/assets/c46d8a2f-1dca-4d7b-9b15-3594879c7939)
![JS8CALL_Settings](https://github.com/user-attachments/assets/904b0411-2f8b-41e0-a97e-83a1ea8867aa)

---

## Features

- **Live station plotting** — pins appear automatically as JS8CALL hears stations; stations expire 1 hour (configurable) after JS8CALL last heard them
- **Shared grid squares** — stations reporting the same grid fan out around its centre so every pin stays visible and clickable
- **Duplicate-free message history** — repeated polls and live events of the same text are stored once
- **Grid-based location** — grids are extracted from both JS8CALL spot data and message text (e.g. `GRID FM16RS`)
- **Signal-strength colour coding** — marker and sidebar colours reflect live SNR
- **Maidenhead grid overlay** — toggleable overlay that auto-adjusts detail level as you zoom (field → square → subsquare); rendered on canvas at high zoom for smooth performance
- **Day/Night overlay** — solar terminator updated every minute, useful for visualising HF propagation conditions
- **US overlays** — toggleable US state/county borders with county name labels (zoom ≥ 8) and interstate highway routes with route number labels (zoom ≥ 7); all data bundled offline
- **Colour themes** — five built-in themes (Dark, Midnight, Terminal, Light, Slate); preference saved across sessions
- **Station detail panel** — click any pin or sidebar entry to see (updates live without losing your scroll position):
  - Callsign, grid square, SNR (colour-coded)
  - Dial frequency and audio offset
  - Distance and bearing from your home station
  - Full message history (directed, activity, and band messages), tagged by type
  - One-click QRZ.com lookup
- **Unread message indicator** — blue dot on sidebar entries with new messages since you last viewed them
- **Distance measurement tool** — step-by-step prompts guide you to click two points; shows distance (km / miles) and bearing
- **Your home station** — pulsing blue square marker; map centres on your grid at startup
- **Fully offline** — world basemap, Leaflet.js, and all assets are bundled locally; no internet connection required
- **Opens itself** — the packaged `.exe` opens the map in your browser as soon as the server is ready
- **Private by default** — only reachable from the same PC unless you opt in to LAN access; other websites can't read the live feed through your browser
- **Auto-reconnect** — reconnects to JS8CALL automatically if it restarts; 15-second connect timeout prevents hangs
- **Graceful shutdown** — `Ctrl+C` closes all connections cleanly
- **Accessible** — keyboard-navigable sidebar, ARIA labels, respects OS reduced-motion preference
- **Collapsible sidebar** — maximise map space when needed

---

## Requirements

### To run from source
- [Node.js](https://nodejs.org/) v18 or later (v22 or later to run the test suite)
- JS8CALL installed and running locally

### To run the packaged `.exe`
- Windows 10 or 11
- JS8CALL installed and running locally
- No other installs required

---

## JS8CALL Setup

Before starting the map, configure the JS8CALL TCP API server:

1. Open JS8CALL
2. Go to **File → Settings → Reporting**
3. Check **"Enable TCP Server"**
4. Leave the port at the default **2237**
5. Set **"Max TCP Connections"** to **3** (the default of 1 is not enough — the map uses one persistent connection for real-time events and additional short-lived connections to query station and activity data)
6. Click **OK**

---

## Installation (Source)

```bash
# 1. Clone or download this repository
cd "JS8CALL Map"

# 2. Install dependencies (one-time only)
#    Use a plain `npm install`: Leaflet and the map data are devDependencies
#    (they are bundled into the .exe as files, not required as code), so
#    `npm install --omit=dev` would leave them out.
npm install

# 3. Start the server
npm start

# 4. Open your browser (or start with `npm start -- --open`)
#    http://localhost:8181
```

### Running the tests

```bash
npm test
```

The suite covers the Maidenhead grid maths, JS8CALL message parsing (deduplication,
expiry, validation), configuration, browser launching, the `.exe` asset list, and an
end-to-end run of the server against a simulated JS8CALL.

---

## Configuration

Defaults work for a typical single-PC setup. To change them, use any of the following
(later ones win):

1. A `config.json` file next to `js8call-map.exe` (or in the project folder when running from source)
2. Environment variables
3. Command-line options

| Setting | `config.json` key | Environment variable | Command line | Default |
|---|---|---|---|---|
| Web address | `webHost` | `JS8MAP_HOST` | `--host` | `127.0.0.1` |
| Web port | `webPort` | `JS8MAP_PORT` | `--port` | `8181` |
| JS8CALL host | `js8Host` | `JS8MAP_JS8_HOST` | `--js8-host` | `127.0.0.1` |
| JS8CALL port | `js8Port` | `JS8MAP_JS8_PORT` | `--js8-port` | `2237` |
| Poll interval (s) | `pollSeconds` | `JS8MAP_POLL_SECONDS` | `--poll-seconds` | `30` |
| Station expiry (min) | `ttlMinutes` | `JS8MAP_TTL_MINUTES` | `--ttl-minutes` | `60` |
| Messages per station | `maxMessages` | `JS8MAP_MAX_MESSAGES` | `--max-messages` | `100` |
| Open browser at startup | `openBrowser` | `JS8MAP_OPEN` | `--open` / `--no-open` | on for the exe, off from source |

Example `config.json`:

```json
{ "webPort": 8282 }
```

By default the map is only reachable from the same computer. To view it from a phone
or another PC on your network, set `webHost` to `0.0.0.0` and browse to
`http://<this-pc's-ip>:8181`. Run `js8call-map --help` for a summary.

---

## Packaging as a Standalone .exe

To produce a single `js8call-map.exe` that runs on any Windows machine without Node.js installed:

```bash
npm run package
```

The output is written to the `dist/` folder:

```
dist/
└── js8call-map.exe
```

All web assets (HTML, CSS, JS), the Leaflet library, and the offline map data are bundled inside the executable (about 62 MB, ~23 MB zipped; most of that is the Node.js 22 runtime) — **no additional files need to be distributed**.

Only the files the page actually loads are bundled. They are listed in
[`lib/assets.js`](lib/assets.js) and must also appear in `pkg.assets` in `package.json`;
`npm test` fails if the two lists drift apart.

### Starting the map

Double-click `js8call-map.exe`. Once the server is ready it opens the map in your
default browser on the configured address and port, so no separate launcher is needed.
If the port is already in use, no browser opens and the console window shows the error.

To start it without opening a browser (for example when running it in the background),
use `js8call-map.exe --no-open`, or put `{ "openBrowser": false }` in `config.json`.
When run from source with `npm start`, the browser is **not** opened by default; use
`npm start -- --open` to opt in.

For a desktop shortcut: right-click `js8call-map.exe` → **Create shortcut** and move it
to your Desktop. Options such as `--port 8282` can be added to the shortcut's **Target**
field. The old `launch.bat` still works; it now simply starts the exe.

### Distributing to other operators

Send them `js8call-map.exe` (or the zip from the [Releases](../../releases) page).
They double-click it and the map opens in their browser.

---

## Usage

### Map Navigation

| Action | Result |
|---|---|
| Scroll wheel | Zoom in / out |
| Click and drag | Pan the map |
| Click a station pin | Open station detail panel |
| Click a station in the sidebar | Open detail panel and pan to station |
| Keyboard `Enter` / `Space` on sidebar item | Select station (keyboard accessible) |

### Toolbar

| Control | Function |
|---|---|
| Theme selector | Switch between Dark, Midnight, Terminal, Light, and Slate colour themes |
| **Grid** | Toggle the Maidenhead grid overlay on/off |
| **Night** | Toggle the day/night (solar terminator) overlay — useful for HF propagation planning |
| **US States** | Toggle US state and county border overlay; county names appear at zoom ≥ 8 |
| **Interstates** | Toggle US interstate highway overlay; route numbers appear at zoom ≥ 7 |
| **Measure Distance** | Activate measure mode — a hint banner guides you to click two points |
| **✕ Clear Measure** | Remove the measurement line and result |

### Day / Night Overlay

When enabled, a semi-transparent overlay shows the night side of Earth based on the current UTC time. The terminator line updates every minute as the Earth rotates. This is particularly useful for HF because:

- The **D-layer** (which absorbs HF signals) dissipates at night
- The **F-layer** remains reflective after dark, enabling long-distance skip
- Signals generally propagate better across the night-side path

### Station Detail Panel

Click any station pin or sidebar entry to open the detail panel on the right. It shows:

- **SNR** — signal-to-noise ratio, colour-coded by strength:

  | Colour | Range | Meaning |
  |---|---|---|
  | 🟢 Bright green | ≥ 0 dB | Strong |
  | 🟢 Light green | −1 to −10 dB | Good |
  | 🟡 Yellow | −11 to −20 dB | Fair |
  | 🟠 Orange | −21 to −30 dB | Weak |
  | 🔴 Red | < −30 dB | Very weak |

- **Distance / Bearing** — great-circle distance and bearing from your station (requires your grid to be set in JS8CALL)
- **Messages** — all text heard from that station, tagged by type:
  - `DIRECTED` — message addressed to a specific callsign
  - `ACTIVITY` — general decoded activity
  - `BAND` — band activity text

### Grid Location Detection

A station pin only appears on the map once its Maidenhead grid square is known. The app learns a station's grid from two sources:

1. **JS8CALL spot data** — the `GRID` field in `RX.SPOT` and `RX.CALL_ACTIVITY` events
2. **Message text** — any message (including band activity) containing `GRID XXXX` or `GRID XXXXXX` (e.g. `W4AOE: KJ4QEO GRID EM85SI *`)

Invalid locators are ignored. When several stations share a grid square, their pins are
fanned out a few pixels around the square's centre; your own station stays nearest the centre.

Stations that have never transmitted their grid will appear in the sidebar but not on the map until a grid is received.

### Unread Message Indicator

A blue dot appears on a station's sidebar entry when a new message arrives and the station detail panel is not currently open for that station. The dot clears when you select the station.

### Maidenhead Grid Overlay

The grid automatically changes resolution as you zoom:

| Zoom Level | Grid Resolution | Labels |
|---|---|---|
| 1 – 4 | Field (20° × 10°) | 2-character (e.g. `EM`) |
| 5 – 8 | Square (2° × 1°) | 4-character (e.g. `EM72`) |
| 9 + | Subsquare (5′ × 2.5′) | None (canvas-rendered for performance) |

---

## Architecture

```
JS8CALL application  (localhost:2237)
        │  TCP — newline-delimited JSON
        ▼
server.js  (Node.js + Express + WebSocket)
        │  WebSocket — live push updates
        ▼
Browser  (Leaflet.js + app.js)
        │
        └─ http://localhost:8181
```

**server.js responsibilities:**
- Maintains a **persistent listen-only TCP connection** to JS8CALL for real-time events (`RX.SPOT`, `RX.DIRECTED`, `RX.ACTIVITY`) — this socket is never written to
- Opens **short-lived TCP connections** every 30 seconds (configurable) to query callsign, grid, and activity history — each query connects, waits for the reply carrying its own `_ID` (ignoring any live events that arrive first), and closes (requires Max TCP Connections ≥ 3 in JS8CALL settings)
- Serves the web interface and bundled offline data, listening on `127.0.0.1:8181` by default; rejects WebSocket connections from other websites
- Pushes live updates to all connected browsers via WebSocket, only when something actually changed
- Opens the default browser once listening (packaged `.exe`, or `--open`)
- Handles `SIGINT` / `SIGTERM` for graceful shutdown

**lib/station-store.js responsibilities:**
- Validates callsigns (must contain a digit), grid locators, frequency, offset, and message text before storing
- Uses JS8CALL's own timestamps for "last heard", so stations repeated in every activity poll still expire on time; older reports never overwrite fresher readings
- Stores each message once — exact repeats from polling, and the same text arriving via a live event within 10 minutes, are dropped
- Keeps messages newest-first, capped per station; removes stations not heard within the expiry time

**app.js responsibilities:**
- Renders a Leaflet map with a fully offline vector world basemap (TopoJSON via world-atlas)
- Draws the Maidenhead grid overlay (polylines at low zoom, canvas at zoom ≥ 9)
- Calculates and renders the solar terminator for the day/night overlay
- Renders US state/county borders and interstate highways from bundled offline data; shows county name and route number labels at appropriate zoom levels
- Places and updates station markers with SNR-based colours, fanning out stations that share a grid square
- Manages the station list sidebar with partial DOM updates (surgical patches, not full rebuilds)
- Handles station selection and the detail panel, patching stats and inserting new messages in place so the reading position is kept
- Adds county and interstate labels only for the area in view
- Implements the distance / bearing measurement tool
- Applies and persists colour theme selection via localStorage

---

## File Structure

```
JS8CALL Map/
├── server.js          Node.js backend — HTTP/WebSocket server, JS8CALL TCP bridge
├── lib/
│   ├── station-store.js  Station/message store and JS8CALL message parsing
│   ├── config.js         config.json / environment / command-line settings
│   ├── net-utils.js      Query-reply matching, WebSocket origin check, line splitter
│   ├── open-browser.js   Opens the map in the default browser at startup
│   └── assets.js         The files served to the browser (and bundled into the .exe)
├── test/              node:test suites (npm test)
├── launch.bat         Optional launcher for older shortcuts (the exe opens the browser itself)
├── package.json       Project config, npm scripts, pkg bundler config
├── .gitignore         Git exclusions (build output, release zips, local config.json)
├── .gitattributes     Line-ending rules
├── LICENSE            MIT licence
├── README.md          This file
└── public/
    ├── index.html     App shell, layout, ARIA landmark roles
    ├── style.css      Themes, CSS custom properties, SNR colour classes
    ├── grid.js        Maidenhead grid / distance maths (shared by browser, server and tests)
    ├── app.js         Leaflet map, grid overlay, day/night overlay, US overlays, markers, sidebar, measure tool
    └── data/
        ├── interstates.geojson   US interstate highway routes (Census TIGER-derived, simplified)
        └── county_names.json     FIPS → county name lookup (3,143 entries)
```

---

## Troubleshooting

**Map shows "Disconnected"**
- Confirm JS8CALL is running
- Confirm the TCP server is enabled in JS8CALL settings (port 2237)
- Check that no firewall is blocking `localhost:2237`
- If JS8CALL is slow to start, the app will retry every 5 seconds automatically

**Connection attempt times out**
- The app waits up to 15 seconds for JS8CALL to accept the connection, then retries
- If JS8CALL is running but the TCP server is not enabled, you will see repeated "timed out" messages in the console — enable the TCP server in JS8CALL settings

**No stations appear on the map**
- Stations only appear once JS8CALL decodes a signal — if the band is quiet or the radio is not receiving, no pins will appear
- Stations will appear in the sidebar but not on the map until their grid square is known — this happens when JS8CALL reports it in spot data or when the station transmits a `GRID` message
- Check the JS8CALL main window for decoded activity
- Stations not heard for 1 hour (or your `ttlMinutes` setting) are automatically removed

**The map won't load from another computer or phone**
- By default the server only listens on this PC (`127.0.0.1`)
- Start it with `--host 0.0.0.0` (or `{ "webHost": "0.0.0.0" }` in `config.json`), allow it through Windows Firewall when prompted, and browse to `http://<this-pc's-ip>:8181`

**"CONNECTIONS FULL" appears in JS8CALL or the map shows a constant disconnect loop**
- JS8CALL's TCP connection limit has been reached (default is 1, which is not enough)
- Go to **File → Settings → Reporting** in JS8CALL and set **Max TCP Connections** to **3**
- Restart JS8CALL to clear any stuck connections, then restart the map server

**Port conflict — server won't start**
- Start with a different port: `js8call-map.exe --port 8282` (or `npm start -- --port 8282`)
- Or create `config.json` next to the program containing `{ "webPort": 8282 }`
- The packaged exe opens your browser on the new port automatically

**Packaged .exe doesn't start**
- Open a terminal (`cmd` or PowerShell), run `js8call-map.exe` directly, and check the console output for error messages
- Ensure JS8CALL is running before or shortly after starting the map

---

## Contributing

Bug reports and pull requests are welcome. Please open an issue first to discuss significant changes.

---

## License

MIT — see [LICENSE](LICENSE) for full text.

---

## Acknowledgements

- [JS8CALL](http://js8call.com/) by KN4CRD — JS8 digital mode software
- [Leaflet.js](https://leafletjs.com/) — interactive mapping library
- [Natural Earth / world-atlas](https://github.com/topojson/world-atlas) — offline world map data
- [us-atlas](https://github.com/topojson/us-atlas) — offline US state and county boundary data
- [US Census Bureau TIGER/Line](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html) — interstate highway source data
- [topojson-client](https://github.com/topojson/topojson-client) — TopoJSON decoder
- [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) — Node.js single-binary packager (maintained fork of vercel/pkg)
