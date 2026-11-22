## Setup (Windows)
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

Use `python -m pip`, `python -m uvicorn`, `python -m pytest` (not the bare commands).
If imports fail with "Application Control policy has blocked this file",
turn off Smart App Control (Windows Security > App & browser control).

## Run (always from the project folder, in two terminals)
Terminal 1 (receiver + alerts):  python -m backend.app.receiver
Terminal 2 (simulated drone):    python simulator/drone_sim.py
Stop each with Ctrl+C. Start the receiver first. The simulator loops a 160 s flight with faults;
add --no-faults for a clean flight. To just watch raw packets, run python simulator/udp_listener.py
instead of the receiver (only one program can use port 5005 at a time).

## Test
python -m pytest -q