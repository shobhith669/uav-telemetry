## Setup (Windows)
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

Use `python -m pip`, `python -m uvicorn`, `python -m pytest` (not the bare commands).
If imports fail with "Application Control policy has blocked this file",
turn off Smart App Control (Windows Security > App & browser control).