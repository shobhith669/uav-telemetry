"""The web server: listens for the drone on UDP, serves the dashboard, pushes data over a WebSocket.

Run from the project folder:   python -m uvicorn backend.app.main:app --port 8000
Then open:                     http://localhost:8000
"""
import asyncio
import socket
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.app.pipeline import Pipeline

DASHBOARD_DIR = Path(__file__).resolve().parents[2] / "dashboard"
UDP_HOST = "0.0.0.0"
UDP_PORT = 5005
HISTORY_LEN = 6000  # recent telemetry kept for pages opened late: about 10 minutes at 10 per second


class Hub:
    """Remembers which browser pages are connected and sends every message to all of them."""

    def __init__(self):
        self.clients: set[WebSocket] = set()
        self.latest: dict | None = None  # newest message of any type
        self.history: deque = deque(maxlen=HISTORY_LEN)  # recent telemetry messages
        self.lock = asyncio.Lock()  # so a new page gets its history and the live stream without gaps

    async def connect(self, ws: WebSocket):
        await ws.accept()
        async with self.lock:
            # A page opened late (or refreshed) first gets what it missed, so its graphs are not empty.
            if self.history:
                await ws.send_json({"type": "history", "version": 1, "messages": list(self.history)})
            if self.latest is not None and self.latest["type"] != "telemetry":
                await ws.send_json(self.latest)  # e.g. a "link" message while packets are missing
            self.clients.add(ws)

    def disconnect(self, ws: WebSocket):
        self.clients.discard(ws)

    async def broadcast(self, msg: dict):
        async with self.lock:
            self.latest = msg
            if msg["type"] == "telemetry":
                self.history.append(msg)
            for ws in list(self.clients):
                try:
                    await ws.send_json(msg)
                except Exception:  # that page went away
                    self.clients.discard(ws)


def udp_loop(pipeline: Pipeline, hub: Hub, loop: asyncio.AbstractEventLoop, stop: threading.Event, sock: socket.socket):
    """Runs in its own thread: wait for packets, process them, hand the result to the web side."""
    while not stop.is_set():
        msg = None
        try:
            try:
                data, _ = sock.recvfrom(4096)
            except socket.timeout:
                # Nothing arrived for 0.5 s: check whether the link has gone quiet
                msg = pipeline.check_link(time.monotonic(), int(time.time() * 1000))
            else:
                now_ms = int(time.time() * 1000)  # taken after the packet arrived
                msg = pipeline.handle_datagram(data, now_ms, time.monotonic())
            if msg is not None:
                asyncio.run_coroutine_threadsafe(hub.broadcast(msg), loop)
        except ConnectionResetError:
            continue
        except RuntimeError:  # the web side is shutting down
            break
        except Exception as exc:  # never let this thread die
            print(f"[ERROR] {type(exc).__name__}: {exc}")
    sock.close()


def create_app(udp_port: int = UDP_PORT) -> FastAPI:
    hub = Hub()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.bind((UDP_HOST, udp_port))
        except OSError as exc:
            sock.close()
            raise RuntimeError(
                f"Cannot listen on UDP port {udp_port} ({exc}). Another receiver, listener "
                f"or server is probably still running. Close it and try again."
            ) from exc
        sock.settimeout(0.5)
        pipeline = Pipeline()
        app.state.pipeline = pipeline
        stop = threading.Event()
        thread = threading.Thread(
            target=udp_loop,
            args=(pipeline, hub, asyncio.get_running_loop(), stop, sock),
            daemon=True,
        )
        thread.start()
        print(f"Listening for the drone on UDP {udp_port}. Open http://localhost:8000 in your browser.")
        yield
        stop.set()
        thread.join(timeout=2)

    app = FastAPI(title="UAV telemetry", lifespan=lifespan)
    app.state.hub = hub

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await hub.connect(ws)
        try:
            while True:
                await ws.receive_text()  # the page sends nothing; this just notices when it closes
        except WebSocketDisconnect:
            pass
        finally:
            hub.disconnect(ws)

    @app.get("/api/thresholds")
    async def thresholds():
        # The same limits the alert engine uses (config/thresholds.yaml), so the graphs can draw them
        return app.state.pipeline.anomaly.cfg

    @app.get("/")
    async def index():
        return FileResponse(DASHBOARD_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=DASHBOARD_DIR), name="static")
    return app


app = create_app()
