## Setup (Windows)
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

Use `python -m pip`, `python -m uvicorn`, `python -m pytest` (not the bare commands).
If imports fail with "Application Control policy has blocked this file",
turn off Smart App Control (Windows Security > App & browser control).

## Run the dashboard (always from the project folder, in two terminals)
Terminal 1 (backend + dashboard):  python -m uvicorn backend.app.main:app --port 8000
Terminal 2 (simulated drone):      python simulator/drone_sim.py
Then open http://localhost:8000 in the browser (Ctrl+F5 after editing the dashboard files).
Stop each terminal with Ctrl+C. Start the backend first. The simulator loops a 160 s flight with
faults; add --no-faults for a clean flight.

The dashboard has three tabs: FLIGHT (3D simulation and the nine cards), GRAPHS (history) and MAP (flight track).
The page always fits the window. Only the left side scrolls; the alert and link panel on the right stays put.
The MAP tab shows a metre grid, so it works with no internet. Press TILES to show real map tiles
(OpenStreetMap) when you are online. For heavy use later, switch to another tile provider (see dashboard/map.js).
Leaflet (the map library) is in dashboard/vendor/leaflet and ECharts (the graphs) in dashboard/vendor, so nothing loads from the internet.

## Run without the dashboard (text only)
Terminal 1 (receiver + alerts):  python -m backend.app.receiver
Terminal 2 (simulated drone):    python simulator/drone_sim.py
To just watch raw packets, run python simulator/udp_listener.py instead of the receiver.
Only one program can use UDP port 5005 at a time (the backend, the receiver or the listener).

## Test
python -m pytest -q