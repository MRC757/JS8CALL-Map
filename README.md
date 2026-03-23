# JS8CALL Map

An interactive browser-based map that displays the real-time locations of ham radio operators heard by your local [JS8CALL](http://js8call.com/) station. Stations are plotted on a Maidenhead grid map with signal strength, frequency data, message history, and distance/bearing tools.
![Light](https://github.com/user-attachments/assets/7c6e1e9f-239b-4f4f-bd51-27bef5bcf27c)
![Slate](https://github.com/user-attachments/assets/960c92b4-2686-47f2-97e5-3d8729c45378)
![Grid](https://github.com/user-attachments/assets/c46d8a2f-1dca-4d7b-9b15-3594879c7939)
![JS8CALL_Settings](https://github.com/user-attachments/assets/904b0411-2f8b-41e0-a97e-83a1ea8867aa)

---

## Features

- **Live station plotting** — pins appear automatically as JS8CALL hears stations; inactive stations expire after 1 hour
- **Grid-based location** — grids are extracted from both JS8CALL spot data and message text (e.g. `GRID FM16RS`)
- **Signal-strength colour coding** — marker and sidebar colours reflect live SNR
- **Maidenhead grid overlay** — toggleable overlay that auto-adjusts detail level as you zoom (field → square → subsquare); rendered on canvas at high zoom for smooth performance
- **Day/Night overlay** — solar terminator updated every minute, useful for visualising HF propagation conditions
- **US overlays** — toggleable US state/county borders with county name labels (zoom ≥ 8) and interstate highway routes with route number labels (zoom ≥ 7); all data bundled offline
- **Colour themes** — five built-in themes (Dark, Midnight, Terminal, Light, Slate); preference saved across sessions
- **Station detail panel** — click any pin or sidebar entry to see:
  - Callsign, grid square, SNR (colour-coded)
  - Dial frequency and audio offset
  - Distance and bearing from your home station
  - Full message history (directed, activity, and band messages), tagged by type
  - One-click QRZ.com lookup
- **Unread message indicator** — blue dot on sidebar entries with new messages since you last viewed them
- **Distance measurement tool** — step-by-step prompts guide you to click two points; shows distance (km / miles) and bearing
- **Your home station** — pulsing blue square marker; map centres on your grid at startup
- **Fully offline** — world basemap, Leaflet.js, and all assets are bundled locally; no internet connection required
- **Auto-reconnect** — reconnects to JS8CALL automatically if it restarts; 15-second connect timeout prevents hangs
- **Graceful shutdown** — `Ctrl+C` closes all connections cleanly
- **Accessible** — keyboard-navigable sidebar, ARIA labels, respects OS reduced-motion preference
- **Collapsible sidebar** — maximise map space when needed

---

## Requirements

### To run from source
- [Node.js](https://nodejs.org/) v18 or later
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
npm install

# 3. Start the server
npm start

# 4. Open your browser
#    http://localhost:8181
```

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

All web assets (HTML, CSS, JS), the Leaflet library, and the offline world map are bundled inside the executable — **no additional files need to be distributed**.

### Desktop shortcut (optional)

For a one-click launch that opens the map in your browser automatically, use the included `launch.bat` (found in the project root):

1. Right-click `launch.bat` → **Create shortcut**
2. Move the shortcut to your Desktop
3. Optionally set a custom icon: right-click shortcut → **Properties → Change Icon** → browse to `js8call-map.exe`

`launch.bat` starts the server and opens `http://localhost:8181` in your default browser after a short delay.

### Distributing to other operators

Send them both files (or the zip from the [Releases](../../releases) page):

```
js8call-map.exe   ← the server (everything bundled inside)
launch.bat        ← optional one-click launcher
```

They double-click `launch.bat` (or the `.exe` directly), then open `http://localhost:8181` in any browser.

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
2. **Message text** — any message containing `GRID XXXX` or `GRID XXXXXX` (e.g. `W4AOE: KJ4QEO GRID EM85SI *`)

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
- Opens **short-lived TCP connections** every 30 seconds to query callsign, grid, and activity history — each query connects, reads the response, and closes (requires Max TCP Connections ≥ 3 in JS8CALL settings)
- Validates all incoming callsigns and sanitises frequency, offset, and message text before storing
- Creates station stubs when messages arrive before spot data, preventing message loss
- Maintains an in-memory station store; removes stations not heard in 1 hour
- Serves the web interface, bundled Leaflet library, and offline world map data on port 8181
- Pushes live updates to all connected browsers via WebSocket
- Handles `SIGINT` / `SIGTERM` for graceful shutdown

**app.js responsibilities:**
- Renders a Leaflet map with a fully offline vector world basemap (TopoJSON via world-atlas)
- Draws the Maidenhead grid overlay (polylines at low zoom, canvas at zoom ≥ 9)
- Calculates and renders the solar terminator for the day/night overlay
- Renders US state/county borders and interstate highways from bundled offline data; shows county name and route number labels at appropriate zoom levels
- Places and updates station markers with SNR-based colours
- Manages the station list sidebar with partial DOM updates (surgical patches, not full rebuilds)
- Handles station selection, detail panel rendering, and message history display
- Implements the distance / bearing measurement tool
- Applies and persists colour theme selection via localStorage

---

## File Structure

```
JS8CALL Map/
├── server.js          Node.js backend — TCP bridge, WebSocket server, station store
├── launch.bat         One-click launcher — starts server and opens browser
├── package.json       Project config, npm scripts, pkg bundler config
├── .gitignore         Git exclusions
├── LICENSE            MIT licence
├── README.md          This file
└── public/
    ├── index.html     App shell, layout, ARIA landmark roles
    ├── style.css      Themes, CSS custom properties, SNR colour classes
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
- Stations not heard for 1 hour are automatically removed

**"CONNECTIONS FULL" appears in JS8CALL or the map shows a constant disconnect loop**
- JS8CALL's TCP connection limit has been reached (default is 1, which is not enough)
- Go to **File → Settings → Reporting** in JS8CALL and set **Max TCP Connections** to **3**
- Restart JS8CALL to clear any stuck connections, then restart the map server

**Port conflict — server won't start**
- Edit `server.js` and change `WEB_PORT` at the top of the file to any available port
- The app currently uses port **8181**; if that is also taken, try `8282` or similar
- Reopen your browser to the new port

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
- [pkg](https://github.com/vercel/pkg) — Node.js single-binary packager
