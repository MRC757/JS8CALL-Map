# JS8CALL Map

An interactive browser-based map that displays the real-time locations of ham radio operators heard by your local [JS8CALL](http://js8call.com/) station. Stations are plotted on a Maidenhead grid map with signal strength, frequency data, message history, and distance/bearing tools.
![Light](https://github.com/user-attachments/assets/7c6e1e9f-239b-4f4f-bd51-27bef5bcf27c)
![Slate](https://github.com/user-attachments/assets/960c92b4-2686-47f2-97e5-3d8729c45378)
![Grid](https://github.com/user-attachments/assets/c46d8a2f-1dca-4d7b-9b15-3594879c7939)
![JS8CALL_Settings](https://github.com/user-attachments/assets/904b0411-2f8b-41e0-a97e-83a1ea8867aa)

---

## Features

- **Live station plotting** — pins appear automatically as JS8CALL hears stations; inactive stations expire after 4 hours
- **Signal-strength colour coding** — marker and sidebar colours reflect live SNR
- **Maidenhead grid overlay** — toggleable overlay that auto-adjusts detail level as you zoom (field → square → subsquare); rendered on canvas at high zoom for smooth performance
- **Station detail panel** — click any pin or sidebar entry to see:
  - Callsign, grid square, SNR (colour-coded)
  - Dial frequency and audio offset
  - Distance and bearing from your home station
  - Full message history (directed, activity, and band messages), tagged by type
  - One-click QRZ.com lookup
- **Unread message indicator** — blue dot on sidebar entries with new messages since you last viewed them
- **Distance measurement tool** — step-by-step prompts guide you to click two points; shows distance (km / miles) and bearing
- **Your home station** — pulsing blue square marker; map centres on your grid at startup
- **Works offline** — Leaflet.js is bundled locally; only map tiles require internet
- **Auto-reconnect** — reconnects to JS8CALL automatically if it restarts; 15-second connect timeout prevents hangs
- **Graceful shutdown** — `Ctrl+C` closes all connections cleanly
- **Dark theme UI** — easy on the eyes during night operating sessions
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

Before starting the map, enable the JS8CALL TCP API server:

1. Open JS8CALL
2. Go to **File → Settings → Reporting**
3. Check **"Enable TCP Server"**
4. Leave the port at the default **2237**
5. Click **OK**

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
#    http://localhost:8080
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

All web assets (HTML, CSS, JS) and the Leaflet library are bundled inside the executable — **no additional files need to be distributed**.

### Distributing to other operators

Send them the single file:

```
js8call-map.exe   ← everything is inside; nothing else needed
```

They double-click it, then open `http://localhost:8080` in any browser.

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

### Toolbar Buttons

| Button | Function |
|---|---|
| **Grid** | Toggle the Maidenhead grid overlay on/off |
| **Measure Distance** | Activate measure mode — a hint banner guides you to click two points |
| **✕ Clear Measure** | Remove the measurement line and result |

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
        └─ http://localhost:8080
```

**server.js responsibilities:**
- Connects to JS8CALL's TCP API on port 2237 with a 15-second connect timeout
- Validates all incoming callsigns against a strict pattern before storing
- Polls for station and band activity every 30 seconds
- Listens for real-time `RX.SPOT`, `RX.DIRECTED`, and `RX.ACTIVITY` events
- Maintains an in-memory station store; removes stations not heard in 4 hours
- Serves the web interface and bundled Leaflet library on port 8080
- Pushes live updates to all connected browsers via WebSocket
- Handles `SIGINT` / `SIGTERM` for graceful shutdown

**app.js responsibilities:**
- Renders a Leaflet map with a dark CartoDB basemap
- Draws the Maidenhead grid overlay (polylines at low zoom, canvas at zoom ≥ 9)
- Places and updates station markers with SNR-based colours
- Manages the station list sidebar with partial DOM updates (surgical patches, not full rebuilds)
- Handles station selection, detail panel rendering, and message history display
- Implements the distance / bearing measurement tool

---

## File Structure

```
JS8CALL Map/
├── server.js          Node.js backend — TCP bridge, WebSocket server, station store
├── package.json       Project config, npm scripts, pkg bundler config
├── .gitignore         Git exclusions
├── LICENSE            MIT licence
├── README.md          This file
└── public/
    ├── index.html     App shell, layout, ARIA landmark roles
    ├── style.css      Dark theme, CSS custom properties, SNR colour classes
    └── app.js         Leaflet map, grid overlay, markers, sidebar, measure tool
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
- Check the JS8CALL main window for decoded activity
- Stations that have not been heard for 4 hours are automatically removed

**Map tiles are not loading**
- The map tiles (background imagery) are fetched from CartoDB and require an internet connection
- If running offline, the map background will be blank but all station pins and the grid overlay will still work correctly

**Port 8080 is already in use**
- Edit `server.js` and change `WEB_PORT` at the top of the file to any available port (e.g. `8181`)
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
- [CartoDB](https://carto.com/) — dark basemap tiles
- [pkg](https://github.com/vercel/pkg) — Node.js single-binary packager
